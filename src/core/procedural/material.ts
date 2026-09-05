/**
 * The procedural material contract.
 *
 * A material is a pure function from (coordinate, parameters, mesh maps) to a
 * channel bundle. It never samples an image. That constraint is what makes the
 * catalogue resolution independent, tiny to serialise, and safe to evaluate at
 * any projection without worrying about texture memory.
 *
 * Materials author against a plain 2D coordinate. Projection (UV, triplanar,
 * planar, ...) is applied *around* them by `projection.ts`, which for triplanar
 * evaluates the same material once per axis and blends the bundles.
 */

import type { ParamValue } from '../doc/types'
import type { F, PartialBundle, V2, V3 } from '../gpu/nodes'
import type { ParamDef } from './params'
import { ParamBag, defaultValues } from './params'

/**
 * The baked geometric data a material or generator may read. When a texture
 * set has not been baked yet these are neutral constants, so every graph still
 * compiles and renders - it just loses the geometry-aware effects.
 */
export interface MeshMapNodes {
  /** Object-space position, normalised into the mesh bounding box (0..1). */
  position: V3
  /** World-space position, in mesh units. */
  worldPosition: V3
  /**
   * The same position, reconstructed from the residual map.
   *
   * Only correct when read at a texel centre - a 1:1 fullscreen pass over the
   * texture set - and only inside a UV island. That covers exactly the one
   * caller that needs it: the brush, whose whole job is to compare a world
   * distance against a radius that may be a few texels wide.
   */
  worldPositionPrecise: V3
  /** World-space shading normal. */
  normal: V3
  /** World-space tangent (from the mesh UV parameterisation). */
  tangent: V3
  /** World-space bitangent. */
  bitangent: V3
  /** Ambient occlusion, 1 = fully open. */
  ao: F
  /** Curvature: 0.5 flat, above 0.5 convex (edges), below 0.5 concave (cracks). */
  curvature: F
  /** Thickness: 0 = paper thin, 1 = deep solid. */
  thickness: F
  /** 1 inside a UV island, 0 in the gutter. Grows as maps are dilated. */
  coverage: F
  /** 1 inside a UV island, 0 outside. Never dilated, so always the truth. */
  island: F
  /**
   * Source-mesh part index (material slot, object, colour ID, or face).
   * Integer-valued; 0 when the mesh has no partitions.
   */
  partId: F
  /** True when real baked maps are bound rather than neutral fallbacks. */
  baked: boolean
}

export interface MatContext {
  /** The 2D coordinate to evaluate at, already tiled/rotated/projected. */
  uv: V2
  /** Size of one texel in the units of `uv`. Use it for derivative epsilons. */
  texel: F
  params: ParamBag
  meshMaps: MeshMapNodes
  /**
   * Which axis this evaluation belongs to under triplanar projection
   * (0 = X, 1 = Y, 2 = Z), or -1 for a plain 2D projection. Materials that
   * want directional behaviour - drips running down, snow on top - read this.
   */
  axis: number
}

export interface ProceduralMaterialDef {
  id: string
  name: string
  category: string
  description: string
  params: readonly ParamDef[]
  /**
   * Builds the channel graph. Return only the channels the material actually
   * authors; the rest fall back to the channel defaults.
   */
  build(ctx: MatContext): PartialBundle
}

const registry = new Map<string, ProceduralMaterialDef>()

export function registerMaterial(def: ProceduralMaterialDef): ProceduralMaterialDef {
  if (registry.has(def.id)) throw new Error(`Material "${def.id}" is already registered`)
  registry.set(def.id, def)
  return def
}

export function getMaterialDef(id: string): ProceduralMaterialDef | null {
  return registry.get(id) ?? null
}

export function listMaterialDefs(): ProceduralMaterialDef[] {
  return [...registry.values()]
}

export function listCategories(): string[] {
  const seen = new Set<string>()
  for (const def of registry.values()) seen.add(def.category)
  return [...seen].sort()
}

/** Builds a document-level material instance with defaults applied. */
export function instantiateMaterial(defId: string, overrides: Record<string, ParamValue> = {}) {
  const def = getMaterialDef(defId)
  if (!def) throw new Error(`Unknown material "${defId}"`)
  return { defId, params: { ...defaultValues(def.params), ...overrides } }
}

export function makeParamBag(defId: string, values: Record<string, ParamValue>): ParamBag {
  const def = getMaterialDef(defId)
  return new ParamBag(def?.params ?? [], values)
}

/** Machine-readable description of the whole catalogue, for tooling/agents. */
export function describeCatalogue() {
  return listMaterialDefs().map((def) => ({
    id: def.id,
    name: def.name,
    category: def.category,
    description: def.description,
    params: def.params.map((p) => ({
      key: p.key,
      label: p.label,
      type: p.type,
      default: p.default,
      min: p.min,
      max: p.max,
      group: p.group,
      description: p.description,
    })),
  }))
}

/** Shared param definitions most materials want. */
export const SEED_PARAM: ParamDef = {
  key: 'seed',
  label: 'Seed',
  type: 'float',
  default: 0,
  min: 0,
  max: 100,
  step: 0.01,
  group: 'Pattern',
  description: 'Offsets every noise lookup. Change it for a different variation of the same material.',
}

/** Applies the seed as a coordinate offset, so one number rerolls everything. */
export function seeded(ctx: MatContext, coord: V3): V3 {
  const s = ctx.params.has('seed') ? ctx.params.float('seed') : null
  if (!s) return coord
  return coord.add(s.mul(17.3))
}

export type { V2, V3, F }
