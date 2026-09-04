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
  /**
   * Resolution the mesh maps bake at, capped to the texture set's.
   *
   * Tracing cost is quadratic in this, so it is the main speed control. Mesh
   * maps feed masks rather than detail, and the result is dilated and sampled
   * bilinearly, so it upscales without showing.
   */
  resolution: number
  /** Rays per texel for AO. Rounded up to a multiple of the pass size. */
  aoRays: number
  aoDistance: number
  /** @deprecated The GPU baker shares one direction set between AO and thickness. */
  thicknessRays: number
  /**
   * How far a thickness probe looks for the far side of the model, as a
   * fraction of the model radius. Anything thicker than this reads as solid.
   */
  thicknessDistance: number
  curvatureRadius: number
  curvatureIntensity: number
  /** Dilation passes applied past UV island borders. */
  dilation: number
  /**
   * How far a ray starts off its own surface, as a fraction of the model
   * radius. Only has to clear float error on the originating triangle now that
   * rays hit real geometry rather than a rasterised depth map.
   */
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

/**
 * Triplanar by default. UV projection is the "correct" mode for a properly
 * unwrapped production mesh, but every built-in primitive here has wildly
 * uneven UV density - a torus knot stretches a pattern into streaks along the
 * tube - and triplanar never stretches. One dropdown switches back.
 */
export const DEFAULT_PROJECTION: ProjectionSettings = {
  mode: 'triplanar',
  scale: [1.6, 1.6],
  offset: [0, 0],
  rotation: 0,
  blendSharpness: 4,
  axis: 'y',
}

/**
 * Defaults chosen for a bake that finishes in a few seconds rather than one
 * that is theoretically ideal.
 *
 * Mesh maps are low-frequency by nature - they feed masks, not detail - so a
 * lower resolution costs very little visually and costs four times less per
 * doubling. The ray budget is the wall-clock time; the bake panel exposes all
 * of it for when quality matters more than the wait.
 */
export const DEFAULT_BAKE_SETTINGS: BakeSettings = {
  resolution: 512,
  aoRays: 64,
  aoDistance: 0.5,
  thicknessRays: 12,
  thicknessDistance: 0.5,
  curvatureRadius: 1,
  curvatureIntensity: 1,
  dilation: 12,
  rayBias: 2e-4,
}
