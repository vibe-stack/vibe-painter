/**
 * The geometry half of baking: position, normal, tangent frame and island
 * coverage, rasterised straight into UV space on the GPU.
 *
 * This is cheap enough to redo whenever the mesh changes, and everything else
 * depends on it - triplanar projection needs world position, generators need
 * the normal, painting needs both, and dilation needs the coverage mask to
 * know which texels are real.
 */

import { BufferAttribute, MeshBasicNodeMaterial, NoBlending, NodeMaterial, Vector3 } from 'three/webgpu'
import type { BufferGeometry, Renderer } from 'three/webgpu'
import {
  attribute,
  floor,
  mrt,
  modelNormalMatrix,
  modelWorldMatrix,
  normalLocal,
  normalize,
  positionWorld,
  tangentGeometry,
  tangentLocal,
  uniform,
  vec4,
} from 'three/tsl'
import { PART_ID_ATTRIBUTE } from '../mesh/parts'
import { GEOMETRY_MAP_NAMES, MeshMaps, POSITION_SPLIT } from './meshmaps'
import type { F } from './nodes'
import { UVSpacePass, uvClipPosition } from './uvspace'

export class GeometryBaker {
  #pass = new UVSpacePass()
  #material: NodeMaterial | null = null
  #maskMaterial: MeshBasicNodeMaterial | null = null
  #idMaterial: NodeMaterial | null = null
  #bboxMin = uniform(new Vector3(0, 0, 0))
  #bboxSize = uniform(new Vector3(1, 1, 1))

  #buildMaterial(): NodeMaterial {
    if (this.#material) return this.#material
    const material = new NodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    // Normalising position into the bounding box gives generators a stable
    // 0..1 space regardless of mesh scale, and keeps half-float precision
    // useful across the whole model.
    const normalised = positionWorld.sub(this.#bboxMin).div(this.#bboxSize)

    // Transform the normal by hand rather than using `normalWorld`.
    //
    // `normalWorld` is face-direction corrected: three flips it for back-facing
    // fragments so that double-sided surfaces light correctly. That is right
    // for a camera render and completely wrong here, because this pass
    // rasterises the mesh into its *UV layout* - "front facing" then means
    // "wound anticlockwise in UV space", which has nothing to do with the
    // geometry. The result is a normal map inverted on whichever islands happen
    // to be wound the other way, per triangle. Everything that reads this map
    // then misbehaves in a way that follows the UV layout instead of the model.
    const worldNormal = normalize(modelNormalMatrix.mul(normalLocal))
    const worldTangent = normalize(modelWorldMatrix.mul(vec4(tangentLocal, 0)).xyz)

    // The bits the half-float position map cannot hold.
    //
    // `normalised` is a float32 varying here, so it carries the full precision
    // of the rasterised triangle; the attachment it lands in does not. Writing
    // the fractional part of a 256x magnification into a second attachment
    // keeps that precision available to anything that reads both, and one
    // `round()` on the way back recovers which period a texel belongs to. See
    // `MeshMaps.nodes()`.
    const scaledPosition = normalised.mul(POSITION_SPLIT)
    const finePosition = scaledPosition.sub(floor(scaledPosition))

    material.fragmentNode = mrt({
      [GEOMETRY_MAP_NAMES[0]]: vec4(normalised, 1),
      // Handedness rides in .w so the bitangent can be reconstructed with a
      // single cross product, matching three's own convention
      // (bitangent = cross(normal, tangent) * tangent.w).
      [GEOMETRY_MAP_NAMES[1]]: vec4(worldNormal, tangentGeometry.w),
      [GEOMETRY_MAP_NAMES[2]]: vec4(worldTangent, 0),
      [GEOMETRY_MAP_NAMES[3]]: vec4(finePosition, 1),
    })
    this.#material = material
    return material
  }

  /**
   * Rasterises the geometry maps. Returns the world bounding box actually used,
   * which the caller stores so shader-side denormalisation matches.
   */
  bake(renderer: Renderer, geometry: BufferGeometry, maps: MeshMaps): { min: Vector3; max: Vector3 } {
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const min = box.min.clone()
    const max = box.max.clone()

    this.#bboxMin.value.copy(min)
    this.#bboxSize.value.set(
      Math.max(1e-5, max.x - min.x),
      Math.max(1e-5, max.y - min.y),
      Math.max(1e-5, max.z - min.z),
    )

    // True island coverage from the mesh UVs the viewport actually samples.
    // Must not use the expanded raster: that marks neighbour-chart overlap as
    // "island", and composite padding then refuses to fill the gray holes.
    this.#rasteriseIslandMask(renderer, geometry, maps)
    // One texel of silhouette growth covers the bilinear neighbourhood
    // without reaching the next packed chart (atlas gutter is several texels).
    // Four texels stole interiors of neighbouring islands and wrote the
    // default fill into the middle of a part.
    const expanded = expandTriangleUVs(geometry, maps.resolution, 1)
    this.#pass.render(renderer, expanded, this.#buildMaterial(), maps.geometry, true)
    this.#bakeIdMap(renderer, expanded, maps)
    if (expanded !== geometry) expanded.dispose()
    maps.markGeometryBaked(min, max)
    return { min, max }
  }

  #buildIdMaterial(): NodeMaterial {
    if (this.#idMaterial) return this.#idMaterial
    const material = new NodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const id = attribute(PART_ID_ATTRIBUTE, 'float') as unknown as F
    // Alpha is "this texel was covered", not the ID: part 0 is a real part,
    // so a cleared (0,0,0,0) texel and a part-0 texel are distinguished only
    // by alpha. Dilation copies IDs into the empty gutter from this flag.
    material.fragmentNode = vec4(id, 0, 0, 1)
    this.#idMaterial = material
    return material
  }

  #bakeIdMap(renderer: Renderer, geometry: BufferGeometry, maps: MeshMaps): void {
    this.#pass.render(renderer, geometry, this.#buildIdMaterial(), maps.idMap, true)
    this.#pass.render(renderer, geometry, this.#buildIdMaterial(), maps.idMap, false)
  }

  #buildCoverageMaterial(): MeshBasicNodeMaterial {
    if (this.#maskMaterial) return this.#maskMaterial
    const material = new MeshBasicNodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    material.fragmentNode = vec4(1, 1, 1, 1)
    this.#maskMaterial = material
    return material
  }

  #rasteriseIslandMask(renderer: Renderer, geometry: BufferGeometry, maps: MeshMaps): void {
    const material = this.#buildCoverageMaterial()
    this.#pass.render(renderer, geometry, material, maps.islandMask, true)
    this.#pass.render(renderer, geometry, material, maps.islandMask, false)
  }

  dispose(): void {
    this.#material?.dispose()
    this.#material = null
    this.#maskMaterial?.dispose()
    this.#maskMaterial = null
    this.#idMaterial?.dispose()
    this.#idMaterial = null
    this.#pass.dispose()
  }
}

/**
 * Grows only the *silhouette* of each UV island (and any UV edge that still
 * joins two source-mesh parts) so bilinear taps at seam vertices land on
 * baked texels.
 *
 * Expanding every triangle (centroid or edge-normal) tears the island apart:
 * a shared internal edge is pushed both ways, neighbouring triangles write
 * extrapolated normals into each other's interiors, and world-normal / paint
 * both go wrong in the middle of a part. Internal same-part edges stay put.
 */
function expandTriangleUVs(geometry: BufferGeometry, resolution: number, texels: number): BufferGeometry {
  const source = geometry.getIndex() ? geometry.toNonIndexed() : geometry.clone()
  const uv = source.getAttribute('uv')
  if (!uv || uv.count < 3) return source
  const pad = texels / Math.max(1, resolution)
  const maxMiter = pad * 6
  const triCount = Math.floor(uv.count / 3)
  const uses = new Map<string, number[]>()
  const partAttr = source.getAttribute(PART_ID_ATTRIBUTE)
  const partOf = (t: number) => (partAttr ? Math.round(partAttr.getX(t * 3)) : 0)

  const keyOf = (ax: number, ay: number, bx: number, by: number): string => {
    const a = `${ax.toFixed(5)},${ay.toFixed(5)}`
    const b = `${bx.toFixed(5)},${by.toFixed(5)}`
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  for (let t = 0; t < triCount; t++) {
    const i = t * 3
    const u0 = uv.getX(i), v0 = uv.getY(i)
    const u1 = uv.getX(i + 1), v1 = uv.getY(i + 1)
    const u2 = uv.getX(i + 2), v2 = uv.getY(i + 2)
    const id = partOf(t)
    for (const key of [keyOf(u0, v0, u1, v1), keyOf(u1, v1, u2, v2), keyOf(u2, v2, u0, v0)]) {
      const list = uses.get(key)
      if (list) list.push(id)
      else uses.set(key, [id])
    }
  }

  const isBorder = (key: string): boolean => {
    const ids = uses.get(key) ?? []
    if (ids.length <= 1) return true
    return ids.some((id) => id !== ids[0])
  }

  const outward = (ax: number, ay: number, bx: number, by: number, sign: number): [number, number] => {
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    if (len < 1e-12) return [0, 0]
    return [(dy / len) * sign, (-dx / len) * sign]
  }

  const out = new Float32Array(uv.count * 2)
  for (let t = 0; t < triCount; t++) {
    const i = t * 3
    const u0 = uv.getX(i), v0 = uv.getY(i)
    const u1 = uv.getX(i + 1), v1 = uv.getY(i + 1)
    const u2 = uv.getX(i + 2), v2 = uv.getY(i + 2)
    const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)
    const sign = area >= 0 ? 1 : -1
    const edges: { a: number; b: number; n: [number, number]; border: boolean }[] = [
      { a: 0, b: 1, n: outward(u0, v0, u1, v1, sign), border: isBorder(keyOf(u0, v0, u1, v1)) },
      { a: 1, b: 2, n: outward(u1, v1, u2, v2, sign), border: isBorder(keyOf(u1, v1, u2, v2)) },
      { a: 2, b: 0, n: outward(u2, v2, u0, v0, sign), border: isBorder(keyOf(u2, v2, u0, v0)) },
    ]
    const us = [u0, u1, u2]
    const vs = [v0, v1, v2]
    const ox = [0, 0, 0]
    const oy = [0, 0, 0]
    for (const edge of edges) {
      if (!edge.border) continue
      ox[edge.a] += edge.n[0] * pad
      oy[edge.a] += edge.n[1] * pad
      ox[edge.b] += edge.n[0] * pad
      oy[edge.b] += edge.n[1] * pad
    }
    for (let k = 0; k < 3; k++) {
      let x = ox[k]
      let y = oy[k]
      const miter = Math.hypot(x, y)
      if (miter > maxMiter && miter > 1e-12) {
        const s = maxMiter / miter
        x *= s
        y *= s
      }
      const o = (i + k) * 2
      out[o] = us[k] + x
      out[o + 1] = vs[k] + y
    }
  }
  source.setAttribute('uv', new BufferAttribute(out, 2))
  return source
}
