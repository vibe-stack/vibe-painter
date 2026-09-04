/**
 * Industrial surfaces: the things a workshop, a factory floor or a shipping
 * yard is actually made of.
 *
 * These are all *fabricated*, which means the pattern is exact and the wear is
 * not. A pressed panel has perfectly spaced holes and completely random rust;
 * a hazard stripe is machine-straight and scuffed through at random. Getting
 * that split right - rigid geometry, chaotic damage - is what stops them
 * looking like clean CG props.
 */

import { abs, cos, float, fract, max, min, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  cavityAO,
  fbm01,
  microVariation,
  normalFromHeightFn,
  ridged,
  scratches,
  stripes,
  tintVariation,
  voronoi2,
  voronoiCellValue,
  warp,
  worley,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

const gravityWeight = (ctx: MatContext): number => (ctx.axis === 1 ? 0 : 1)

// ---------------------------------------------------------------------------

export const corrugatedSteel = registerMaterial({
  id: 'corrugated-steel',
  name: 'Corrugated Steel',
  category: 'Industrial',
  description: 'Rolled sheet with rust in the valleys. The corrugation is a clean sine wave, but water runs down the troughs and never off the ridges, so the corrosion is banded by the geometry - that correlation is the whole material.',
  params: [
    { key: 'tint', label: 'Sheet', type: 'color', default: [0.6, 0.61, 0.62], group: 'Colour' },
    { key: 'rustColor', label: 'Rust', type: 'color', default: [0.42, 0.19, 0.08], group: 'Colour' },
    { key: 'period', label: 'Corrugations', type: 'float', default: 14, min: 1, max: 90, step: 0.5, group: 'Profile' },
    { key: 'depth', label: 'Profile Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Profile' },
    { key: 'squareness', label: 'Squareness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Profile', description: 'Trapezoidal roofing sheet versus classic sinusoidal iron.' },
    { key: 'dents', label: 'Dents', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Profile' },
    { key: 'rust', label: 'Rust', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'valleyBias', label: 'Valley Bias', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'How strongly the rust prefers the troughs, where water sits.' },
    { key: 'streaks', label: 'Streaks', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const profileAt = (uvNode: V2): F => {
      const t = uvNode.x.mul(p.float('period'))
      const wave = sin(t.mul(6.2832)).mul(0.5).add(0.5)
      // Flattening the peaks turns the sine into a trapezoid, which is what a
      // modern roll-former actually produces.
      const flat = smoothstep(float(0.25), float(0.75), wave)
      return mix(wave, flat, p.float('squareness'))
    }

    const heightAt = (uvNode: V2): F => {
      const dent = fbm01(vec3(uvNode.mul(7), offset.add(3)), 3, 2.1, 0.55).sub(0.5).mul(p.float('dents')).mul(0.18)
      const grain = fbm01(vec3(uvNode.mul(220), offset.add(9)), 2, 2, 0.5).sub(0.5).mul(0.02)
      return profileAt(uvNode).mul(p.float('depth')).add(dent).add(grain)
    }

    const profile = profileAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.2).add(0.2))
    const h = heightAt(ctx.uv)

    const valley = mix(float(0.5), profile.oneMinus(), p.float('valleyBias'))
    const rustField = fbm01(warp(coord3(ctx, 6).add(23), 0.5, 1.2), 5, 2.1, 0.55)
    const rust = smoothstep(float(0.62), float(0.38), rustField.sub(valley.mul(0.35)))
      .mul(p.float('rust'))
      .clamp(0, 1)

    const gravity = gravityWeight(ctx)
    const streak =
      gravity === 0
        ? float(0)
        : smoothstep(float(0.5), float(0.8), fbm01(vec3(ctx.uv.mul(vec2(9, 0.7)), offset.add(31)), 4, 2.1, 0.55))
            .mul(p.float('streaks'))
            .mul(rust.mul(0.6).add(0.4))

    const metal = p.color('tint').mul(mix(float(0.9), float(1.06), microVariation(ctx.uv, 40, offset)))
    const rusted = tintVariation(p.color('rustColor'), rustField, 0.02, 0.22, 0.25)

    return {
      baseColor: mix(mix(metal, rusted, rust), rusted.mul(0.5), streak.mul(0.6)),
      // Rust is a dielectric crust over the metal; the streak is a thin stain
      // that dulls the metal without fully covering it.
      metallic: rust.oneMinus().mul(streak.mul(0.4).oneMinus()),
      roughness: mix(float(0.35), float(0.92), rust).add(streak.mul(0.12)).clamp(0.05, 1),
      ao: cavityAO(profile.mul(0.6).add(0.3), normal, 0.4),
      height: h.mul(0.7).add(0.3).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const perforatedPanel = registerMaterial({
  id: 'perforated-panel',
  name: 'Perforated Panel',
  category: 'Industrial',
  description: 'Punched sheet in a staggered grid. The holes drive opacity as well as height, so the panel is genuinely see-through, and the punch leaves a rolled lip on the exit side of every hole - which is the detail that says "punched" rather than "drilled".',
  params: [
    { key: 'tint', label: 'Sheet', type: 'color', default: [0.55, 0.56, 0.58], group: 'Colour' },
    { key: 'holeColor', label: 'Behind', type: 'color', default: [0.02, 0.02, 0.02], group: 'Colour' },
    { key: 'pitch', label: 'Hole Pitch', type: 'float', default: 26, min: 2, max: 160, step: 0.5, group: 'Pattern' },
    { key: 'radius', label: 'Hole Radius', type: 'float', default: 0.3, min: 0.02, max: 0.49, step: 0.005, group: 'Pattern' },
    { key: 'stagger', label: 'Stagger', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Half-offset alternate rows: the standard 60-degree perforation layout.' },
    { key: 'lip', label: 'Punch Lip', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'cutOpacity', label: 'Cut Through', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'At 1 the holes are real openings. Drop it to keep the pattern but close the sheet.' },
    { key: 'brush', label: 'Brushing', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.32, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'grime', label: 'Grime', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const pitch = p.float('pitch')

    const holeAt = (uvNode: V2): F => {
      const q = vec2(uvNode.x.mul(pitch), uvNode.y.mul(pitch))
      const row = q.y.floor()
      const shifted = vec2(q.x.add(row.mul(p.float('stagger'))), q.y)
      const local = fract(shifted).sub(0.5)
      return smoothstep(p.float('radius'), p.float('radius').mul(0.85), local.length())
    }

    const heightAt = (uvNode: V2): F => {
      const hole = holeAt(uvNode)
      // The lip is a narrow ring just outside the hole: the difference between
      // the hole mask and a slightly larger one.
      const q = vec2(uvNode.x.mul(pitch), uvNode.y.mul(pitch))
      const row = q.y.floor()
      const local = fract(vec2(q.x.add(row.mul(p.float('stagger'))), q.y)).sub(0.5)
      const d = local.length()
      const lip = smoothstep(p.float('radius').mul(1.5), p.float('radius'), d).mul(
        smoothstep(p.float('radius').mul(0.9), p.float('radius').mul(1.1), d),
      )
      return hole.oneMinus().mul(0.5).add(lip.mul(p.float('lip')).mul(0.2))
    }

    const hole = holeAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))
    const h = heightAt(ctx.uv)

    const brush = scratches(ctx.uv.add(vec2(offset, offset)), float(0), float(70), pitch.mul(6)).mul(p.float('brush'))
    const grime = smoothstep(float(0.5), float(0.85), fbm01(coord3(ctx, pitch.mul(0.15)).add(19), 4, 2.1, 0.55))
      .mul(p.float('grime'))

    return {
      baseColor: mix(p.color('tint').mul(mix(float(1), float(0.86), brush)), p.color('holeColor'), hole)
        .mul(mix(float(1), float(0.7), grime.mul(0.6))),
      metallic: hole.oneMinus(),
      roughness: p.float('roughness').add(brush.mul(0.3)).add(grime.mul(0.3)).clamp(0.04, 1),
      // Opacity is what makes the perforation real rather than painted on.
      opacity: hole.mul(p.float('cutOpacity')).oneMinus(),
      ao: cavityAO(h.mul(2).clamp(0, 1), normal, 0.6),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const chainLink = registerMaterial({
  id: 'chain-link',
  name: 'Chain Link Fence',
  category: 'Industrial',
  description: 'Woven diamond mesh. The wires spiral through each other, so along every strand the wire alternates between passing in front and behind - reading that alternation off the strand coordinate is what makes the weave hold together at a crossing.',
  params: [
    { key: 'wire', label: 'Wire', type: 'color', default: [0.62, 0.63, 0.64], group: 'Colour' },
    { key: 'behind', label: 'Behind', type: 'color', default: [0.02, 0.02, 0.02], group: 'Colour' },
    { key: 'scale', label: 'Mesh Size', type: 'float', default: 9, min: 1, max: 60, step: 0.25, group: 'Mesh' },
    { key: 'thickness', label: 'Wire Gauge', type: 'float', default: 0.13, min: 0.02, max: 0.45, step: 0.005, group: 'Mesh' },
    { key: 'weave', label: 'Weave Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Mesh', description: 'How far the wire ducks behind its neighbour at each crossing.' },
    { key: 'sag', label: 'Sag', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Mesh', description: 'Old fence never stays taut.' },
    { key: 'galvanised', label: 'Galvanising', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The zinc spangle. Where it has worn off, the wire rusts.' },
    { key: 'rust', label: 'Rust', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const meshAt = (uvNode: V2) => {
      const sag = fbm01(vec3(uvNode.mul(2), offset), 2, 2, 0.5).sub(0.5).mul(p.float('sag')).mul(0.05)
      const q = uvNode.add(vec2(0, sag)).mul(scale)
      // The two wire families run at plus and minus 45 degrees.
      const a = q.x.add(q.y)
      const b = q.x.sub(q.y)
      const t = p.float('thickness')
      const wireA = smoothstep(t, float(0), abs(fract(a).sub(0.5)))
      const wireB = smoothstep(t, float(0), abs(fract(b).sub(0.5)))
      // Along strand A, the over/under alternates every half period of B.
      const overA = fract(b.mul(0.5)).sub(0.5).sign().mul(0.5).add(0.5)
      return { wireA, wireB, overA }
    }

    const heightAt = (uvNode: V2): F => {
      const m = meshAt(uvNode)
      const w = p.float('weave')
      const a = m.wireA.mul(mix(float(1).sub(w.mul(0.5)), float(1), m.overA))
      const b = m.wireB.mul(mix(float(1), float(1).sub(w.mul(0.5)), m.overA))
      return max(a, b).mul(0.5)
    }

    const m = meshAt(ctx.uv)
    const cover = max(m.wireA, m.wireB).clamp(0, 1)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    const spangle = voronoiCellValue(voronoi2(ctx.uv.mul(scale.mul(9)).add(vec2(offset, offset)), float(0.9)))
    const rust = smoothstep(float(0.5), float(0.78), fbm01(coord3(ctx, scale.mul(0.6)).add(29), 4, 2.1, 0.55))
      .mul(p.float('rust'))
      .mul(cover)
    const wireColour = mix(p.color('wire'), vec3(0.36, 0.16, 0.07), rust)
      .mul(mix(float(1), mix(float(0.88), float(1.12), spangle), p.float('galvanised')))

    return {
      baseColor: mix(p.color('behind'), wireColour, cover),
      metallic: cover.mul(rust.oneMinus()),
      roughness: mix(float(0.9), float(0.34).add(spangle.sub(0.5).mul(p.float('galvanised')).mul(0.2)), cover)
        .add(rust.mul(0.5))
        .clamp(0.05, 1),
      opacity: cover,
      ao: cavityAO(h.mul(2).clamp(0, 1), normal, 0.5),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const castIron = registerMaterial({
  id: 'cast-iron',
  name: 'Cast Iron',
  category: 'Industrial',
  description: 'Sand-cast iron straight out of the mould: a coarse, granular skin that took the impression of the sand, with blowholes where gas was trapped and a faint parting line where the mould halves met. It is dark, matt and nothing like rolled steel.',
  params: [
    { key: 'tint', label: 'Iron', type: 'color', default: [0.19, 0.185, 0.185], group: 'Colour' },
    { key: 'oxide', label: 'Oxide Bloom', type: 'color', default: [0.3, 0.21, 0.15], group: 'Colour' },
    { key: 'sandScale', label: 'Sand Grain', type: 'float', default: 120, min: 10, max: 700, step: 1, group: 'Casting' },
    { key: 'sandDepth', label: 'Skin Roughness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Casting' },
    { key: 'blowholes', label: 'Blowholes', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Casting' },
    { key: 'partingLine', label: 'Parting Line', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Casting', description: 'The flash ridge left where the two halves of the mould met.' },
    { key: 'machined', label: 'Machined Faces', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Patches turned back to bright metal on a lathe or mill.' },
    { key: 'oxidation', label: 'Oxidation', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const ss = p.float('sandScale')

    const machinedAt = (uvNode: V2): F =>
      smoothstep(float(0.62), float(0.72), fbm01(vec3(uvNode.mul(2.6), offset.add(13)), 3, 2, 0.5))
        .mul(p.float('machined'))

    const heightAt = (uvNode: V2): F => {
      const sand = fbm01(vec3(uvNode.mul(ss), offset), 4, 2.3, 0.6).sub(0.5).mul(p.float('sandDepth')).mul(0.12)
      const holes = smoothstep(float(0.14), float(0), worley(vec3(uvNode.mul(ss.mul(0.18)), offset.add(3)), 1))
        .mul(p.float('blowholes'))
        .mul(0.35)
      const parting = smoothstep(float(0.02), float(0), abs(fract(uvNode.y.mul(1.3).add(offset)).sub(0.5)))
        .mul(p.float('partingLine'))
        .mul(0.12)
      // A machined face is cut flat: it erases the cast skin entirely.
      const flat = machinedAt(uvNode)
      return mix(sand.sub(holes).add(parting), float(0.06), flat)
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.1))
    const h = heightAt(ctx.uv)
    const machined = machinedAt(ctx.uv)

    const oxide = smoothstep(float(0.5), float(0.8), fbm01(coord3(ctx, 5).add(23), 4, 2.1, 0.55))
      .mul(p.float('oxidation'))
      .mul(machined.oneMinus())
    const turned = scratches(ctx.uv.add(vec2(offset, offset)), float(1.2), float(90), ss.mul(2)).mul(machined)

    return {
      baseColor: mix(
        mix(p.color('tint'), p.color('oxide'), oxide),
        p.color('tint').mul(1.9),
        machined,
      ).mul(mix(float(1), float(0.92), turned)),
      metallic: float(1),
      // The cast skin is one of the roughest metal finishes there is; a
      // machined face on the same part is one of the smoothest.
      roughness: mix(float(0.88).add(oxide.mul(0.08)), float(0.22).add(turned.mul(0.2)), machined)
        .add(microVariation(ctx.uv, ss.mul(0.3), offset).sub(0.5).mul(0.1))
        .clamp(0.08, 1),
      ao: cavityAO(h.mul(4).add(0.6).clamp(0, 1), normal, 0.5),
      height: h.mul(2).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const hazardStripes = registerMaterial({
  id: 'hazard-stripes',
  name: 'Hazard Stripes',
  category: 'Industrial',
  description: 'Painted warning stripes on a metal substrate. The stripe is masked and sprayed, so the edge is crisp but never perfect; the wear comes from feet and tyres, which follow their own paths and ignore the pattern completely.',
  params: [
    { key: 'stripeA', label: 'Stripe A', type: 'color', default: [0.85, 0.65, 0.05], group: 'Colour' },
    { key: 'stripeB', label: 'Stripe B', type: 'color', default: [0.05, 0.05, 0.05], group: 'Colour' },
    { key: 'substrate', label: 'Substrate', type: 'color', default: [0.42, 0.43, 0.44], group: 'Colour' },
    { key: 'angle', label: 'Angle', type: 'float', default: 0.785, min: 0, max: 3.1416, step: 0.01, group: 'Pattern' },
    { key: 'period', label: 'Stripe Width', type: 'float', default: 9, min: 0.5, max: 60, step: 0.25, group: 'Pattern' },
    { key: 'edgeBleed', label: 'Edge Bleed', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Paint creeping under the mask. Zero is a vector graphic, not a paint job.' },
    { key: 'wear', label: 'Wear Through', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'scuffs', label: 'Scuffs', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'grime', label: 'Grime', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'gloss', label: 'Paint Gloss', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const stripeAt = (uvNode: V2): F => {
      const a = p.float('angle')
      // Project onto the stripe normal: the stripe runs perpendicular to this.
      const proj = uvNode.x.mul(sin(a)).add(uvNode.y.mul(cos(a)))
      // Bleed pushes the stripe boundary around with noise before it is sharpened.
      const bleed = fbm01(vec3(uvNode.mul(90), offset), 3, 2.3, 0.6).sub(0.5).mul(p.float('edgeBleed')).mul(0.06)
      return stripes(proj.mul(p.float('period')).add(bleed), float(0.5), float(0.012))
    }

    // Wear follows traffic, not the stripes: a separate field entirely.
    const wearAt = (uvNode: V2): F =>
      smoothstep(float(0.44), float(0.74), fbm01(vec3(uvNode.mul(vec2(2.2, 5)), offset.add(19)), 4, 2.1, 0.55))
        .mul(p.float('wear'))

    const heightAt = (uvNode: V2): F =>
      wearAt(uvNode).negate().mul(0.1).add(
        fbm01(vec3(uvNode.mul(200), offset.add(3)), 2, 2, 0.5).sub(0.5).mul(0.03),
      )

    const stripe = stripeAt(ctx.uv)
    const wear = wearAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.7))
    const scuff = scratches(ctx.uv.add(vec2(offset, offset)), float(0.4), float(50), float(180)).mul(p.float('scuffs'))
    const grime = smoothstep(float(0.45), float(0.85), fbm01(coord3(ctx, 4).add(41), 4, 2.2, 0.55)).mul(p.float('grime'))

    const paint = mix(p.color('stripeB'), p.color('stripeA'), stripe)
    const worn = mix(paint, p.color('substrate'), wear)

    return {
      baseColor: mix(worn, vec3(0.07, 0.065, 0.06), grime.mul(0.55)).mul(mix(float(1), float(0.85), scuff)),
      // Bare substrate is metal; the paint over it is not.
      metallic: wear.mul(0.9),
      roughness: mix(mix(float(0.65), float(0.22), p.float('gloss')), float(0.55), wear)
        .add(scuff.mul(0.3))
        .add(grime.mul(0.2))
        .clamp(0.05, 1),
      ao: cavityAO(wear.oneMinus().mul(0.5).add(0.5), normal, 0.3),
      height: heightAt(ctx.uv).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const acousticFoam = registerMaterial({
  id: 'acoustic-foam',
  name: 'Acoustic Foam',
  category: 'Industrial',
  description: 'Studio wedge foam. The profile is a pair of crossed triangle waves at ninety degrees, which is exactly how the material is cut, and the surface is open-cell polyurethane - so it is uniformly, deeply matt with no specular story at all.',
  params: [
    { key: 'tint', label: 'Foam', type: 'color', default: [0.13, 0.13, 0.14], group: 'Colour' },
    { key: 'tipTint', label: 'Tip Fade', type: 'color', default: [0.22, 0.21, 0.2], group: 'Colour', description: 'Foam yellows and dusts at the tips first.' },
    { key: 'wedges', label: 'Wedges', type: 'float', default: 10, min: 1, max: 60, step: 0.5, group: 'Profile' },
    { key: 'depth', label: 'Wedge Depth', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Profile' },
    { key: 'pyramid', label: 'Pyramid', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Profile', description: 'At 0 the wedges run in one direction; at 1 both directions cut, giving pyramids.' },
    { key: 'cellScale', label: 'Cell Size', type: 'float', default: 260, min: 20, max: 1200, step: 5, group: 'Surface' },
    { key: 'openCell', label: 'Open Cells', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The blown bubble structure. It is what makes foam eat light.' },
    { key: 'dust', label: 'Dust', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('wedges')

    const triangle = (x: F): F => abs(fract(x).sub(0.5)).mul(2)

    const heightAt = (uvNode: V2): F => {
      const a = triangle(uvNode.x.mul(n))
      const b = triangle(uvNode.y.mul(n))
      const wedge = mix(a, min(a, b), p.float('pyramid'))
      const cells = fbm01(vec3(uvNode.mul(p.float('cellScale')), offset), 3, 2.3, 0.6)
        .sub(0.5)
        .mul(p.float('openCell'))
        .mul(0.04)
      return wedge.mul(p.float('depth')).add(cells)
    }

    const a = triangle(ctx.uv.x.mul(n))
    const b = triangle(ctx.uv.y.mul(n))
    const wedge = mix(a, min(a, b), p.float('pyramid'))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.4).add(0.1))
    const h = heightAt(ctx.uv)

    const dust = smoothstep(float(0.5), float(0.85), fbm01(coord3(ctx, n.mul(2)).add(23), 4, 2.1, 0.55))
      .mul(p.float('dust'))
      .mul(wedge)

    return {
      baseColor: mix(p.color('tint'), p.color('tipTint'), wedge.pow(2)).add(dust.mul(0.05)),
      metallic: float(0),
      // There is no smooth region anywhere on open-cell foam. Clamping the
      // floor high is not laziness: anything glossier stops reading as foam.
      roughness: float(0.94).add(dust.mul(0.04)).sub(wedge.mul(0.03)).clamp(0.75, 1),
      ao: cavityAO(wedge, normal, 0.85),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const conveyorBelt = registerMaterial({
  id: 'conveyor-belt',
  name: 'Conveyor Belt',
  category: 'Industrial',
  description: 'Moulded rubber belt with a chevron tread and a fabric carcass showing at the worn edges. Rubber is the one common material with genuinely zero specular character until it is polished by use - so here the shine is entirely a map of where things have run over it.',
  params: [
    { key: 'rubber', label: 'Rubber', type: 'color', default: [0.045, 0.045, 0.05], group: 'Colour' },
    { key: 'fabric', label: 'Carcass', type: 'color', default: [0.35, 0.3, 0.24], group: 'Colour' },
    { key: 'dust', label: 'Dust', type: 'color', default: [0.4, 0.36, 0.3], group: 'Colour' },
    { key: 'chevrons', label: 'Chevrons', type: 'float', default: 7, min: 0.5, max: 40, step: 0.25, group: 'Tread' },
    { key: 'chevronAngle', label: 'Chevron Angle', type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, group: 'Tread' },
    { key: 'treadDepth', label: 'Tread Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Tread' },
    { key: 'wear', label: 'Wear', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Tread rounded off and rubber polished by load.' },
    { key: 'exposure', label: 'Carcass Exposure', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'dusting', label: 'Dusting', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const treadAt = (uvNode: V2): F => {
      // A chevron is a stripe field whose phase depends on |x|: the V shape.
      const v = uvNode.y.add(abs(uvNode.x.sub(0.5)).mul(p.float('chevronAngle')))
      return stripes(v.mul(p.float('chevrons')), float(0.45), float(0.05))
    }

    const wearAt = (uvNode: V2): F =>
      smoothstep(float(0.4), float(0.75), fbm01(vec3(uvNode.mul(vec2(1.6, 4)), offset.add(13)), 4, 2.1, 0.55))
        .mul(p.float('wear'))

    const heightAt = (uvNode: V2): F => {
      const tread = treadAt(uvNode)
      const worn = wearAt(uvNode)
      const grain = fbm01(vec3(uvNode.mul(160), offset), 3, 2.2, 0.55).sub(0.5).mul(0.04)
      // Wear rounds the tread off rather than removing it: mix towards flat.
      return mix(tread, tread.mul(0.4).add(0.15), worn).mul(p.float('treadDepth')).add(grain)
    }

    const tread = treadAt(ctx.uv)
    const wear = wearAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('treadDepth').mul(1.6).add(0.1))
    const h = heightAt(ctx.uv)

    const carcass = smoothstep(float(0.6), float(0.85), fbm01(coord3(ctx, 6).add(29), 4, 2.2, 0.55))
      .mul(p.float('exposure'))
      .mul(wear.mul(0.7).add(0.3))
    const weave = ridged(vec3(ctx.uv.mul(vec2(220, 220)), offset.add(7)), float(2), float(0.5)).mul(carcass)
    const dusting = smoothstep(float(0.45), float(0.8), fbm01(coord3(ctx, 9).add(41), 4, 2.1, 0.55))
      .mul(p.float('dusting'))
      .mul(tread.oneMinus().mul(0.6).add(0.4))

    const surface = mix(p.color('rubber'), p.color('fabric').mul(mix(float(0.8), float(1.1), weave)), carcass)

    return {
      baseColor: mix(surface, p.color('dust'), dusting.mul(0.5)),
      metallic: float(0),
      // Polished rubber: the only place a belt shines is where it is worn.
      roughness: float(0.92).sub(wear.mul(0.4).mul(tread)).add(carcass.mul(0.05)).add(dusting.mul(0.03)).clamp(0.15, 1),
      ao: cavityAO(h.div(max(p.float('treadDepth'), float(1e-3))).clamp(0, 1), normal, 0.7),
      height: h.add(0.2).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const INDUSTRIAL = [
  corrugatedSteel,
  perforatedPanel,
  chainLink,
  castIron,
  hazardStripes,
  acousticFoam,
  conveyorBelt,
]
