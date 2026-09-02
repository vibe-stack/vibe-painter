/**
 * Masonry and stone. These are the materials where *height* does most of the
 * work: bricks, tiles and rock all read primarily as a displacement pattern
 * with colour riding along.
 */

import { float, min, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  brickGrid,
  fbm01,
  gradient3,
  hash21,
  normalFromHeightFn,
  ridged,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
  warp,
  worley,
} from '../noise'
import type { MatContext } from '../material'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

export const bricks = registerMaterial({
  id: 'bricks',
  name: 'Brick Wall',
  category: 'Masonry',
  description: 'Running-bond brickwork. Each brick gets its own colour and height from a hash of its grid cell, which is what stops the wall from looking stamped.',
  params: [
    { key: 'rows', label: 'Rows', type: 'float', default: 12, min: 1, max: 80, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Brick Aspect', type: 'float', default: 2.2, min: 0.2, max: 8, step: 0.01, group: 'Layout', description: 'Width divided by height. Standard brick is about 2.2.' },
    { key: 'bond', label: 'Row Offset', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout', description: '0.5 is a running bond, 0 is a stack bond.' },
    { key: 'mortar', label: 'Mortar Width', type: 'float', default: 0.06, min: 0, max: 0.4, step: 0.001, group: 'Layout' },
    { key: 'brickA', label: 'Brick Colour A', type: 'color', default: [0.44, 0.19, 0.14], group: 'Colour' },
    { key: 'brickB', label: 'Brick Colour B', type: 'color', default: [0.58, 0.29, 0.2], group: 'Colour' },
    { key: 'brickC', label: 'Brick Colour C', type: 'color', default: [0.34, 0.16, 0.13], group: 'Colour' },
    { key: 'mortarColor', label: 'Mortar Colour', type: 'color', default: [0.62, 0.6, 0.56], group: 'Colour' },
    { key: 'variation', label: 'Colour Variation', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'depth', label: 'Mortar Recess', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.82, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'grain', label: 'Surface Grain', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const rows = p.float('rows')
    const cols = rows.mul(p.float('aspect'))
    const offset = seedOffset(ctx)

    const gridAt = (uvNode: V2) => brickGrid(vec2(uvNode.x.mul(cols), uvNode.y.mul(rows)), p.float('bond'))

    const brickMaskAt = (uvNode: V2): F => {
      const g = gridAt(uvNode)
      const m = p.float('mortar')
      // Distance to the nearest cell edge, anti-aliased into a 0..1 mask.
      const dx = min(g.x, g.x.oneMinus())
      const dy = min(g.y, g.y.oneMinus())
      const d = min(dx, dy.mul(p.float('aspect')))
      return smoothstep(m.mul(0.5), m, d)
    }

    const heightAt = (uvNode: V2): F => {
      const brick = brickMaskAt(uvNode)
      const grain = fbm01(vec3(uvNode.mul(cols.mul(4)), offset), 4, 2, 0.5).sub(0.5).mul(p.float('grain').mul(0.25))
      return brick.mul(p.float('depth')).add(grain.mul(brick))
    }

    const g = gridAt(ctx.uv)
    const brick = brickMaskAt(ctx.uv)
    const id = hash21(g.zw.add(vec2(offset, offset)))
    const tone = mix(float(0.5), id, p.float('variation'))
    const brickColour = gradient3(tone, p.color('brickA'), p.color('brickB'), p.color('brickC'))
    const grain = fbm01(vec3(ctx.uv.mul(cols.mul(6)), offset.add(4)), 4, 2, 0.5)
    const shaded = brickColour.mul(mix(float(0.82), float(1.1), grain))

    return {
      baseColor: mix(p.color('mortarColor').mul(mix(float(0.85), float(1.05), grain)), shaded, brick),
      roughness: mix(float(0.95), p.float('roughness'), brick),
      metallic: float(0),
      ao: mix(float(0.55), float(1), brick),
      height: heightAt(ctx.uv),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const concrete = registerMaterial({
  id: 'concrete',
  name: 'Concrete',
  category: 'Masonry',
  description: 'Cast concrete: broad tonal drift, aggregate showing through, and air-bubble pitting. The pits are inverted Worley cells, which is why they cluster the way real voids do.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.62, 0.61, 0.58], group: 'Colour' },
    { key: 'stainColor', label: 'Stain Colour', type: 'color', default: [0.36, 0.35, 0.33], group: 'Colour' },
    { key: 'stains', label: 'Staining', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 4, min: 0.2, max: 40, step: 0.05, group: 'Pattern' },
    { key: 'pits', label: 'Pitting', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'pitScale', label: 'Pit Density', type: 'float', default: 45, min: 4, max: 300, step: 0.5, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'aggregate', label: 'Aggregate', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const heightAt = (uvNode: V2): F => {
      const coarse = fbm01(vec3(uvNode.mul(scale), offset), 4, 2, 0.5).mul(0.35)
      const pit = worley(vec3(uvNode.mul(p.float('pitScale')), offset.add(7)), 1)
      const pitMask = smoothstep(float(0.0), float(0.22), pit).oneMinus()
      const aggregate = worley(vec3(uvNode.mul(p.float('pitScale').mul(0.35)), offset.add(2)), 0.9)
      return coarse
        .sub(pitMask.mul(p.float('pits')))
        .add(aggregate.mul(p.float('aggregate')).mul(0.12))
    }

    const drift = fbm01(vec3(ctx.uv.mul(scale.mul(0.6)), offset.add(11)), 3, 2, 0.6)
    const stain = fbm01(warp(vec3(ctx.uv.mul(scale.mul(1.6)), offset.add(21)), 0.5, 1.2), 5, 2.2, 0.55)
    const stainMask = smoothstep(float(0.5), float(0.78), stain).mul(p.float('stains'))
    const h = heightAt(ctx.uv)

    return {
      baseColor: mix(p.color('tint').mul(mix(float(0.85), float(1.12), drift)), p.color('stainColor'), stainMask),
      metallic: float(0),
      roughness: p.float('roughness').add(stainMask.mul(0.06)).clamp(0.05, 1),
      ao: h.mul(0.5).add(0.5).clamp(0.35, 1),
      height: h.mul(0.5).add(0.5),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const marble = registerMaterial({
  id: 'marble',
  name: 'Marble',
  category: 'Masonry',
  description: 'Veined marble. The veins are a sine of a domain-warped field: warping first is what makes them wander and branch instead of drawing parallel stripes.',
  params: [
    { key: 'baseTint', label: 'Base', type: 'color', default: [0.9, 0.89, 0.87], group: 'Colour' },
    { key: 'veinColor', label: 'Vein', type: 'color', default: [0.22, 0.21, 0.24], group: 'Colour' },
    { key: 'secondaryColor', label: 'Secondary Vein', type: 'color', default: [0.62, 0.58, 0.52], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 3, min: 0.2, max: 30, step: 0.05, group: 'Pattern' },
    { key: 'warpAmount', label: 'Turbulence', type: 'float', default: 1.1, min: 0, max: 4, step: 0.01, group: 'Pattern' },
    { key: 'veinCount', label: 'Vein Frequency', type: 'float', default: 4, min: 0.5, max: 30, step: 0.05, group: 'Pattern' },
    { key: 'veinSharpness', label: 'Vein Sharpness', type: 'float', default: 6, min: 1, max: 40, step: 0.1, group: 'Pattern' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.14, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const base = vec3(ctx.uv.mul(p.float('scale')), offset)
    const warped = warp(base, p.float('warpAmount'), 0.8)

    const field = warped.x.add(warped.y).mul(p.float('veinCount'))
    const vein = field.sin().abs().oneMinus().pow(p.float('veinSharpness'))
    const secondary = fbm01(warp(base.mul(2.7), p.float('warpAmount').mul(0.6), 1.7), 4, 2, 0.55)
    const secondaryMask = smoothstep(float(0.55), float(0.85), secondary).mul(0.5)

    const colour = mix(mix(p.color('baseTint'), p.color('secondaryColor'), secondaryMask), p.color('veinColor'), vein.clamp(0, 1))

    return {
      baseColor: colour,
      metallic: float(0),
      // Veins are a different mineral, so they polish differently.
      roughness: p.float('roughness').add(vein.mul(0.1)).clamp(0.01, 1),
      height: vein.mul(0.05).add(0.5),
      normal: normalFromHeightFn(
        (uvNode) => {
          const w = warp(vec3(uvNode.mul(p.float('scale')), offset), p.float('warpAmount'), 0.8)
          return w.x.add(w.y).mul(p.float('veinCount')).sin().abs().oneMinus().pow(p.float('veinSharpness'))
        },
        ctx.uv,
        ctx.texel,
        float(0.06),
      ),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const rock = registerMaterial({
  id: 'rock',
  name: 'Rock',
  category: 'Masonry',
  description: 'Fractured rock. Ridged noise supplies the sharp creases a plain fbm cannot, and Worley borders cut the cracks between plates.',
  params: [
    { key: 'darkTint', label: 'Dark', type: 'color', default: [0.19, 0.18, 0.17], group: 'Colour' },
    { key: 'midTint', label: 'Mid', type: 'color', default: [0.38, 0.36, 0.33], group: 'Colour' },
    { key: 'lightTint', label: 'Light', type: 'color', default: [0.56, 0.54, 0.5], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 50, step: 0.05, group: 'Pattern' },
    { key: 'plates', label: 'Plate Density', type: 'float', default: 7, min: 0.5, max: 60, step: 0.1, group: 'Pattern' },
    { key: 'crackDepth', label: 'Crack Depth', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.7, min: 0, max: 2, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const heightAt = (uvNode: V2): F => {
      const body = ridged(vec3(uvNode.mul(p.float('scale')), offset), float(5), float(0.55))
      const cells = voronoi2(uvNode.mul(p.float('plates')).add(vec2(offset, offset)), float(0.95))
      const crack = smoothstep(float(0), float(0.09), voronoiBorder(cells))
      const plateLift = voronoiCellValue(cells).mul(0.18)
      return body.mul(p.float('relief')).add(plateLift).sub(crack.oneMinus().mul(p.float('crackDepth')))
    }

    const h = heightAt(ctx.uv)
    const tone = fbm01(vec3(ctx.uv.mul(p.float('scale').mul(2.3)), offset.add(5)), 4, 2, 0.5)
    const colour = gradient3(tone.mul(0.6).add(h.clamp(0, 1).mul(0.4)), p.color('darkTint'), p.color('midTint'), p.color('lightTint'))

    return {
      baseColor: colour,
      metallic: float(0),
      roughness: p.float('roughness').sub(h.mul(0.08)).clamp(0.1, 1),
      ao: h.clamp(0, 1).mul(0.45).add(0.55),
      height: h.mul(0.5).add(0.5),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(1.4)),
    }
  },
} satisfies ProceduralMaterialDef)

export const MASONRY = [bricks, concrete, marble, rock]
