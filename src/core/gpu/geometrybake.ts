/**
 * The geometry half of baking: position, normal, tangent frame and island
 * coverage, rasterised straight into UV space on the GPU.
 *
 * This is cheap enough to redo whenever the mesh changes, and everything else
 * depends on it - triplanar projection needs world position, generators need
 * the normal, painting needs both, and dilation needs the coverage mask to
 * know which texels are real.
 */

import { NoBlending, NodeMaterial, Vector3 } from 'three/webgpu'
import type { BufferGeometry, Renderer } from 'three/webgpu'
import { mrt, normalWorld, positionWorld, tangentGeometry, tangentWorld, uniform, vec4 } from 'three/tsl'
import { GEOMETRY_MAP_NAMES, MeshMaps } from './meshmaps'
import { UVSpacePass, uvClipPosition } from './uvspace'

export class GeometryBaker {
  #pass = new UVSpacePass()
  #material: NodeMaterial | null = null
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
    material.fragmentNode = mrt({
      [GEOMETRY_MAP_NAMES[0]]: vec4(normalised, 1),
      // Handedness rides in .w so the bitangent can be reconstructed with a
      // single cross product, matching three's own convention
      // (bitangent = cross(normal, tangent) * tangent.w).
      [GEOMETRY_MAP_NAMES[1]]: vec4(normalWorld, tangentGeometry.w),
      [GEOMETRY_MAP_NAMES[2]]: vec4(tangentWorld, 0),
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
    maps.markGeometryBaked(min, max)
    return { min, max }
  }

  dispose(): void {
    this.#material?.dispose()
    this.#material = null
    this.#pass.dispose()
  }
}
