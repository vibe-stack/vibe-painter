/**
 * Wood, leather, fabric, sand and growth - the materials where the pattern is
 * a *structure* rather than a noise field, so most of the code here is about
 * building grids, interlaces and fibre directions before any noise is applied.
 *
 * Organic surfaces are also the ones that punish a single frequency hardest.
 * Wood has rings *and* pores; leather has pebbles *and* creases; fabric has a
 * weave *and* the fibres that make up each thread. Every material here is
 * built from at least two scales for that reason.
 */

import { cos, float, fract, max, min, mix, sin, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  fbm01,
  gradient3,
  hash21,
  microVariation,
  normalFromHeightFn,
  pebbles,
  ridged,
  sparkle,
  tintVariation,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
  warp,
  worley,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

export const woodPlanks = registerMaterial({
  id: 'wood-planks',
  name: 'Wood Planks',
  category: 'Organic',
  description: 'Planks with per-board grain, knots and open pores. The rings bend around each knot because the knot displaces the ring field itself - drawing rings and then stamping knots over them is the version that never looks like wood.',
  params: [
    { key: 'planks', label: 'Plank Count', type: 'float', default: 6, min: 1, max: 40, step: 0.5, group: 'Layout' },
    { key: 'stagger', label: 'End Stagger', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'gap', label: 'Gap Width', type: 'float', default: 0.02, min: 0, max: 0.2, step: 0.001, group: 'Layout' },
    { key: 'gapDepth', label: 'Gap Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'chamfer', label: 'Edge Chamfer', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Rounds the top arris of each board, where a floor wears first.' },
    { key: 'lightWood', label: 'Light Wood', type: 'color', default: [0.58, 0.38, 0.2], group: 'Colour' },
    { key: 'midWood', label: 'Mid Wood', type: 'color', default: [0.4, 0.24, 0.12], group: 'Colour' },
    { key: 'darkWood', label: 'Dark Wood', type: 'color', default: [0.2, 0.11, 0.055], group: 'Colour' },
    { key: 'ringDensity', label: 'Ring Density', type: 'float', default: 22, min: 1, max: 120, step: 0.5, group: 'Grain' },
    { key: 'ringWobble', label: 'Ring Wobble', type: 'float', default: 0.35, min: 0, max: 2, step: 0.01, group: 'Grain' },
    { key: 'knots', label: 'Knots', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Grain', description: 'Where a branch left the trunk. The grain has to flow around it, so this warps the ring field rather than painting a disc.' },
    { key: 'knotScale', label: 'Knot Spacing', type: 'float', default: 2.5, min: 0.2, max: 20, step: 0.05, group: 'Grain' },
    { key: 'pores', label: 'Open Pores', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Grain', description: 'The fine vessel lines of an open-grained wood like oak or ash.' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.22, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.42, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'varnish', label: 'Varnish', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'A finish pools in the pores and wears off the high points, so it makes the grain glossier than the field.' },
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
      const d = min(dx.mul(planks.mul(0.25)), dy)
      // The chamfer is a second, wider ramp outside the hard gap edge.
      const hard = smoothstep(g.mul(0.4), g, d)
      const soft = smoothstep(g, g.add(p.float('chamfer').mul(0.06)), d)
      return mix(hard, hard.mul(0.35).add(soft.mul(0.65)), p.float('chamfer'))
    }

    /**
     * Distance to the nearest knot, plus the knot's own strength.
     *
     * Knots are sparse, so they come from a Voronoi cell whose id decides
     * whether a knot exists there at all. The distance field is then fed back
     * into the ring coordinate, which is what drags the grain around it.
     */
    const knotAt = (uvNode: V2) => {
      const cells = voronoi2(uvNode.mul(vec2(1, 2.2)).mul(p.float('knotScale')).add(vec2(offset, offset)), float(0.9))
      const present = step(voronoiCellValue(cells), p.float('knots').mul(0.45))
      return { distance: cells.x, strength: present.mul(p.float('knots')) }
    }

    const ringsAt = (uvNode: V2): F => {
      const b = boardAt(uvNode)
      const seedForBoard = hash21(b.id.add(vec2(offset, offset))).mul(37)
      const knot = knotAt(uvNode)
      // Rings compress towards a knot and bulge around it.
      const pull = float(1).div(knot.distance.mul(6).add(0.35)).mul(knot.strength)
      const w = warp(
        vec3(uvNode.x.mul(1.5), b.local.y.mul(3).add(seedForBoard), seedForBoard),
        p.float('ringWobble'),
        2.5,
      )
      const d = w.y.add(w.x.mul(0.35)).add(pull.mul(0.6))
      const rings = sin(d.mul(p.float('ringDensity'))).mul(0.5).add(0.5)
      // Earlywood/latewood is not a sine: the dark band is much narrower.
      const shaped = rings.pow(1.7)
      const fine = fbm01(vec3(uvNode.mul(vec2(80, 8)), seedForBoard), 3, 2, 0.5)
      const knotCore = smoothstep(float(0.09), float(0), knot.distance).mul(knot.strength)
      return shaped.mul(0.72).add(fine.mul(0.28)).mul(knotCore.oneMinus()).add(knotCore.mul(0.85))
    }

    // Pores are short dashes running along the board, not a noise field: they
    // are stretched hard in U and cut off by a threshold.
    const poresAt = (uvNode: V2): F =>
      smoothstep(float(0.55), float(0.78), fbm01(vec3(uvNode.mul(vec2(24, 620)), offset.add(7)), 2, 2, 0.5))
        .mul(p.float('pores'))

    const heightAt = (uvNode: V2): F => {
      const gap = gapAt(uvNode)
      return ringsAt(uvNode)
        .mul(p.float('grainDepth'))
        .mul(gap)
        .sub(poresAt(uvNode).mul(0.06).mul(gap))
        .sub(gap.oneMinus().mul(p.float('gapDepth')))
    }

    const b = boardAt(ctx.uv)
    const boardTone = mix(float(0.5), hash21(b.id.add(vec2(offset.add(3), offset))), p.float('variation'))
    const rings = ringsAt(ctx.uv)
    const gap = gapAt(ctx.uv)
    const pores = poresAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('grainDepth').add(p.float('gapDepth')))
    const h = heightAt(ctx.uv)

    const wood = tintVariation(
      gradient3(rings.mul(0.65).add(boardTone.mul(0.35)), p.color('darkWood'), p.color('midWood'), p.color('lightWood')),
      hash21(b.id.add(vec2(offset.add(11), offset.add(2)))),
      0.012,
      0.2,
      0.22,
    )
    const withPores = wood.mul(mix(float(1), float(0.62), pores))

    return {
      baseColor: mix(vec3(0.018, 0.013, 0.009), withPores, gap),
      metallic: float(0),
      // Varnish pools in the pores and rings, so they end up *glossier*.
      roughness: p
        .float('roughness')
        .add(rings.sub(0.5).mul(0.14))
        .sub(p.float('varnish').mul(0.3))
        .sub(pores.mul(p.float('varnish')).mul(0.15))
        .clamp(0.04, 1),
      ao: cavityAO(h.add(p.float('gapDepth')).div(max(p.float('gapDepth').add(0.2), float(1e-3))).clamp(0, 1), normal, 0.6),
      height: h.mul(0.5).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const leather = registerMaterial({
  id: 'leather',
  name: 'Leather',
  category: 'Organic',
  description: 'Grained leather at two cell scales, with the creases running in a direction. Handling polishes the raised grain and leaves the valleys matte, which is why the roughness map here matters more than the colour.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.22, 0.115, 0.075], group: 'Colour' },
    { key: 'highlight', label: 'Highlight', type: 'color', default: [0.46, 0.3, 0.2], group: 'Colour' },
    { key: 'scale', label: 'Grain Density', type: 'float', default: 55, min: 4, max: 400, step: 0.5, group: 'Pattern' },
    { key: 'fineScale', label: 'Fine Grain', type: 'float', default: 190, min: 10, max: 900, step: 1, group: 'Pattern', description: 'The second cell scale. Real hide grain is fractal, not one size.' },
    { key: 'creaseScale', label: 'Crease Density', type: 'float', default: 7, min: 0.5, max: 60, step: 0.1, group: 'Pattern' },
    { key: 'stretch', label: 'Stretch', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Elongates the grain, the way hide is stretched over a frame while it dries.' },
    { key: 'creaseDepth', label: 'Crease Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.58, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'sheen', label: 'Wear Sheen', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Polishes the raised grain, the way handling wears leather smooth on the high points.' },
    { key: 'patina', label: 'Patina', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Broad darkening where the piece is handled most.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    // Anisotropic sampling: one number turns round grain into stretched grain.
    const stretchVec = vec2(float(1).add(p.float('stretch').mul(0.9)), float(1).sub(p.float('stretch').mul(0.4)))

    const grainAt = (uvNode: V2): F => {
      const q = uvNode.mul(stretchVec)
      const coarse = pebbles(q.mul(p.float('scale')).add(vec2(offset, offset)), float(0.9), float(0.14))
      const fine = pebbles(q.mul(p.float('fineScale')).add(vec2(offset.add(4), offset)), float(0.95), float(0.3))
      return coarse.x.mul(mix(float(0.75), float(1), hash21(coarse.zw))).mul(0.78).add(fine.x.mul(0.22))
    }

    const creaseAt = (uvNode: V2): F => {
      const cells = voronoi2(
        uvNode.mul(stretchVec).mul(p.float('creaseScale')).add(vec2(offset.add(9), offset)),
        float(1),
      )
      const modulate = fbm01(vec3(uvNode.mul(p.float('creaseScale').mul(3)), offset), 3, 2, 0.5)
      return smoothstep(float(0), float(0.11), voronoiBorder(cells)).mul(mix(float(0.4), float(1), modulate))
    }

    const heightAt = (uvNode: V2): F =>
      grainAt(uvNode).mul(p.float('grainDepth')).sub(creaseAt(uvNode).oneMinus().mul(p.float('creaseDepth')))

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('grainDepth').add(p.float('creaseDepth')))
    const raised = h.clamp(-1, 1).mul(0.5).add(0.5)

    const patina = smoothstep(float(0.42), float(0.8), fbm01(vec3(ctx.uv.mul(2.5), offset.add(31)), 4, 2.1, 0.55))
      .mul(p.float('patina'))
    const dyed = tintVariation(
      mix(p.color('tint'), p.color('highlight'), raised.mul(0.75)),
      fbm01(vec3(ctx.uv.mul(6), offset.add(13)), 3, 2, 0.5),
      0.008,
      0.16,
      0.14,
    )

    return {
      baseColor: dyed.mul(mix(float(1), float(0.72), patina)),
      metallic: float(0),
      // Wear is a *high point* effect: the sheen tracks the raised grain, and
      // the valleys stay matte. Uniform roughness here reads as vinyl.
      roughness: p
        .float('roughness')
        .sub(raised.pow(2).mul(p.float('sheen')))
        .sub(patina.mul(0.12))
        .add(microVariation(ctx.uv, p.float('scale').mul(6), offset).sub(0.5).mul(0.1))
        .clamp(0.06, 1),
      ao: cavityAO(raised, normal, 0.55),
      height: raised,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const fabricWeave = registerMaterial({
  id: 'fabric-weave',
  name: 'Woven Fabric',
  category: 'Organic',
  description: 'A plain over-under weave down to the fibre. Each thread is a cosine ridge with twisted filaments running along it, a checkerboard decides which is on top in each cell - which is literally how weaving works - and the gaps between threads go dark because you are seeing through the cloth.',
  params: [
    { key: 'warpColor', label: 'Warp Colour', type: 'color', default: [0.4, 0.38, 0.42], group: 'Colour' },
    { key: 'weftColor', label: 'Weft Colour', type: 'color', default: [0.28, 0.27, 0.31], group: 'Colour' },
    { key: 'threads', label: 'Thread Count', type: 'float', default: 60, min: 4, max: 400, step: 1, group: 'Pattern' },
    { key: 'threadWidth', label: 'Thread Width', type: 'float', default: 0.82, min: 0.2, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'twist', label: 'Fibre Twist', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'The filaments spiralling along each thread. This is the detail that separates cloth from a quilted pattern.' },
    { key: 'depth', label: 'Weave Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'fuzz', label: 'Fuzz', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Fibre noise breaking up the thread edges.' },
    { key: 'sheen', label: 'Sheen', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Threads reflect along their length, so the warp and weft never look the same at once.' },
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
      // Twist: filaments running along the thread, at an angle to it.
      const twist = sin(mix(local.y, local.x, over).mul(Math.PI * 2).add(mix(local.x, local.y, over).mul(Math.PI * 9)))
        .mul(0.5)
        .add(0.5)
        .mul(p.float('twist'))
        .mul(0.14)
      return { height: max(top, bottom).add(twist.mul(top)), over, warpH, weftH, top }
    }

    const fuzzAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(n.mul(3)), offset), 3, 2, 0.5).sub(0.5).mul(p.float('fuzz').mul(0.25))

    const heightAt = (uvNode: V2): F => weaveAt(uvNode).height.mul(p.float('depth')).add(fuzzAt(uvNode))

    const w = weaveAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.6))
    const shade = heightAt(ctx.uv).clamp(0, 1)

    const thread = tintVariation(
      mix(p.color('weftColor'), p.color('warpColor'), w.over),
      fbm01(vec3(ctx.uv.mul(n.mul(0.4)), offset.add(3)), 3, 2, 0.5),
      0.006,
      0.14,
      0.14,
    )
    // Where neither thread is on top you are looking into the weave.
    const gap = smoothstep(float(0.25), float(0.02), w.height)

    return {
      baseColor: thread.mul(mix(float(0.62), float(1.06), shade)).mul(gap.oneMinus().mul(0.85).add(0.15)),
      metallic: float(0),
      // Sheen runs along the thread, so it lands on the crest of whichever set
      // is on top - the reason satin and canvas differ at the same roughness.
      roughness: p
        .float('roughness')
        .add(fuzzAt(ctx.uv).mul(0.4))
        .sub(w.top.pow(3).mul(p.float('sheen')).mul(0.4))
        .clamp(0.1, 1),
      ao: cavityAO(shade, normal, 0.6).mul(gap.mul(0.35).oneMinus()),
      height: shade,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const sand = registerMaterial({
  id: 'sand',
  name: 'Sand',
  category: 'Organic',
  description: 'Wind ripples with grain on top. The ripples are asymmetric - a shallow windward face and a steep slip face - which is the difference between sand and a sine wave, and the sparkle is quartz catching the sun one grain at a time.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.76, 0.65, 0.45], group: 'Colour' },
    { key: 'shadowTint', label: 'Shadow Tint', type: 'color', default: [0.46, 0.37, 0.25], group: 'Colour' },
    { key: 'darkGrains', label: 'Dark Minerals', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'The magnetite and mica speckle that no real beach is without.' },
    { key: 'rippleScale', label: 'Ripple Scale', type: 'float', default: 14, min: 0.5, max: 120, step: 0.1, group: 'Pattern' },
    { key: 'rippleDepth', label: 'Ripple Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'asymmetry', label: 'Slip Face', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'How steep the leeward face is compared with the windward one.' },
    { key: 'grainScale', label: 'Grain Scale', type: 'float', default: 420, min: 40, max: 2000, step: 1, group: 'Surface' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'sparkle', label: 'Sparkle', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'debris', label: 'Debris', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Shell fragments and pebbles sitting on the surface.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.9, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const debrisAt = (uvNode: V2): F => {
      const stones = pebbles(uvNode.mul(p.float('rippleScale').mul(3.5)).add(vec2(offset.add(7), offset)), float(0.95), float(0.4))
      // Sparse: only a fraction of cells hold anything.
      return stones.x.mul(step(hash21(stones.zw), p.float('debris').mul(0.25)))
    }

    const heightAt = (uvNode: V2): F => {
      const warped = warp(vec3(uvNode.mul(p.float('rippleScale')), offset), 0.6, 0.5)
      const phase = warped.x.add(warped.y.mul(0.4))
      // Asymmetric profile: raising the wave to a power > 1 on one side and
      // < 1 on the other makes one flank shallow and the other a cliff.
      const wave = phase.sin().mul(0.5).add(0.5)
      const ripples = mix(wave.pow(1.6), wave.pow(mix(float(1.6), float(4.5), p.float('asymmetry'))), float(0.5))
      const grain = fbm01(vec3(uvNode.mul(p.float('grainScale')), offset.add(5)), 2, 2, 0.5)
      return ripples.mul(p.float('rippleDepth')).add(grain.mul(p.float('grainDepth')).mul(0.07)).add(debrisAt(uvNode).mul(0.06))
    }

    const h = heightAt(ctx.uv)
    const coarseNormal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('rippleDepth').mul(1.2))
    // Grain detail is far too fine for the height derivative to resolve at
    // texture resolution, so it goes on as a detail normal instead.
    const grainNormal = normalFromHeightFn(
      (uvNode) => fbm01(vec3(uvNode.mul(p.float('grainScale')), offset.add(5)), 2, 2, 0.5),
      ctx.uv,
      ctx.texel,
      p.float('grainDepth').mul(0.05),
    )
    const normal = blendDetailNormal(coarseNormal, grainNormal, 1)

    const glitter = sparkle(ctx.uv, p.float('grainScale').mul(0.5), offset.add(31), float(0.1)).mul(p.float('sparkle'))
    const minerals = smoothstep(float(0.62), float(0.78), fbm01(vec3(ctx.uv.mul(p.float('grainScale').mul(0.6)), offset.add(17)), 2, 2, 0.5))
      .mul(p.float('darkGrains'))
    const debris = debrisAt(ctx.uv)

    const body = mix(p.color('shadowTint'), p.color('tint'), h.clamp(0, 1).mul(0.8).add(0.2))
    const withMinerals = mix(body, vec3(0.09, 0.08, 0.07), minerals.mul(0.7))

    return {
      baseColor: mix(withMinerals, vec3(0.72, 0.68, 0.6), debris.mul(0.8)),
      metallic: float(0),
      // Quartz facets are locally smooth, so sparkle is a roughness effect -
      // an emissive dot would glow in shadow, which sand does not do.
      roughness: p.float('roughness').sub(glitter.mul(0.75)).sub(debris.mul(0.2)).clamp(0.05, 1),
      ao: cavityAO(h.clamp(0, 1), normal, 0.35),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const snow = registerMaterial({
  id: 'snow',
  name: 'Snow',
  category: 'Organic',
  description: 'Wind-packed snow. Two things make snow read as snow: crystal sparkle at grazing angles, and the fact that its shadows go blue - light scatters *through* the crystals rather than off them, and the deep parts of a drift lose the warm end of the spectrum first.',
  params: [
    { key: 'tint', label: 'Snow', type: 'color', default: [0.92, 0.94, 0.97], group: 'Colour' },
    { key: 'shadowTint', label: 'Deep Tint', type: 'color', default: [0.45, 0.57, 0.78], group: 'Colour', description: 'The colour that shows in the hollows. Blue, because that is what subsurface scattering leaves behind.' },
    { key: 'scatter', label: 'Scattering', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'driftScale', label: 'Drift Scale', type: 'float', default: 3.5, min: 0.2, max: 40, step: 0.05, group: 'Pattern' },
    { key: 'driftDepth', label: 'Drift Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'windRipples', label: 'Wind Ripples', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Sastrugi: the hard, carved ridges wind leaves on packed snow.' },
    { key: 'crust', label: 'Crust', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'A refrozen surface layer, which is smoother and slightly harder than fresh powder.' },
    { key: 'sparkle', label: 'Crystal Sparkle', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'sparkleScale', label: 'Crystal Density', type: 'float', default: 500, min: 40, max: 2500, step: 5, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.72, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('driftScale')

    const heightAt = (uvNode: V2): F => {
      const drift = fbm01(warp(vec3(uvNode.mul(scale), offset), 0.5, 0.8), 4, 2, 0.55)
      // Sastrugi are carved, not deposited: ridged noise, not fbm.
      const carved = ridged(vec3(uvNode.mul(scale.mul(4)).mul(vec2(1, 0.35)), offset.add(9)), float(4), float(0.5))
      const powder = fbm01(vec3(uvNode.mul(scale.mul(30)), offset.add(3)), 3, 2.2, 0.5)
      return drift
        .mul(p.float('driftDepth'))
        .add(carved.mul(p.float('windRipples')).mul(0.18))
        .add(powder.mul(0.03).mul(p.float('crust').oneMinus()))
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('driftDepth').mul(1.1))
    const h01 = h.clamp(0, 1)

    const glitter = sparkle(ctx.uv, p.float('sparkleScale'), offset.add(41), float(0.09)).mul(p.float('sparkle'))
    // Depth of snow above the point, roughly: hollows are deeper into the pack.
    const depth = h01.oneMinus().pow(1.4).mul(p.float('scatter'))

    return {
      baseColor: mix(p.color('tint'), p.color('shadowTint'), depth.mul(0.65)),
      metallic: float(0),
      // Fresh powder is matte; a refrozen crust is nearly a mirror at grazing
      // angles, and every crystal facet is a tiny smooth spot.
      roughness: p
        .float('roughness')
        .sub(p.float('crust').mul(0.35))
        .sub(glitter.mul(0.7))
        .add(microVariation(ctx.uv, scale.mul(9), offset).sub(0.5).mul(0.12))
        .clamp(0.03, 1),
      // Snow is the one material where AO must stay shallow: it bounces light
      // internally, so a deep hollow is far from black.
      ao: cavityAO(h01, normal, 0.3),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const moss = registerMaterial({
  id: 'moss',
  name: 'Moss',
  category: 'Organic',
  description: 'Clumped growth. Moss is not a green noise: it grows in cushions with dark, damp gaps between them, and the tips of each cushion are lighter and yellower than the shaded body - so colour has to follow the height field, not sit next to it.',
  params: [
    { key: 'tipColor', label: 'Tips', type: 'color', default: [0.34, 0.46, 0.14], group: 'Colour' },
    { key: 'bodyColor', label: 'Body', type: 'color', default: [0.14, 0.26, 0.09], group: 'Colour' },
    { key: 'deepColor', label: 'Shade', type: 'color', default: [0.04, 0.08, 0.035], group: 'Colour' },
    { key: 'dryColor', label: 'Dry Patches', type: 'color', default: [0.42, 0.4, 0.19], group: 'Colour' },
    { key: 'dryness', label: 'Dryness', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'clumpScale', label: 'Clump Size', type: 'float', default: 10, min: 0.5, max: 80, step: 0.1, group: 'Pattern' },
    { key: 'fibreScale', label: 'Fibre Density', type: 'float', default: 160, min: 10, max: 900, step: 1, group: 'Pattern', description: 'The individual shoots. Without them a moss cushion reads as a sponge.' },
    { key: 'clumpDepth', label: 'Clump Depth', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'fibreDepth', label: 'Fibre Depth', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'damp', label: 'Dampness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Wet moss is glossy in the hollows where water collects.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const clumpAt = (uvNode: V2): F => {
      const cells = pebbles(uvNode.mul(p.float('clumpScale')).add(vec2(offset, offset)), float(0.95), float(0.45))
      // Clumps vary in vigour, so some cushions are much fuller than others.
      return cells.x.mul(mix(float(0.5), float(1.15), hash21(cells.zw)))
    }

    const fibreAt = (uvNode: V2): F => {
      // Shoots point outwards from the clump, so the fibre noise is sampled in
      // a coordinate that has already been warped by the clump field.
      const w = warp(vec3(uvNode.mul(p.float('fibreScale')), offset.add(5)), 0.35, 3.5)
      return worley(w, 1).oneMinus().pow(1.6)
    }

    const heightAt = (uvNode: V2): F =>
      clumpAt(uvNode).mul(p.float('clumpDepth')).add(fibreAt(uvNode).mul(p.float('fibreDepth')).mul(0.16))

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('clumpDepth').add(0.2))
    const h01 = h.clamp(0, 1)

    // Colour by depth into the cushion: tips catch light, the base is black.
    const green = gradient3(h01, p.color('deepColor'), p.color('bodyColor'), p.color('tipColor'))
    const varied = tintVariation(green, fbm01(vec3(ctx.uv.mul(p.float('clumpScale').mul(0.6)), offset.add(23)), 3, 2, 0.5), 0.02, 0.25, 0.2)
    const dry = smoothstep(float(0.5), float(0.8), fbm01(vec3(ctx.uv.mul(p.float('clumpScale').mul(0.4)), offset.add(37)), 4, 2.1, 0.55))
      .mul(p.float('dryness'))

    return {
      baseColor: mix(varied, p.color('dryColor'), dry.mul(0.8)),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .sub(h01.oneMinus().mul(p.float('damp')).mul(0.4))
        .add(dry.mul(0.1))
        .clamp(0.08, 1),
      // Moss self-shadows hard: the gaps between cushions are genuinely dark.
      ao: cavityAO(h01, normal, 0.85),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const treeBark = registerMaterial({
  id: 'tree-bark',
  name: 'Tree Bark',
  category: 'Organic',
  description: 'Furrowed bark. Bark cracks because the trunk grows faster than its dead outer layer can stretch, so the fissures run *along* the trunk and the plates between them are stretched in the same direction - anisotropy is the whole material.',
  params: [
    { key: 'plateColor', label: 'Plate', type: 'color', default: [0.24, 0.18, 0.13], group: 'Colour' },
    { key: 'ridgeColor', label: 'Ridge', type: 'color', default: [0.4, 0.32, 0.24], group: 'Colour' },
    { key: 'fissureColor', label: 'Fissure', type: 'color', default: [0.055, 0.04, 0.03], group: 'Colour' },
    { key: 'lichenColor', label: 'Lichen', type: 'color', default: [0.52, 0.56, 0.44], group: 'Colour' },
    { key: 'lichen', label: 'Lichen', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.05, group: 'Pattern' },
    { key: 'stretch', label: 'Grain Stretch', type: 'float', default: 6, min: 1, max: 30, step: 0.1, group: 'Pattern', description: 'How far the furrows are drawn out along the trunk.' },
    { key: 'fissureDepth', label: 'Fissure Depth', type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'plateBreak', label: 'Plate Break-up', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Cross-cracks that split the ridges into scales.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')
    // Stretching V compresses the pattern along the trunk axis.
    const anis = (uvNode: V2): V2 => vec2(uvNode.x.mul(scale), uvNode.y.mul(scale).div(p.float('stretch')))

    const fissureAt = (uvNode: V2): F => {
      const q = anis(uvNode)
      // Ridged noise gives the sharp V-section of a real furrow; a Worley
      // border would give it a flat bottom, which bark does not have.
      const furrows = ridged(vec3(warp(vec3(q, offset), 0.35, 1.6)), float(4), float(0.5))
      const cross = ridged(vec3(vec2(q.x.mul(0.4), q.y.mul(9)), offset.add(7)), float(3), float(0.5))
      return furrows.mul(0.75).add(cross.mul(p.float('plateBreak')).mul(0.25))
    }

    const heightAt = (uvNode: V2): F => {
      const f = fissureAt(uvNode)
      const grain = fbm01(vec3(anis(uvNode).mul(14), offset.add(3)), 3, 2.2, 0.5).sub(0.5).mul(0.08)
      return f.pow(1.4).mul(p.float('fissureDepth')).add(grain.mul(f))
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('fissureDepth').mul(1.6))
    const h01 = h.div(max(p.float('fissureDepth'), float(1e-3))).clamp(0, 1)

    const barkColour = gradient3(h01, p.color('fissureColor'), p.color('plateColor'), p.color('ridgeColor'))
    const varied = tintVariation(barkColour, fbm01(vec3(ctx.uv.mul(scale.mul(0.8)), offset.add(29)), 3, 2, 0.5), 0.01, 0.18, 0.2)
    // Lichen sits on the exposed ridges, on the side it happens to face.
    const lichenField = fbm01(warp(vec3(ctx.uv.mul(scale.mul(1.1)), offset.add(43)), 0.9, 1.3), 4, 2.2, 0.55)
    const lichenMask = smoothstep(float(0.55), float(0.8), lichenField).mul(smoothstep(float(0.45), float(0.9), h01)).mul(p.float('lichen'))

    return {
      baseColor: mix(varied, p.color('lichenColor'), lichenMask.mul(0.85)),
      metallic: float(0),
      roughness: p.float('roughness').add(h01.oneMinus().mul(0.06)).sub(lichenMask.mul(0.1)).clamp(0.15, 1),
      ao: cavityAO(h01, normal, 0.85),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const ORGANIC = [woodPlanks, leather, fabricWeave, sand, snow, moss, treeBark]
