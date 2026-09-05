/**
 * Per-vertex tangent generation (Lengyel's method).
 *
 * We compute tangents on the CPU rather than deriving them in the shader on
 * purpose. Screen-space derivatives would work, but `dFdy` points the opposite
 * way in WGSL and GLSL, so a derivative-based frame flips handedness depending
 * on which backend the renderer picked. A vertex attribute is unambiguous, and
 * it matches the convention normal maps are authored and exported against.
 */

import { BufferAttribute, Vector3 } from 'three/webgpu'
import type { BufferGeometry } from 'three/webgpu'
import { ensurePartIdAttribute } from './parts'
import { isolatePartUvIslands } from './unwrap'

export function computeTangents(geometry: BufferGeometry): void {
  const positionAttr = geometry.getAttribute('position')
  const normalAttr = geometry.getAttribute('normal')
  const uvAttr = geometry.getAttribute('uv')
  if (!positionAttr || !normalAttr || !uvAttr) {
    throw new Error('computeTangents requires position, normal and uv attributes')
  }

  const vertexCount = positionAttr.count
  const index = geometry.getIndex()
  const indices = index ? index.array : null
  const triangleCount = (indices ? indices.length : vertexCount) / 3

  const tan1 = new Float32Array(vertexCount * 3)
  const tan2 = new Float32Array(vertexCount * 3)

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices ? Number(indices[t * 3]) : t * 3
    const i1 = indices ? Number(indices[t * 3 + 1]) : t * 3 + 1
    const i2 = indices ? Number(indices[t * 3 + 2]) : t * 3 + 2

    const x0 = positionAttr.getX(i0), y0 = positionAttr.getY(i0), z0 = positionAttr.getZ(i0)
    const x1 = positionAttr.getX(i1), y1 = positionAttr.getY(i1), z1 = positionAttr.getZ(i1)
    const x2 = positionAttr.getX(i2), y2 = positionAttr.getY(i2), z2 = positionAttr.getZ(i2)

    const u0 = uvAttr.getX(i0), v0 = uvAttr.getY(i0)
    const u1 = uvAttr.getX(i1), v1 = uvAttr.getY(i1)
    const u2 = uvAttr.getX(i2), v2 = uvAttr.getY(i2)

    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0
    const du1 = u1 - u0, dv1 = v1 - v0
    const du2 = u2 - u0, dv2 = v2 - v0

    const det = du1 * dv2 - du2 * dv1
    // A degenerate UV triangle has no tangent to contribute; skip rather than
    // poisoning its vertices with infinities.
    if (det === 0 || !Number.isFinite(det)) continue
    const r = 1 / det

    const sx = (dv2 * e1x - dv1 * e2x) * r
    const sy = (dv2 * e1y - dv1 * e2y) * r
    const sz = (dv2 * e1z - dv1 * e2z) * r
    const tx = (du1 * e2x - du2 * e1x) * r
    const ty = (du1 * e2y - du2 * e1y) * r
    const tz = (du1 * e2z - du2 * e1z) * r

    for (const i of [i0, i1, i2]) {
      tan1[i * 3] += sx; tan1[i * 3 + 1] += sy; tan1[i * 3 + 2] += sz
      tan2[i * 3] += tx; tan2[i * 3 + 1] += ty; tan2[i * 3 + 2] += tz
    }
  }

  const out = new Float32Array(vertexCount * 4)
  const n = new Vector3()
  const t = new Vector3()
  const b = new Vector3()
  const tmp = new Vector3()

  for (let i = 0; i < vertexCount; i++) {
    n.set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i))
    t.set(tan1[i * 3], tan1[i * 3 + 1], tan1[i * 3 + 2])
    b.set(tan2[i * 3], tan2[i * 3 + 1], tan2[i * 3 + 2])

    if (t.lengthSq() < 1e-12) {
      // No usable UV gradient here: pick any vector perpendicular to the normal
      // so the frame stays orthonormal instead of collapsing.
      t.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0)
      t.sub(tmp.copy(n).multiplyScalar(n.dot(t)))
    } else {
      // Gram-Schmidt against the normal.
      t.sub(tmp.copy(n).multiplyScalar(n.dot(t)))
    }
    t.normalize()

    const handedness = tmp.copy(n).cross(t).dot(b) < 0 ? -1 : 1
    out[i * 4] = t.x
    out[i * 4 + 1] = t.y
    out[i * 4 + 2] = t.z
    out[i * 4 + 3] = handedness
  }

  geometry.setAttribute('tangent', new BufferAttribute(out, 4))
}

/** Ensures the geometry has everything the painter and baker need. */
export function prepareGeometry(geometry: BufferGeometry): BufferGeometry {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  if (!geometry.getAttribute('uv')) {
    throw new Error('Mesh has no UV coordinates. Painting and baking both work in UV space, so a UV layout is required.')
  }
  ensurePartIdAttribute(geometry)
  if (isolatePartUvIslands(geometry)) geometry.deleteAttribute('tangent')
  if (!geometry.getAttribute('tangent')) computeTangents(geometry)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
