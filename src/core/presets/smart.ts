/**
 * Smart materials: whole effects, ready to drop on.
 *
 * A generator turns geometry into a mask and a fill layer turns a mask into a
 * surface, and everything in this file is those two facts assembled in advance.
 * "Dirt" is not a new feature - it is an occlusion mask under a rough brown
 * fill, which is a minute of clicking that nobody should have to repeat.
 *
 * Every preset is a *recipe*, not pixels: it is built out of the same document
 * nodes the panels create, so anything here can be taken apart, retuned, and
 * saved back out as a smart material file. Presets that stack two effects use
 * an anchor point to tie the second to the first, which is also the clearest
 * demonstration of what anchors are for.
 *
 * Presets marked `requiresBake` still apply without a bake; their masks just
 * read the neutral fallbacks and come out flat until the maps exist.
 */

import { createFillLayer, createFolder, createGenerator, createMask } from '../doc/document'
import { defaultGeneratorParams } from '../procedural/generators'
import { instantiateMaterial } from '../procedural/material'
import type {
  AnchorSource,
  BlendMode,
  GeneratorType,
  LayerState,
  Levels,
  ParamValue,
} from '../doc/types'
import type { Channel } from '../channels'

export interface SmartMaterialDef {
  id: string
  name: string
  /** Groups the browser. Keep the list short; these are shelves, not tags. */
  category: 'Grime' | 'Wear' | 'Weather' | 'Surface' | 'Coating'
  description: string
  /** Whether the effect is geometry-driven and therefore wants baked maps. */
  requiresBake: boolean
  /** Two swatch colours, so the browser can show something before a thumbnail. */
  swatch: [string, string]
  build(): LayerState
}

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

interface GeneratorSpec {
  type: GeneratorType
  params?: Record<string, ParamValue>
  blend?: BlendMode
  opacity?: number
  invert?: boolean
  levels?: Partial<Levels>
  /** Set on the *referencing* generator; resolved against `anchorOf` below. */
  anchorSource?: AnchorSource
}

interface FillSpec {
  name: string
  material: string
  params?: Record<string, ParamValue>
  opacity?: number
  /** Mask base value. 0 for an effect the generators reveal, 1 to carve away. */
  base?: number
  generators?: GeneratorSpec[]
  /** Channels this layer is allowed to write. Omit to write all of them. */
  only?: Channel[]
  /** Per-channel blend overrides, for a layer that darkens rather than covers. */
  blends?: Partial<Record<Channel, BlendMode>>
  /** Publishes this layer's mask under a name, for the layer above to read. */
  anchorName?: string
  /** Anchor (by name) that this layer's `anchorSource` generators point at. */
  readsAnchor?: string
}

const ALL_CHANNELS: Channel[] = [
  'baseColor',
  'opacity',
  'roughness',
  'metallic',
  'normal',
  'height',
  'ao',
  'emissive',
]

function fill(spec: FillSpec): LayerState {
  const layer = createFillLayer(instantiateMaterial(spec.material, spec.params ?? {}), spec.name)
  layer.opacity = spec.opacity ?? 1
  layer.anchorName = spec.anchorName ?? null

  if (spec.only) {
    for (const channel of ALL_CHANNELS) {
      if (spec.only.includes(channel)) continue
      layer.channels[channel] = { enabled: false, opacity: 1, blend: 'normal' }
    }
  }
  for (const [channel, blend] of Object.entries(spec.blends ?? {})) {
    const key = channel as Channel
    const current = layer.channels[key] ?? { enabled: true, opacity: 1, blend: 'normal' as BlendMode }
    layer.channels[key] = { ...current, blend: blend as BlendMode }
  }

  if (spec.generators?.length || spec.base !== undefined) {
    const mask = createMask(spec.base ?? 0)
    for (const gen of spec.generators ?? []) {
      const generator = createGenerator(gen.type, {
        ...defaultGeneratorParams(gen.type),
        ...(gen.params ?? {}),
      })
      if (gen.blend) generator.blend = gen.blend
      if (gen.opacity !== undefined) generator.opacity = gen.opacity
      if (gen.invert) generator.invert = true
      if (gen.levels) generator.levels = { ...generator.levels, ...gen.levels }
      // Resolved by `group()` once every layer in the preset has an id.
      if (gen.anchorSource) {
        generator.anchorRef = { layerId: spec.readsAnchor ?? '', source: gen.anchorSource }
      }
      mask.generators.push(generator)
    }
    layer.mask = mask
  }
  return layer
}

/**
 * Assembles a multi-layer preset and resolves its anchor references.
 *
 * `fill()` cannot do it alone: an anchor reference is a layer *id*, and ids
 * only exist once the layers have been constructed. So the specs name anchors
 * by their published name and this pass rewrites those names to ids - which is
 * the same shape the mask panel's picker works in.
 */
function group(name: string, specs: FillSpec[]): LayerState {
  const layers = specs.map(fill)
  const byName = new Map<string, string>()
  specs.forEach((spec, i) => {
    if (spec.anchorName) byName.set(spec.anchorName, layers[i].id)
  })
  specs.forEach((spec, i) => {
    if (!spec.readsAnchor) return
    const target = byName.get(spec.readsAnchor)
    if (!target) return
    for (const gen of layers[i].mask?.generators ?? []) {
      if (gen.anchorRef) gen.anchorRef = { ...gen.anchorRef, layerId: target }
    }
  })
  return layers.length === 1 ? layers[0] : createFolder(name, layers)
}

// ---------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------

const registry = new Map<string, SmartMaterialDef>()

function register(def: SmartMaterialDef): SmartMaterialDef {
  registry.set(def.id, def)
  return def
}

register({
  id: 'grime',
  name: 'Grime',
  category: 'Grime',
  description:
    'Greasy dark build-up in everything the air does not reach. Occlusion-driven, broken up with noise so it reads as accumulation rather than as a shadow.',
  requiresBake: true,
  swatch: ['#4a4034', '#241f19'],
  build: () =>
    group('Grime', [
      {
        name: 'Grime',
        material: 'plain',
        params: { color: [0.13, 0.11, 0.09], roughness: 0.82, metallic: 0, height: 0.5 },
        base: 0,
        generators: [
          { type: 'dirt', params: { threshold: 0.5, softness: 0.45, grungeAmount: 0.55, grungeScale: 42 } },
          { type: 'grunge', params: { scale: 8, contrast: 0.35 }, blend: 'multiply', opacity: 0.5 },
        ],
      },
    ]),
})

register({
  id: 'dust',
  name: 'Dust',
  category: 'Grime',
  description:
    'A pale, matte settling on every upward face. Position-driven rather than occlusion-driven, because dust falls: it lands on the top of a ledge, not inside it.',
  requiresBake: true,
  swatch: ['#b6ada0', '#8d8577'],
  build: () =>
    group('Dust', [
      {
        name: 'Dust',
        material: 'plain',
        params: { color: [0.62, 0.59, 0.54], roughness: 0.95, metallic: 0 },
        only: ['baseColor', 'roughness', 'metallic'],
        opacity: 0.7,
        base: 0,
        generators: [
          { type: 'lightDirt', params: { dirY: 1, spread: 0.85, occlusion: 0.35, grungeAmount: 0.6, grungeScale: 55 } },
        ],
      },
    ]),
})

register({
  id: 'soot',
  name: 'Soot',
  category: 'Grime',
  description:
    'Smoke deposit: dense in cavities, feathering upward out of them. Writes colour and roughness only, so whatever it settles on keeps its own shape.',
  requiresBake: true,
  swatch: ['#2b2724', '#0d0c0b'],
  build: () =>
    group('Soot', [
      {
        name: 'Soot',
        material: 'plain',
        params: { color: [0.05, 0.045, 0.042], roughness: 0.96, metallic: 0 },
        only: ['baseColor', 'roughness', 'ao'],
        base: 0,
        generators: [
          { type: 'dirt', params: { threshold: 0.45, softness: 0.5, grungeAmount: 0.45 } },
          { type: 'lightDirt', params: { dirY: 1, spread: 1.1, occlusion: 0.6 }, blend: 'lighten', opacity: 0.45 },
        ],
      },
    ]),
})

register({
  id: 'fingerprints',
  name: 'Smudges',
  category: 'Grime',
  description:
    'Handling marks. Roughness only - a smudge does not change what something is made of, it changes how it catches the light, which is exactly why a colour-based version of this never looks right.',
  requiresBake: false,
  swatch: ['#6f7076', '#4a4b50'],
  build: () =>
    group('Smudges', [
      {
        name: 'Smudges',
        material: 'plain',
        params: { roughness: 0.72 },
        only: ['roughness'],
        opacity: 0.65,
        base: 0,
        generators: [
          { type: 'grunge', params: { kind: 0, scale: 22, warpAmount: 1.2, contrast: 0.62 } },
          { type: 'curvature', params: { edges: 1, cavities: 0, range: 0.16 }, blend: 'lighten', opacity: 0.4 },
        ],
      },
    ]),
})

register({
  id: 'edge-wear',
  name: 'Edge Wear',
  category: 'Wear',
  description:
    'Bare metal where the shape has been knocked about. Curvature picks the convex edges and the break-up noise keeps the line from being a perfect outline of the mesh.',
  requiresBake: true,
  swatch: ['#c9c6c0', '#8e8b86'],
  build: () =>
    group('Edge Wear', [
      {
        name: 'Edge Wear',
        material: 'polished-metal',
        base: 0,
        generators: [
          { type: 'curvature', params: { edges: 1, cavities: 0, range: 0.09, grungeAmount: 0.55, grungeScale: 90 } },
        ],
      },
    ]),
})

register({
  id: 'chipped-rust',
  name: 'Chipped Paint & Rust',
  category: 'Wear',
  description:
    'Two effects that know about each other. The chip layer eats through on edges and publishes an anchor; the rust above it reads that anchor, so rust only ever appears where paint actually came off - and it follows every change you make to the chipping.',
  requiresBake: true,
  swatch: ['#8a4a24', '#3b2415'],
  build: () =>
    group('Chipped Paint & Rust', [
      {
        name: 'Chips',
        material: 'plain',
        params: { color: [0.35, 0.33, 0.31], roughness: 0.7, metallic: 0.2, height: 0.42 },
        anchorName: 'Chips',
        base: 0,
        generators: [
          { type: 'curvature', params: { edges: 1, cavities: 0.15, range: 0.12, grungeAmount: 0.7, grungeScale: 60 } },
        ],
      },
      {
        name: 'Rust in the Chips',
        material: 'rusted-iron',
        readsAnchor: 'Chips',
        base: 0,
        generators: [
          { type: 'anchor', anchorSource: 'mask', params: { contrast: 0.35, grungeAmount: 0.5, grungeScale: 70 } },
          { type: 'dirt', params: { threshold: 0.6, softness: 0.4 }, blend: 'lighten', opacity: 0.4 },
        ],
      },
    ]),
})

register({
  id: 'scratches',
  name: 'Scratches',
  category: 'Wear',
  description:
    'Hairline scuffs running one way, biased towards the edges something would have scraped past. Roughness and normal only, so the marks catch light without repainting the surface.',
  requiresBake: false,
  swatch: ['#9fa3a8', '#5d6165'],
  build: () =>
    group('Scratches', [
      {
        name: 'Scratches',
        material: 'plain',
        params: { roughness: 0.18, metallic: 0.35 },
        only: ['roughness', 'metallic'],
        base: 0,
        generators: [{ type: 'scratches', params: { density: 34, stretch: 60, amount: 0.85, edgeBias: 0.4 } }],
      },
    ]),
})

register({
  id: 'polished-edges',
  name: 'Polished Edges',
  category: 'Wear',
  description:
    'The opposite of edge wear: handling that has burnished the high points smooth instead of stripping them. Roughness only.',
  requiresBake: true,
  swatch: ['#d8d5cf', '#9b9893'],
  build: () =>
    group('Polished Edges', [
      {
        name: 'Polish',
        material: 'plain',
        params: { roughness: 0.08 },
        only: ['roughness'],
        base: 0,
        generators: [{ type: 'curvature', params: { edges: 1, cavities: 0, range: 0.14, grungeAmount: 0.3 } }],
      },
    ]),
})

register({
  id: 'rain-streaks',
  name: 'Rain Streaks',
  category: 'Weather',
  description:
    'Dirt washed downward into vertical runs. Long stretched noise on a downward-facing gradient, so the streaks start under the ledges that shed the water.',
  requiresBake: true,
  swatch: ['#5a544a', '#2f2b26'],
  build: () =>
    group('Rain Streaks', [
      {
        name: 'Streaks',
        material: 'plain',
        params: { color: [0.16, 0.15, 0.13], roughness: 0.78 },
        only: ['baseColor', 'roughness'],
        opacity: 0.8,
        base: 0,
        generators: [
          { type: 'scratches', params: { angle: 1.5708, density: 5, stretch: 90, amount: 1 } },
          { type: 'lightDirt', params: { dirY: -1, spread: 1.2, occlusion: 0.3 }, blend: 'multiply' },
          { type: 'dirt', params: { threshold: 0.7, softness: 0.4 }, blend: 'lighten', opacity: 0.5 },
        ],
      },
    ]),
})

register({
  id: 'moss',
  name: 'Moss',
  category: 'Weather',
  description:
    'Growth where it is damp and sheltered: upward faces, biased into occluded pockets. Carries its own height, so it sits on the surface rather than being painted onto it.',
  requiresBake: true,
  swatch: ['#4c6a2f', '#25341a'],
  build: () =>
    group('Moss', [
      {
        name: 'Moss',
        material: 'moss',
        base: 0,
        generators: [
          { type: 'lightDirt', params: { dirY: 1, spread: 0.9, occlusion: 0.15, grungeAmount: 0.65, grungeScale: 26 } },
          { type: 'dirt', params: { threshold: 0.72, softness: 0.35 }, blend: 'lighten', opacity: 0.55 },
        ],
      },
    ]),
})

register({
  id: 'snow',
  name: 'Snow',
  category: 'Weather',
  description:
    'Settled on the top surfaces only, and kept out of anything enclosed. The facing falloff is what makes it stop at the shoulder of a form instead of wrapping around it.',
  requiresBake: true,
  swatch: ['#f2f4f8', '#c3ccd8'],
  build: () =>
    group('Snow', [
      {
        name: 'Snow',
        material: 'snow',
        base: 0,
        generators: [
          { type: 'lightDirt', params: { dirY: 1, spread: 0.55, occlusion: 0.55, grungeAmount: 0.35, grungeScale: 18 } },
        ],
      },
    ]),
})

register({
  id: 'sand-drift',
  name: 'Sand Drift',
  category: 'Weather',
  description: 'Fine grit collected in every crevice and along upward faces, the way sand settles on anything left outside.',
  requiresBake: true,
  swatch: ['#c8ab77', '#8d764c'],
  build: () =>
    group('Sand Drift', [
      {
        name: 'Sand',
        material: 'dune-sand',
        base: 0,
        generators: [
          { type: 'dirt', params: { threshold: 0.55, softness: 0.45, grungeAmount: 0.5, grungeScale: 34 } },
          { type: 'lightDirt', params: { dirY: 1, spread: 0.9, occlusion: 0.2 }, blend: 'lighten', opacity: 0.6 },
        ],
      },
    ]),
})

register({
  id: 'mud-splatter',
  name: 'Mud Splatter',
  category: 'Weather',
  description: 'Thrown wet mud, heaviest low on the model and thinning upward. Cell noise gives it the flung, uneven edge that fractal noise alone does not.',
  requiresBake: true,
  swatch: ['#57432c', '#2b2015'],
  build: () =>
    group('Mud Splatter', [
      {
        name: 'Mud',
        material: 'wet-mud',
        base: 0,
        generators: [
          { type: 'grunge', params: { kind: 2, scale: 26, contrast: 0.72 } },
          { type: 'position', params: { axis: 1, start: 0.55, end: 0.05, facing: 0.3 }, blend: 'multiply' },
        ],
      },
    ]),
})

register({
  id: 'wet-pooling',
  name: 'Wet Pooling',
  category: 'Coating',
  description:
    'Water gathered where it cannot drain. Roughness and normal only - wet does not recolour a surface much, it just makes it mirror-smooth, which is the whole read.',
  requiresBake: true,
  swatch: ['#38506b', '#16202c'],
  build: () =>
    group('Wet Pooling', [
      {
        name: 'Wet',
        material: 'plain',
        params: { roughness: 0.04, metallic: 0 },
        only: ['roughness', 'metallic', 'baseColor'],
        blends: { baseColor: 'multiply' },
        base: 0,
        generators: [
          { type: 'dirt', params: { threshold: 0.45, softness: 0.5, grungeAmount: 0.25 } },
          { type: 'lightDirt', params: { dirY: 1, spread: 0.6, occlusion: 0.9 }, blend: 'multiply' },
        ],
      },
    ]),
})

register({
  id: 'oil-film',
  name: 'Oil Film',
  category: 'Coating',
  description: 'A thin iridescent slick pooled in the low points, the way spilled oil finds every recess.',
  requiresBake: true,
  swatch: ['#3c2f52', '#191426'],
  build: () =>
    group('Oil Film', [
      {
        name: 'Oil',
        material: 'oil-slick',
        opacity: 0.85,
        base: 0,
        generators: [
          { type: 'dirt', params: { threshold: 0.42, softness: 0.55, grungeAmount: 0.4, grungeScale: 18 } },
        ],
      },
    ]),
})

register({
  id: 'frost',
  name: 'Frost',
  category: 'Coating',
  description: 'Ice crystallised on exposed faces and thin sections, which is where heat leaves a shape first.',
  requiresBake: true,
  swatch: ['#cfe4ee', '#8fb2c4'],
  build: () =>
    group('Frost', [
      {
        name: 'Frost',
        material: 'frost-ice',
        base: 0,
        generators: [
          { type: 'lightDirt', params: { dirY: 1, spread: 1, occlusion: 0.4, grungeAmount: 0.5, grungeScale: 40 } },
          { type: 'thickness', params: { threshold: 0.4, softness: 0.3 }, blend: 'lighten', opacity: 0.5 },
        ],
      },
    ]),
})

register({
  id: 'cavity-shade',
  name: 'Cavity Shade',
  category: 'Surface',
  description:
    'Not dirt - depth. A multiply layer keyed to occlusion, which is the cheapest way to stop a flat material reading as a decal on a complicated shape.',
  requiresBake: true,
  swatch: ['#3a3a3d', '#1a1a1c'],
  build: () =>
    group('Cavity Shade', [
      {
        name: 'Cavity Shade',
        material: 'plain',
        params: { color: [0.32, 0.31, 0.3] },
        only: ['baseColor'],
        blends: { baseColor: 'multiply' },
        opacity: 0.75,
        base: 0,
        generators: [{ type: 'dirt', params: { threshold: 0.35, softness: 0.6, grungeAmount: 0 } }],
      },
    ]),
})

register({
  id: 'colour-variation',
  name: 'Colour Variation',
  category: 'Surface',
  description:
    'Large slow blotches of tint over whatever is underneath. Nothing real is one flat colour across a whole object, and this is the layer that fixes that in one click.',
  requiresBake: false,
  swatch: ['#7d7466', '#5b5449'],
  build: () =>
    group('Colour Variation', [
      {
        name: 'Variation',
        material: 'plain',
        params: { color: [0.45, 0.42, 0.38] },
        only: ['baseColor'],
        blends: { baseColor: 'overlay' },
        opacity: 0.45,
        base: 0,
        generators: [{ type: 'grunge', params: { kind: 0, scale: 3.5, warpAmount: 0.8, contrast: 0.15 } }],
      },
    ]),
})

// ---------------------------------------------------------------------------

export function getSmartMaterial(id: string): SmartMaterialDef | null {
  return registry.get(id) ?? null
}

export function listSmartMaterials(): SmartMaterialDef[] {
  return [...registry.values()]
}

/** Machine-readable summary, for the headless API and for tooling. */
export function describeSmartMaterials() {
  return listSmartMaterials().map((def) => ({
    id: def.id,
    name: def.name,
    category: def.category,
    description: def.description,
    requiresBake: def.requiresBake,
  }))
}
