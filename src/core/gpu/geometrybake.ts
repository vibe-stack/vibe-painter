/**
 * The geometry half of baking: position, normal, tangent frame and island
 * coverage, rasterised straight into UV space on the GPU.
 *
 * This is cheap enough to redo whenever the mesh changes, and everything else
 * depends on it - triplanar projection needs world position, generators need
 * the normal, painting needs both, and dilation needs the coverage mask to
 * know which texels are real.
 */

import { MeshBasicNodeMaterial, NoBlending, NodeMaterial, QuadMesh, Vector3 } from 'three/webgpu'
import type { BufferGeometry, Renderer } from 'three/webgpu'
import {
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
import { GEOMETRY_MAP_NAMES, MeshMaps } from './meshmaps'
import { UVSpacePass, renderQuad, uvClipPosition } from './uvspace'

export class GeometryBaker {
  #pass = new UVSpacePass()
  #quad = new QuadMesh()
  #material: NodeMaterial | null = null
  #maskMaterial: MeshBasicNodeMaterial | null = null
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

    material.fragmentNode = mrt({
      [GEOMETRY_MAP_NAMES[0]]: vec4(normalised, 1),
      // Handedness rides in .w so the bitangent can be reconstructed with a
      // single cross product, matching three's own convention
      // (bitangent = cross(normal, tangent) * tangent.w).
      [GEOMETRY_MAP_NAMES[1]]: vec4(worldNormal, tangentGeometry.w),
      [GEOMETRY_MAP_NAMES[2]]: vec4(worldTangent, 0),
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
    maps.markGeometryBaked(min, max)
    return { min, max }
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
    this.#pass.dispose()
  }
}
