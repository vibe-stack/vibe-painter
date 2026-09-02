/**
 * Metals. Every one of these is coordinates and noise - no scans, no photos.
 *
 * The recurring trick is that a metal reads as a metal because of its
 * *roughness* structure, not its colour: brushed lines, corrosion patches and
 * hammer dents are all roughness/height stories with a nearly constant albedo.
 */

import { float, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { ParamDef } from '../params'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import { fbm01, gradient3, normalFromHeightFn, ridged, scratches, voronoi2, voronoiCellValue, warp } from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

// ---------------------------------------------------------------------------

const polishedParams: readonly ParamDef[] = [
  { key: 'tint', label: 'Tint', type: 'color', default: [0.95, 0.93, 0.88], group: 'Colour', description: 'Reflectance colour. Gold ~ (1.0, 0.77, 0.34), copper ~ (0.96, 0.64, 0.54).' },
  { key: 'roughness', label: 'Roughness', type: 'float', default: 0.12, min: 0, max: 1, step: 0.001, group: 'Surface' },
  { key: 'variation', label: 'Roughness Variation', type: 'float', default: 0.06, min: 0, max: 0.5, step: 0.001, group: 'Surface', description: 'Large-scale smudging. Zero looks synthetic; a little is what sells it.' },
  { key: 'varScale', label: 'Variation Scale', type: 'float', default: 6, min: 0.5, max: 60, step: 0.1, group: 'Surface' },
  SEED_PARAM,
]

export const polishedMetal = registerMaterial({
  id: 'polished-metal',
  name: 'Polished Metal',
  category: 'Metal',
  description: 'Clean reflective metal with subtle roughness drift. The base every other metal is built on.',
  params: polishedParams,
  build(ctx): PartialBundle {
    const p = ctx.params
    const smudge = fbm01(coord3(ctx, p.float('varScale')), 3, 2, 0.5)
    return {
      baseColor: p.color('tint'),
      metallic: float(1),
      roughness: p.float('roughness').add(smudge.sub(0.5).mul(p.float('variation'))).clamp(0.008, 1),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const brushedMetal = registerMaterial({
  id: 'brushed-metal',
  name: 'Brushed Metal',
  category: 'Metal',
  description: 'Anisotropic brushing. Noise stretched along one axis becomes directional grain - the same trick drives hair and satin.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.82, 0.83, 0.85], group: 'Colour' },
    { key: 'angle', label: 'Brush Angle', type: 'float', default: 0, min: 0, max: Math.PI, step: 0.01, group: 'Grain' },
    { key: 'stretch', label: 'Anisotropy', type: 'float', default: 40, min: 1, max: 400, step: 0.5, group: 'Grain', description: 'How far the grain is stretched along the brush direction.' },
    { key: 'density', label: 'Density', type: 'float', default: 40, min: 1, max: 400, step: 0.5, group: 'Grain' },
    { key: 'roughness', label: 'Base Roughness', type: 'float', default: 0.25, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'depth', label: 'Groove Depth', type: 'float', default: 0.15, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const grainAt = (uvNode: V2): F =>
      scratches(uvNode.add(vec2(offset, offset)), p.float('angle'), p.float('stretch'), p.float('density'))
    const grain = grainAt(ctx.uv)
    return {
      baseColor: p.color('tint').mul(mix(float(1), float(0.88), grain)),
      metallic: float(1),
      roughness: p.float('roughness').add(grain.mul(0.35)).clamp(0.02, 1),
      height: grain.mul(p.float('depth')).mul(0.5).add(0.5),
      normal: normalFromHeightFn(grainAt, ctx.uv, ctx.texel, p.float('depth').mul(0.35)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const rustedIron = registerMaterial({
  id: 'rusted-iron',
  name: 'Rusted Iron',
  category: 'Metal',
  description: 'Iron with corrosion blooms. Domain-warped noise gives the rust an organic edge; a hard threshold would look like a stain, not like rust eating metal.',
  params: [
    { key: 'metalTint', label: 'Metal Tint', type: 'color', default: [0.55, 0.56, 0.58], group: 'Colour' },
    { key: 'rustDark', label: 'Rust Dark', type: 'color', default: [0.24, 0.11, 0.06], group: 'Colour' },
    { key: 'rustMid', label: 'Rust Mid', type: 'color', default: [0.51, 0.23, 0.09], group: 'Colour' },
    { key: 'rustLight', label: 'Rust Light', type: 'color', default: [0.72, 0.41, 0.19], group: 'Colour' },
    { key: 'coverage', label: 'Rust Coverage', type: 'float', default: 0.55, min: 0, max: 1, step: 0.001, group: 'Corrosion' },
    { key: 'edgeSoftness', label: 'Edge Softness', type: 'float', default: 0.12, min: 0.005, max: 0.5, step: 0.001, group: 'Corrosion' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 60, step: 0.1, group: 'Corrosion' },
    { key: 'warpAmount', label: 'Warp', type: 'float', default: 0.45, min: 0, max: 2, step: 0.01, group: 'Corrosion', description: 'Distorts the corrosion field so the boundary meanders instead of drawing smooth blobs.' },
    { key: 'crust', label: 'Crust Height', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('scale')

    const rustAt = (uvNode: V2): F => {
      const base = vec3(uvNode.mul(scale), seedOffset(ctx))
      const warped = warp(base, p.float('warpAmount'), 0.7)
      const field = fbm01(warped, 5, 2.1, 0.55)
      const t = p.float('coverage').oneMinus()
      const soft = p.float('edgeSoftness')
      return smoothstep(t.sub(soft), t.add(soft), field)
    }

    const rust = rustAt(ctx.uv)
    // Crust rides on top of the metal, so height only rises where rust is.
    const crustAt = (uvNode: V2): F => {
      const grain = ridged(vec3(uvNode.mul(scale.mul(6)), seedOffset(ctx)), float(4), float(0.5))
      return rustAt(uvNode).mul(grain.mul(p.float('crust')))
    }

    const tone = fbm01(vec3(ctx.uv.mul(scale.mul(3)), seedOffset(ctx).add(9)), 4, 2, 0.5)
    const rustColour = gradient3(tone, p.color('rustDark'), p.color('rustMid'), p.color('rustLight'))

    return {
      baseColor: mix(p.color('metalTint'), rustColour, rust),
      metallic: rust.oneMinus(),
      roughness: mix(float(0.28), float(0.92), rust),
      ao: mix(float(1), float(0.82), rust),
      height: crustAt(ctx.uv).mul(0.5).add(0.4),
      normal: normalFromHeightFn(crustAt, ctx.uv, ctx.texel, p.float('crust').mul(0.6)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const paintedMetal = registerMaterial({
  id: 'painted-metal',
  name: 'Painted Metal',
  category: 'Metal',
  description: 'Paint over metal with chipping. Chips follow a ridged field so they break in flakes with jagged edges rather than round dots.',
  params: [
    { key: 'paintColor', label: 'Paint Colour', type: 'color', default: [0.15, 0.34, 0.52], group: 'Colour' },
    { key: 'metalTint', label: 'Metal Under', type: 'color', default: [0.5, 0.5, 0.52], group: 'Colour' },
    { key: 'chipAmount', label: 'Chipping', type: 'float', default: 0.3, min: 0, max: 1, step: 0.001, group: 'Wear' },
    { key: 'chipScale', label: 'Chip Scale', type: 'float', default: 14, min: 1, max: 120, step: 0.1, group: 'Wear' },
    { key: 'paintRoughness', label: 'Paint Roughness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'orangePeel', label: 'Orange Peel', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The fine dimpling of sprayed paint.' },
    { key: 'paintThickness', label: 'Paint Thickness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('chipScale')

    const paintAt = (uvNode: V2): F => {
      const field = ridged(vec3(uvNode.mul(scale), seedOffset(ctx)), float(4), float(0.55))
      const threshold = p.float('chipAmount')
      return smoothstep(threshold.sub(0.06), threshold.add(0.06), field)
    }
    const paint = paintAt(ctx.uv)

    const peelAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(scale.mul(14)), seedOffset(ctx).add(3)), 2, 2, 0.5).mul(p.float('orangePeel'))

    const heightAt = (uvNode: V2): F => paintAt(uvNode).mul(p.float('paintThickness')).add(peelAt(uvNode).mul(0.06))

    return {
      baseColor: mix(p.color('metalTint'), p.color('paintColor'), paint),
      metallic: paint.oneMinus(),
      roughness: mix(float(0.4), p.float('paintRoughness').add(peelAt(ctx.uv).mul(0.1)), paint).clamp(0.02, 1),
      ao: mix(float(0.85), float(1), paint),
      height: heightAt(ctx.uv).mul(0.6).add(0.3),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('paintThickness').mul(1.2)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const hammeredMetal = registerMaterial({
  id: 'hammered-metal',
  name: 'Hammered Metal',
  category: 'Metal',
  description: 'Voronoi dents. Each cell becomes one hammer strike, with a rounded floor and a raised rim where the metal displaced.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.78, 0.78, 0.8], group: 'Colour' },
    { key: 'scale', label: 'Strike Density', type: 'float', default: 9, min: 1, max: 80, step: 0.1, group: 'Pattern' },
    { key: 'jitter', label: 'Irregularity', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'depth', label: 'Dent Depth', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.22, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('scale')
    const offset = seedOffset(ctx)

    const heightAt = (uvNode: V2): F => {
      const cell = voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), p.float('jitter'))
      // A dome inside each cell, dropping to a rim at the border.
      const dome = float(1).sub(cell.x.mul(2).clamp(0, 1))
      const depthVariation = mix(float(0.7), float(1), voronoiCellValue(cell))
      return dome.mul(dome).mul(depthVariation).mul(p.float('depth'))
    }

    const h = heightAt(ctx.uv)
    return {
      baseColor: p.color('tint').mul(mix(float(0.9), float(1.05), h)),
      metallic: float(1),
      roughness: p.float('roughness').add(h.oneMinus().mul(0.12)).clamp(0.02, 1),
      ao: mix(float(0.88), float(1), h),
      height: h.mul(0.7).add(0.15),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.5)),
    }
  },
} satisfies ProceduralMaterialDef)

export const METALS = [polishedMetal, brushedMetal, rustedIron, paintedMetal, hammeredMetal]
