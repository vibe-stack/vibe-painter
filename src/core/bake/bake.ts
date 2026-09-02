/**
 * The ray half of baking: ambient occlusion, curvature and thickness.
 *
 * This runs on the CPU in a worker rather than in a compute shader. That is a
 * deliberate trade: a GPU baker would be faster, but it would also make the
 * headless API depend on a live WebGPU device, and baking is exactly the kind
 * of thing an agent or a test wants to run without one. It is a one-time cost
 * per mesh, it reports progress, and it parallelises across workers cleanly.
 *
 * Sampling is stratified (Hammersley) with a per-texel rotation rather than
 * uniform random. Quality per ray matters far more here than raw ray
 * throughput: 32 stratified rays look like several times as many random ones,
 * and the ray budget is what the wall-clock time actually is.
 *
 * This module must stay free of three.js and DOM references so it can be
 * imported by a worker.
 */

import { Bvh } from './bvh'

export interface BakeSettingsInput {
  resolution: number
  aoRays: number
  aoDistance: number
  thicknessRays: number
  curvatureRadius: number
  curvatureIntensity: number
  dilation: number
  rayBias: number
}

export interface BakeGeometry {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint32Array
}

export interface BakeRequest {
  geometry: BakeGeometry
  settings: BakeSettingsInput
  /** Texel rows this call is responsible for. */
  rowStart: number
  rowEnd: number
}

export interface BakeResult {
  rowStart: number
  rowEnd: number
  /** RGBA per texel, rows [rowStart, rowEnd): ao, curvature, thickness, coverage. */
  data: Float32Array
}

/** Van der Corput radical inverse, base 2. */
function radicalInverse(bits: number): number {
  let b = bits
  b = (b << 16) | (b >>> 16)
  b = ((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)
  b = ((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)
  b = ((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)
  b = ((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)
  return (b >>> 0) * 2.3283064365386963e-10
}

/**
 * Discrete mean curvature per vertex.
 *
 * For each neighbour we take the neighbour direction projected on the vertex
 * normal and divide by edge length. For a sphere of radius R that evaluates to
 * about 1/(2R) regardless of tessellation, which is what makes the result
 * comparable across meshes rather than a measure of triangle density.
 *
 * Signed so that positive is convex (edges) and negative is concave (cracks) -
 * that sign is the whole reason curvature drives edge wear and cavity dirt
 * from a single map.
 *
 * The result is then normalised against the mesh's own mean curvature rather
 * than a fixed constant. A fixed scale cannot work: the raw value is roughly
 * `1/(2 x feature radius)`, so a thin tube produces numbers several times
 * larger than a big smooth form and clamps to solid white everywhere, which
 * carries no information at all. Self-calibrating keeps the interesting range
 * spread across the map whatever the model's scale.
 */
function computeVertexCurvature(
  geometry: BakeGeometry,
  intensity: number,
  smoothingPasses: number,
): Float32Array {
  const { positions, normals, indices } = geometry
  const vertexCount = positions.length / 3
  const sum = new Float32Array(vertexCount)
  const count = new Uint32Array(vertexCount)

  const accumulate = (v: number, other: number) => {
    const a = v * 3
    const b = other * 3
    const ex = positions[b] - positions[a]
    const ey = positions[b + 1] - positions[a + 1]
    const ez = positions[b + 2] - positions[a + 2]
    const len2 = ex * ex + ey * ey + ez * ez
    if (len2 < 1e-16) return
    const len = Math.sqrt(len2)
    const projected = (ex * normals[a] + ey * normals[a + 1] + ez * normals[a + 2]) / len
    // Negative projection means the neighbour sits below the tangent plane,
    // i.e. the surface bulges outward here.
    sum[v] += -projected / len
    count[v]++
  }

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2]
    accumulate(i0, i1); accumulate(i0, i2)
    accumulate(i1, i0); accumulate(i1, i2)
    accumulate(i2, i0); accumulate(i2, i1)
  }

  let curvature = new Float32Array(vertexCount)
  for (let v = 0; v < vertexCount; v++) {
    curvature[v] = count[v] > 0 ? sum[v] / count[v] : 0
  }

  // Laplacian smoothing over the edge graph. More passes means a larger
  // effective search radius, which is exactly what "curvature radius" means to
  // someone tuning an edge-wear mask.
  for (let pass = 0; pass < smoothingPasses; pass++) {
    const next = new Float32Array(vertexCount)
    const n = new Uint32Array(vertexCount)
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2]
      next[i0] += curvature[i1] + curvature[i2]; n[i0] += 2
      next[i1] += curvature[i0] + curvature[i2]; n[i1] += 2
      next[i2] += curvature[i0] + curvature[i1]; n[i2] += 2
    }
    for (let v = 0; v < vertexCount; v++) {
      next[v] = n[v] > 0 ? curvature[v] * 0.5 + (next[v] / n[v]) * 0.5 : curvature[v]
    }
    curvature = next
  }

  // Normalise against the mesh's own mean absolute curvature. Three times the
  // mean reaches the end of the range, which keeps ordinary surface just off
  // neutral and leaves headroom for genuine edges.
  let total = 0
  let counted = 0
  for (let v = 0; v < vertexCount; v++) {
    if (count[v] === 0) continue
    total += Math.abs(curvature[v])
    counted++
  }
  const meanAbs = counted > 0 ? total / counted : 0
  const scale = meanAbs > 1e-9 ? intensity / (meanAbs * 3) : 0
  for (let v = 0; v < vertexCount; v++) curvature[v] *= scale

  return curvature
}

/** Any unit vector perpendicular to `n`, chosen to avoid the degenerate axis. */
function perpendicular(nx: number, ny: number, nz: number): [number, number, number] {
  if (Math.abs(nx) < 0.9) {
    const len = Math.sqrt(nz * nz + ny * ny)
    return [0, -nz / len, ny / len]
  }
  const len = Math.sqrt(nz * nz + nx * nx)
  return [nz / len, 0, -nx / len]
}

export function bakeRows(request: BakeRequest, onProgress?: (fraction: number) => void): BakeResult {
  const { geometry, settings, rowStart, rowEnd } = request
  const { positions, normals, uvs, indices } = geometry
  const size = settings.resolution
  const rows = rowEnd - rowStart
  const data = new Float32Array(size * rows * 4)

  // --- Bounds -------------------------------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i + 1] < minY) minY = positions[i + 1]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 1] > maxY) maxY = positions[i + 1]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  const boundingRadius = Math.max(1e-5, diagonal * 0.5)

  const bvh = new Bvh({ positions, indices })
  // Radius maps to smoothing passes: more smoothing averages curvature over a
  // wider neighbourhood, which is what a larger search radius means here.
  const smoothingPasses = Math.max(0, Math.min(16, Math.round(settings.curvatureRadius * 3)))
  const curvature = computeVertexCurvature(geometry, settings.curvatureIntensity, smoothingPasses)

  const aoDistance = Math.max(1e-4, settings.aoDistance * boundingRadius)
  const thicknessDistance = boundingRadius * 2
  const bias = Math.max(1e-6, settings.rayBias * boundingRadius)

  // --- Rasterise this worker's rows, tracing each covered texel -----------
  const triangleCount = indices.length / 3
  let processed = 0
  const reportEvery = Math.max(1, Math.floor(triangleCount / 20))

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2]
    const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1]
    const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1]
    const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1]

    // UV space -> texel space. `v` is flipped to match how the GPU passes
    // rasterise into the same targets (clip.y = 1 - 2v).
    const x0 = u0 * size, y0 = (1 - v0) * size
    const x1 = u1 * size, y1 = (1 - v1) * size
    const x2 = u2 * size, y2 = (1 - v2) * size

    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(area) < 1e-12) continue
    const invArea = 1 / area

    const bboxMinX = Math.max(0, Math.floor(Math.min(x0, x1, x2)) - 1)
    const bboxMaxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)) + 1)
    const bboxMinY = Math.max(rowStart, Math.floor(Math.min(y0, y1, y2)) - 1)
    const bboxMaxY = Math.min(rowEnd - 1, Math.ceil(Math.max(y0, y1, y2)) + 1)

    for (let py = bboxMinY; py <= bboxMaxY; py++) {
      const cy = py + 0.5
      for (let px = bboxMinX; px <= bboxMaxX; px++) {
        const cx = px + 0.5
        let w1 = ((cx - x0) * (y2 - y0) - (cy - y0) * (x2 - x0)) * invArea
        let w2 = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0)) * invArea
        let w0 = 1 - w1 - w2
        // Half a texel of slack, so thin triangles still claim a texel rather
        // than falling entirely between sample points.
        const slack = -0.002
        if (w0 < slack || w1 < slack || w2 < slack) continue
        w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2)
        const wSum = w0 + w1 + w2
        w0 /= wSum; w1 /= wSum; w2 /= wSum

        const a = i0 * 3, b = i1 * 3, c = i2 * 3
        const wx = positions[a] * w0 + positions[b] * w1 + positions[c] * w2
        const wy = positions[a + 1] * w0 + positions[b + 1] * w1 + positions[c + 1] * w2
        const wz = positions[a + 2] * w0 + positions[b + 2] * w1 + positions[c + 2] * w2

        let nx = normals[a] * w0 + normals[b] * w1 + normals[c] * w2
        let ny = normals[a + 1] * w0 + normals[b + 1] * w1 + normals[c + 1] * w2
        let nz = normals[a + 2] * w0 + normals[b + 2] * w1 + normals[c + 2] * w2
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
        nx /= nLen; ny /= nLen; nz /= nLen

        const texelCurvature = curvature[i0] * w0 + curvature[i1] * w1 + curvature[i2] * w2

        const ox = wx + nx * bias, oy = wy + ny * bias, oz = wz + nz * bias
        const ao = traceOcclusion(bvh, ox, oy, oz, nx, ny, nz, settings.aoRays, aoDistance, bias, px, py)
        const thickness = traceThickness(
          bvh, wx - nx * bias, wy - ny * bias, wz - nz * bias,
          -nx, -ny, -nz, settings.thicknessRays, thicknessDistance, bias, px, py,
        )

        const index = ((py - rowStart) * size + px) * 4
        data[index] = ao
        data[index + 1] = Math.min(1, Math.max(0, 0.5 + texelCurvature * 0.5))
        data[index + 2] = thickness
        data[index + 3] = 1
      }
    }

    processed++
    if (onProgress && processed % reportEvery === 0) onProgress(processed / triangleCount)
  }

  onProgress?.(1)
  return { rowStart, rowEnd, data }
}

function traceOcclusion(
  bvh: Bvh,
  ox: number, oy: number, oz: number,
  nx: number, ny: number, nz: number,
  rays: number, maxDistance: number, bias: number,
  px: number, py: number,
): number {
  if (rays <= 0) return 1
  const [tx, ty, tz] = perpendicular(nx, ny, nz)
  const bx = ny * tz - nz * ty
  const by = nz * tx - nx * tz
  const bz = nx * ty - ny * tx
  // Per-texel rotation decorrelates the stratified pattern between neighbours,
  // so residual error looks like fine noise rather than a visible grid.
  const rotation = ((px * 0.7548776662 + py * 0.5698402909) % 1) * Math.PI * 2

  let open = 0
  for (let i = 0; i < rays; i++) {
    const u1 = (i + 0.5) / rays
    const phi = radicalInverse(i) * Math.PI * 2 + rotation
    const r = Math.sqrt(u1)
    const lx = r * Math.cos(phi)
    const ly = r * Math.sin(phi)
    const lz = Math.sqrt(Math.max(0, 1 - u1))

    const dx = tx * lx + bx * ly + nx * lz
    const dy = ty * lx + by * ly + ny * lz
    const dz = tz * lx + bz * ly + nz * lz
    if (!bvh.occludes(ox, oy, oz, dx, dy, dz, bias, maxDistance)) open++
  }
  return open / rays
}

function traceThickness(
  bvh: Bvh,
  ox: number, oy: number, oz: number,
  nx: number, ny: number, nz: number,
  rays: number, maxDistance: number, bias: number,
  px: number, py: number,
): number {
  if (rays <= 0) return 0.5
  const [tx, ty, tz] = perpendicular(nx, ny, nz)
  const bx = ny * tz - nz * ty
  const by = nz * tx - nx * tz
  const bz = nx * ty - ny * tx
  const rotation = ((px * 0.3819660113 + py * 0.6180339887) % 1) * Math.PI * 2

  let total = 0
  for (let i = 0; i < rays; i++) {
    const u1 = (i + 0.5) / rays
    const phi = radicalInverse(i) * Math.PI * 2 + rotation
    const r = Math.sqrt(u1)
    const lx = r * Math.cos(phi)
    const ly = r * Math.sin(phi)
    const lz = Math.sqrt(Math.max(0, 1 - u1))

    const dx = tx * lx + bx * ly + nx * lz
    const dy = ty * lx + by * ly + ny * lz
    const dz = tz * lx + bz * ly + nz * lz
    const hit = bvh.raycast(ox, oy, oz, dx, dy, dz, bias, maxDistance)
    // A ray that escapes means there is nothing on the far side within range,
    // which reads as "as thick as we can measure".
    total += hit < 0 ? maxDistance : hit
  }
  return Math.min(1, total / rays / maxDistance)
}
