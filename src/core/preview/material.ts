/**
 * The preview material: one catalogue entry, evaluated on a sphere.
 *
 * This is deliberately *not* the compositor. A thumbnail has no layer stack, no
 * mask, no paint buffers and no baked mesh maps - it is a single material shown
 * as honestly as possible. Keeping it separate means the thumbnail renderer can
 * run somewhere the compositor cannot (a worker, with no document and no engine
 * around it) and that changing the stack cannot change what a swatch looks like.
 *
 * Projection is triplanar in object space rather than the sphere's own UVs. A
 * lat/long sphere pinches its UVs to nothing at the poles, which would squeeze
 * every pattern into a spiral exactly where the eye lands first; triplanar has
 * no such singularity, so brickwork stays brickwork all the way over the top.
 */

import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  bitangentLocal,
  bitangentView,
  float,
  mat3,
  normalLocal,
  normalize,
  normalView,
  positionLocal,
  tangentLocal,
  tangentView,
  vec2,
  vec3,
} from 'three/tsl'
import type { MeshMapNodes, ProceduralMaterialDef } from '../procedural/material'
import { ParamBag } from '../procedural/params'
import { buildProjected } from '../procedural/projection'
import type { ParamValue } from '../doc/types'
import type { F, V3 } from '../gpu/nodes'

/**
 * `normalize()` that survives a zero-length input.
 *
 * A sphere's tangent frame degenerates at its poles, and `normalize()` of a
 * zero vector is NaN - which does not stay put, it takes every pixel it touches
 * to black. The painted mesh guards the same way in `meshmaps.ts`.
 */
function safeNormalize(v: V3, fallback: V3): V3 {
  const len = v.length()
  return len.greaterThan(float(1e-5)).select(v.div(len), fallback) as V3
}

export interface PreviewOptions {
  /** Pattern repeats across the sphere. Higher shows more of the tiling. */
  tiling?: number
  /** Triplanar blend exponent. Low values smear across the seams. */
  sharpness?: number
}

/**
 * Mesh maps for a bare preview sphere.
 *
 * Object space is the sphere's own space, and the sphere has radius 1, so the
 * position map is a straight remap of the vertex position. AO, curvature and
 * thickness are the same neutral constants an unbaked project would see - a
 * swatch should show the material, not a bake.
 */
function previewMeshMaps(): MeshMapNodes {
  return {
    position: (positionLocal as unknown as V3).mul(0.5).add(vec3(0.5, 0.5, 0.5)),
    worldPosition: positionLocal as unknown as V3,
    worldPositionPrecise: positionLocal as unknown as V3,
    normal: safeNormalize(normalLocal as unknown as V3, vec3(0, 0, 1)),
    tangent: safeNormalize(tangentLocal as unknown as V3, vec3(1, 0, 0)),
    bitangent: safeNormalize(bitangentLocal as unknown as V3, vec3(0, 1, 0)),
    ao: float(1),
    curvature: float(0.5),
    thickness: float(0.5),
    coverage: float(1),
    island: float(1),
    partId: float(0),
    baked: false,
  }
}

/** Builds a physically based material showing `def` at its given parameters. */
export function buildPreviewMaterial(
  def: ProceduralMaterialDef,
  values: Record<string, ParamValue>,
  options: PreviewOptions = {},
): MeshPhysicalNodeMaterial {
  const tiling = options.tiling ?? 2
  const params = new ParamBag(def.params, values)
  const maps = previewMeshMaps()

  const bundle = buildProjected({
    def,
    params,
    mode: 'triplanar',
    axis: 1,
    nodes: {
      scale: vec2(tiling, tiling),
      offset: vec2(0, 0),
      rotation: float(0),
      sharpness: float(options.sharpness ?? 6),
    },
    maps,
    // Triplanar ignores it, but the signature requires a coordinate.
    uv: vec2(0, 0),
  })

  const material = new MeshPhysicalNodeMaterial()
  material.colorNode = bundle.baseColor
  material.roughnessNode = bundle.roughness.clamp(0.015, 1)
  material.metalnessNode = bundle.metallic.clamp(0, 1)
  // AO of 0 kills image-based lighting outright, which turns a swatch black.
  material.aoNode = bundle.ao.max(0.04).clamp(0, 1)
  material.emissiveNode = bundle.emissive
  // The bundle carries a tangent-space normal, so it needs the mesh's own TBN.
  // A zero or negative Z would normalise to NaN and take the whole sphere with it.
  const tangentNormal = vec3(bundle.normal.x, bundle.normal.y, (bundle.normal.z as F).max(0.02))
  material.normalNode = mat3(
    tangentView as unknown as V3,
    bitangentView as unknown as V3,
    normalView as unknown as V3,
  )
    .mul(normalize(tangentNormal))
    .normalize()
  // Lighting comes from the scene: an env node bound here would double-wrap
  // the PMREM output, the same trap the viewport material documents.
  material.envNode = null
  material.lightsNode = null
  return material
}
