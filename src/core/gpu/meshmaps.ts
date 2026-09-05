/**
 * Mesh maps: geometry precomputed into UV space.
 *
 * Baking exists so a generator can ask "how exposed is this point" without
 * raytracing the mesh every frame. We split it in two, because the two halves
 * have wildly different costs:
 *
 *  - The *geometry* maps (position, normal, tangent, island coverage) are a
 *    single GPU pass that rasterises the mesh into its own UV layout. They are
 *    effectively free and are rebuilt whenever the mesh changes.
 *  - The *ray* maps (AO, curvature, thickness) are a fullscreen gather over
 *    those geometry maps, so they share the same UV convention and coverage.
 *
 * Everything downstream reads them through `MeshMapNodes`, which supplies
 * neutral constants for anything not baked yet - so every graph still compiles
 * and renders on a fresh, unbaked project.
 */

import {
  NearestFilter,
  RGBAFormat,
  RedFormat,
  RenderTarget,
  Vector3,
} from 'three/webgpu'
import { CHANNEL_TARGET_OPTIONS } from './targets'
import type { Texture } from 'three/webgpu'
import { cross, float, length, texture, uniform, vec3 } from 'three/tsl'
import type { MeshMapNodes } from '../procedural/material'
import type { V2, V3 } from './nodes'
export const GEOMETRY_MAP_NAMES = ['geomPosition', 'geomNormal', 'geomTangent'] as const

/** @deprecated CPU baker payload; GPU bake writes a render target instead. */
export interface RayMapData {
  resolution: number
  /** r = ao, g = curvature, b = thickness, a = coverage. */
  data: Float32Array
}

export const RAY_MAP_NAME = 'rayMaps'
export const ID_MAP_NAME = 'idMap'

export function createRayTarget(resolution: number, name = RAY_MAP_NAME): RenderTarget {
  const rt = new RenderTarget(resolution, resolution, { ...CHANNEL_TARGET_OPTIONS, format: RGBAFormat })
  rt.texture.name = name
  return rt
}

export class MeshMaps {
  /** MRT target holding the three geometry maps. */
  readonly geometry: RenderTarget
  /**
   * Which texels are actually inside a UV island, *before* dilation.
   *
   * The geometry maps get flooded outward so filtering never samples empty
   * gutter, which by design leaves their coverage channel reading 1
   * everywhere. Padding paint needs the opposite question - "is this texel real
   * surface?" - so the unflooded answer is kept separately.
   */
  readonly islandMask: RenderTarget
  /**
   * Per-texel source-mesh part index, nearest-sampled so IDs never blend.
   * Rasterised with the geometry maps; not dilated (a blended ID is nonsense).
   */
  readonly idMap: RenderTarget
  resolution: number

  #ray: RenderTarget
  #bboxMin = uniform(new Vector3(0, 0, 0))
  #bboxSize = uniform(new Vector3(1, 1, 1))
  #geometryBaked = false
  #rayBaked = false

  constructor(resolution: number) {
    this.resolution = resolution
    this.geometry = new RenderTarget(resolution, resolution, {
      ...CHANNEL_TARGET_OPTIONS,
      format: RGBAFormat,
      count: GEOMETRY_MAP_NAMES.length,
    })
    GEOMETRY_MAP_NAMES.forEach((name, i) => {
      this.geometry.textures[i].name = name
    })
    this.islandMask = new RenderTarget(resolution, resolution, { ...CHANNEL_TARGET_OPTIONS, format: RedFormat })
    this.islandMask.texture.name = 'islandMask'
    this.idMap = new RenderTarget(resolution, resolution, {
      ...CHANNEL_TARGET_OPTIONS,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    })
    this.idMap.texture.name = ID_MAP_NAME
    this.#ray = createRayTarget(resolution)
  }

  get ray(): RenderTarget {
    return this.#ray
  }

  get bbox(): { min: Vector3; max: Vector3 } {
    const min = this.#bboxMin.value.clone()
    const max = min.clone().add(this.#bboxSize.value)
    return { min, max }
  }

  get geometryBaked(): boolean {
    return this.#geometryBaked
  }

  get rayBaked(): boolean {
    return this.#rayBaked
  }

  markGeometryBaked(bboxMin: Vector3, bboxMax: Vector3): void {
    this.#geometryBaked = true
    this.#bboxMin.value.copy(bboxMin)
    // Guard against a degenerate axis (a flat plane) dividing by zero.
    this.#bboxSize.value.set(
      Math.max(1e-5, bboxMax.x - bboxMin.x),
      Math.max(1e-5, bboxMax.y - bboxMin.y),
      Math.max(1e-5, bboxMax.z - bboxMin.z),
    )
  }

  /**
   * Resizes the ray maps, *keeping the same texture object*.
   *
   * This used to dispose the target and build a new one, and that is a live
   * grenade: the compositor's shader graph holds a node bound to this exact
   * `Texture`, and it goes on holding it until the graph is rebuilt - which
   * only happens once the bake finishes. Disposing here destroys the GPU
   * resource out from under a graph that is still rendering the viewport every
   * frame. The next frame samples a destroyed texture, WebGPU rejects the
   * command buffer, and *everything else encoded alongside it dies with it* -
   * including the bake's own passes, which then write nothing at all.
   *
   * It only bites when the resolution actually changes, so the bake looks fine
   * until someone moves the slider and then produces an empty map with a
   * validation error. `setSize` keeps the object and lets three re-upload
   * behind it, which is what the geometry maps and island mask have always
   * done two lines up.
   */
  ensureRayTarget(resolution: number): void {
    if (this.#ray.width === resolution) return
    this.#ray.setSize(resolution, resolution)
    this.#rayBaked = false
  }

  markRayBaked(): void {
    this.#rayBaked = true
  }

  clearRayMaps(): void {
    this.#rayBaked = false
  }

  geometryTexture(index: number): Texture {
    return this.geometry.textures[index]
  }

  get rayTexture(): Texture | null {
    return this.#rayBaked ? this.#ray.texture : null
  }

  setSize(resolution: number): void {
    if (resolution === this.resolution) return
    this.resolution = resolution
    this.geometry.setSize(resolution, resolution)
    this.islandMask.setSize(resolution, resolution)
    this.idMap.setSize(resolution, resolution)
    this.ensureRayTarget(resolution)
    // The geometry maps no longer describe anything until they are re-rendered.
    this.#geometryBaked = false
    this.#rayBaked = false
  }

  /**
   * Builds the node bundle graphs read from. Sampled at an explicit UV so the
   * same maps can be read from a fullscreen compositor pass and from a
   * mesh-space paint pass alike.
   */
  nodes(uvNode: V2): MeshMapNodes {
    if (!this.#geometryBaked) return neutralMeshMaps()

    const posSample = texture(this.geometry.textures[0], uvNode)
    const nrmSample = texture(this.geometry.textures[1], uvNode)
    const tanSample = texture(this.geometry.textures[2], uvNode)

    const position = posSample.xyz
    const coverage = posSample.w

    // Every normalise here is guarded, and that is not defensive padding - it
    // is the difference between a working app and one that turns black.
    //
    // Two texels break the naive version. A texel outside any UV island holds
    // a zero normal and tangent, because nothing rasterised there. A texel at
    // a pole of a lat/long sphere holds a tangent parallel to its normal,
    // because that is what the UV layout does there. `normalize()` of a zero
    // vector is NaN, and NaN does not stay where it is born: the paint commit
    // evaluates the brush material over the *whole* texture and multiplies by
    // the stroke's coverage, but `0 * NaN` is NaN, not 0 - so a texel that
    // received no paint still gets NaN written into it. Dilation then averages
    // it outward a texel per iteration, the compositor propagates it, and the
    // model grows a black hole that spreads with every stroke.
    const normal = safeNormalize(nrmSample.xyz, vec3(0, 0, 1))
    // Handedness is +/-1 on real surface and 0 in the gutter, which would
    // collapse the bitangent; anything not negative means +1.
    const handedness = nrmSample.w.lessThan(0).select(float(-1), float(1))
    // Re-orthogonalise: interpolating and filtering tangents drifts them off
    // the surface, and a skewed frame shows up as tilted normal-mapped detail.
    const projected = tanSample.xyz.sub(normal.mul(normal.dot(tanSample.xyz)))
    const orthoTangent = safeNormalize(projected, perpendicularTo(normal))
    const bitangent = cross(normal, orthoTangent).mul(handedness)

    const ray = this.#rayBaked ? texture(this.#ray.texture, uvNode) : null

    return {
      position,
      worldPosition: position.mul(this.#bboxSize).add(this.#bboxMin),
      normal,
      tangent: orthoTangent,
      bitangent,
      ao: ray ? ray.x : float(1),
      curvature: ray ? ray.y : float(0.5),
      thickness: ray ? ray.z : float(0.5),
      coverage,
      island: texture(this.islandMask.texture, uvNode).x,
      partId: texture(this.idMap.texture, uvNode).x,
      baked: ray !== null,
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.islandMask.dispose()
    this.idMap.dispose()
    this.#ray.dispose()
    this.#rayBaked = false
  }
}

/**
 * `normalize()` that returns `fallback` instead of NaN for a zero-length
 * vector. The length test is the whole point - `normalize()` alone cannot
 * express it, and a NaN here is permanent once it reaches a paint buffer.
 */
function safeNormalize(v: V3, fallback: V3): V3 {
  const len = length(v)
  return len.greaterThan(float(1e-5)).select(v.div(len), fallback) as V3
}

/**
 * Any unit vector perpendicular to `normal`. Used where the baked tangent is
 * useless - at a lat/long sphere's poles it points straight along the normal,
 * so Gram-Schmidt leaves nothing to normalise. Picking the axis the normal is
 * least aligned with keeps the cross product well away from zero.
 */
function perpendicularTo(normal: V3): V3 {
  const helper = normal.z.abs().lessThan(float(0.99)).select(vec3(0, 0, 1), vec3(1, 0, 0)) as V3
  const t = cross(helper, normal)
  return t.div(length(t)) as V3
}

/** Fallbacks used before anything has been baked. */
export function neutralMeshMaps(): MeshMapNodes {
  return {
    position: vec3(0.5, 0.5, 0.5),
    worldPosition: vec3(0, 0, 0),
    normal: vec3(0, 0, 1),
    tangent: vec3(1, 0, 0),
    bitangent: vec3(0, 1, 0),
    ao: float(1),
    curvature: float(0.5),
    thickness: float(0.5),
    coverage: float(1),
    island: float(1),
    partId: float(0),
    baked: false,
  }
}
