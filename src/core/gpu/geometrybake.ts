/**
 * The geometry half of baking: position, normal, tangent frame and island
 * coverage, rasterised straight into UV space on the GPU.
 *
 * This is cheap enough to redo whenever the mesh changes, and everything else
 * depends on it - triplanar projection needs world position, generators need
 * the normal, painting needs both, and dilation needs the coverage mask to
 * know which texels are real.
 */

import { BufferAttribute, MeshBasicNodeMaterial, NoBlending, NodeMaterial, QuadMesh, Vector3 } from 'three/webgpu'
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
  texture,
  uniform,
  uv,
  vec4,
} from 'three/tsl'
import { PART_ID_ATTRIBUTE } from '../mesh/parts'
import { GEOMETRY_MAP_NAMES, MeshMaps, POSITION_SPLIT } from './meshmaps'
import type { F } from './nodes'
import { UVSpacePass, renderQuad, uvClipPosition } from './uvspace'

export class GeometryBaker {
  #pass = new UVSpacePass()
  #quad = new QuadMesh()
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

    this.#pass.render(renderer, geometry, this.#buildMaterial(), maps.geometry, true)
    // Snapshot which texels are real surface *before* dilation floods the
    // coverage channel outward. Paint padding needs this unflooded answer.
    this.#captureIslandMask(renderer, maps)
    this.#bakeIdMap(renderer, geometry, maps)
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
    // Expand each triangle in UV by a couple of texels so pixel centres on
    // island borders are actually covered. Standard rasterisation leaves those
    // empty, and a part mask then shows the layer underneath as a stepped seam.
    const expanded = expandTriangleUVs(geometry, maps.resolution, 2)
    this.#pass.render(renderer, expanded, this.#buildIdMaterial(), maps.idMap, true)
    // WebGPU skips the first draw of a new pipeline; a second draw without
    // clearing recovers the map if the first one was dropped.
    this.#pass.render(renderer, expanded, this.#buildIdMaterial(), maps.idMap, false)
    if (expanded !== geometry) expanded.dispose()
  }

  #captureIslandMask(renderer: Renderer, maps: MeshMaps): void {
    if (!this.#maskMaterial || this.#maskMaterial.userData.source !== maps.geometry.textures[0].id) {
      this.#maskMaterial?.dispose()
      const material = new MeshBasicNodeMaterial()
      material.depthTest = false
      material.depthWrite = false
      material.blending = NoBlending
      const coverage = texture(maps.geometry.textures[0], uv()).w
      material.fragmentNode = vec4(coverage, coverage, coverage, coverage)
      material.userData.source = maps.geometry.textures[0].id
      this.#maskMaterial = material
    }
    renderQuad(renderer, this.#quad, this.#maskMaterial, maps.islandMask)
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
 * Pushes each triangle's vertices away from its UV centroid so the rasteriser
 * covers the texel centres that sit on the island border. The painted mesh's
 * own UVs are not touched; this clone exists only for the ID pass.
 */
function expandTriangleUVs(geometry: BufferGeometry, resolution: number, texels: number): BufferGeometry {
  const source = geometry.getIndex() ? geometry.toNonIndexed() : geometry.clone()
  const uv = source.getAttribute('uv')
  if (!uv || uv.count < 3) return source
  const pad = texels / Math.max(1, resolution)
  const out = new Float32Array(uv.count * 2)
  for (let i = 0; i + 2 < uv.count; i += 3) {
    const u0 = uv.getX(i), v0 = uv.getY(i)
    const u1 = uv.getX(i + 1), v1 = uv.getY(i + 1)
    const u2 = uv.getX(i + 2), v2 = uv.getY(i + 2)
    const cu = (u0 + u1 + u2) / 3
    const cv = (v0 + v1 + v2) / 3
    const pts: [number, number][] = [[u0, v0], [u1, v1], [u2, v2]]
    for (let k = 0; k < 3; k++) {
      const du = pts[k][0] - cu
      const dv = pts[k][1] - cv
      const len = Math.hypot(du, dv)
      const o = (i + k) * 2
      if (len < 1e-12) {
        out[o] = pts[k][0]
        out[o + 1] = pts[k][1]
        continue
      }
      out[o] = pts[k][0] + (du / len) * pad
      out[o + 1] = pts[k][1] + (dv / len) * pad
    }
  }
  source.setAttribute('uv', new BufferAttribute(out, 2))
  return source
}
