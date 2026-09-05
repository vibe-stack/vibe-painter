/**
 * Brush presets.
 *
 * The brush deposits a whole material, not a colour, so "a dirt brush" is a
 * material plus an alpha plus a set of numbers - and picking those apart from
 * scratch every time is the thing that stops people from hand-placing grime at
 * all. Each entry here is one click to a brush that already behaves like the
 * substance it is named after.
 *
 * These set the brush, not the document: nothing is added to the layer stack,
 * so a preset is free to try and free to abandon.
 */

import type { BrushSettings } from '../gpu/painter'
import type { ParamValue } from '../doc/types'

export interface BrushPreset {
  id: string
  name: string
  description: string
  /** Catalogue material the brush deposits. */
  materialId: string
  materialParams?: Record<string, ParamValue>
  /** Brush settings this preset overrides. Everything else is left alone. */
  brush: Partial<BrushSettings>
  swatch: [string, string]
}

export const BRUSH_PRESETS: BrushPreset[] = [
  {
    id: 'detail',
    name: 'Detail',
    description: 'Hard, tight, fully opaque. The one to reach for when the point is an exact edge rather than a blend.',
    materialId: 'plain',
    materialParams: { color: [0.82, 0.82, 0.84], roughness: 0.45 },
    brush: { hardness: 1, flow: 1, opacity: 1, spacing: 0.05, alpha: 'round', pressureSize: 1, pressureFlow: 0.2 },
    swatch: ['#d2d2d6', '#8a8a90'],
  },
  {
    id: 'soft-airbrush',
    name: 'Airbrush',
    description: 'Wide, soft and low flow, so colour builds up over repeated passes instead of landing all at once.',
    materialId: 'plain',
    materialParams: { color: [0.5, 0.5, 0.53], roughness: 0.6 },
    brush: { hardness: 0.05, flow: 0.16, opacity: 0.6, spacing: 0.06, alpha: 'round', pressureSize: 0.4, pressureFlow: 1 },
    swatch: ['#9a9aa2', '#4b4b52'],
  },
  {
    id: 'dirt',
    name: 'Dirt',
    description: 'Broken, speckled deposit in a dull brown. For putting grime exactly where a generator will not think to.',
    materialId: 'plain',
    materialParams: { color: [0.14, 0.12, 0.09], roughness: 0.85 },
    brush: { hardness: 0.3, flow: 0.45, opacity: 0.85, spacing: 0.08, alpha: 'splatter', alphaScale: 1.6, alphaContrast: 0.5 },
    swatch: ['#453a2c', '#20190f'],
  },
  {
    id: 'grime',
    name: 'Grime',
    description: 'Greasy dark build-up with a fine speckle. Lower flow than dirt, so it layers into corners.',
    materialId: 'plain',
    materialParams: { color: [0.1, 0.095, 0.085], roughness: 0.72 },
    brush: { hardness: 0.15, flow: 0.3, opacity: 0.8, spacing: 0.07, alpha: 'speckle', alphaScale: 2.2, alphaContrast: 0.42 },
    swatch: ['#332f2a', '#141210'],
  },
  {
    id: 'dust',
    name: 'Dust',
    description: 'Pale and very rough, applied thinly. Writes over everything softly rather than covering it.',
    materialId: 'plain',
    materialParams: { color: [0.62, 0.59, 0.54], roughness: 0.96 },
    brush: { hardness: 0.05, flow: 0.14, opacity: 0.5, spacing: 0.06, alpha: 'splatter', alphaScale: 3, alphaContrast: 0.3 },
    swatch: ['#b6ada0', '#7e766a'],
  },
  {
    id: 'rust',
    name: 'Rust',
    description: 'The rusted iron material on a torn, splattered alpha - for the streak below a bolt that no mask will find.',
    materialId: 'rusted-iron',
    brush: { hardness: 0.25, flow: 0.6, opacity: 0.95, spacing: 0.08, alpha: 'splatter', alphaScale: 1.3, alphaContrast: 0.55 },
    swatch: ['#8a4a24', '#40220f'],
  },
  {
    id: 'soot',
    name: 'Soot',
    description: 'Near-black and matte, very low flow. Builds smoke staining up out of nothing.',
    materialId: 'plain',
    materialParams: { color: [0.045, 0.042, 0.04], roughness: 0.97 },
    brush: { hardness: 0, flow: 0.1, opacity: 0.55, spacing: 0.05, alpha: 'splatter', alphaScale: 2.6, alphaContrast: 0.28 },
    swatch: ['#2b2724', '#080807'],
  },
  {
    id: 'scratch',
    name: 'Scratch',
    description: 'Thin streaked marks that cut roughness and expose metal. Small radius and a stretched alpha.',
    materialId: 'polished-metal',
    brush: { hardness: 0.9, flow: 0.9, opacity: 1, spacing: 0.04, alpha: 'streaks', alphaScale: 1.4, alphaContrast: 0.6, pressureSize: 1 },
    swatch: ['#c6c8cc', '#7d7f84'],
  },
  {
    id: 'moss',
    name: 'Moss',
    description: 'Clumped growth with its own height. Speckled so the edge of a patch is ragged.',
    materialId: 'moss',
    brush: { hardness: 0.2, flow: 0.7, opacity: 1, spacing: 0.09, alpha: 'speckle', alphaScale: 1.2, alphaContrast: 0.45 },
    swatch: ['#4c6a2f', '#22301a'],
  },
  {
    id: 'wet',
    name: 'Wet',
    description: 'Roughness down to a mirror without touching colour. Paint where something spilled.',
    materialId: 'plain',
    materialParams: { color: [0.3, 0.3, 0.32], roughness: 0.03 },
    brush: { hardness: 0.1, flow: 0.5, opacity: 0.9, spacing: 0.07, alpha: 'round' },
    swatch: ['#38506b', '#1b2836'],
  },
  {
    id: 'sand',
    name: 'Sand',
    description: 'Loose grit with a hard speckled alpha, for drifts against anything that would catch them.',
    materialId: 'dune-sand',
    brush: { hardness: 0.35, flow: 0.55, opacity: 0.9, spacing: 0.08, alpha: 'speckle', alphaScale: 2.8, alphaContrast: 0.5 },
    swatch: ['#c8ab77', '#8b7448'],
  },
  {
    id: 'snow',
    name: 'Snow',
    description: 'Soft, bright and thick. Wide and low-flow so drifts accumulate under repeated passes.',
    materialId: 'snow',
    brush: { hardness: 0.05, flow: 0.28, opacity: 0.9, spacing: 0.06, alpha: 'round', pressureSize: 0.6 },
    swatch: ['#f2f4f8', '#c0c9d5'],
  },
]

export function getBrushPreset(id: string): BrushPreset | null {
  return BRUSH_PRESETS.find((preset) => preset.id === id) ?? null
}

export function describeBrushPresets() {
  return BRUSH_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    materialId: preset.materialId,
  }))
}
