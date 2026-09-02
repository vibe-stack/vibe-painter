/**
 * The document model: plain, serialisable data. No GPU objects, no TSL nodes,
 * no React. The engine watches this tree and rebuilds GPU resources from it.
 *
 * Everything here is "the recipe" in Substance Painter's sense - layers,
 * masks, effects and parameters, never flattened pixels. The only exception is
 * paint, which is inherently raster; paint buffers are referenced by id and
 * serialised separately (see `serialize.ts`).
 */

import type { Channel } from '../channels'

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'hardLight',
  'softLight',
  'difference',
  'exclusion',
  'add',
  'subtract',
  'divide',
  'linearBurn',
  'negation',
] as const
export type BlendMode = (typeof BLEND_MODES)[number]

export const PROJECTIONS = ['uv', 'triplanar', 'planar', 'spherical', 'cylindrical'] as const
export type Projection = (typeof PROJECTIONS)[number]

export type ParamValue = number | boolean | [number, number, number]

/** A concrete use of a catalogue material with its parameter overrides. */
export interface MaterialInstance {
  defId: string
  params: Record<string, ParamValue>
}

export interface ProjectionSettings {
  mode: Projection
  /** Tiling in UV (or world, for triplanar/planar) units. */
  scale: [number, number]
  offset: [number, number]
  /** Rotation in radians. */
  rotation: number
  /** Triplanar blend sharpness. */
  blendSharpness: number
  /** Axis used by planar/cylindrical projections. */
  axis: 'x' | 'y' | 'z'
}

export interface ChannelSettings {
  enabled: boolean
  opacity: number
  blend: BlendMode
}

/** Levels remap applied to a mask or a generator output. */
export interface Levels {
  inLow: number
  inHigh: number
  gamma: number
  outLow: number
  outHigh: number
}

export const GENERATOR_TYPES = [
  'curvature',
  'dirt',
  'position',
  'thickness',
  'lightDirt',
  'grunge',
  'fill',
] as const
export type GeneratorType = (typeof GENERATOR_TYPES)[number]

/**
 * One entry in a mask's own little stack. Generators read baked mesh maps (or
 * pure noise) and produce a grayscale value; they blend with each other the
 * same way layers do.
 */
export interface GeneratorState {
  id: string
  type: GeneratorType
  name: string
  enabled: boolean
  opacity: number
  blend: BlendMode
  params: Record<string, ParamValue>
  levels: Levels
  invert: boolean
}

export interface MaskState {
  enabled: boolean
  invert: boolean
  /** Base value the generator stack composites over. */
  base: number
  generators: GeneratorState[]
  /** Id of the paint buffer holding hand-painted mask strokes, if any. */
  paintBufferId: string | null
  /** How the paint buffer combines with the generator result. */
  paintBlend: BlendMode
  levels: Levels
  /** Gaussian blur radius in texels applied to the final mask. 0 = off. */
  blur: number
}

interface LayerBase {
  id: string
  name: string
  visible: boolean
  /** Global layer opacity, multiplied into the mask. */
  opacity: number
  /** Per-channel enable / opacity / blend mode. Missing entries use defaults. */
  channels: Partial<Record<Channel, ChannelSettings>>
  mask: MaskState | null
}

export interface FillLayerState extends LayerBase {
  kind: 'fill'
  material: MaterialInstance
  projection: ProjectionSettings
}

export interface PaintLayerState extends LayerBase {
  kind: 'paint'
  /** Id of the packed slot buffers holding this layer's painted pixels. */
  paintBufferId: string
}

export interface FolderLayerState extends LayerBase {
  kind: 'folder'
  collapsed: boolean
  children: LayerState[]
}

export type LayerState = FillLayerState | PaintLayerState | FolderLayerState

export interface MeshMapsState {
  /** Resolution the maps were baked at. */
  resolution: number
  /** Which maps are present. */
  available: string[]
  /** Bake settings used, kept so a rebake can reproduce them. */
  settings: BakeSettings
  bakedAt: number
}

export interface BakeSettings {
  resolution: number
  aoRays: number
  aoDistance: number
  thicknessRays: number
  curvatureRadius: number
  curvatureIntensity: number
  /** Dilation passes applied past UV island borders. */
  dilation: number
  /** Cosine bias that keeps AO rays off the originating surface. */
  rayBias: number
}

export interface TextureSetState {
  id: string
  name: string
  resolution: number
  /** Channels this texture set actually allocates. */
  channels: Channel[]
  /** Root of the layer stack. Index 0 is the *bottom* layer. */
  layers: LayerState[]
  meshMaps: MeshMapsState | null
  /** Id of the mesh this set textures. */
  meshId: string
}

export interface MeshState {
  id: string
  name: string
  /** Where the geometry came from: a built-in primitive or an imported file. */
  source: { kind: 'primitive'; preset: string; params?: Record<string, number> } | { kind: 'imported'; fileName: string }
  triangleCount: number
  hasUVs: boolean
}

export interface ProjectState {
  version: 1
  name: string
  meshes: MeshState[]
  textureSets: TextureSetState[]
  activeTextureSetId: string | null
  activeLayerId: string | null
}

export const DEFAULT_LEVELS: Levels = { inLow: 0, inHigh: 1, gamma: 1, outLow: 0, outHigh: 1 }

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = { enabled: true, opacity: 1, blend: 'normal' }

export const DEFAULT_PROJECTION: ProjectionSettings = {
  mode: 'uv',
  scale: [1, 1],
  offset: [0, 0],
  rotation: 0,
  blendSharpness: 4,
  axis: 'y',
}

export const DEFAULT_BAKE_SETTINGS: BakeSettings = {
  resolution: 512,
  aoRays: 48,
  aoDistance: 0.5,
  thicknessRays: 32,
  curvatureRadius: 1,
  curvatureIntensity: 1,
  dilation: 12,
  rayBias: 1e-3,
}
