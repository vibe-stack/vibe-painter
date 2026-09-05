/**
 * The viewport material.
 *
 * The 3D view is a preview, not the document: it binds the composited channel
 * targets to a physically based material and nothing more. Everything shown
 * here was decided in UV space by the compositor.
 *
 * Two extras earn their keep:
 *  - Height is folded into the shading normal. Painter converts height to a
 *    normal so raised detail actually catches light; without it a height-only
 *    material looks completely flat.
 *  - A channel-solo material, driven by a uniform index so switching what you
 *    are inspecting never recompiles anything.
 */

import { DoubleSide, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial, Vector2 } from 'three/webgpu'
import type { Texture } from 'three/webgpu'
import {
  abs,
  attribute,
  bitangentView,
  float,
  fract,
  mat3,
  mix,
  normalize,
  normalView,
  normalWorld,
  tangentView,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { PART_ID_ATTRIBUTE } from '../mesh/parts'
import { CHANNEL_INFO } from '../channels'
import type { MeshMaps } from './meshmaps'
import type { F, V2, V3 } from './nodes'
import { unpackSlots, unpackSlotsForPart } from './packing'
import { sampleTextureForPart } from './sampling'
import type { SlotTargets } from './targets'

/** What the viewport is currently showing. */
export const VIEW_MODES = [
  'shaded',
  'baseColor',
  'roughness',
  'metallic',
  'normal',
  'height',
  'ao',
  'emissive',
  'opacity',
  'mesh-ao',
  'mesh-curvature',
  'mesh-thickness',
  'mesh-position',
  'mesh-normal',
  'uv-coverage',
  'mesh-id',
] as const
export type ViewMode = (typeof VIEW_MODES)[number]

export class ViewportMaterials {
  readonly shaded = new MeshPhysicalNodeMaterial()
  readonly debug = new MeshBasicNodeMaterial()
  /** Flat ID colours + a little lighting. Used while dragging a catalogue material, and as the mesh-id view. */
  readonly idOverlay = new MeshBasicNodeMaterial()

  #heightScale = uniform(1)
  #normalScale = uniform(1)
  #texel = uniform(new Vector2(1 / 1024, 1 / 1024))
  #mode = uniform(1)
  #hoverId = uniform(-1)
  #dimOthers = uniform(0)
  #built = false
  #idBuilt = false

  constructor() {
    this.#buildIdOverlay()
  }

  get heightScale(): number {
    return this.#heightScale.value
  }

  setHeightScale(value: number): void {
    this.#heightScale.value = value
  }

  setNormalScale(value: number): void {
    this.#normalScale.value = value
  }

  setMode(mode: ViewMode): void {
    const index = VIEW_MODES.indexOf(mode)
    this.#mode.value = Math.max(1, index)
  }

  /**
   * `partId` of the region under the cursor, or `null` when nothing is hovered.
   * When a part is hovered the others dim, matching Painter's ID drop target.
   */
  setIdHover(partId: number | null): void {
    this.#hoverId.value = partId ?? -1
    this.#dimOthers.value = partId === null ? 0 : 1
  }

  get built(): boolean {
    return this.#built
  }

  /** (Re)binds the material graphs to a set of composited targets. */
  build(slots: SlotTargets, maps: MeshMaps): void {
    // The mesh's own uv attribute, sampled straight. The compositor writes its
    // targets in this same space (see `sampling.ts`), so no flip belongs here.
    const uvNode = uv()
    this.#texel.value.set(1 / slots.resolution, 1 / slots.resolution)
    const partId = attribute(PART_ID_ATTRIBUTE, 'float') as unknown as F
    const resolution = float(slots.resolution)
    // Part-aware bilinear: a 3D part edge is a geometric join, not a UV-texel
    // join. Sampling the composite as a plain texture mixes neighbouring parts
    // (and empty gutter) into a staircase along every ID seam.
    const bundle = maps.geometryBaked
      ? unpackSlotsForPart(slots.rt.textures, uvNode, resolution, partId, maps.idMap.texture)
      : unpackSlots(slots.rt.textures, uvNode)
    const mapNodes = maps.nodes(uvNode)

    // --- Shaded ----------------------------------------------------------
    const heightTexture = slots.texture(CHANNEL_INFO.height.slot)
    const heightSwizzle = CHANNEL_INFO.height.swizzle as 'r' | 'g' | 'b' | 'a'
    const heightAt = maps.geometryBaked
      ? (at: V2): F => sampleTextureForPart(heightTexture, at, resolution, partId, maps.idMap.texture)[heightSwizzle] as F
      : null
    const heightNormal = normalFromHeightTexture(
      heightTexture,
      uvNode,
      this.#texel as unknown as { x: F; y: F },
      this.#heightScale as unknown as F,
      heightAt,
    )
    const combined = combineNormals(bundle.normal as V3, heightNormal, this.#normalScale as unknown as F)

    this.shaded.colorNode = bundle.baseColor as V3
    this.shaded.roughnessNode = (bundle.roughness as F).clamp(0.015, 1)
    this.shaded.metalnessNode = (bundle.metallic as F).clamp(0, 1)
    // Painted occlusion times baked occlusion, the way Substance combines them.
    // The two answer different questions - the channel is what was painted into
    // the texture set, the mesh map is what the shape itself occludes - and
    // multiplying is what makes baking visible in the viewport rather than only
    // to generators. It stays out of the exported `ao` channel, which is the
    // painted one: a mesh map is a source, not a channel.
    //
    // `aoNode` attenuates indirect light only, so this darkens cavities under
    // the environment without dimming direct lights. Before a bake the mesh AO
    // is a constant 1 and this is exactly what it was.
    //
    // Uncleared composite targets are 0. AO of 0 kills IBL; a 0 tangent
    // normal normalises to NaN and kills direct lighting too.
    this.shaded.aoNode = (bundle.ao as F).mul(mapNodes.ao).max(0.04).clamp(0, 1)
    this.shaded.emissiveNode = bundle.emissive as V3
    // Compositor stores tangent-space normals. TBN * n is the correct
    // transform; `transformNormalToView` is object-space and flattened the
    // whole mesh to +Z, which reads as a black silhouette under PBR.
    const tangentNormal = vec3(combined.x, combined.y, (combined.z as F).max(0.02))
    this.shaded.normalNode = mat3(
      tangentView as unknown as V3,
      bitangentView as unknown as V3,
      normalView as unknown as V3,
    ).mul(normalize(tangentNormal)).normalize()
    this.shaded.opacityNode = (bundle.opacity as F).max(0.02).clamp(0, 1)
    // IBL comes from `scene.environment` (set by the engine). Binding envNode
    // here double-wrapped PMREM and compiled a black shader on cold start.
    // Punctual lights come from the scene graph, not a captured LightsNode —
    // capturing them by constructor identity breaks when Vite duplicates three.
    this.shaded.envNode = null
    this.shaded.lightsNode = null
    this.shaded.needsUpdate = true

    // --- Debug / channel solo -------------------------------------------
    const options: { mode: ViewMode; value: V3 }[] = [
      { mode: 'baseColor', value: bundle.baseColor as V3 },
      { mode: 'roughness', value: vec3(bundle.roughness as F) },
      { mode: 'metallic', value: vec3(bundle.metallic as F) },
      // Normals are shown re-encoded to 0..1 so the usual purple map is legible.
      { mode: 'normal', value: normalize(bundle.normal as V3).mul(0.5).add(vec3(0.5, 0.5, 0.5)) },
      { mode: 'height', value: vec3(bundle.height as F) },
      { mode: 'ao', value: vec3(bundle.ao as F) },
      { mode: 'emissive', value: bundle.emissive as V3 },
      { mode: 'opacity', value: vec3(bundle.opacity as F) },
      { mode: 'mesh-ao', value: vec3(mapNodes.ao) },
      { mode: 'mesh-curvature', value: curvatureRamp(mapNodes.curvature) },
      { mode: 'mesh-thickness', value: vec3(mapNodes.thickness) },
      { mode: 'mesh-position', value: mapNodes.position },
      { mode: 'mesh-normal', value: mapNodes.normal.mul(0.5).add(vec3(0.5, 0.5, 0.5)) },
      { mode: 'uv-coverage', value: vec3(mapNodes.coverage) },
    ]

    let debugColour: V3 = vec3(0, 0, 0)
    for (const option of options) {
      const index = VIEW_MODES.indexOf(option.mode)
      // Uniform-driven selection: one shader covers every solo mode.
      const weight = float(1).sub(this.#mode.sub(index).abs().clamp(0, 1))
      debugColour = debugColour.add(option.value.mul(weight))
    }
    this.debug.fragmentNode = vec4(debugColour, 1)
    this.debug.needsUpdate = true
    this.#built = true
    this.#buildIdOverlay()
  }

  #buildIdOverlay(): void {
    if (this.#idBuilt) return
    const id = attribute(PART_ID_ATTRIBUTE, 'float') as unknown as F
    const hue = fract(id.mul(0.61803398875).add(0.07))
    const base = hsvToRgb(hue, float(0.72), float(0.92))
    const hovered = abs(id.sub(this.#hoverId)).lessThan(float(0.5)).select(float(1), float(0))
    const shade = mix(float(1), mix(float(0.32), float(1.18), hovered), this.#dimOthers)
    const lighting = normalize(normalWorld)
      .dot(normalize(vec3(0.25, 0.85, 0.45)))
      .mul(0.38)
      .add(0.62)
    this.idOverlay.fragmentNode = vec4(base.mul(shade).mul(lighting), 1)
    this.idOverlay.side = DoubleSide
    this.idOverlay.polygonOffset = true
    this.idOverlay.polygonOffsetFactor = 1
    this.idOverlay.polygonOffsetUnits = 1
    this.idOverlay.needsUpdate = true
    this.#idBuilt = true
  }

  dispose(): void {
    this.shaded.dispose()
    this.debug.dispose()
    this.idOverlay.dispose()
  }
}

/** Compact HSV, identical to `partDisplayColor` in `mesh/parts.ts`. */
function hsvToRgb(h: F, s: F, v: F): V3 {
  const rgb = abs(fract(vec3(h, h.add(2 / 3), h.add(1 / 3))).mul(6).sub(3)).sub(1).clamp(0, 1)
  return mix(vec3(1, 1, 1), rgb, s).mul(v) as V3
}

/**
 * Sobel derivative of the height channel, expressed as a tangent-space normal.
 * Sampling the texture rather than differentiating the analytic material keeps
 * this correct for painted height too.
 */
function normalFromHeightTexture(
  tex: Texture,
  uvNode: V2,
  texel: { x: F; y: F },
  scale: F,
  sampleAt: ((uv: V2) => F) | null = null,
): V3 {
  const size = texel
  const swizzle = CHANNEL_INFO.height.swizzle as 'r' | 'g' | 'b' | 'a'
  const at = (dx: number, dy: number): F => {
    const u = uvNode.add(vec2(size.x.mul(dx), size.y.mul(dy)))
    if (sampleAt) return sampleAt(u)
    const sample = texture(tex, u)
    return sample[swizzle] as F
  }
  const dx = at(-1, 0).sub(at(1, 0))
  const dy = at(0, -1).sub(at(0, 1))
  return normalize(vec3(dx.mul(scale).mul(8), dy.mul(scale).mul(8), 1))
}

/** Reoriented normal mapping, same as the compositor uses between layers. */
function combineNormals(base: V3, detail: V3, strength: F): V3 {
  const scaled = normalize(vec3(detail.x.mul(strength), detail.y.mul(strength), detail.z))
  const t = base.add(vec3(0, 0, 1))
  const u = scaled.mul(vec3(-1, -1, 1))
  return normalize(t.mul(t.dot(u)).div(t.z.max(1e-4)).sub(u))
}

/** Blue for cavities, red for edges - much easier to read than grayscale. */
function curvatureRamp(curvature: F): V3 {
  const convex = curvature.sub(0.5).mul(2).clamp(0, 1)
  const concave = curvature.sub(0.5).mul(-2).clamp(0, 1)
  return vec3(convex.add(float(0.15)), float(0.15), concave.add(float(0.15)))
}
