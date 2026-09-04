/**
 * Per-vertex curvature, measured on the mesh's own connectivity.
 *
 * The obvious GPU version - rasterise into UV space and take `dFdx`/`dFdy` of
 * the interpolated normal - looks right and is not. Varyings interpolate
 * linearly, so a screen-space derivative is *constant across a triangle* and a
 * 2x2 quad never straddles two primitives. The result is a faceted, per-face
 * value that misses the one thing curvature is for: the crease *between* two
 * triangles. It also measures along the chart's u and v axes, so rotating a UV
 * island changes the answer.
 *
 * So curvature is measured here instead, on the connected mesh, before anything
 * touches UV space. Each neighbour gives the normal curvature of the arc
 * through it, which for a small offset `d` off the tangent plane at `v` is
 *
 *     k(v, u) = -2 * dot(u - v, N(v)) / |u - v|^2
 *
 * and their mean is the discrete mean curvature at `v`. Neighbours below the
 * tangent plane (a ridge) give a positive value, above it (a cavity) a negative
 * one.
 *
 * The `/|d|^2` rather than `/|d|` is what makes this a curvature - a radius
 * reciprocal - instead of a tessellation measurement. Dividing only once leaves
 * the answer weighted by edge length, so a quad grid with long tube edges and
 * short ring edges reports the long direction's curvature and can call a saddle
 * convex. It also matters for what these maps are *for*: a small sharp fillet
 * and a broad gentle dome sit off the tangent plane by similar amounts, and
 * only the true curvature tells them apart - which is the difference between
 * edge wear that finds the chamfers and edge wear that finds everything.
 *
 * Two details make it work on real assets rather than on a test sphere:
 *
 *  - **Welding.** glTF splits vertices at every UV seam and every hard edge, so
 *    index-based connectivity is severed exactly where curvature is most
 *    interesting. Positions are welded first and the estimate is computed on
 *    the welded graph, then scattered back - otherwise every seam bakes as a
 *    flat grey line.
 *  - **Its own normals.** Split vertices also carry split normals. The welded
 *    graph gets area-weighted face normals, which is the surface's actual
 *    tangent plane rather than one side of a hard edge.
 */

import { BufferAttribute } from 'three/webgpu'
import type { BufferGeometry } from 'three/webgpu'
import { attributeToFloat32 } from './attributes'

/**
 * Vertex attribute the UV-space bake reads. Signed, and rescaled so that the
 * mesh's own 90th percentile of |curvature| lands at 1.
 */
export const CURVATURE_ATTRIBUTE = 'bakeCurvature'

/**
 * Ensures `geometry` carries a `bakeCurvature` attribute for this radius.
 *
 * Cached on the geometry: the estimate depends only on the mesh and the radius,
 * and re-welding a dense mesh on every bake is the slowest thing in the bake.
 */
export function ensureVertexCurvature(geometry: BufferGeometry, radius: number): void {
  const smoothing = smoothingIterations(radius)
  const cached = geometry.userData.bakeCurvatureSmoothing as number | undefined
  if (cached === smoothing && geometry.getAttribute(CURVATURE_ATTRIBUTE)) return

  const values = computeVertexCurvature(geometry, smoothing)
  geometry.setAttribute(CURVATURE_ATTRIBUTE, new BufferAttribute(values, 1))
  geometry.userData.bakeCurvatureSmoothing = smoothing
}

/**
 * The radius slider in world-ish terms: how many rings of neighbours the
 * estimate is averaged over. Zero keeps the raw per-vertex value, which is the
 * finest crease the topology can express.
 */
function smoothingIterations(radius: number): number {
  return Math.max(0, Math.min(24, Math.round(radius * 3)))
}

function computeVertexCurvature(geometry: BufferGeometry, smoothing: number): Float32Array {
  const positionAttr = geometry.getAttribute('position')
  if (!positionAttr) throw new Error('Curvature needs a position attribute')

  const positions = attributeToFloat32(positionAttr, 3)
  const vertexCount = positionAttr.count
  const index = geometry.getIndex()
  const triangleIndices: ArrayLike<number> = index
    ? (index.array as ArrayLike<number>)
    : Uint32Array.from({ length: vertexCount }, (_, i) => i)

  const { remap, weldedCount } = weldByPosition(positions, vertexCount)
  const weldedPositions = collapsePositions(positions, remap, vertexCount, weldedCount)
  const weldedNormals = faceWeightedNormals(weldedPositions, triangleIndices, remap, weldedCount)
  const adjacency = buildAdjacency(triangleIndices, remap, weldedCount)

  let curvature = tangentPlaneOffset(weldedPositions, weldedNormals, adjacency, weldedCount)
  for (let i = 0; i < smoothing; i++) {
    curvature = umbrellaSmooth(curvature, adjacency, weldedCount)
  }

  normaliseInPlace(curvature)

  const out = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) out[i] = curvature[remap[i]]
  return out
}

// -- welding ----------------------------------------------------------------

interface Weld {
  /** Original vertex -> welded vertex. */
  remap: Int32Array
  weldedCount: number
}

/**
 * Merges vertices that share a position.
 *
 * The grid quantisation has the usual failure mode - two points a hair apart
 * either side of a cell boundary stay separate - but the case that matters here
 * is exporter-duplicated seam vertices, which are bit-identical copies and
 * always land in the same cell.
 */
function weldByPosition(positions: Float32Array, count: number): Weld {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const inverseCell = 1 / (diagonal * 1e-5)

  const cells = new Map<string, number>()
  const remap = new Int32Array(count)
  let next = 0
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(positions[i * 3] * inverseCell)},`
      + `${Math.round(positions[i * 3 + 1] * inverseCell)},`
      + `${Math.round(positions[i * 3 + 2] * inverseCell)}`
    let id = cells.get(key)
    if (id === undefined) {
      id = next++
      cells.set(key, id)
    }
    remap[i] = id
  }
  return { remap, weldedCount: next }
}

function collapsePositions(
  positions: Float32Array,
  remap: Int32Array,
  count: number,
  weldedCount: number,
): Float32Array {
  const out = new Float32Array(weldedCount * 3)
  const filled = new Uint8Array(weldedCount)
  for (let i = 0; i < count; i++) {
    const w = remap[i]
    if (filled[w]) continue
    filled[w] = 1
    out[w * 3] = positions[i * 3]
    out[w * 3 + 1] = positions[i * 3 + 1]
    out[w * 3 + 2] = positions[i * 3 + 2]
  }
  return out
}

/**
 * Area-weighted normals on the welded graph.
 *
 * The cross product of two triangle edges has twice the triangle's area as its
 * length, so summing them unnormalised weights each face by area for free -
 * which is what keeps a fan of slivers from dominating the vertex it fans
 * around.
 */
function faceWeightedNormals(
  positions: Float32Array,
  indices: ArrayLike<number>,
  remap: Int32Array,
  weldedCount: number,
): Float32Array {
  const normals = new Float32Array(weldedCount * 3)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]]
    if (a === b || b === c || a === c) continue

    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
    const e1x = positions[b * 3] - ax, e1y = positions[b * 3 + 1] - ay, e1z = positions[b * 3 + 2] - az
    const e2x = positions[c * 3] - ax, e2y = positions[c * 3 + 1] - ay, e2z = positions[c * 3 + 2] - az
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x

    for (const v of [a, b, c]) {
      normals[v * 3] += nx
      normals[v * 3 + 1] += ny
      normals[v * 3 + 2] += nz
    }
  }

  for (let v = 0; v < weldedCount; v++) {
    const x = normals[v * 3], y = normals[v * 3 + 1], z = normals[v * 3 + 2]
    const length = Math.hypot(x, y, z)
    if (length < 1e-20) continue
    normals[v * 3] = x / length
    normals[v * 3 + 1] = y / length
    normals[v * 3 + 2] = z / length
  }
  return normals
}

// -- adjacency --------------------------------------------------------------

interface Adjacency {
  /** Start of each vertex's neighbour slice in `neighbours`. */
  offsets: Uint32Array
  neighbours: Uint32Array
}

/**
 * Neighbour lists in CSR form, deduplicated.
 *
 * Interior edges are visited by two triangles and boundary edges by one;
 * without the dedupe pass the interior would be weighted twice as heavily as
 * the border, which shows up as a bright rim around every open edge.
 */
function buildAdjacency(indices: ArrayLike<number>, remap: Int32Array, weldedCount: number): Adjacency {
  const CORNERS: [number, number][] = [[0, 1], [1, 2], [2, 0], [1, 0], [2, 1], [0, 2]]

  const counts = new Uint32Array(weldedCount + 1)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (const [from, to] of CORNERS) {
      const a = remap[indices[t + from]], b = remap[indices[t + to]]
      if (a !== b) counts[a]++
    }
  }

  const offsets = new Uint32Array(weldedCount + 1)
  for (let v = 0; v < weldedCount; v++) offsets[v + 1] = offsets[v] + counts[v]
  const raw = new Uint32Array(offsets[weldedCount])
  const cursor = offsets.slice(0, weldedCount)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (const [from, to] of CORNERS) {
      const a = remap[indices[t + from]], b = remap[indices[t + to]]
      if (a !== b) raw[cursor[a]++] = b
    }
  }

  const compactOffsets = new Uint32Array(weldedCount + 1)
  const compact = new Uint32Array(raw.length)
  let write = 0
  for (let v = 0; v < weldedCount; v++) {
    compactOffsets[v] = write
    const slice = raw.subarray(offsets[v], offsets[v + 1])
    slice.sort()
    let previous = -1
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === previous) continue
      previous = slice[i]
      compact[write++] = previous
    }
  }
  compactOffsets[weldedCount] = write
  return { offsets: compactOffsets, neighbours: compact.subarray(0, write) }
}

// -- the estimate -----------------------------------------------------------

function tangentPlaneOffset(
  positions: Float32Array,
  normals: Float32Array,
  adjacency: Adjacency,
  weldedCount: number,
): Float32Array {
  const out = new Float32Array(weldedCount)
  for (let v = 0; v < weldedCount; v++) {
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2]
    const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2]
    let sum = 0
    let used = 0
    for (let i = adjacency.offsets[v]; i < adjacency.offsets[v + 1]; i++) {
      const u = adjacency.neighbours[i]
      const dx = positions[u * 3] - px, dy = positions[u * 3 + 1] - py, dz = positions[u * 3 + 2] - pz
      const lengthSq = dx * dx + dy * dy + dz * dz
      if (lengthSq < 1e-24) continue
      sum -= (2 * (dx * nx + dy * ny + dz * nz)) / lengthSq
      used++
    }
    out[v] = used > 0 ? sum / used : 0
  }
  return out
}

/** One umbrella pass: half the vertex's own value, half its neighbourhood's. */
function umbrellaSmooth(values: Float32Array, adjacency: Adjacency, weldedCount: number): Float32Array {
  const out = new Float32Array(weldedCount)
  for (let v = 0; v < weldedCount; v++) {
    let sum = 0
    let used = 0
    for (let i = adjacency.offsets[v]; i < adjacency.offsets[v + 1]; i++) {
      sum += values[adjacency.neighbours[i]]
      used++
    }
    out[v] = used > 0 ? values[v] * 0.5 + (sum / used) * 0.5 : values[v]
  }
  return out
}

/**
 * Rescales against the mesh's own distribution.
 *
 * The raw estimate is dimensionless but its *range* is entirely a property of
 * the tessellation: a densely subdivided smooth model barely leaves the tangent
 * plane, a game-res hard-surface model swings most of the way to 1. Dividing by
 * a high percentile of the mesh's own magnitudes makes the contrast slider mean
 * the same thing everywhere. The percentile rather than the maximum, because
 * one pinched vertex should not flatten the whole map.
 */
function normaliseInPlace(values: Float32Array): void {
  const stride = Math.max(1, Math.floor(values.length / 20000))
  const sample: number[] = []
  for (let i = 0; i < values.length; i += stride) sample.push(Math.abs(values[i]))
  if (sample.length === 0) return
  sample.sort((a, b) => a - b)

  const scale = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.9))]
  if (!(scale > 1e-6)) return

  const inverse = 1 / scale
  for (let i = 0; i < values.length; i++) {
    values[i] = Math.max(-8, Math.min(8, values[i] * inverse))
  }
}
