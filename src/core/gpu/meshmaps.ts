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
 *  - The *ray* maps (AO, curvature, thickness) need a BVH traversal per texel.
 *    Those are baked on the CPU in a worker, at a lower resolution, on demand.
 *
 * Everything downstream reads them through `MeshMapNodes`, which supplies
 * neutral constants for anything not baked yet - so every graph still compiles
 * and renders on a fresh, unbaked project.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  RenderTarget,
  Vector3,
} from 'three/webgpu'
import type { Texture } from 'three/webgpu'
import { cross, float, normalize, texture, uniform, vec3 } from 'three/tsl'
import type { MeshMapNodes } from '../procedural/material'
import type { V2 } from './nodes'

export const GEOMETRY_MAP_NAMES = ['geomPosition', 'geomNormal', 'geomTangent'] as const

/** Ray-baked maps, packed into one RGBA texture. */
export interface RayMapData {
  resolution: number
  /** r = ao, g = curvature, b = thickness, a = coverage. */
  data: Float32Array
}

export class MeshMaps {
  /** MRT target holding the three geometry maps. */
  readonly geometry: RenderTarget
  resolution: number

  #rayTexture: DataTexture | null = null
  #bboxMin = uniform(new Vector3(0, 0, 0))
  #bboxSize = uniform(new Vector3(1, 1, 1))
  #geometryBaked = false

  constructor(resolution: number) {
    this.resolution = resolution
    this.geometry = new RenderTarget(resolution, resolution, {
      count: GEOMETRY_MAP_NAMES.length,
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      generateMipmaps: false,
      colorSpace: NoColorSpace,
    })
    GEOMETRY_MAP_NAMES.forEach((name, i) => {
      this.geometry.textures[i].name = name
    })
  }

  get geometryBaked(): boolean {
    return this.#geometryBaked
  }

  get rayBaked(): boolean {
    return this.#rayTexture !== null
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

  setRayMaps(maps: RayMapData): void {
    this.#rayTexture?.dispose()
    const tex = new DataTexture(maps.data, maps.resolution, maps.resolution, RGBAFormat, FloatType)
    tex.name = 'rayMaps'
    tex.minFilter = LinearFilter
    tex.magFilter = LinearFilter
    tex.wrapS = ClampToEdgeWrapping
    tex.wrapT = ClampToEdgeWrapping
    tex.generateMipmaps = false
    tex.colorSpace = NoColorSpace
    tex.needsUpdate = true
    this.#rayTexture = tex
  }

  clearRayMaps(): void {
    this.#rayTexture?.dispose()
    this.#rayTexture = null
  }

  geometryTexture(index: number): Texture {
    return this.geometry.textures[index]
  }

  get rayTexture(): DataTexture | null {
    return this.#rayTexture
  }

  setSize(resolution: number): void {
    if (resolution === this.resolution) return
    this.resolution = resolution
    this.geometry.setSize(resolution, resolution)
    // The geometry maps no longer describe anything until they are re-rendered.
    this.#geometryBaked = false
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
    const normal = normalize(nrmSample.xyz)
    const handedness = nrmSample.w
    const tangent = normalize(tanSample.xyz)
    // Re-orthogonalise: interpolating and filtering tangents drifts them off
    // the surface, and a skewed frame shows up as tilted normal-mapped detail.
    const orthoTangent = normalize(tangent.sub(normal.mul(normal.dot(tangent))))
    const bitangent = cross(normal, orthoTangent).mul(handedness)

    const ray = this.#rayTexture ? texture(this.#rayTexture, uvNode) : null

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
      baked: ray !== null,
    }
  }

  dispose(): void {
    this.geometry.dispose()
    this.#rayTexture?.dispose()
    this.#rayTexture = null
  }
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
    baked: false,
  }
}
