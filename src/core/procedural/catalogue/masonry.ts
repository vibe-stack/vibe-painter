/**
 * Masonry and stone. These are the materials where *height* does most of the
 * work: bricks, tiles and rock all read primarily as a displacement pattern
 * with colour riding along.
 *
 * The one rule that governs all of them is that a unit is never identical to
 * its neighbour. Every brick, sett and chip pulls its own colour, height and
 * wear from a hash of its cell id, because a masonry surface that repeats is
 * the most obvious failure mode there is - the eye finds a repeated stone
 * across a whole wall instantly.
 */

import { float, max, min, mix, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  brickGrid,
  cavityAO,
  cracks,
  drips,
  fbm01,
  gradient3,
  hash21,
  heightBlend,
  microVariation,
  normalFromHeightFn,
  pebbles,
  ridged,
  tintVariation,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
  warp,
  worley,
} from '../noise'
import type { MatContext } from '../material'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

/** Vertical faces only: rain runs down walls, not across floors. */
function gravityWeight(ctx: MatContext): number {
  return ctx.axis === 1 ? 0 : 1
}

export const bricks = registerMaterial({
  id: 'bricks',
  name: 'Brick Wall',
  category: 'Masonry',
  description: 'Running-bond brickwork where every brick is laid slightly differently: its own colour, its own height off the wall face, its own chipped corners. That per-unit variation is what stops a wall from looking stamped.',
  params: [
    { key: 'rows', label: 'Rows', type: 'float', default: 12, min: 1, max: 80, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Brick Aspect', type: 'float', default: 2.2, min: 0.2, max: 8, step: 0.01, group: 'Layout', description: 'Width divided by height. Standard brick is about 2.2.' },
    { key: 'bond', label: 'Row Offset', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout', description: '0.5 is a running bond, 0 is a stack bond.' },
    { key: 'mortar', label: 'Mortar Width', type: 'float', default: 0.06, min: 0, max: 0.4, step: 0.001, group: 'Layout' },
    { key: 'unevenness', label: 'Laying Unevenness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How far individual bricks sit proud of or behind the wall face. A perfectly flush wall is machine-made.' },
    { key: 'brickA', label: 'Brick Colour A', type: 'color', default: [0.4, 0.16, 0.12], group: 'Colour' },
    { key: 'brickB', label: 'Brick Colour B', type: 'color', default: [0.57, 0.28, 0.19], group: 'Colour' },
    { key: 'brickC', label: 'Brick Colour C', type: 'color', default: [0.3, 0.14, 0.12], group: 'Colour' },
    { key: 'mortarColor', label: 'Mortar Colour', type: 'color', default: [0.6, 0.58, 0.54], group: 'Colour' },
    { key: 'variation', label: 'Colour Variation', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'efflorescence', label: 'Efflorescence', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'The pale salt bloom that leaches out of mortar and runs down brickwork.' },
    { key: 'depth', label: 'Mortar Recess', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'chips', label: 'Chipped Edges', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Breaks the arris of each brick, which is where damage always starts.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.82, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'grain', label: 'Surface Grain', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const rows = p.float('rows')
    const cols = rows.mul(p.float('aspect'))
    const offset = seedOffset(ctx)

    const gridAt = (uvNode: V2) => brickGrid(vec2(uvNode.x.mul(cols), uvNode.y.mul(rows)), p.float('bond'))

    /**
     * The brick mask, eroded at the edges by a noise field.
     *
     * A plain smoothstep on the cell distance gives every brick an identical
     * machined arris. Pushing the threshold around with noise chips the
     * corners irregularly, and because the noise is sampled in wall space the
     * chips do not repeat brick to brick.
     */
    const brickMaskAt = (uvNode: V2): F => {
      const g = gridAt(uvNode)
      const m = p.float('mortar')
      const dx = min(g.x, g.x.oneMinus())
      const dy = min(g.y, g.y.oneMinus())
      const d = min(dx, dy.mul(p.float('aspect')))
      const chip = fbm01(vec3(uvNode.mul(cols.mul(3.5)), offset.add(13)), 4, 2.2, 0.55)
        .sub(0.5)
        .mul(p.float('chips'))
        .mul(m.mul(1.6))
      return smoothstep(m.mul(0.5), m, d.add(chip))
    }

    const heightAt = (uvNode: V2): F => {
      const g = gridAt(uvNode)
      const brick = brickMaskAt(uvNode)
      // Each brick sits at its own depth in the wall.
      const lay = hash21(g.zw.add(vec2(offset.add(7), offset))).sub(0.5).mul(p.float('unevenness')).mul(0.25)
      const grain = fbm01(vec3(uvNode.mul(cols.mul(4)), offset), 4, 2, 0.5).sub(0.5).mul(p.float('grain').mul(0.22))
      // Mortar is not flat either: it is troweled, and it sags.
      const mortarTexture = fbm01(vec3(uvNode.mul(cols.mul(9)), offset.add(3)), 3, 2, 0.5).sub(0.5).mul(0.06)
      return brick.mul(p.float('depth').add(lay)).add(grain.mul(brick)).add(mortarTexture.mul(brick.oneMinus()))
    }

    const g = gridAt(ctx.uv)
    const brick = brickMaskAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2))
    const h = heightAt(ctx.uv)

    const id = hash21(g.zw.add(vec2(offset, offset)))
    const tone = mix(float(0.5), id, p.float('variation'))
    const grain = fbm01(vec3(ctx.uv.mul(cols.mul(6)), offset.add(4)), 4, 2, 0.5)
    // Firing gives each brick its own hue as well as its own value: a kiln is
    // not a paint mixer, and a brightness-only variation reads as a decal.
    const brickColour = tintVariation(
      gradient3(tone, p.color('brickA'), p.color('brickB'), p.color('brickC')),
      hash21(g.zw.add(vec2(offset.add(31), offset.add(5)))),
      0.012,
      0.22,
      0.2,
    ).mul(mix(float(0.84), float(1.1), grain))

    const mortarColour = p.color('mortarColor').mul(mix(float(0.82), float(1.06), grain))

    // Salt bloom: strongest just below the mortar joints, washed downwards.
    const gravity = gravityWeight(ctx)
    const bloom =
      gravity === 0
        ? float(0)
        : drips(ctx.uv, rows.mul(0.8), float(5), offset.add(53))
            .mul(brick.oneMinus().mul(0.5).add(0.5))
            .mul(p.float('efflorescence'))

    const surface = mix(mortarColour, brickColour, brick)

    return {
      baseColor: mix(surface, vec3(0.72, 0.71, 0.68), bloom.clamp(0, 1).mul(0.7)),
      roughness: mix(float(0.96), p.float('roughness'), brick).add(bloom.mul(0.05)).clamp(0.1, 1),
      metallic: float(0),
      // Mortar joints are a groove: the AO belongs to the geometry, not to a
      // flat "mortar is darker" constant.
      ao: cavityAO(h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1), normal, 0.65),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const concrete = registerMaterial({
  id: 'concrete',
  name: 'Concrete',
  category: 'Masonry',
  description: 'Cast concrete: broad tonal drift, aggregate showing through a thin skim of cement, air-bubble pitting, and the shrinkage cracks that every slab eventually gets. The pits are inverted Worley cells, which is why they cluster the way real voids do.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.6, 0.59, 0.57], group: 'Colour' },
    { key: 'stainColor', label: 'Stain Colour', type: 'color', default: [0.32, 0.31, 0.29], group: 'Colour' },
    { key: 'stains', label: 'Staining', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 4, min: 0.2, max: 40, step: 0.05, group: 'Pattern' },
    { key: 'pits', label: 'Pitting', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'pitScale', label: 'Pit Density', type: 'float', default: 45, min: 4, max: 300, step: 0.5, group: 'Surface' },
    { key: 'aggregate', label: 'Aggregate', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Stones in the mix pushing up through the cement skim.' },
    { key: 'aggregateColor', label: 'Aggregate Colour', type: 'color', default: [0.45, 0.43, 0.4], group: 'Colour' },
    { key: 'cracking', label: 'Cracking', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Shrinkage cracks. They terminate rather than closing into a mesh, which is what real ones do.' },
    { key: 'crackScale', label: 'Crack Scale', type: 'float', default: 7, min: 0.5, max: 60, step: 0.1, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const aggregateAt = (uvNode: V2): F => {
      const stones = pebbles(uvNode.mul(p.float('pitScale').mul(0.3)).add(vec2(offset, offset)), float(0.9), float(0.35))
      return stones.x
    }

    const crackAt = (uvNode: V2): F =>
      cracks(uvNode.add(vec2(offset, offset)), p.float('crackScale'), float(0.035), offset.add(9)).mul(p.float('cracking'))

    const heightAt = (uvNode: V2): F => {
      const coarse = fbm01(vec3(uvNode.mul(scale), offset), 4, 2, 0.5).mul(0.3)
      const pit = worley(vec3(uvNode.mul(p.float('pitScale')), offset.add(7)), 1)
      // Two pit sizes: many small bubbles and a few large voids. One size
      // reads as a regular stipple.
      const smallPits = smoothstep(float(0.22), float(0), pit).mul(p.float('pits'))
      const bigPit = worley(vec3(uvNode.mul(p.float('pitScale').mul(0.22)), offset.add(19)), 1)
      const bigPits = smoothstep(float(0.09), float(0), bigPit).mul(p.float('pits')).mul(1.6)
      return coarse
        .add(aggregateAt(uvNode).mul(p.float('aggregate')).mul(0.16))
        .sub(smallPits.mul(0.35))
        .sub(bigPits.mul(0.3))
        .sub(crackAt(uvNode).mul(0.4))
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1))
    const h01 = h.mul(1.6).add(0.4).clamp(0, 1)

    const drift = fbm01(vec3(ctx.uv.mul(scale.mul(0.6)), offset.add(11)), 3, 2, 0.6)
    const stain = fbm01(warp(vec3(ctx.uv.mul(scale.mul(1.6)), offset.add(21)), 0.5, 1.2), 5, 2.2, 0.55)
    const stainMask = smoothstep(float(0.5), float(0.78), stain).mul(p.float('stains'))

    const cement = tintVariation(p.color('tint'), drift, 0.006, 0.12, 0.18)
    // Aggregate is a different rock, so it is blended in by *height*: the
    // stones show only where they actually break the cement surface.
    const exposure = heightBlend(
      p.float('aggregate'),
      aggregateAt(ctx.uv),
      fbm01(vec3(ctx.uv.mul(scale), offset), 4, 2, 0.5),
      0.12,
    )
    const withAggregate = mix(cement, p.color('aggregateColor'), exposure.mul(p.float('aggregate')).mul(0.8))
    const crack = crackAt(ctx.uv)

    return {
      baseColor: mix(mix(withAggregate, p.color('stainColor'), stainMask), vec3(0.05, 0.05, 0.05), crack.mul(0.7)),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .add(stainMask.mul(0.05))
        .add(microVariation(ctx.uv, scale.mul(28), offset).sub(0.5).mul(0.08))
        .clamp(0.05, 1),
      ao: cavityAO(h01, normal, 0.7),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const marble = registerMaterial({
  id: 'marble',
  name: 'Marble',
  category: 'Masonry',
  description: 'Veined marble in two generations: thick primary veins and the hairline network that branches off them. The veins are a sine of a domain-warped field - warping first is what makes them wander and branch instead of drawing parallel stripes.',
  params: [
    { key: 'baseTint', label: 'Base', type: 'color', default: [0.88, 0.87, 0.85], group: 'Colour' },
    { key: 'veinColor', label: 'Vein', type: 'color', default: [0.16, 0.15, 0.18], group: 'Colour' },
    { key: 'secondaryColor', label: 'Secondary Vein', type: 'color', default: [0.6, 0.56, 0.5], group: 'Colour' },
    { key: 'cloudColor', label: 'Clouding', type: 'color', default: [0.76, 0.76, 0.78], group: 'Colour', description: 'The soft grey drift between the veins. Pure white stone looks like plastic.' },
    { key: 'scale', label: 'Scale', type: 'float', default: 3, min: 0.2, max: 30, step: 0.05, group: 'Pattern' },
    { key: 'warpAmount', label: 'Turbulence', type: 'float', default: 1.1, min: 0, max: 4, step: 0.01, group: 'Pattern' },
    { key: 'veinCount', label: 'Vein Frequency', type: 'float', default: 4, min: 0.5, max: 30, step: 0.05, group: 'Pattern' },
    { key: 'veinSharpness', label: 'Vein Sharpness', type: 'float', default: 6, min: 1, max: 40, step: 0.1, group: 'Pattern' },
    { key: 'hairlines', label: 'Hairline Veins', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'The fine second generation that runs alongside the main veins.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.11, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'polishWear', label: 'Polish Wear', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Traffic dulls a polished floor unevenly.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const veinAt = (uvNode: V2): F => {
      const base = vec3(uvNode.mul(scale), offset)
      const warped = warp(base, p.float('warpAmount'), 0.8)
      const field = warped.x.add(warped.y).mul(p.float('veinCount'))
      return field.sin().abs().oneMinus().pow(p.float('veinSharpness')).clamp(0, 1)
    }

    // The hairlines share the warp field of the main veins but run at a much
    // higher frequency, which is why they follow the same flow rather than
    // looking like an unrelated second pattern.
    const hairAt = (uvNode: V2): F => {
      const base = vec3(uvNode.mul(scale.mul(1.4)), offset.add(7))
      const warped = warp(base, p.float('warpAmount').mul(1.4), 1.6)
      const field = warped.x.sub(warped.y.mul(0.7)).mul(p.float('veinCount').mul(5.5))
      return field.sin().abs().oneMinus().pow(float(22)).clamp(0, 1).mul(p.float('hairlines'))
    }

    const vein = veinAt(ctx.uv)
    const hair = hairAt(ctx.uv)
    const cloud = fbm01(warp(vec3(ctx.uv.mul(scale.mul(0.7)), offset.add(3)), 0.6, 0.9), 4, 2, 0.55)
    const secondary = fbm01(warp(vec3(ctx.uv.mul(scale.mul(2.7)), offset), p.float('warpAmount').mul(0.6), 1.7), 4, 2, 0.55)
    const secondaryMask = smoothstep(float(0.55), float(0.85), secondary).mul(0.45)

    const body = mix(p.color('baseTint'), p.color('cloudColor'), smoothstep(float(0.35), float(0.75), cloud))
    const withSecondary = mix(body, p.color('secondaryColor'), secondaryMask)
    const colour = mix(mix(withSecondary, p.color('veinColor'), vein), p.color('veinColor'), hair.mul(0.8))

    // Vein mineral is softer, so it polishes to a different sheen and sits a
    // hair below the surface after grinding.
    const heightAt = (uvNode: V2): F => veinAt(uvNode).mul(0.6).add(hairAt(uvNode).mul(0.4))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.05))
    const wear = smoothstep(float(0.45), float(0.8), fbm01(vec3(ctx.uv.mul(scale.mul(0.5)), offset.add(41)), 3, 2, 0.6))
      .mul(p.float('polishWear'))

    return {
      baseColor: colour,
      metallic: float(0),
      roughness: p.float('roughness').add(vein.mul(0.09)).add(wear.mul(0.35)).clamp(0.01, 1),
      ao: cavityAO(vein.oneMinus(), normal, 0.12),
      height: vein.mul(0.05).add(0.5),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const rock = registerMaterial({
  id: 'rock',
  name: 'Rock',
  category: 'Masonry',
  description: 'Fractured rock with sedimentary banding. Ridged noise supplies the sharp creases a plain fbm cannot, Worley borders cut the cracks between plates, and the strata run across both so the stone reads as layered rather than lumpy.',
  params: [
    { key: 'darkTint', label: 'Dark', type: 'color', default: [0.16, 0.15, 0.14], group: 'Colour' },
    { key: 'midTint', label: 'Mid', type: 'color', default: [0.36, 0.34, 0.31], group: 'Colour' },
    { key: 'lightTint', label: 'Light', type: 'color', default: [0.56, 0.54, 0.49], group: 'Colour' },
    { key: 'lichenColor', label: 'Lichen', type: 'color', default: [0.36, 0.4, 0.24], group: 'Colour' },
    { key: 'lichen', label: 'Lichen Cover', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Patches of growth, which settle on the flat and the sheltered rather than the exposed edges.' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 50, step: 0.05, group: 'Pattern' },
    { key: 'plates', label: 'Plate Density', type: 'float', default: 7, min: 0.5, max: 60, step: 0.1, group: 'Pattern' },
    { key: 'strata', label: 'Strata', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Sedimentary banding. Turn it off for igneous rock.' },
    { key: 'strataScale', label: 'Strata Frequency', type: 'float', default: 9, min: 0.5, max: 60, step: 0.1, group: 'Pattern' },
    { key: 'crackDepth', label: 'Crack Depth', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.7, min: 0, max: 2, step: 0.01, group: 'Surface' },
    { key: 'grit', label: 'Grit', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Fine mineral grain riding on top of the big shapes.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const strataAt = (uvNode: V2): F => {
      // Bands follow a warped V so they undulate the way a bedding plane does.
      const w = warp(vec3(uvNode.mul(scale.mul(0.5)), offset.add(23)), 0.5, 1.1)
      return w.y.mul(p.float('strataScale')).sin().mul(0.5).add(0.5)
    }

    const heightAt = (uvNode: V2): F => {
      const body = ridged(vec3(uvNode.mul(scale), offset), float(5), float(0.55))
      const cells = voronoi2(uvNode.mul(p.float('plates')).add(vec2(offset, offset)), float(0.95))
      const crack = smoothstep(float(0), float(0.09), voronoiBorder(cells))
      const plateLift = voronoiCellValue(cells).mul(0.18)
      const band = strataAt(uvNode).sub(0.5).mul(p.float('strata')).mul(0.12)
      const grit = fbm01(vec3(uvNode.mul(scale.mul(24)), offset.add(5)), 3, 2.3, 0.5).sub(0.5).mul(p.float('grit')).mul(0.05)
      return body.mul(p.float('relief')).add(plateLift).add(band).add(grit).sub(crack.oneMinus().mul(p.float('crackDepth')))
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(1.4))
    const h01 = h.clamp(0, 1)

    const tone = fbm01(vec3(ctx.uv.mul(scale.mul(2.3)), offset.add(5)), 4, 2, 0.5)
    const banded = mix(tone, strataAt(ctx.uv), p.float('strata').mul(0.6))
    const stone = tintVariation(
      gradient3(banded.mul(0.6).add(h01.mul(0.4)), p.color('darkTint'), p.color('midTint'), p.color('lightTint')),
      fbm01(vec3(ctx.uv.mul(scale.mul(0.4)), offset.add(61)), 3, 2, 0.5),
      0.01,
      0.18,
      0.16,
    )

    // Lichen grows where water sits and light is indirect: the sheltered,
    // near-flat parts of the rock, not the exposed ridges.
    const lichenField = fbm01(warp(vec3(ctx.uv.mul(scale.mul(1.8)), offset.add(37)), 0.8, 1.4), 4, 2.2, 0.55)
    const lichenMask = smoothstep(float(0.52), float(0.78), lichenField)
      .mul(smoothstep(float(0.2), float(0.75), normal.z))
      .mul(p.float('lichen'))

    return {
      baseColor: mix(stone, p.color('lichenColor'), lichenMask.mul(0.85)),
      metallic: float(0),
      roughness: p.float('roughness').sub(h01.mul(0.06)).add(lichenMask.mul(0.08)).clamp(0.1, 1),
      ao: cavityAO(h01, normal, 0.7),
      height: h.mul(0.5).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const cobblestone = registerMaterial({
  id: 'cobblestone',
  name: 'Cobblestone',
  category: 'Masonry',
  description: 'Rounded setts bedded in sand. Traffic polishes the crown of each stone and leaves the flanks rough, so the wear pattern follows the height field - which is exactly how a real street ages.',
  params: [
    { key: 'stoneDark', label: 'Stone Dark', type: 'color', default: [0.15, 0.15, 0.16], group: 'Colour' },
    { key: 'stoneMid', label: 'Stone Mid', type: 'color', default: [0.31, 0.3, 0.29], group: 'Colour' },
    { key: 'stoneLight', label: 'Stone Light', type: 'color', default: [0.48, 0.46, 0.43], group: 'Colour' },
    { key: 'sandColor', label: 'Joint Sand', type: 'color', default: [0.36, 0.33, 0.27], group: 'Colour' },
    { key: 'scale', label: 'Sett Density', type: 'float', default: 9, min: 1, max: 60, step: 0.1, group: 'Layout' },
    { key: 'jitter', label: 'Irregularity', type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Zero lays a perfect grid of setts; one lets the mason place them by eye.' },
    { key: 'joint', label: 'Joint Width', type: 'float', default: 0.14, min: 0.01, max: 0.5, step: 0.005, group: 'Layout' },
    { key: 'crown', label: 'Crown', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'How domed each stone is. Old setts are worn nearly flat; new ones are proud.' },
    { key: 'settle', label: 'Settling', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'How unevenly the stones have sunk into their bed.' },
    { key: 'polish', label: 'Traffic Polish', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.8, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const cellAt = (uvNode: V2) =>
      pebbles(uvNode.mul(scale).add(vec2(offset, offset)), p.float('jitter'), p.float('joint'))

    const heightAt = (uvNode: V2): F => {
      const cell = cellAt(uvNode)
      const settle = hash21(cell.zw.add(vec2(offset.add(3), offset))).sub(0.5).mul(p.float('settle')).mul(0.3)
      const crown = cell.x.pow(mix(float(1.4), float(0.55), p.float('crown')))
      // Stone texture, and sand in the joints. The sand is grainy, so it gets
      // its own high-frequency field rather than sharing the stone's.
      const rough = fbm01(vec3(uvNode.mul(scale.mul(14)), offset.add(7)), 3, 2.2, 0.5).sub(0.5).mul(0.05)
      const sand = fbm01(vec3(uvNode.mul(scale.mul(40)), offset.add(11)), 2, 2, 0.5).mul(0.04)
      return crown.mul(p.float('crown').mul(0.6).add(0.3)).add(settle.mul(cell.x)).add(rough.mul(cell.x)).add(sand.mul(cell.x.oneMinus()))
    }

    const cell = cellAt(ctx.uv)
    const stoneMask = cell.x
    const id = hash21(cell.zw)
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('crown').add(0.4).mul(1.4))
    const h01 = h.clamp(0, 1)

    const mottle = fbm01(vec3(ctx.uv.mul(scale.mul(6)), offset.add(19)), 4, 2, 0.5)
    const stone = tintVariation(
      gradient3(id.mul(0.7).add(mottle.mul(0.3)), p.color('stoneDark'), p.color('stoneMid'), p.color('stoneLight')),
      hash21(cell.zw.add(vec2(9.1, 2.3))),
      0.01,
      0.2,
      0.24,
    )
    const sand = p.color('sandColor').mul(mix(float(0.8), float(1.15), fbm01(vec3(ctx.uv.mul(scale.mul(30)), offset), 2, 2, 0.5)))

    // Boots and wheels only ever touch the top of the crown.
    const polished = smoothstep(float(0.55), float(0.95), stoneMask).mul(p.float('polish'))

    return {
      baseColor: mix(sand, stone.mul(mix(float(1), float(0.82), polished.mul(0.4))), stoneMask),
      metallic: float(0),
      roughness: mix(float(0.95), p.float('roughness').sub(polished.mul(0.5)), stoneMask).clamp(0.06, 1),
      ao: cavityAO(h01, normal, 0.75),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const terrazzo = registerMaterial({
  id: 'terrazzo',
  name: 'Terrazzo',
  category: 'Masonry',
  description: 'Stone chips set in a cement binder and ground flat. Two chip sizes at independent scales are what makes it read as poured rather than tiled: a single Voronoi layer always betrays its grid.',
  params: [
    { key: 'binder', label: 'Binder', type: 'color', default: [0.82, 0.8, 0.77], group: 'Colour' },
    { key: 'chipA', label: 'Chip A', type: 'color', default: [0.14, 0.14, 0.15], group: 'Colour' },
    { key: 'chipB', label: 'Chip B', type: 'color', default: [0.66, 0.24, 0.2], group: 'Colour' },
    { key: 'chipC', label: 'Chip C', type: 'color', default: [0.35, 0.45, 0.4], group: 'Colour' },
    { key: 'chipD', label: 'Chip D', type: 'color', default: [0.9, 0.88, 0.82], group: 'Colour' },
    { key: 'largeScale', label: 'Large Chips', type: 'float', default: 14, min: 1, max: 90, step: 0.1, group: 'Aggregate' },
    { key: 'smallScale', label: 'Small Chips', type: 'float', default: 34, min: 2, max: 200, step: 0.5, group: 'Aggregate' },
    { key: 'density', label: 'Chip Density', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Aggregate', description: 'How much of the surface is stone rather than binder.' },
    { key: 'relief', label: 'Grind Relief', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Chips are harder than the binder, so grinding leaves them a fraction proud.' },
    { key: 'polish', label: 'Polish', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const layer = (uvNode: V2, scale: F, seed: number) => {
      const cells = voronoi2(uvNode.mul(scale).add(vec2(offset.add(seed), offset.add(seed))), float(1))
      const id = voronoiCellValue(cells)
      // A chip only exists where its cell wins the density draw, and its shape
      // is the cell interior eroded by the draw itself - which gives ragged,
      // conchoidal edges rather than clean polygons.
      const present = step(id, p.float('density'))
      const shape = smoothstep(float(0.02), float(0.12), voronoiBorder(cells))
      return { mask: present.mul(shape), id: hash21(cells.zw.add(vec2(seed, seed))) }
    }

    const chipAt = (uvNode: V2) => {
      const big = layer(uvNode, p.float('largeScale'), 0)
      const small = layer(uvNode, p.float('smallScale'), 13)
      // Large chips sit on top: the small ones fill the gaps between them.
      const smallMask = small.mask.mul(big.mask.oneMinus())
      return { big, small, smallMask, mask: max(big.mask, smallMask) }
    }

    const heightAt = (uvNode: V2): F => chipAt(uvNode).mask.mul(p.float('relief')).mul(0.1)

    const c = chipAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(0.35))

    const chipColour = (t: F) =>
      mix(
        mix(p.color('chipA'), p.color('chipB'), smoothstep(float(0.25), float(0.5), t)),
        mix(p.color('chipC'), p.color('chipD'), smoothstep(float(0.75), float(1), t)),
        smoothstep(float(0.5), float(0.75), t),
      )

    const bigColour = tintVariation(chipColour(c.big.id), c.big.id, 0.01, 0.15, 0.18)
    const smallColour = tintVariation(chipColour(c.small.id), c.small.id, 0.01, 0.15, 0.18)
    const binder = p.color('binder').mul(mix(float(0.92), float(1.06), fbm01(vec3(ctx.uv.mul(60), offset), 3, 2, 0.5)))

    const colour = mix(mix(binder, smallColour, c.smallMask), bigColour, c.big.mask)
    const glossiness = p.float('polish')

    return {
      baseColor: colour,
      metallic: float(0),
      // Stone takes a polish; the cement between it never quite does.
      roughness: mix(float(0.42), float(0.05), glossiness)
        .add(c.mask.oneMinus().mul(0.22))
        .add(microVariation(ctx.uv, float(220), offset).sub(0.5).mul(0.04))
        .clamp(0.02, 1),
      ao: cavityAO(c.mask.mul(0.3).add(0.7), normal, 0.15),
      height: heightAt(ctx.uv).mul(4).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const asphalt = registerMaterial({
  id: 'asphalt',
  name: 'Asphalt',
  category: 'Masonry',
  description: 'Aggregate in bitumen. The stones are blended in by height rather than by a mask, so the binder covers them where it is thick and they break through where it has worn - which is the whole visual story of a road surface.',
  params: [
    { key: 'binder', label: 'Bitumen', type: 'color', default: [0.055, 0.055, 0.06], group: 'Colour' },
    { key: 'aggregateDark', label: 'Aggregate Dark', type: 'color', default: [0.13, 0.13, 0.13], group: 'Colour' },
    { key: 'aggregateLight', label: 'Aggregate Light', type: 'color', default: [0.42, 0.41, 0.39], group: 'Colour' },
    { key: 'scale', label: 'Aggregate Size', type: 'float', default: 55, min: 4, max: 400, step: 0.5, group: 'Aggregate' },
    { key: 'exposure', label: 'Wear', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Aggregate', description: 'How much bitumen has worn off the stones. New tarmac is nearly black; an old road is grey with exposed aggregate.' },
    { key: 'patchiness', label: 'Patchiness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Aggregate', description: 'Wear is never even - it follows the wheel paths.' },
    { key: 'cracking', label: 'Cracking', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Damage' },
    { key: 'crackScale', label: 'Crack Scale', type: 'float', default: 6, min: 0.5, max: 60, step: 0.1, group: 'Damage' },
    { key: 'oil', label: 'Oil Staining', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Damage' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.82, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const stonesAt = (uvNode: V2): F => pebbles(uvNode.mul(scale).add(vec2(offset, offset)), float(0.95), float(0.4)).x
    const fineAt = (uvNode: V2): F => pebbles(uvNode.mul(scale.mul(2.6)).add(vec2(offset.add(5), offset)), float(0.95), float(0.5)).x
    const crackAt = (uvNode: V2): F =>
      cracks(uvNode.add(vec2(offset, offset)), p.float('crackScale'), float(0.045), offset.add(29)).mul(p.float('cracking'))

    // Wear follows broad bands, so the aggregate is exposed in patches.
    const wearAt = (uvNode: V2): F => {
      const band = fbm01(vec3(uvNode.mul(vec2(1.5, 5)).mul(0.7), offset.add(17)), 4, 2.1, 0.55)
      return mix(p.float('exposure'), p.float('exposure').mul(band.mul(2)), p.float('patchiness')).clamp(0, 1)
    }

    const heightAt = (uvNode: V2): F => {
      const stones = stonesAt(uvNode).mul(0.7).add(fineAt(uvNode).mul(0.3))
      const bitumenLevel = float(1).sub(wearAt(uvNode))
      // Bitumen fills between the stones: the more of it, the smoother.
      return mix(stones.mul(0.35), stones.mul(0.08), bitumenLevel).sub(crackAt(uvNode).mul(0.3))
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.9))
    const stones = stonesAt(ctx.uv)
    const wear = wearAt(ctx.uv)
    const exposed = heightBlend(wear, stones, float(0.3), 0.18).mul(stones)

    const stoneColour = tintVariation(
      mix(p.color('aggregateDark'), p.color('aggregateLight'), fbm01(vec3(ctx.uv.mul(scale.mul(1.4)), offset.add(3)), 3, 2, 0.5)),
      fbm01(vec3(ctx.uv.mul(scale.mul(0.7)), offset.add(23)), 3, 2, 0.5),
      0.008,
      0.15,
      0.3,
    )
    const oil = smoothstep(float(0.62), float(0.85), fbm01(warp(vec3(ctx.uv.mul(3), offset.add(43)), 0.7, 1.2), 4, 2.1, 0.55))
      .mul(p.float('oil'))
    const crack = crackAt(ctx.uv)

    return {
      baseColor: mix(mix(p.color('binder'), stoneColour, exposed), vec3(0.02, 0.02, 0.02), max(oil, crack.mul(0.8))),
      metallic: float(0),
      // Fresh bitumen is slightly glossy; exposed aggregate is dead matte.
      roughness: mix(float(0.55), p.float('roughness'), exposed).sub(oil.mul(0.35)).clamp(0.08, 1),
      ao: cavityAO(h.mul(2.5).add(0.4).clamp(0, 1), normal, 0.6),
      height: h.mul(1.6).add(0.4).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const MASONRY = [bricks, concrete, marble, rock, cobblestone, terrazzo, asphalt]
