/**
 * Metals. Every one of these is coordinates and noise - no scans, no photos.
 *
 * The recurring trick is that a metal reads as a metal because of its
 * *roughness* structure, not its colour: brushed lines, corrosion patches and
 * hammer dents are all roughness/height stories with a nearly constant albedo.
 *
 * The second trick, and the one that separates these from a shader test, is
 * that nothing is ever uniform. A polished sheet still carries polish swirl and
 * handling smudge; a painted panel has primer under the paint and dirt in its
 * chips. Constant roughness does not exist in the world, so it does not exist
 * here either.
 */

import { float, max, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { ParamDef } from '../params'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  cavityAO,
  cracks,
  drips,
  fbm01,
  gradient3,
  hash21,
  microVariation,
  normalFromHeightFn,
  ridged,
  scratches,
  tintVariation,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
  warp,
  worley,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

/**
 * How much a gravity-driven effect applies on this evaluation.
 *
 * Under triplanar the material is evaluated once per axis, and only the two
 * vertical planes should get runs and drips - a rust streak on an upward-facing
 * surface is just a stain. The axis is structural (a JS number, not a node), so
 * this branch happens at graph-build time and costs nothing at runtime.
 */
function gravityWeight(ctx: MatContext): number {
  return ctx.axis === 1 ? 0 : 1
}

// ---------------------------------------------------------------------------

const polishedParams: readonly ParamDef[] = [
  { key: 'tint', label: 'Tint', type: 'color', default: [0.95, 0.93, 0.88], group: 'Colour', description: 'Reflectance colour. Gold ~ (1.0, 0.77, 0.34), copper ~ (0.96, 0.64, 0.54).' },
  { key: 'roughness', label: 'Roughness', type: 'float', default: 0.09, min: 0, max: 1, step: 0.001, group: 'Surface' },
  { key: 'variation', label: 'Roughness Variation', type: 'float', default: 0.08, min: 0, max: 0.5, step: 0.001, group: 'Surface', description: 'Large-scale smudging. Zero looks synthetic; a little is what sells it.' },
  { key: 'varScale', label: 'Variation Scale', type: 'float', default: 6, min: 0.5, max: 60, step: 0.1, group: 'Surface' },
  { key: 'swirl', label: 'Polish Swirl', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Polish', description: 'Fine crossed scratches left by the buffing wheel. This is what a real polish looks like up close.' },
  { key: 'swirlDensity', label: 'Swirl Density', type: 'float', default: 210, min: 20, max: 900, step: 1, group: 'Polish' },
  { key: 'fingerprints', label: 'Handling Smudge', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Polish', description: 'Greasy patches that scatter the reflection without changing the colour.' },
  SEED_PARAM,
]

export const polishedMetal = registerMaterial({
  id: 'polished-metal',
  name: 'Polished Metal',
  category: 'Metal',
  description: 'Clean reflective metal carrying buffing swirl and handling smudge. The base every other metal is built on.',
  params: polishedParams,
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const density = p.float('swirlDensity')

    // Two crossed scratch fields, not one: a single direction reads as brushed
    // metal, and it is the crossing that says "buffed" rather than "sanded".
    const swirlAt = (uvNode: V2): F => {
      const shifted = uvNode.add(vec2(offset, offset))
      const a = scratches(shifted, float(0.7), float(70), density)
      const b = scratches(shifted, float(2.3), float(55), density.mul(0.8))
      return max(a, b.mul(0.7)).mul(p.float('swirl'))
    }

    const swirl = swirlAt(ctx.uv)
    const smudge = fbm01(coord3(ctx, p.float('varScale')), 3, 2, 0.5)
    // Grease scatters light but leaves the metal underneath, so it lifts
    // roughness without touching base colour or metalness.
    const grease = smoothstep(float(0.48), float(0.78), fbm01(coord3(ctx, p.float('varScale').mul(2.4)).add(31), 4, 2.1, 0.55))
      .mul(p.float('fingerprints'))

    const roughness = p
      .float('roughness')
      .add(smudge.sub(0.5).mul(p.float('variation')))
      .add(swirl.mul(0.22))
      .add(grease.mul(0.3))

    return {
      baseColor: p.color('tint').mul(mix(float(1), float(0.97), swirl)),
      metallic: float(1),
      roughness: roughness.clamp(0.008, 1),
      // The swirl is microns deep; the normal carries it, the height does not.
      normal: normalFromHeightFn(swirlAt, ctx.uv, ctx.texel, float(0.004)),
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const brushedMetal = registerMaterial({
  id: 'brushed-metal',
  name: 'Brushed Metal',
  category: 'Metal',
  description: 'Anisotropic brushing at two grain scales, with the deeper grooves running dark. Noise stretched along one axis becomes directional grain - the same trick drives hair and satin.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.82, 0.83, 0.85], group: 'Colour' },
    { key: 'angle', label: 'Brush Angle', type: 'float', default: 0, min: 0, max: Math.PI, step: 0.01, group: 'Grain' },
    { key: 'stretch', label: 'Anisotropy', type: 'float', default: 60, min: 1, max: 400, step: 0.5, group: 'Grain', description: 'How far the grain is stretched along the brush direction.' },
    { key: 'density', label: 'Density', type: 'float', default: 45, min: 1, max: 400, step: 0.5, group: 'Grain' },
    { key: 'fineDensity', label: 'Fine Grain', type: 'float', default: 320, min: 10, max: 1200, step: 1, group: 'Grain', description: 'The second, much finer pass. A single frequency reads as noise; two read as an abrasive.' },
    { key: 'deepGrooves', label: 'Deep Grooves', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Grain', description: 'The occasional coarse scratch that a real belt leaves behind.' },
    { key: 'roughness', label: 'Base Roughness', type: 'float', default: 0.22, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'depth', label: 'Groove Depth', type: 'float', default: 0.15, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const angle = p.float('angle')

    const grainAt = (uvNode: V2): F => {
      const shifted = uvNode.add(vec2(offset, offset))
      const coarse = scratches(shifted, angle, p.float('stretch'), p.float('density'))
      const fine = scratches(shifted.add(vec2(3.1, 7.7)), angle, p.float('stretch').mul(1.6), p.float('fineDensity'))
      // A handful of much deeper lines, sparse enough to read individually.
      const deep = scratches(shifted.add(vec2(11.3, 2.9)), angle, p.float('stretch').mul(2.5), p.float('density').mul(0.35))
      return coarse.mul(0.55).add(fine.mul(0.3)).add(deep.mul(p.float('deepGrooves')).mul(0.6))
    }

    const grain = grainAt(ctx.uv)
    const normal = normalFromHeightFn(grainAt, ctx.uv, ctx.texel, p.float('depth').mul(0.5))

    return {
      // Grooves catch dirt and scatter, so they read darker as well as rougher.
      baseColor: p.color('tint').mul(mix(float(1.02), float(0.84), grain.clamp(0, 1))),
      metallic: float(1),
      roughness: p.float('roughness').add(grain.mul(0.4)).clamp(0.02, 1),
      height: grain.clamp(0, 1).mul(p.float('depth')).mul(0.5).add(0.5),
      ao: cavityAO(grain.clamp(0, 1).oneMinus(), normal, 0.25),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const rustedIron = registerMaterial({
  id: 'rusted-iron',
  name: 'Rusted Iron',
  category: 'Metal',
  description: 'Iron eaten by corrosion in three stages: pitting in the metal, a flaking crust over it, and stain runs below. Domain-warped noise gives the rust an organic edge; a hard threshold would look like a stain, not like rust eating metal.',
  params: [
    { key: 'metalTint', label: 'Metal Tint', type: 'color', default: [0.55, 0.56, 0.58], group: 'Colour' },
    { key: 'rustDark', label: 'Rust Dark', type: 'color', default: [0.19, 0.08, 0.04], group: 'Colour' },
    { key: 'rustMid', label: 'Rust Mid', type: 'color', default: [0.46, 0.19, 0.07], group: 'Colour' },
    { key: 'rustLight', label: 'Rust Light', type: 'color', default: [0.74, 0.42, 0.18], group: 'Colour' },
    { key: 'coverage', label: 'Rust Coverage', type: 'float', default: 0.55, min: 0, max: 1, step: 0.001, group: 'Corrosion' },
    { key: 'edgeSoftness', label: 'Edge Softness', type: 'float', default: 0.1, min: 0.005, max: 0.5, step: 0.001, group: 'Corrosion' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 60, step: 0.1, group: 'Corrosion' },
    { key: 'warpAmount', label: 'Warp', type: 'float', default: 0.45, min: 0, max: 2, step: 0.01, group: 'Corrosion', description: 'Distorts the corrosion field so the boundary meanders instead of drawing smooth blobs.' },
    { key: 'pitting', label: 'Pitting', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Corrosion', description: 'Corrosion eats *into* the metal before it builds up on top. Without the pits the rust looks painted on.' },
    { key: 'flakes', label: 'Flaking', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Corrosion', description: 'Breaks the crust into scabs that lift at their edges.' },
    { key: 'crust', label: 'Crust Height', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'runs', label: 'Stain Runs', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Rust-stained water running down from the corrosion. Applied only to vertical faces under triplanar.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('scale')
    const offset = seedOffset(ctx)

    const rustAt = (uvNode: V2): F => {
      const base = vec3(uvNode.mul(scale), offset)
      const warped = warp(base, p.float('warpAmount'), 0.7)
      const field = fbm01(warped, 5, 2.1, 0.55)
      const t = p.float('coverage').oneMinus()
      const soft = p.float('edgeSoftness')
      return smoothstep(t.sub(soft), t.add(soft), field)
    }

    const rust = rustAt(ctx.uv)

    // Three height contributions, in the order corrosion actually happens:
    // the metal is pitted, crust grows in the pits, and the crust cracks into
    // flakes whose edges stand proud.
    const heightAt = (uvNode: V2): F => {
      const r = rustAt(uvNode)
      const pit = worley(vec3(uvNode.mul(scale.mul(9)), offset.add(3)), 1)
      const pits = smoothstep(float(0.35), float(0), pit).mul(p.float('pitting')).mul(r)
      const grain = ridged(vec3(uvNode.mul(scale.mul(2.5)), offset), float(4), float(0.55))
      const flake = cracks(uvNode, scale.mul(4), float(0.06), offset.add(17)).mul(p.float('flakes'))
      const crust = grain.mul(p.float('crust')).mul(r)
      return crust.sub(pits.mul(0.4)).sub(flake.mul(0.25).mul(r))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('crust').mul(0.6).add(0.1))
    const h = heightAt(ctx.uv)

    // Colour: three rust tones by an independent field, then hue-jittered so
    // neighbouring patches are not the same orange.
    const tone = fbm01(vec3(ctx.uv.mul(scale.mul(3)), offset.add(9)), 4, 2, 0.5)
    const patch = fbm01(vec3(ctx.uv.mul(scale.mul(0.8)), offset.add(41)), 3, 2, 0.5)
    const rustColour = tintVariation(
      gradient3(tone, p.color('rustDark'), p.color('rustMid'), p.color('rustLight')),
      patch,
      0.015,
      0.2,
      0.22,
    )

    // Runs: stained water leaving the corroded patch and travelling down.
    const gravity = gravityWeight(ctx)
    const runMask =
      gravity === 0
        ? float(0)
        : drips(ctx.uv, scale.mul(1.6), float(7), offset.add(63)).mul(p.float('runs')).mul(rust.add(0.25).clamp(0, 1))

    const metalBase = p.color('metalTint').mul(mix(float(1), float(0.82), microVariation(ctx.uv, scale.mul(12), offset)))
    const stained = mix(metalBase, rustColour.mul(0.55), runMask.clamp(0, 1))

    return {
      baseColor: mix(stained, rustColour, rust),
      // Iron oxide is a dielectric. This transition is the single most
      // important thing about the material: rust that stays metallic looks
      // like orange paint.
      metallic: rust.oneMinus().mul(runMask.mul(0.35).oneMinus()),
      roughness: mix(float(0.26), float(0.94), rust).add(runMask.mul(0.15)).clamp(0.05, 1),
      ao: cavityAO(h.mul(1.5).add(0.5).clamp(0, 1), normal, 0.55).mul(mix(float(1), float(0.88), rust)),
      height: h.mul(0.6).add(0.45).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const paintedMetal = registerMaterial({
  id: 'painted-metal',
  name: 'Painted Metal',
  category: 'Metal',
  description: 'A real paint job is three layers, so this is too: bare metal, primer, then topcoat. Chips break through one layer at a time along a ridged field, which is why they flake with jagged edges instead of punching round holes.',
  params: [
    { key: 'paintColor', label: 'Paint Colour', type: 'color', default: [0.13, 0.31, 0.5], group: 'Colour' },
    { key: 'primerColor', label: 'Primer', type: 'color', default: [0.42, 0.22, 0.13], group: 'Colour', description: 'The coat between paint and steel. Deep chips show it; shallow ones only scuff the topcoat.' },
    { key: 'metalTint', label: 'Metal Under', type: 'color', default: [0.5, 0.5, 0.52], group: 'Colour' },
    { key: 'chipAmount', label: 'Chipping', type: 'float', default: 0.3, min: 0, max: 1, step: 0.001, group: 'Wear' },
    { key: 'chipScale', label: 'Chip Scale', type: 'float', default: 14, min: 1, max: 120, step: 0.1, group: 'Wear' },
    { key: 'scuffs', label: 'Scuffs', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Scratches that dull the gloss without going through the paint.' },
    { key: 'dirt', label: 'Grime', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Settles into the chips and the low points, where washing never reaches.' },
    { key: 'paintRoughness', label: 'Paint Roughness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'orangePeel', label: 'Orange Peel', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The fine dimpling of sprayed paint.' },
    { key: 'paintThickness', label: 'Paint Thickness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('chipScale')
    const offset = seedOffset(ctx)
    const threshold = p.float('chipAmount')

    // One field, two thresholds: wherever the topcoat is gone the primer may
    // still be there. That ordering is what makes the chip read as depth.
    const chipFieldAt = (uvNode: V2): F =>
      ridged(vec3(uvNode.mul(scale).add(vec2(offset, offset)), offset), float(4), float(0.55))

    const paintAt = (uvNode: V2): F => smoothstep(threshold.sub(0.05), threshold.add(0.05), chipFieldAt(uvNode))
    const primerAt = (uvNode: V2): F =>
      smoothstep(threshold.mul(0.55).sub(0.05), threshold.mul(0.55).add(0.05), chipFieldAt(uvNode))

    const paint = paintAt(ctx.uv)
    const primer = primerAt(ctx.uv)

    const peelAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(scale.mul(14)), offset.add(3)), 2, 2, 0.5).mul(p.float('orangePeel'))

    const heightAt = (uvNode: V2): F =>
      paintAt(uvNode).mul(p.float('paintThickness'))
        .add(primerAt(uvNode).mul(p.float('paintThickness')).mul(0.35))
        .add(peelAt(uvNode).mul(0.05))

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('paintThickness').mul(1.2))
    const h = heightAt(ctx.uv)

    const scuff = scratches(ctx.uv.add(vec2(offset, offset)), float(1.1), float(90), scale.mul(14))
      .mul(p.float('scuffs'))
    // Grime collects where the surface is broken and low.
    const grime = smoothstep(float(0.45), float(0.8), fbm01(vec3(ctx.uv.mul(scale.mul(0.7)), offset.add(23)), 4, 2.1, 0.55))
      .mul(paint.oneMinus().mul(0.6).add(0.4))
      .mul(p.float('dirt'))

    const substrate = mix(p.color('metalTint'), p.color('primerColor'), primer)
    const colour = mix(substrate, p.color('paintColor'), paint)
    const grimed = mix(colour, vec3(0.09, 0.08, 0.07), grime.mul(0.6))

    return {
      baseColor: grimed,
      // Only bare steel is metallic; both coats are dielectric.
      metallic: primer.oneMinus(),
      roughness: mix(
        float(0.42),
        p.float('paintRoughness').add(peelAt(ctx.uv).mul(0.12)).add(scuff.mul(0.35)),
        paint,
      ).add(grime.mul(0.2)).clamp(0.02, 1),
      ao: cavityAO(h.div(max(p.float('paintThickness'), float(1e-3))).clamp(0, 1), normal, 0.5),
      height: h.mul(0.6).add(0.3).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const hammeredMetal = registerMaterial({
  id: 'hammered-metal',
  name: 'Hammered Metal',
  category: 'Metal',
  description: 'Voronoi dents. Each cell is one hammer strike with a rounded floor and a raised rim where the metal was displaced - the rim is what a plain dome misses, and it is what catches the light.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.78, 0.78, 0.8], group: 'Colour' },
    { key: 'scale', label: 'Strike Density', type: 'float', default: 9, min: 1, max: 80, step: 0.1, group: 'Pattern' },
    { key: 'jitter', label: 'Irregularity', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'rim', label: 'Displaced Rim', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Metal has to go somewhere: it piles up around the strike.' },
    { key: 'depth', label: 'Dent Depth', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'planish', label: 'Planishing Marks', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The fine tool texture inside each strike.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.2, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('scale')
    const offset = seedOffset(ctx)

    const heightAt = (uvNode: V2): F => {
      const cell = voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), p.float('jitter'))
      const dome = float(1).sub(cell.x.mul(2).clamp(0, 1))
      const depthVariation = mix(float(0.7), float(1), voronoiCellValue(cell))
      const strike = dome.mul(dome).mul(depthVariation).mul(p.float('depth'))
      // The rim rides the cell border, so it is shared between neighbours -
      // exactly how displaced metal behaves between two adjacent blows.
      const rim = smoothstep(float(0.12), float(0), voronoiBorder(cell)).mul(p.float('rim')).mul(0.35)
      const planish = fbm01(vec3(uvNode.mul(scale.mul(22)), offset.add(7)), 2, 2, 0.5)
        .sub(0.5)
        .mul(p.float('planish'))
        .mul(0.06)
      return strike.add(rim).add(planish)
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.5))
    const h01 = h.clamp(0, 1)

    return {
      baseColor: p.color('tint').mul(mix(float(0.88), float(1.06), h01)),
      metallic: float(1),
      // The tool work-hardens and roughens the floor of each strike.
      roughness: p.float('roughness').add(h01.oneMinus().mul(0.16)).add(p.float('planish').mul(0.05)).clamp(0.02, 1),
      ao: cavityAO(h01, normal, 0.4),
      height: h.mul(0.7).add(0.2).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const oxidisedCopper = registerMaterial({
  id: 'oxidised-copper',
  name: 'Oxidised Copper',
  category: 'Metal',
  description: 'Copper going to verdigris. The patina is a powdery dielectric crust that grows from the low points outward, so it needs its own roughness, its own height and its own colour range - not a green tint over a metal.',
  params: [
    { key: 'copper', label: 'Copper', type: 'color', default: [0.95, 0.64, 0.54], group: 'Colour' },
    { key: 'tarnish', label: 'Tarnish', type: 'color', default: [0.28, 0.15, 0.1], group: 'Colour', description: 'The brown-black stage between bright copper and green patina.' },
    { key: 'patinaDark', label: 'Patina Dark', type: 'color', default: [0.1, 0.28, 0.24], group: 'Colour' },
    { key: 'patinaLight', label: 'Patina Light', type: 'color', default: [0.36, 0.68, 0.56], group: 'Colour' },
    { key: 'coverage', label: 'Patina Coverage', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Patina' },
    { key: 'scale', label: 'Scale', type: 'float', default: 4, min: 0.2, max: 40, step: 0.05, group: 'Patina' },
    { key: 'warpAmount', label: 'Bloom', type: 'float', default: 0.7, min: 0, max: 3, step: 0.01, group: 'Patina', description: 'How much the patina boundary wanders. Straight edges never happen in corrosion.' },
    { key: 'crust', label: 'Crust Height', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'runs', label: 'Green Runs', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Copper salts washing down the surface in rain.' },
    { key: 'roughness', label: 'Copper Roughness', type: 'float', default: 0.28, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const scale = p.float('scale')
    const offset = seedOffset(ctx)

    const patinaAt = (uvNode: V2): F => {
      const warped = warp(vec3(uvNode.mul(scale), offset), p.float('warpAmount'), 0.9)
      const field = fbm01(warped, 5, 2.15, 0.55)
      const t = p.float('coverage').oneMinus()
      return smoothstep(t.sub(0.11), t.add(0.11), field)
    }

    const heightAt = (uvNode: V2): F => {
      const patina = patinaAt(uvNode)
      // Verdigris is granular - worley gives it the crumbly, non-directional
      // texture that fbm alone cannot.
      const grain = worley(vec3(uvNode.mul(scale.mul(14)), offset.add(5)), 0.9).oneMinus()
      const bloom = fbm01(vec3(uvNode.mul(scale.mul(3.5)), offset.add(11)), 4, 2, 0.55)
      return patina.mul(p.float('crust')).mul(grain.mul(0.45).add(bloom.mul(0.55)))
    }

    const patina = patinaAt(ctx.uv)
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('crust').mul(0.9))

    const gravity = gravityWeight(ctx)
    const runMask =
      gravity === 0
        ? float(0)
        : drips(ctx.uv, scale.mul(1.4), float(8), offset.add(77)).mul(p.float('runs')).mul(patina.add(0.3).clamp(0, 1))

    const tone = fbm01(vec3(ctx.uv.mul(scale.mul(6)), offset.add(19)), 4, 2, 0.5)
    const patinaColour = tintVariation(
      mix(p.color('patinaDark'), p.color('patinaLight'), tone),
      fbm01(vec3(ctx.uv.mul(scale.mul(1.2)), offset.add(51)), 3, 2, 0.5),
      0.02,
      0.25,
      0.2,
    )

    // Tarnish is the transition band: present where the patina is arriving but
    // has not taken hold. Without it copper meets green along a hard line.
    const tarnish = smoothstep(float(0.05), float(0.6), patina).mul(smoothstep(float(1), float(0.55), patina))
    const metalColour = mix(p.color('copper'), p.color('tarnish'), tarnish.mul(0.85))

    const patinaTotal = max(patina, runMask.mul(0.7)).clamp(0, 1)

    return {
      baseColor: mix(metalColour, patinaColour, patinaTotal),
      metallic: patinaTotal.oneMinus(),
      roughness: mix(p.float('roughness').add(tarnish.mul(0.25)), float(0.93), patinaTotal).clamp(0.03, 1),
      ao: cavityAO(h.mul(1.4).add(0.45).clamp(0, 1), normal, 0.5).mul(mix(float(1), float(0.9), patinaTotal)),
      height: h.mul(0.7).add(0.35).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const damascusSteel = registerMaterial({
  id: 'damascus-steel',
  name: 'Damascus Steel',
  category: 'Metal',
  description: 'Pattern-welded steel. Folding two alloys and etching leaves the layers standing at different heights and reflecting differently; the pattern is a domain-warped stripe field, which is geometrically what folding a billet does to a flat stack.',
  params: [
    { key: 'lightSteel', label: 'Nickel Layer', type: 'color', default: [0.86, 0.87, 0.88], group: 'Colour' },
    { key: 'darkSteel', label: 'Etched Layer', type: 'color', default: [0.24, 0.23, 0.24], group: 'Colour' },
    { key: 'layers', label: 'Layer Count', type: 'float', default: 26, min: 2, max: 200, step: 1, group: 'Pattern' },
    { key: 'fold', label: 'Fold Turbulence', type: 'float', default: 0.55, min: 0, max: 3, step: 0.01, group: 'Pattern', description: 'How violently the billet was folded. Low values give ladder patterns, high values give the classic wood-grain swirl.' },
    { key: 'foldScale', label: 'Fold Scale', type: 'float', default: 2.2, min: 0.1, max: 20, step: 0.05, group: 'Pattern' },
    { key: 'contrast', label: 'Etch Contrast', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'etchDepth', label: 'Etch Depth', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Acid bites the softer layer away, so the pattern has real relief.' },
    { key: 'polish', label: 'Polish', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const layerAt = (uvNode: V2): F => {
      const base = vec3(uvNode.mul(p.float('foldScale')), offset)
      // Two warps at different frequencies: the coarse one is the fold, the
      // fine one is the grind that cuts through it at an angle.
      const w1 = warp(base, p.float('fold'), 1.1)
      const w2 = warp(w1, p.float('fold').mul(0.4), 3.3)
      const bands = w2.y.add(w2.x.mul(0.25)).mul(p.float('layers'))
      const wave = bands.sin().mul(0.5).add(0.5)
      const c = p.float('contrast')
      return smoothstep(float(0.5).sub(c.mul(0.5).oneMinus().mul(0.5)), float(0.5).add(c.mul(0.45)), wave)
    }

    const heightAt = (uvNode: V2): F => layerAt(uvNode).oneMinus().mul(p.float('etchDepth'))

    const layer = layerAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('etchDepth').mul(0.5))
    const polishSwirl = scratches(ctx.uv.add(vec2(offset, offset)), float(0.9), float(80), float(260))

    return {
      baseColor: mix(p.color('darkSteel'), p.color('lightSteel'), layer),
      metallic: float(1),
      // The etched layer is microscopically pitted; the nickel layer polishes.
      roughness: mix(float(0.45), float(1).sub(p.float('polish').mul(0.92)), layer)
        .add(polishSwirl.mul(0.05))
        .clamp(0.02, 1),
      ao: cavityAO(layer, normal, 0.3),
      height: heightAt(ctx.uv).negate().mul(0.6).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const galvanisedSteel = registerMaterial({
  id: 'galvanised-steel',
  name: 'Galvanised Steel',
  category: 'Metal',
  description: 'Hot-dip zinc coating. The spangle is the giveaway: as the zinc freezes it grows crystal grains, each with its own facet orientation, so neighbouring grains catch the light completely differently at the same roughness.',
  params: [
    { key: 'tint', label: 'Zinc', type: 'color', default: [0.72, 0.73, 0.75], group: 'Colour' },
    { key: 'spangle', label: 'Spangle', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Crystal', description: 'Crystal grain contrast. This is what says galvanised rather than plain steel.' },
    { key: 'grainScale', label: 'Grain Size', type: 'float', default: 11, min: 1, max: 80, step: 0.1, group: 'Crystal' },
    { key: 'facet', label: 'Facet Depth', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Crystal' },
    { key: 'weathering', label: 'Weathering', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'White zinc oxide bloom, which is chalky and not metallic at all.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('grainScale')

    const grainAt = (uvNode: V2) => voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), float(0.95))

    const heightAt = (uvNode: V2): F => {
      const cell = grainAt(uvNode)
      // Each grain is a shallow facet tilted its own way; the seam between
      // grains sits slightly low.
      const tilt = hash21(cell.zw.add(vec2(4.3, 1.7))).sub(0.5)
      const across = cell.x.mul(tilt).mul(2)
      const seam = smoothstep(float(0.05), float(0), voronoiBorder(cell)).mul(0.4)
      return across.mul(p.float('facet')).sub(seam.mul(p.float('facet')))
    }

    const cell = grainAt(ctx.uv)
    const grainId = voronoiCellValue(cell)
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('facet').mul(0.8))

    const bloom = smoothstep(float(0.5), float(0.82), fbm01(vec3(ctx.uv.mul(scale.mul(0.4)), offset.add(29)), 4, 2.1, 0.55))
      .mul(p.float('weathering'))

    const zinc = tintVariation(p.color('tint'), grainId, 0.006, 0.1, p.float('spangle').mul(0.25))

    return {
      baseColor: mix(zinc, vec3(0.78, 0.78, 0.76), bloom),
      metallic: bloom.oneMinus(),
      // Per-grain roughness is the real spangle mechanism: same material,
      // different crystal orientation, wildly different highlight.
      roughness: p
        .float('roughness')
        .add(grainId.sub(0.5).mul(p.float('spangle')).mul(0.45))
        .add(bloom.mul(0.5))
        .clamp(0.03, 1),
      ao: cavityAO(h.mul(2).add(0.5).clamp(0, 1), normal, 0.25),
      height: h.mul(0.5).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const METALS = [
  polishedMetal,
  brushedMetal,
  rustedIron,
  paintedMetal,
  hammeredMetal,
  oxidisedCopper,
  damascusSteel,
  galvanisedSteel,
]
