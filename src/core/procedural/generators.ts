/**
 * Mask generators.
 *
 * This is the machinery behind "smart" materials. A generator is a function
 * from baked mesh maps to a grayscale mask, so an effect expressed as
 * "wear on the edges" becomes a *function of geometry* rather than a painting
 * job. Rebake after changing the mesh and the wear moves with the new edges.
 *
 * The two workhorses are curvature (convex = edges, concave = cracks) and
 * ambient occlusion (enclosed = dirt traps). Almost every classic effect is one
 * of those pushed through levels and broken up with noise.
 */

import { abs, dot, float, max, mix, normalize, smoothstep, vec2, vec3 } from 'three/tsl'
import type { AnchorRef, AnchorSource, GeneratorType, ParamValue } from '../doc/types'
import type { ChannelBundle, F, V2, V3 } from '../gpu/nodes'
import { fbm01, ridged, scratches as scratchField, voronoi2, voronoiBorder, warp } from './noise'
import type { MeshMapNodes } from './material'
import type { ParamDef } from './params'
import { ParamBag, defaultValues } from './params'

/**
 * What one anchored layer offers the layers above it.
 *
 * These are live nodes from the *same* fused shader, not a rendered texture.
 * The compositor already computed this layer's mask and its channel bundle on
 * the way past; an anchor is simply a name kept on them so a generator further
 * up can wire itself to the node instead of recomputing anything.
 */
export interface AnchorOutputs {
  /** The layer's mask, including where a paint layer's brush actually landed. */
  mask: F
  /** What the layer itself produced, before it was blended into the stack. */
  bundle: ChannelBundle
}

export interface GenContext {
  uv: V2
  texel: F
  params: ParamBag
  meshMaps: MeshMapNodes
  /** Anchor points published *below* this generator's layer, keyed by layer id. */
  anchors: Map<string, AnchorOutputs>
  /** The anchor this generator instance was pointed at, if any. */
  anchorRef: AnchorRef | null
}

export interface GeneratorDef {
  type: GeneratorType
  name: string
  description: string
  /** Whether this generator needs baked mesh maps to do anything useful. */
  requiresBake: boolean
  params: readonly ParamDef[]
  build(ctx: GenContext): F
}

const GRUNGE_PARAMS: readonly ParamDef[] = [
  { key: 'grungeAmount', label: 'Break-up', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Break-up', description: 'Multiplies noise into the mask so the effect looks eroded rather than stencilled.' },
  { key: 'grungeScale', label: 'Break-up Scale', type: 'float', default: 30, min: 0.5, max: 400, step: 0.5, group: 'Break-up' },
  { key: 'grungeContrast', label: 'Break-up Contrast', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Break-up' },
  { key: 'seed', label: 'Seed', type: 'float', default: 0, min: 0, max: 100, step: 0.01, group: 'Break-up' },
]

/** Shared noise break-up. Returns 1 when break-up is disabled. */
function grunge(ctx: GenContext): F {
  const amount = ctx.params.float('grungeAmount')
  const n = fbm01(vec3(ctx.uv.mul(ctx.params.float('grungeScale')), ctx.params.float('seed').mul(13.1)), 4, 2.1, 0.55)
  const contrast = ctx.params.float('grungeContrast')
  const shaped = smoothstep(contrast.mul(0.5), float(1).sub(contrast.mul(0.5)), n)
  return mix(float(1), shaped, amount)
}

const registry = new Map<GeneratorType, GeneratorDef>()

function register(def: GeneratorDef): GeneratorDef {
  registry.set(def.type, def)
  return def
}

// ---------------------------------------------------------------------------

register({
  type: 'curvature',
  name: 'Curvature (Edge Wear)',
  description: 'Masks convex edges, concave cavities, or both. This is the generator behind chipped paint and polished corners.',
  requiresBake: true,
  params: [
    { key: 'edges', label: 'Convex Edges', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Curvature' },
    { key: 'cavities', label: 'Concave Cavities', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Curvature' },
    { key: 'range', label: 'Range', type: 'float', default: 0.2, min: 0.001, max: 0.5, step: 0.001, group: 'Curvature', description: 'How far from perfectly flat the mask starts to open. Small values pick only the sharpest edges.' },
    { key: 'bias', label: 'Bias', type: 'float', default: 0, min: -0.4, max: 0.4, step: 0.001, group: 'Curvature' },
    ...GRUNGE_PARAMS,
  ],
  build(ctx) {
    const c = ctx.meshMaps.curvature.sub(0.5).sub(ctx.params.float('bias'))
    const range = max(ctx.params.float('range'), float(1e-3))
    const convex = smoothstep(float(0), range, c)
    const concave = smoothstep(float(0), range, c.negate())
    const combined = convex.mul(ctx.params.float('edges')).add(concave.mul(ctx.params.float('cavities')))
    return combined.clamp(0, 1).mul(grunge(ctx))
  },
})

register({
  type: 'dirt',
  name: 'Dirt (Occlusion)',
  description: 'Masks enclosed areas from the baked AO map. Dust, grime and rust all settle where air does not move.',
  requiresBake: true,
  params: [
    { key: 'strength', label: 'Strength', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Occlusion' },
    { key: 'threshold', label: 'Threshold', type: 'float', default: 0.65, min: 0, max: 1, step: 0.001, group: 'Occlusion' },
    { key: 'softness', label: 'Softness', type: 'float', default: 0.35, min: 0.001, max: 1, step: 0.001, group: 'Occlusion' },
    ...GRUNGE_PARAMS,
  ],
  build(ctx) {
    const occluded = ctx.meshMaps.ao.oneMinus()
    const t = ctx.params.float('threshold').oneMinus()
    const s = max(ctx.params.float('softness'), float(1e-3))
    return smoothstep(t.sub(s), t.add(s), occluded).mul(ctx.params.float('strength')).mul(grunge(ctx))
  },
})

register({
  type: 'position',
  name: 'Position Gradient',
  description: 'A gradient along one axis of the mesh bounding box, optionally gated by which way the surface faces. This is how you get snow on top and drips below.',
  requiresBake: true,
  params: [
    { key: 'axis', label: 'Axis', type: 'int', default: 1, min: 0, max: 2, step: 1, group: 'Gradient', description: '0 = X, 1 = Y (up), 2 = Z.' },
    { key: 'start', label: 'Start', type: 'float', default: 0.4, min: -0.5, max: 1.5, step: 0.001, group: 'Gradient' },
    { key: 'end', label: 'End', type: 'float', default: 0.9, min: -0.5, max: 1.5, step: 0.001, group: 'Gradient' },
    { key: 'facing', label: 'Facing Influence', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Gradient', description: 'Requires the surface to point along the axis, not merely to sit high on it.' },
    { key: 'facingPower', label: 'Facing Falloff', type: 'float', default: 2, min: 0.2, max: 12, step: 0.01, group: 'Gradient' },
    ...GRUNGE_PARAMS,
  ],
  build(ctx) {
    const axis = ctx.params.float('axis')
    const pos = pickAxis(ctx.meshMaps.position, axis)
    const nrm = pickAxis(ctx.meshMaps.normal, axis)
    const gradient = smoothstep(ctx.params.float('start'), ctx.params.float('end'), pos)
    const facing = nrm.clamp(0, 1).pow(max(ctx.params.float('facingPower'), float(0.05)))
    return gradient.mul(mix(float(1), facing, ctx.params.float('facing'))).mul(grunge(ctx))
  },
})

register({
  type: 'thickness',
  name: 'Thickness',
  description: 'Masks thin parts of the mesh, from the baked thickness map. Good for wear that eats through fins and edges, or for translucency.',
  requiresBake: true,
  params: [
    { key: 'threshold', label: 'Threshold', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Thickness' },
    { key: 'softness', label: 'Softness', type: 'float', default: 0.25, min: 0.001, max: 1, step: 0.001, group: 'Thickness' },
    { key: 'invert', label: 'Mask Thick Instead', type: 'bool', default: false, group: 'Thickness' },
    ...GRUNGE_PARAMS,
  ],
  build(ctx) {
    const t = ctx.meshMaps.thickness
    const th = ctx.params.float('threshold')
    const s = max(ctx.params.float('softness'), float(1e-3))
    const thin = smoothstep(th.sub(s), th.add(s), t).oneMinus()
    const thick = smoothstep(th.sub(s), th.add(s), t)
    return mix(thin, thick, ctx.params.float('invert')).mul(grunge(ctx))
  },
})

register({
  type: 'lightDirt',
  name: 'Directional Exposure',
  description: 'Masks whatever faces a chosen direction. Sun bleaching, rain streaking and one-sided dust all come from this.',
  requiresBake: true,
  params: [
    { key: 'dirX', label: 'Direction X', type: 'float', default: 0, min: -1, max: 1, step: 0.01, group: 'Direction' },
    { key: 'dirY', label: 'Direction Y', type: 'float', default: 1, min: -1, max: 1, step: 0.01, group: 'Direction' },
    { key: 'dirZ', label: 'Direction Z', type: 'float', default: 0, min: -1, max: 1, step: 0.01, group: 'Direction' },
    { key: 'spread', label: 'Spread', type: 'float', default: 0.6, min: 0.01, max: 2, step: 0.01, group: 'Direction' },
    { key: 'occlusion', label: 'Occlusion Influence', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Direction', description: 'Shadowed pockets receive less, even when they face the right way.' },
    ...GRUNGE_PARAMS,
  ],
  build(ctx) {
    const dir = normalize(vec3(ctx.params.float('dirX'), ctx.params.float('dirY'), ctx.params.float('dirZ')).add(vec3(1e-5, 1e-5, 1e-5)))
    const facing = dot(ctx.meshMaps.normal, dir).mul(0.5).add(0.5)
    const shaped = smoothstep(float(1).sub(ctx.params.float('spread')), float(1), facing)
    return shaped.mul(mix(float(1), ctx.meshMaps.ao, ctx.params.float('occlusion'))).mul(grunge(ctx))
  },
})

register({
  type: 'grunge',
  name: 'Grunge Noise',
  description: 'Pure procedural noise, no geometry needed. Use it as a break-up layer or as the whole mask when you just want variation.',
  requiresBake: false,
  params: [
    { key: 'kind', label: 'Noise', type: 'int', default: 0, min: 0, max: 3, step: 1, group: 'Noise', description: '0 = fractal, 1 = ridged, 2 = cells, 3 = cell borders.' },
    { key: 'scale', label: 'Scale', type: 'float', default: 12, min: 0.2, max: 400, step: 0.1, group: 'Noise' },
    { key: 'octaves', label: 'Octaves', type: 'float', default: 5, min: 1, max: 8, step: 1, group: 'Noise' },
    { key: 'gain', label: 'Gain', type: 'float', default: 0.55, min: 0.05, max: 0.95, step: 0.01, group: 'Noise' },
    { key: 'warpAmount', label: 'Warp', type: 'float', default: 0.25, min: 0, max: 3, step: 0.01, group: 'Noise' },
    { key: 'contrast', label: 'Contrast', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Noise' },
    { key: 'seed', label: 'Seed', type: 'float', default: 0, min: 0, max: 100, step: 0.01, group: 'Noise' },
  ],
  build(ctx) {
    const p = ctx.params
    const seed = p.float('seed').mul(13.1)
    const base = warp(vec3(ctx.uv.mul(p.float('scale')), seed), p.float('warpAmount'), 1.2)
    const fractal = fbm01(base, 5, 2.1, 0.55)
    const ridge = ridged(base, p.float('octaves'), p.float('gain'))
    const cells = voronoi2(ctx.uv.mul(p.float('scale')), float(1))
    const cellValue = cells.x.clamp(0, 1)
    const borders = smoothstep(float(0), float(0.12), voronoiBorder(cells)).oneMinus()

    // `kind` is a uniform, so switching noise type never recompiles the shader.
    const kind = p.float('kind')
    const value = mix(
      mix(fractal, ridge, pick(kind, 1)),
      mix(cellValue, borders, pick(kind, 3)),
      pick(kind, 2).add(pick(kind, 3)).clamp(0, 1),
    )
    const c = p.float('contrast')
    return smoothstep(c.mul(0.5), float(1).sub(c.mul(0.5)), value)
  },
})

register({
  type: 'fill',
  name: 'Uniform Fill',
  description: 'A constant value. Useful as the bottom of a mask stack, or to knock a whole layer back with a blend mode.',
  requiresBake: false,
  params: [{ key: 'value', label: 'Value', type: 'float', default: 1, min: 0, max: 1, step: 0.001, group: 'Fill' }],
  build(ctx) {
    return ctx.params.float('value')
  },
})

register({
  type: 'idSelect',
  name: 'Mesh ID',
  description:
    'Masks one part of the source mesh: a material slot, a separate object, a vertex-colour ID, or a face group. Dropping a catalogue material onto the viewport writes this generator for you.',
  requiresBake: false,
  params: [
    {
      key: 'partId',
      label: 'Part',
      type: 'int',
      default: 0,
      min: 0,
      max: 255,
      step: 1,
      group: 'ID',
      description: 'Index of the source-mesh part to keep. Everything else is masked out.',
    },
  ],
  build(ctx) {
    const id = ctx.meshMaps.partId
    const target = ctx.params.float('partId')
    // Integer IDs, nearest-sampled: a 0.5 window is an exact match.
    const match = float(1).sub(abs(id.sub(target)).mul(2).clamp(0, 1))
    return match.mul(ctx.meshMaps.coverage)
  },
})


register({
  type: 'scratches',
  name: 'Scratches',
  description:
    'Directional scuffs and brush marks. Pure noise, so it needs no bake - but it can be biased towards exposed edges once one exists, which is what stops scratches reading as wallpaper.',
  requiresBake: false,
  params: [
    { key: 'angle', label: 'Angle', type: 'float', default: 0.4, min: -3.15, max: 3.15, step: 0.01, group: 'Scratches' },
    { key: 'density', label: 'Density', type: 'float', default: 26, min: 1, max: 300, step: 0.5, group: 'Scratches' },
    { key: 'stretch', label: 'Stretch', type: 'float', default: 26, min: 1, max: 200, step: 0.5, group: 'Scratches', description: 'How far each mark is drawn out along the angle. High values give long hairline scratches.' },
    { key: 'amount', label: 'Amount', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Scratches' },
    { key: 'edgeBias', label: 'Edge Bias', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Scratches', description: 'Concentrates the marks on convex edges, where something would actually have scraped past. Needs a bake.' },
    { key: 'seed', label: 'Seed', type: 'float', default: 0, min: 0, max: 100, step: 0.01, group: 'Scratches' },
  ],
  build(ctx) {
    const p = ctx.params
    const seed = p.float('seed').mul(7.3)
    const coord = ctx.uv.add(vec2(seed, seed.mul(0.37)))
    const field = scratchField(coord, p.float('angle'), max(p.float('stretch'), float(1)), max(p.float('density'), float(0.01)))
    const edges = smoothstep(float(0.5), float(0.62), ctx.meshMaps.curvature)
    const biased = field.mul(mix(float(1), edges, p.float('edgeBias')))
    return biased.mul(p.float('amount')).clamp(0, 1)
  },
})

register({
  type: 'anchor',
  name: 'Anchor Point',
  description:
    'Reads what another layer produced. Point it at a layer that publishes an anchor and this mask follows that layer as it is edited - paint a chip, then let rust find it, then let grime find the rust.',
  requiresBake: false,
  params: [
    { key: 'contrast', label: 'Contrast', type: 'float', default: 0, min: 0, max: 0.98, step: 0.01, group: 'Anchor', description: 'Tightens the midtones. At 0 the anchor comes through exactly as it is.' },
    { key: 'balance', label: 'Balance', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Anchor', description: 'Where the contrast pivots. Below 0.5 keeps more of the anchor, above 0.5 keeps only its strongest parts.' },
    ...GRUNGE_PARAMS,
  ],
  build(ctx) {
    const ref = ctx.anchorRef
    const outputs = ref ? ctx.anchors.get(ref.layerId) : undefined
    // No anchor selected, or one that lives *above* this layer and therefore
    // has not been evaluated yet. Contributing nothing is the honest answer;
    // the mask panel says so in words.
    if (!ref || !outputs) return float(0)

    const raw = anchorValue(outputs, ref.source).clamp(0, 1)
    const contrast = ctx.params.float('contrast').clamp(0, 0.98)
    const balance = ctx.params.float('balance')
    // At contrast 0 the window spans the whole range and the mix weight is 0,
    // so the anchor comes through untouched; as it rises the window closes
    // around `balance` until the anchor reads as a hard selection. Kept off
    // zero width because WGSL leaves smoothstep indeterminate at low == high.
    const width = max(contrast.oneMinus(), float(0.02)).mul(0.5)
    const shaped = smoothstep(balance.sub(width), balance.add(width), raw)
    return mix(raw, shaped, contrast).mul(grunge(ctx))
  },
})

/** Pulls one scalar out of an anchored layer's outputs. */
function anchorValue(outputs: AnchorOutputs, source: AnchorSource): F {
  switch (source) {
    case 'height':
      return outputs.bundle.height
    case 'luminance':
      return dot(outputs.bundle.baseColor, vec3(0.2126, 0.7152, 0.0722))
    case 'opacity':
      return outputs.bundle.opacity
    case 'roughness':
      return outputs.bundle.roughness
    case 'ao':
      return outputs.bundle.ao
    default:
      return outputs.mask
  }
}

// ---------------------------------------------------------------------------

/** 1 when the uniform `value` equals `target`, 0 otherwise - branch-free. */
function pick(value: F, target: number): F {
  return float(1).sub(abs(value.sub(target)).clamp(0, 1))
}

function pickAxis(v: V3, axis: F): F {
  const isX = pick(axis, 0)
  const isY = pick(axis, 1)
  const isZ = pick(axis, 2)
  return v.x.mul(isX).add(v.y.mul(isY)).add(v.z.mul(isZ))
}

export function getGeneratorDef(type: GeneratorType): GeneratorDef | null {
  return registry.get(type) ?? null
}

export function listGeneratorDefs(): GeneratorDef[] {
  return [...registry.values()]
}

export function defaultGeneratorParams(type: GeneratorType): Record<string, ParamValue> {
  const def = registry.get(type)
  return def ? defaultValues(def.params) : {}
}

export function describeGenerators() {
  return listGeneratorDefs().map((def) => ({
    type: def.type,
    name: def.name,
    description: def.description,
    requiresBake: def.requiresBake,
    params: def.params.map((p) => ({ key: p.key, label: p.label, type: p.type, default: p.default, min: p.min, max: p.max, group: p.group, description: p.description })),
  }))
}
