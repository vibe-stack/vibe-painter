/**
 * Wood, leather, fabric and sand - the materials where the pattern is a
 * *structure* rather than a noise field, so most of the code here is about
 * building grids and interlaces before any noise is applied.
 */

import { cos, float, fract, max, min, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  fbm01,
  gradient3,
  hash21,
  normalFromHeightFn,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
  warp,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

export const woodPlanks = registerMaterial({
  id: 'wood-planks',
  name: 'Wood Planks',
  category: 'Organic',
  description: 'Planks with per-board grain. Growth rings come from a warped radial distance, so knots and ring density change board to board.',
  params: [
    { key: 'planks', label: 'Plank Count', type: 'float', default: 6, min: 1, max: 40, step: 0.5, group: 'Layout' },
    { key: 'stagger', label: 'End Stagger', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'gap', label: 'Gap Width', type: 'float', default: 0.02, min: 0, max: 0.2, step: 0.001, group: 'Layout' },
    { key: 'gapDepth', label: 'Gap Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'lightWood', label: 'Light Wood', type: 'color', default: [0.55, 0.36, 0.19], group: 'Colour' },
    { key: 'midWood', label: 'Mid Wood', type: 'color', default: [0.4, 0.24, 0.12], group: 'Colour' },
    { key: 'darkWood', label: 'Dark Wood', type: 'color', default: [0.22, 0.12, 0.06], group: 'Colour' },
    { key: 'ringDensity', label: 'Ring Density', type: 'float', default: 22, min: 1, max: 120, step: 0.5, group: 'Grain' },
    { key: 'ringWobble', label: 'Ring Wobble', type: 'float', default: 0.35, min: 0, max: 2, step: 0.01, group: 'Grain' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.45, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'variation', label: 'Board Variation', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Colour' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const planks = p.float('planks')

    // Board id: rows across V, staggered ends along U.
    const boardAt = (uvNode: V2) => {
      const row = uvNode.y.mul(planks)
      const rowIndex = row.floor()
      const shift = hash21(vec2(rowIndex, offset)).mul(p.float('stagger'))
      const u = uvNode.x.add(shift)
      return { local: vec2(fract(u), fract(row)), id: vec2(u.floor(), rowIndex) }
    }

    const gapAt = (uvNode: V2): F => {
      const b = boardAt(uvNode)
      const g = p.float('gap')
      const dy = min(b.local.y, b.local.y.oneMinus())
      const dx = min(b.local.x, b.local.x.oneMinus())
      return smoothstep(g.mul(0.4), g, min(dx.mul(planks.mul(0.25)), dy))
    }

    const ringsAt = (uvNode: V2): F => {
      const b = boardAt(uvNode)
      const seedForBoard = hash21(b.id.add(vec2(offset, offset))).mul(37)
      // Rings run along the board, wobbled so they are not dead straight.
      const w = warp(vec3(uvNode.x.mul(1.5), b.local.y.mul(3).add(seedForBoard), seedForBoard), p.float('ringWobble'), 2.5)
      const d = w.y.add(w.x.mul(0.35))
      const rings = sin(d.mul(p.float('ringDensity'))).mul(0.5).add(0.5)
      const fine = fbm01(vec3(uvNode.mul(vec2(80, 8)), seedForBoard), 3, 2, 0.5)
      return rings.mul(0.75).add(fine.mul(0.25))
    }

    const heightAt = (uvNode: V2): F =>
      ringsAt(uvNode).mul(p.float('grainDepth')).mul(gapAt(uvNode)).sub(gapAt(uvNode).oneMinus().mul(p.float('gapDepth')))

    const b = boardAt(ctx.uv)
    const boardTone = mix(float(0.5), hash21(b.id.add(vec2(offset.add(3), offset))), p.float('variation'))
    const rings = ringsAt(ctx.uv)
    const gap = gapAt(ctx.uv)
    const colour = gradient3(rings.mul(0.65).add(boardTone.mul(0.35)), p.color('darkWood'), p.color('midWood'), p.color('lightWood'))

    return {
      baseColor: mix(vec3(0.02, 0.015, 0.01), colour, gap),
      metallic: float(0),
      roughness: p.float('roughness').add(rings.sub(0.5).mul(0.12)).clamp(0.05, 1),
      ao: mix(float(0.35), float(1), gap),
      height: heightAt(ctx.uv).mul(0.5).add(0.5),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('grainDepth').add(p.float('gapDepth'))),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const leather = registerMaterial({
  id: 'leather',
  name: 'Leather',
  category: 'Organic',
  description: 'Grained leather. Voronoi cells become the pebbled surface; the creases between them are the cell borders, deepened by a second noise so they are not uniform.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.24, 0.13, 0.09], group: 'Colour' },
    { key: 'highlight', label: 'Highlight', type: 'color', default: [0.45, 0.29, 0.2], group: 'Colour' },
    { key: 'scale', label: 'Grain Density', type: 'float', default: 55, min: 4, max: 400, step: 0.5, group: 'Pattern' },
    { key: 'creaseScale', label: 'Crease Density', type: 'float', default: 7, min: 0.5, max: 60, step: 0.1, group: 'Pattern' },
    { key: 'creaseDepth', label: 'Crease Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.55, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'sheen', label: 'Wear Sheen', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Polishes the raised grain, the way handling wears leather smooth on the high points.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const grainAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(p.float('scale')).add(vec2(offset, offset)), float(0.9))
      const bump = smoothstep(float(0), float(0.14), voronoiBorder(cells))
      return bump.mul(mix(float(0.75), float(1), voronoiCellValue(cells)))
    }
    const creaseAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(p.float('creaseScale')).add(vec2(offset.add(9), offset)), float(1))
      const modulate = fbm01(vec3(uvNode.mul(p.float('creaseScale').mul(3)), offset), 3, 2, 0.5)
      return smoothstep(float(0), float(0.11), voronoiBorder(cells)).mul(mix(float(0.4), float(1), modulate))
    }

    const heightAt = (uvNode: V2): F =>
      grainAt(uvNode).mul(p.float('grainDepth')).sub(creaseAt(uvNode).oneMinus().mul(p.float('creaseDepth')))

    const h = heightAt(ctx.uv)
    const raised = h.clamp(-1, 1).mul(0.5).add(0.5)

    return {
      baseColor: mix(p.color('tint'), p.color('highlight'), raised.mul(0.7)),
      metallic: float(0),
      roughness: p.float('roughness').sub(raised.mul(p.float('sheen'))).clamp(0.08, 1),
      ao: raised.mul(0.4).add(0.6),
      height: raised,
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('grainDepth').add(p.float('creaseDepth'))),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const fabricWeave = registerMaterial({
  id: 'fabric-weave',
  name: 'Woven Fabric',
  category: 'Organic',
  description: 'A plain over-under weave. Warp and weft threads are cosine ridges; a checkerboard decides which one is on top in each cell, which is literally how weaving works.',
  params: [
    { key: 'warpColor', label: 'Warp Colour', type: 'color', default: [0.42, 0.4, 0.44], group: 'Colour' },
    { key: 'weftColor', label: 'Weft Colour', type: 'color', default: [0.3, 0.29, 0.33], group: 'Colour' },
    { key: 'threads', label: 'Thread Count', type: 'float', default: 60, min: 4, max: 400, step: 1, group: 'Pattern' },
    { key: 'threadWidth', label: 'Thread Width', type: 'float', default: 0.8, min: 0.2, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'depth', label: 'Weave Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'fuzz', label: 'Fuzz', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Fibre noise breaking up the thread edges.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.78, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('threads')

    const weaveAt = (uvNode: V2) => {
      const g = uvNode.mul(n)
      const cell = g.floor()
      const local = fract(g)
      // Alternating cells put the warp on top, then the weft.
      const over = fract(cell.x.add(cell.y).mul(0.5)).mul(2)
      const w = p.float('threadWidth')
      const ridge = (t: F): F => cos(t.sub(0.5).div(max(w, float(0.05))).mul(Math.PI)).clamp(0, 1)
      const warpH = ridge(local.x)
      const weftH = ridge(local.y)
      const top = mix(weftH, warpH, over)
      const bottom = mix(warpH, weftH, over).mul(0.35)
      return { height: max(top, bottom), over, warpH, weftH }
    }

    const fuzzAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(n.mul(3)), offset), 3, 2, 0.5).sub(0.5).mul(p.float('fuzz').mul(0.25))

    const heightAt = (uvNode: V2): F => weaveAt(uvNode).height.mul(p.float('depth')).add(fuzzAt(uvNode))

    const w = weaveAt(ctx.uv)
    const colour = mix(p.color('weftColor'), p.color('warpColor'), w.over)
    const shade = heightAt(ctx.uv).clamp(0, 1)

    return {
      baseColor: colour.mul(mix(float(0.6), float(1.05), shade)),
      metallic: float(0),
      roughness: p.float('roughness').add(fuzzAt(ctx.uv).mul(0.4)).clamp(0.1, 1),
      ao: shade.mul(0.5).add(0.5),
      height: shade,
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.6)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const sand = registerMaterial({
  id: 'sand',
  name: 'Sand',
  category: 'Organic',
  description: 'Dunes with grain on top. The two scales are deliberate: broad ripples for silhouette, high-frequency sparkle for the glitter sand gets in sunlight.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.76, 0.65, 0.45], group: 'Colour' },
    { key: 'shadowTint', label: 'Shadow Tint', type: 'color', default: [0.5, 0.41, 0.28], group: 'Colour' },
    { key: 'rippleScale', label: 'Ripple Scale', type: 'float', default: 14, min: 0.5, max: 120, step: 0.1, group: 'Pattern' },
    { key: 'rippleDepth', label: 'Ripple Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'grainScale', label: 'Grain Scale', type: 'float', default: 420, min: 40, max: 2000, step: 1, group: 'Surface' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.9, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const heightAt = (uvNode: V2): F => {
      const warped = warp(vec3(uvNode.mul(p.float('rippleScale')), offset), 0.6, 0.5)
      const ripples = sin(warped.x.add(warped.y.mul(0.4))).mul(0.5).add(0.5).pow(1.6)
      const grain = fbm01(vec3(uvNode.mul(p.float('grainScale')), offset.add(5)), 2, 2, 0.5)
      return ripples.mul(p.float('rippleDepth')).add(grain.mul(p.float('grainDepth')).mul(0.08))
    }

    const h = heightAt(ctx.uv)
    const sparkle = fbm01(vec3(ctx.uv.mul(p.float('grainScale').mul(1.7)), offset.add(31)), 2, 2, 0.5)

    return {
      baseColor: mix(p.color('shadowTint'), p.color('tint'), h.clamp(0, 1).mul(0.8).add(0.2)),
      metallic: float(0),
      roughness: p.float('roughness').sub(smoothstep(float(0.82), float(1), sparkle).mul(0.5)).clamp(0.1, 1),
      ao: h.clamp(0, 1).mul(0.35).add(0.65),
      height: h.clamp(0, 1),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('rippleDepth').mul(1.2)),
    }
  },
} satisfies ProceduralMaterialDef)

export const ORGANIC = [woodPlanks, leather, fabricWeave, sand]
