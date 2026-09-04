/**
 * Glass.
 *
 * Transparency here is the *opacity* channel, not a refraction solve: these
 * materials describe what the surface does to light that hits it, and let the
 * viewport's own transmission handle what passes through. What separates a
 * convincing pane from a grey rectangle is therefore never the alpha value -
 * it is everything sitting on the glass. Float glass is faintly wavy, every
 * pane is smudged where hands touched it, and the edges of a break are
 * brighter than the body because they scatter.
 *
 * The recurring construction is: an almost-flat height field for the pane, a
 * separate high-frequency field for whatever is stuck to it, and roughness
 * driven by the second while opacity follows both.
 */

import { float, fract, max, min, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  brickGrid,
  cavityAO,
  cracks,
  fbm01,
  gradient3,
  hash21,
  microVariation,
  normalFromHeightFn,
  polar,
  ridged,
  scratches,
  sparkle,
  stripes,
  tintVariation,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
  warp,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

// ---------------------------------------------------------------------------

export const clearGlass = registerMaterial({
  id: 'clear-glass',
  name: 'Clear Glass',
  category: 'Glass',
  description: 'Float glass with the two things a flat transparent quad always misses: the slow waviness left by the float bath, and the handling smudge that makes the surface visible at all. Both ride on roughness as well as normal, because a fingerprint scatters more than it bends.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.86, 0.93, 0.9], group: 'Colour', description: 'Glass is never colourless: soda-lime is faintly green on edge.' },
    { key: 'opacity', label: 'Opacity', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.04, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'waviness', label: 'Float Waviness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The long, shallow ripple every drawn pane carries. Reflections bend along it.' },
    { key: 'waveScale', label: 'Wave Scale', type: 'float', default: 3, min: 0.2, max: 30, step: 0.1, group: 'Surface' },
    { key: 'smudge', label: 'Handling Smudge', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Grime' },
    { key: 'dust', label: 'Dust', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Grime', description: 'Isolated specks, one per cell, so they never clump into a haze.' },
    { key: 'scratches', label: 'Scratches', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Grime' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const waveAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(p.float('waveScale')), offset), 3, 2, 0.5).sub(0.5).mul(p.float('waviness'))

    const normal = normalFromHeightFn(waveAt, ctx.uv, ctx.texel, p.float('waviness').mul(0.25).add(0.02))

    const smudge = smoothstep(float(0.44), float(0.78), fbm01(coord3(ctx, 9).add(11), 4, 2.2, 0.55))
      .mul(p.float('smudge'))
    const dust = sparkle(ctx.uv, float(420), offset.add(5), float(0.06)).mul(p.float('dust'))
    const scuff = scratches(ctx.uv.add(vec2(offset, offset)), float(0.8), float(60), float(260))
      .mul(p.float('scratches'))

    // Anything stuck to the pane both scatters and blocks: one field drives
    // roughness and opacity together, which is why smudges read as smudges
    // rather than as a printed decal.
    const dirt = smudge.mul(0.7).add(dust).add(scuff.mul(0.5)).clamp(0, 1)

    return {
      baseColor: p.color('tint'),
      metallic: float(0),
      roughness: p.float('roughness').add(dirt.mul(0.45)).clamp(0.005, 1),
      opacity: p.float('opacity').add(dirt.mul(0.55)).clamp(0, 1),
      height: waveAt(ctx.uv).mul(0.5).add(0.5),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const frostedGlass = registerMaterial({
  id: 'frosted-glass',
  name: 'Frosted Glass',
  category: 'Glass',
  description: 'Acid-etched or sandblasted glass. The etch is a dense micro-pit field, so the normal stays busy at any zoom while the macro surface stays flat - the opposite balance to clear glass, and the reason it reads as translucent rather than dirty.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.9, 0.94, 0.95], group: 'Colour' },
    { key: 'opacity', label: 'Opacity', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.62, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'etchScale', label: 'Etch Scale', type: 'float', default: 180, min: 10, max: 900, step: 1, group: 'Etch' },
    { key: 'etchDepth', label: 'Etch Depth', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Etch' },
    { key: 'blastVariation', label: 'Blast Unevenness', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Etch', description: 'A hand-held blaster does not cover evenly; patches stay clearer.' },
    { key: 'clearPatches', label: 'Clear Patches', type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Etch', description: 'Masked-off areas that were never etched, as on a bathroom window.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const etchAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(p.float('etchScale')), offset), 3, 2.4, 0.6).sub(0.5).mul(p.float('etchDepth'))

    const normal = normalFromHeightFn(etchAt, ctx.uv, ctx.texel, p.float('etchDepth').mul(0.06))

    // Coverage varies at two scales: broad passes of the blaster, and the
    // masked patches that never got hit at all.
    const coverage = mix(
      float(1),
      fbm01(coord3(ctx, 5).add(17), 4, 2.1, 0.55),
      p.float('blastVariation'),
    )
    const clear = smoothstep(float(0.62), float(0.82), fbm01(coord3(ctx, 2.2).add(29), 3, 2, 0.5))
      .mul(p.float('clearPatches'))
    const etched = coverage.mul(clear.oneMinus()).clamp(0, 1)

    return {
      baseColor: p.color('tint'),
      metallic: float(0),
      roughness: mix(float(0.05), p.float('roughness'), etched).clamp(0.02, 1),
      opacity: mix(float(0.08), p.float('opacity'), etched).clamp(0, 1),
      height: etchAt(ctx.uv).mul(0.4).add(0.5),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const stainedGlass = registerMaterial({
  id: 'stained-glass',
  name: 'Stained Glass',
  category: 'Glass',
  description: 'Coloured cames leaded together. Each Voronoi cell is one piece of glass with its own hue and its own thickness, and the lead between them is opaque metal - the abrupt change from a transmissive dielectric to a dull metal at the joint is the whole effect.',
  params: [
    { key: 'colorA', label: 'Glass A', type: 'color', default: [0.15, 0.28, 0.62], group: 'Colour' },
    { key: 'colorB', label: 'Glass B', type: 'color', default: [0.68, 0.16, 0.16], group: 'Colour' },
    { key: 'colorC', label: 'Glass C', type: 'color', default: [0.85, 0.7, 0.2], group: 'Colour' },
    { key: 'leadColor', label: 'Lead Came', type: 'color', default: [0.16, 0.16, 0.17], group: 'Colour' },
    { key: 'scale', label: 'Piece Size', type: 'float', default: 7, min: 1, max: 60, step: 0.1, group: 'Layout' },
    { key: 'jitter', label: 'Irregularity', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'leadWidth', label: 'Came Width', type: 'float', default: 0.07, min: 0.005, max: 0.35, step: 0.001, group: 'Layout' },
    { key: 'opacity', label: 'Glass Opacity', type: 'float', default: 0.42, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'ripple', label: 'Cathedral Ripple', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Hand-rolled glass is never flat. The ripple is what makes each piece read as glass and not as paint.' },
    { key: 'grime', label: 'Age Grime', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const cellAt = (uvNode: V2) => voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), p.float('jitter'))

    // The came sits proud of the glass on both faces, so the height field is a
    // ridge along the border rather than a groove.
    const heightAt = (uvNode: V2): F => {
      const cells = cellAt(uvNode)
      const border = voronoiBorder(cells)
      const lead = smoothstep(p.float('leadWidth'), float(0), border)
      const ripple = fbm01(vec3(uvNode.mul(scale.mul(6)), offset.add(3)), 3, 2.1, 0.55)
        .sub(0.5)
        .mul(p.float('ripple'))
        .mul(0.25)
      return lead.mul(0.5).add(ripple.mul(lead.oneMinus()))
    }

    const cells = cellAt(ctx.uv)
    const lead = smoothstep(p.float('leadWidth'), p.float('leadWidth').mul(0.4), voronoiBorder(cells))
    const id = voronoiCellValue(cells)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.8))
    const h = heightAt(ctx.uv)

    // Per-piece hue jitter on top of the three-way ramp: a real window was cut
    // from several sheets, so no two neighbours match exactly.
    const glass = tintVariation(
      gradient3(id, p.color('colorA'), p.color('colorB'), p.color('colorC')),
      hash21(cells.zw.add(vec2(7.3, 1.9))),
      0.03,
      0.25,
      0.28,
    )

    const grime = smoothstep(float(0.45), float(0.85), fbm01(coord3(ctx, scale.mul(0.8)).add(23), 4, 2.1, 0.55))
      .mul(p.float('grime'))

    return {
      baseColor: mix(glass, p.color('leadColor'), lead).mul(mix(float(1), float(0.6), grime.mul(0.7))),
      // Lead is metal, glass is not. Everything else follows from that split.
      metallic: lead.mul(0.9),
      roughness: mix(float(0.14), float(0.68), lead).add(grime.mul(0.25)).clamp(0.03, 1),
      opacity: mix(p.float('opacity').mul(mix(float(0.7), float(1.2), id)), float(1), lead).clamp(0, 1),
      ao: cavityAO(h.add(0.5).clamp(0, 1), normal, 0.45),
      height: h.add(0.4).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const crackedGlass = registerMaterial({
  id: 'cracked-glass',
  name: 'Cracked Glass',
  category: 'Glass',
  description: 'A pane struck at one point. Radial cracks run outwards from the impact and concentric ones ring it, both fading with distance - that combination is what a real break makes, and a uniform crack net is what it never makes.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.88, 0.93, 0.92], group: 'Colour' },
    { key: 'crackColor', label: 'Crack Colour', type: 'color', default: [0.95, 0.97, 1], group: 'Colour', description: 'A fracture surface scatters, so it reads brighter than the pane around it.' },
    { key: 'impactX', label: 'Impact X', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Impact' },
    { key: 'impactY', label: 'Impact Y', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Impact' },
    { key: 'radials', label: 'Radial Cracks', type: 'float', default: 22, min: 3, max: 90, step: 1, group: 'Impact' },
    { key: 'rings', label: 'Concentric Cracks', type: 'float', default: 7, min: 0, max: 30, step: 0.5, group: 'Impact' },
    { key: 'reach', label: 'Reach', type: 'float', default: 0.55, min: 0.05, max: 2, step: 0.01, group: 'Impact', description: 'How far the damage travels before the pane holds.' },
    { key: 'shatter', label: 'Crush Zone', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Impact', description: 'The pulverised area right at the strike, where the glass went white.' },
    { key: 'width', label: 'Crack Width', type: 'float', default: 0.02, min: 0.002, max: 0.15, step: 0.001, group: 'Surface' },
    { key: 'opacity', label: 'Opacity', type: 'float', default: 0.14, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const centre = vec2(p.float('impactX'), p.float('impactY'))

    const crackAt = (uvNode: V2): F => {
      const pc = polar(uvNode, centre)
      const r = pc.x
      const a = pc.y
      // Radial spokes, angle-jittered so they are not a clean starburst.
      const jitter = fbm01(vec3(a.mul(9), r.mul(3), offset), 3, 2, 0.5).sub(0.5).mul(0.35)
      const spokes = stripes(a.mul(p.float('radials')).add(jitter), float(0.5), float(0.14))
      const spokeLine = smoothstep(float(0.5).sub(p.float('width').mul(8)), float(0.5), spokes)
      // Rings, pushed around so they buckle instead of drawing perfect circles.
      const ringR = r.add(fbm01(vec3(uvNode.mul(14), offset.add(5)), 3, 2, 0.5).sub(0.5).mul(0.06))
      const ring = stripes(ringR.mul(p.float('rings')), float(0.5), float(0.12))
      const ringLine = smoothstep(float(0.62), float(0.95), ring).mul(smoothstep(float(0.02), float(0.12), r))
      // Everything fades with distance from the strike.
      const falloff = smoothstep(p.float('reach'), p.float('reach').mul(0.15), r)
      return max(spokeLine, ringLine.mul(0.85)).mul(falloff)
    }

    const heightAt = (uvNode: V2): F => crackAt(uvNode).negate().mul(0.6)
    const crack = crackAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))

    const r = polar(ctx.uv, centre).x
    const crush = smoothstep(p.float('reach').mul(0.16), float(0), r)
      .mul(p.float('shatter'))
      .mul(fbm01(coord3(ctx, 90).add(31), 3, 2.2, 0.6).add(0.4).clamp(0, 1))

    const broken = crack.add(crush).clamp(0, 1)

    return {
      baseColor: mix(p.color('tint'), p.color('crackColor'), broken),
      metallic: float(0),
      roughness: mix(float(0.05), float(0.5), broken).clamp(0.02, 1),
      opacity: mix(p.float('opacity'), float(0.92), broken).clamp(0, 1),
      height: heightAt(ctx.uv).add(0.6).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const glassBlocks = registerMaterial({
  id: 'glass-blocks',
  name: 'Glass Blocks',
  category: 'Glass',
  description: 'Moulded glass brick, laid in a stack bond with mortar between. The face carries the pressed pattern the mould left; the joints are ordinary cement, which is what stops the wall from reading as a single sheet.',
  params: [
    { key: 'tint', label: 'Glass Tint', type: 'color', default: [0.76, 0.87, 0.86], group: 'Colour' },
    { key: 'mortarColor', label: 'Mortar', type: 'color', default: [0.62, 0.61, 0.58], group: 'Colour' },
    { key: 'rows', label: 'Rows', type: 'float', default: 6, min: 1, max: 40, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Aspect', type: 'float', default: 1, min: 0.2, max: 4, step: 0.01, group: 'Layout' },
    { key: 'bond', label: 'Row Offset', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'joint', label: 'Joint Width', type: 'float', default: 0.07, min: 0.005, max: 0.4, step: 0.001, group: 'Layout' },
    { key: 'bevel', label: 'Face Bevel', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'pattern', label: 'Mould Pattern', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The pressed ribbing inside the face, which is what diffuses the light.' },
    { key: 'patternScale', label: 'Pattern Scale', type: 'float', default: 26, min: 2, max: 160, step: 0.5, group: 'Surface' },
    { key: 'opacity', label: 'Glass Opacity', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const rows = p.float('rows')
    const cols = rows.mul(p.float('aspect'))

    const gridAt = (uvNode: V2) => brickGrid(vec2(uvNode.x.mul(cols), uvNode.y.mul(rows)), p.float('bond'))

    const blockAt = (uvNode: V2): F => {
      const g = gridAt(uvNode)
      const j = p.float('joint')
      const d = max(float(0), min(min(g.x, g.x.oneMinus()), min(g.y, g.y.oneMinus())))
      return smoothstep(j, j.add(p.float('bevel').mul(0.14).add(0.01)), d)
    }

    const heightAt = (uvNode: V2): F => {
      const block = blockAt(uvNode)
      // The mould pattern is a crossed rib, not noise: it was pressed by a die.
      const s = p.float('patternScale')
      const ribs = stripes(uvNode.x.mul(s), float(0.5), float(0.2))
        .mul(stripes(uvNode.y.mul(s), float(0.5), float(0.2)))
        .mul(p.float('pattern'))
      return block.mul(float(0.55).add(ribs.mul(0.18)))
    }

    const block = blockAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.1))
    const h = heightAt(ctx.uv)
    const g = gridAt(ctx.uv)
    const id = hash21(g.zw.add(vec2(offset, offset)))

    const grit = fbm01(coord3(ctx, cols.mul(8)).add(13), 4, 2, 0.5)
    const mortar = p.color('mortarColor').mul(mix(float(0.8), float(1.1), grit))
    const glass = p.color('tint').mul(mix(float(0.94), float(1.06), id))

    return {
      baseColor: mix(mortar, glass, block),
      metallic: float(0),
      roughness: mix(float(0.95), float(0.12).add(microVariation(ctx.uv, cols.mul(3), offset).mul(0.06)), block).clamp(0.03, 1),
      opacity: mix(float(1), p.float('opacity'), block).clamp(0, 1),
      ao: cavityAO(h.div(float(0.6)).clamp(0, 1), normal, 0.7),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const wiredGlass = registerMaterial({
  id: 'wired-glass',
  name: 'Wired Safety Glass',
  category: 'Glass',
  description: 'Georgian wired glass: a welded steel mesh cast into the pane. The wire is metal seen *through* glass, so it stays sharp while the glass around it is smeared by its own ripple - and where the pane has cracked, the wire holds the pieces in place.',
  params: [
    { key: 'tint', label: 'Glass Tint', type: 'color', default: [0.82, 0.9, 0.84], group: 'Colour' },
    { key: 'wireColor', label: 'Wire', type: 'color', default: [0.4, 0.39, 0.37], group: 'Colour' },
    { key: 'grid', label: 'Mesh Density', type: 'float', default: 22, min: 2, max: 120, step: 0.5, group: 'Mesh' },
    { key: 'wireWidth', label: 'Wire Width', type: 'float', default: 0.07, min: 0.005, max: 0.4, step: 0.001, group: 'Mesh' },
    { key: 'sag', label: 'Mesh Sag', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Mesh', description: 'The wire is laid by hand into molten glass, so the grid wanders.' },
    { key: 'opacity', label: 'Glass Opacity', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'ripple', label: 'Rolled Ripple', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'damage', label: 'Cracking', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const grid = p.float('grid')

    const wireAt = (uvNode: V2): F => {
      // Warping the sample space before the lines is what makes the mesh sag;
      // warping the result would only blur it.
      const wobble = warp(vec3(uvNode.mul(3), offset), p.float('sag').mul(0.04), 2.2)
      const q = vec2(wobble.x, wobble.y).mul(grid)
      const w = p.float('wireWidth')
      const fx = fract(q.x)
      const fy = fract(q.y)
      const vLine = smoothstep(w, float(0), min(fx, fx.oneMinus()))
      const hLine = smoothstep(w, float(0), min(fy, fy.oneMinus()))
      return max(vLine, hLine)
    }

    const rippleAt = (uvNode: V2): F =>
      ridged(vec3(uvNode.mul(18), offset.add(7)), float(2), float(0.5)).mul(p.float('ripple')).mul(0.12)

    const heightAt = (uvNode: V2): F => rippleAt(uvNode).add(wireAt(uvNode).mul(0.1))

    const wire = wireAt(ctx.uv).clamp(0, 1)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.7))
    const crack = cracks(ctx.uv, float(9), float(0.05), offset.add(41)).mul(p.float('damage'))

    return {
      baseColor: mix(p.color('tint'), p.color('wireColor'), wire).mul(mix(float(1), float(1.3), crack)),
      metallic: wire.mul(0.85),
      roughness: mix(float(0.12).add(crack.mul(0.4)), float(0.55), wire).clamp(0.03, 1),
      opacity: mix(p.float('opacity').add(crack.mul(0.5)), float(1), wire).clamp(0, 1),
      height: heightAt(ctx.uv).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const GLASS = [clearGlass, frostedGlass, stainedGlass, crackedGlass, glassBlocks, wiredGlass]
