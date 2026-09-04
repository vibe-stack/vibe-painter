/**
 * Creature surfaces.
 *
 * Biology has one rule that no manufactured material follows: nothing is
 * opaque. Skin, bone, chitin and membrane all let light *in* before sending it
 * back out, which is why a creature lit like a plastic toy looks dead. Without
 * a subsurface channel to write to, the working substitute is to keep base
 * colour bright and slightly desaturated in the thin regions, put the darkness
 * into AO rather than into albedo, and never let roughness go flat.
 *
 * The second rule is that biological pattern grows: scales overlap because
 * each row was laid over the one before, fur lies in a direction because it
 * grew that way. Both are cheap - an offset row grid and a stretched noise -
 * and both are what the eye actually reads.
 */

import { abs, cos, float, fract, max, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  brickGrid,
  cavityAO,
  fbm01,
  gradient3,
  hash21,
  microVariation,
  normalFromHeightFn,
  ridged,
  scratches,
  sparkle,
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

// ---------------------------------------------------------------------------

export const skin = registerMaterial({
  id: 'skin',
  name: 'Skin',
  category: 'Creature',
  description: 'Human skin, which is three signals at three scales: the fine diamond micro-relief of the epidermis, the pore field, and the slow blotch of blood underneath. The colour variation is in hue, not brightness - skin goes red and yellow, it does not go dark, and lerping towards grey is what makes CG skin look like clay.',
  params: [
    { key: 'base', label: 'Skin Tone', type: 'color', default: [0.78, 0.6, 0.5], group: 'Colour' },
    { key: 'blood', label: 'Blood Tone', type: 'color', default: [0.72, 0.36, 0.32], group: 'Colour', description: 'Where capillaries run close to the surface: cheeks, knuckles, the nose.' },
    { key: 'sallow', label: 'Sallow Tone', type: 'color', default: [0.74, 0.63, 0.44], group: 'Colour', description: 'The yellowish cast over bone and cartilage.' },
    { key: 'blotch', label: 'Blotching', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'freckles', label: 'Freckles', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'poreScale', label: 'Pore Density', type: 'float', default: 160, min: 20, max: 900, step: 1, group: 'Detail' },
    { key: 'pores', label: 'Pore Depth', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Detail' },
    { key: 'microRelief', label: 'Micro Relief', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Detail', description: 'The criss-crossed diamond furrows that cover all skin. Look at the back of your hand.' },
    { key: 'wrinkles', label: 'Wrinkles', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Detail' },
    { key: 'oiliness', label: 'Oiliness', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Sebum on the high points. Skin is never uniformly matt: the shine is patchy, and that patchiness is what reads as alive.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.62, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const ps = p.float('poreScale')

    // The diamond micro-relief: two crossed stretched noise fields, which is
    // the same construction as brushed metal at a completely different scale.
    const microAt = (uvNode: V2): F => {
      const a = scratches(uvNode.add(vec2(offset, offset)), float(0.7), float(6), ps.mul(0.6))
      const b = scratches(uvNode.add(vec2(offset.add(4), offset)), float(2.4), float(6), ps.mul(0.55))
      return max(a, b).mul(p.float('microRelief'))
    }

    const poreAt = (uvNode: V2): F =>
      smoothstep(float(0.32), float(0), worley(vec3(uvNode.mul(ps), offset.add(3)), 1)).mul(p.float('pores'))

    const wrinkleAt = (uvNode: V2): F =>
      ridged(vec3(uvNode.mul(vec2(6, 22)), offset.add(9)), float(3), float(0.55)).mul(p.float('wrinkles'))

    const heightAt = (uvNode: V2): F =>
      microAt(uvNode).mul(-0.05).sub(poreAt(uvNode).mul(0.12)).sub(wrinkleAt(uvNode).mul(0.2))

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.9))
    // The pore field gets its own high-frequency normal, reoriented onto the
    // coarse one so it survives inside a wrinkle.
    const poreNormal = normalFromHeightFn((uvNode) => poreAt(uvNode).negate(), ctx.uv, ctx.texel, float(0.35))
    const h = heightAt(ctx.uv)

    const blotch = fbm01(coord3(ctx, 4).add(13), 4, 2.1, 0.55)
    const deep = fbm01(coord3(ctx, 1.6).add(29), 3, 2, 0.5)
    const tone = mix(float(0.5), blotch, p.float('blotch'))
    const colour = gradient3(tone, p.color('sallow'), p.color('base'), p.color('blood'))

    const freckle = smoothstep(float(0.55), float(0.75), sparkle(ctx.uv, ps.mul(0.22), offset.add(41), float(0.3)))
      .mul(p.float('freckles'))

    // Sebum sits on the high ground and in the pore-free areas.
    const oil = smoothstep(float(0.45), float(0.8), fbm01(coord3(ctx, 7).add(53), 4, 2.2, 0.55))
      .mul(p.float('oiliness'))

    return {
      // Deep tone shifts hue rather than value: that is the whole trick.
      baseColor: tintVariation(colour, deep, 0.02, 0.14, 0.1).mul(mix(float(1), float(0.72), freckle)),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .sub(oil.mul(0.35))
        .add(poreAt(ctx.uv).mul(0.15))
        .add(microVariation(ctx.uv, ps.mul(0.4), offset).sub(0.5).mul(0.1))
        .clamp(0.12, 1),
      // Skin scatters, so occlusion is shallow: a hard AO makes it look carved.
      ao: cavityAO(h.mul(4).add(0.8).clamp(0, 1), normal, 0.35),
      height: h.mul(2).add(0.6).clamp(0, 1),
      normal: blendDetailNormal(normal, poreNormal, 0.7),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const reptileScales = registerMaterial({
  id: 'reptile-scales',
  name: 'Reptile Scales',
  category: 'Creature',
  description: 'Overlapping keratin scales in offset rows. Each scale is a rounded plate whose free edge lifts away from the body, so the shadow sits under the trailing edge and nowhere else - a symmetric dome would read as a bubble sheet instead.',
  params: [
    { key: 'colorA', label: 'Scale A', type: 'color', default: [0.16, 0.3, 0.16], group: 'Colour' },
    { key: 'colorB', label: 'Scale B', type: 'color', default: [0.42, 0.46, 0.2], group: 'Colour' },
    { key: 'colorC', label: 'Belly', type: 'color', default: [0.72, 0.68, 0.5], group: 'Colour' },
    { key: 'pattern', label: 'Pattern Scale', type: 'float', default: 2.5, min: 0.2, max: 20, step: 0.05, group: 'Colour', description: 'The size of the markings, which are laid over the scales rather than following them.' },
    { key: 'rows', label: 'Rows', type: 'float', default: 22, min: 2, max: 120, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Scale Aspect', type: 'float', default: 1.3, min: 0.3, max: 5, step: 0.01, group: 'Layout' },
    { key: 'bond', label: 'Row Offset', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'lift', label: 'Edge Lift', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How far the trailing edge stands off the body. This is what makes them overlap.' },
    { key: 'keel', label: 'Keel', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The raised ridge down the centre of each scale, as on a viper.' },
    { key: 'gloss', label: 'Gloss', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'shed', label: 'Shedding', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Dulled patches of old skin about to come away.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const rows = p.float('rows')
    const cols = rows.mul(p.float('aspect'))

    const gridAt = (uvNode: V2) => brickGrid(vec2(uvNode.x.mul(cols), uvNode.y.mul(rows)), p.float('bond'))

    const heightAt = (uvNode: V2): F => {
      const g = gridAt(uvNode)
      const local = g.xy.sub(0.5)
      // Ellipse, biased so the scale is fullest at its leading edge.
      const d = vec2(local.x.mul(1.15), local.y.add(p.float('lift').mul(0.18)).mul(1.5)).length()
      const body = smoothstep(float(0.5), float(0.18), d)
      // The trailing edge is a step, not a fade: that is the overlap.
      const overlap = smoothstep(float(0.34), float(0.5), local.y.add(0.5)).mul(p.float('lift'))
      const keel = smoothstep(float(0.16), float(0), abs(local.x)).mul(p.float('keel')).mul(body)
      const grain = fbm01(vec3(uvNode.mul(cols.mul(9)), offset.add(3)), 3, 2.2, 0.55).sub(0.5).mul(0.05)
      return body.mul(float(0.45).add(overlap.mul(0.4))).add(keel.mul(0.2)).add(grain.mul(body))
    }

    const g = gridAt(ctx.uv)
    const id = hash21(g.zw.add(vec2(offset, offset)))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))
    const h = heightAt(ctx.uv)

    // Markings ignore the scale grid: the pigment is in the skin under it.
    const marking = fbm01(warp(vec3(ctx.uv.mul(p.float('pattern')), offset.add(23)), 0.6, 1.5), 4, 2.1, 0.55)
    const belly = smoothstep(float(0.15), float(0.5), ctx.uv.y)
    const colour = gradient3(marking, p.color('colorA'), p.color('colorB'), p.color('colorC'))
    const withBelly = mix(p.color('colorC'), colour, belly)

    const shed = smoothstep(float(0.58), float(0.82), fbm01(coord3(ctx, 5).add(37), 4, 2.2, 0.55)).mul(p.float('shed'))

    return {
      baseColor: tintVariation(withBelly, id, 0.014, 0.16, 0.14).mul(mix(float(1), float(1.18), shed)),
      metallic: float(0),
      // Keratin is glossy, and the gloss rides the dome: the crown of each
      // scale is the shiniest point on the animal.
      roughness: mix(float(0.72), float(0.18), p.float('gloss').mul(h.mul(1.6).clamp(0, 1)))
        .add(shed.mul(0.35))
        .add(microVariation(ctx.uv, cols.mul(4), offset).sub(0.5).mul(0.08))
        .clamp(0.05, 1),
      ao: cavityAO(h.div(float(0.9)).clamp(0, 1), normal, 0.7),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const fishScales = registerMaterial({
  id: 'fish-scales',
  name: 'Fish Scales',
  category: 'Creature',
  description: 'Cycloid scales with growth rings, under an iridescent guanine layer. The iridescence is faked the way nature builds it - a thin-film shift that changes hue with the surface angle - by driving hue from the normal rather than from position, so it moves as the model turns.',
  params: [
    { key: 'base', label: 'Body', type: 'color', default: [0.4, 0.46, 0.52], group: 'Colour' },
    { key: 'belly', label: 'Belly', type: 'color', default: [0.82, 0.84, 0.86], group: 'Colour' },
    { key: 'sheenA', label: 'Sheen A', type: 'color', default: [0.35, 0.75, 0.85], group: 'Colour' },
    { key: 'sheenB', label: 'Sheen B', type: 'color', default: [0.75, 0.45, 0.8], group: 'Colour' },
    { key: 'iridescence', label: 'Iridescence', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'rows', label: 'Rows', type: 'float', default: 26, min: 2, max: 140, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Aspect', type: 'float', default: 1, min: 0.3, max: 4, step: 0.01, group: 'Layout' },
    { key: 'overlap', label: 'Overlap', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'circuli', label: 'Growth Rings', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The concentric ridges on each scale, which record its growth like a tree.' },
    { key: 'slime', label: 'Slime Coat', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'A wet fish is glossy everywhere; a dry one is not. This is the difference between fresh and dead.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const rows = p.float('rows')
    const cols = rows.mul(p.float('aspect'))

    const gridAt = (uvNode: V2) => brickGrid(vec2(uvNode.x.mul(cols), uvNode.y.mul(rows)), float(0.5))

    const heightAt = (uvNode: V2): F => {
      const g = gridAt(uvNode)
      const local = g.xy.sub(0.5)
      const d = local.length()
      const body = smoothstep(float(0.52), float(0.2), d)
      const edge = smoothstep(float(0.3), float(0.52), d).mul(p.float('overlap'))
      // Circuli: rings centred on the scale, tightening towards the rim.
      const circuli = sin(d.mul(38).sub(1.2)).mul(0.5).add(0.5).mul(p.float('circuli')).mul(body).mul(0.06)
      return body.mul(float(0.5).sub(edge.mul(0.3))).add(circuli)
    }

    const g = gridAt(ctx.uv)
    const id = hash21(g.zw.add(vec2(offset, offset)))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.2))
    const h = heightAt(ctx.uv)

    const belly = smoothstep(float(0.1), float(0.55), ctx.uv.y)
    const body = mix(p.color('belly'), p.color('base'), belly)

    /**
     * Thin-film shift, faked from the local normal.
     *
     * The real effect depends on the angle between the eye and the film, which
     * a material graph cannot see. Using the normal's tilt is the next best
     * thing: it still varies across every scale and still moves when the model
     * rotates, which is what the eye reads as iridescence.
     */
    const tilt = normal.xy.length().mul(2.2).add(id.mul(0.6))
    const sheen = mix(p.color('sheenA'), p.color('sheenB'), fract(tilt))
    const irid = p.float('iridescence').mul(smoothstep(float(0.1), float(0.6), normal.xy.length()).mul(0.6).add(0.4))

    return {
      baseColor: mix(tintVariation(body, id, 0.01, 0.12, 0.16), sheen, irid.mul(0.55)),
      // Guanine platelets are genuinely reflective; a touch of metalness is
      // the cheapest honest way to get that mirror without a thin-film BSDF.
      metallic: irid.mul(0.35),
      roughness: mix(float(0.42), float(0.06), p.float('slime'))
        .add(id.sub(0.5).mul(0.1))
        .clamp(0.03, 1),
      ao: cavityAO(h.div(float(0.55)).clamp(0, 1), normal, 0.6),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const fur = registerMaterial({
  id: 'fur',
  name: 'Short Fur',
  category: 'Creature',
  description: 'Fur as a surface rather than as geometry. Individual hairs are stretched noise following a flow field, and the thing that makes it read as fur instead of as brushed metal is the parting: the flow diverges, and where hairs sweep apart the skin shows through.',
  params: [
    { key: 'hairA', label: 'Hair Light', type: 'color', default: [0.5, 0.36, 0.22], group: 'Colour' },
    { key: 'hairB', label: 'Hair Dark', type: 'color', default: [0.16, 0.11, 0.07], group: 'Colour' },
    { key: 'skin', label: 'Skin Under', type: 'color', default: [0.42, 0.3, 0.26], group: 'Colour' },
    { key: 'banding', label: 'Ticking', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Agouti banding: each hair is dark at the root and pale at the tip, which is why fur is lighter where it stands up.' },
    { key: 'density', label: 'Hair Density', type: 'float', default: 300, min: 20, max: 1500, step: 5, group: 'Fur' },
    { key: 'flow', label: 'Flow Strength', type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, group: 'Fur', description: 'How strongly the coat swirls. Zero is combed straight; higher values give cowlicks and partings.' },
    { key: 'flowScale', label: 'Flow Scale', type: 'float', default: 3, min: 0.2, max: 20, step: 0.1, group: 'Fur' },
    { key: 'clumping', label: 'Clumping', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Fur', description: 'Hairs stick together in locks. A perfectly even coat looks like carpet.' },
    { key: 'depth', label: 'Depth', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Fur' },
    { key: 'sheen', label: 'Sheen', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    // A flow field: a slowly varying angle the hairs are combed along.
    const angleAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(p.float('flowScale')), offset), 3, 2, 0.5).sub(0.5).mul(p.float('flow')).mul(6.283)

    const hairAt = (uvNode: V2): F => {
      const a = angleAt(uvNode)
      // Rotate into the flow frame, then stretch: the hairs follow the swirl.
      const c = cos(a)
      const s = sin(a)
      const rotated = vec2(uvNode.x.mul(c).sub(uvNode.y.mul(s)), uvNode.x.mul(s).add(uvNode.y.mul(c)))
      const stretched = vec2(rotated.x.mul(30), rotated.y)
      const fine = fbm01(vec3(stretched.mul(p.float('density').mul(0.02)), offset.add(3)), 3, 2.3, 0.6)
      const clump = fbm01(vec3(stretched.mul(p.float('density').mul(0.004)), offset.add(9)), 3, 2.1, 0.55)
      return mix(fine, fine.mul(clump.mul(1.6)), p.float('clumping')).clamp(0, 1)
    }

    const heightAt = (uvNode: V2): F => hairAt(uvNode).mul(p.float('depth'))

    const hair = hairAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.5).add(0.2))
    const h = heightAt(ctx.uv)

    // Partings: where the flow field diverges the coat opens and skin shows.
    const parting = smoothstep(float(0.42), float(0.18), hair).mul(p.float('flow').mul(0.3).clamp(0, 0.6))

    const tip = mix(float(0.5), hair, p.float('banding'))
    const coat = mix(p.color('hairB'), p.color('hairA'), tip)
    const patch = fbm01(coord3(ctx, 2.2).add(29), 3, 2, 0.5)

    return {
      baseColor: mix(tintVariation(coat, patch, 0.012, 0.16, 0.2), p.color('skin'), parting.mul(0.7)),
      metallic: float(0),
      // Hair is anisotropic: it is smooth along its length and rough across.
      // Without an anisotropy channel, the usable approximation is that the
      // lit tips read smoother than the roots.
      roughness: mix(float(0.85), float(0.4), p.float('sheen').mul(hair))
        .add(parting.mul(0.15))
        .clamp(0.15, 1),
      ao: cavityAO(hair, normal, 0.75),
      height: h.add(0.25).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const feathers = registerMaterial({
  id: 'feathers',
  name: 'Feathers',
  category: 'Creature',
  description: 'Overlapping contour feathers. Each one is a shaft with barbs running off it at an angle, and the barbs are drawn in the feather’s own local frame - which is why they fan correctly on every feather instead of all running the same way across the sheet.',
  params: [
    { key: 'vaneA', label: 'Vane', type: 'color', default: [0.3, 0.33, 0.4], group: 'Colour' },
    { key: 'vaneB', label: 'Vane Tip', type: 'color', default: [0.12, 0.13, 0.16], group: 'Colour' },
    { key: 'shaftColor', label: 'Shaft', type: 'color', default: [0.72, 0.68, 0.6], group: 'Colour' },
    { key: 'rows', label: 'Rows', type: 'float', default: 12, min: 1, max: 60, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Feather Aspect', type: 'float', default: 0.55, min: 0.15, max: 2, step: 0.01, group: 'Layout', description: 'Below 1 the feathers are longer than they are wide, as contour feathers are.' },
    { key: 'overlap', label: 'Overlap', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'barbs', label: 'Barb Density', type: 'float', default: 80, min: 5, max: 400, step: 1, group: 'Detail' },
    { key: 'barbAngle', label: 'Barb Angle', type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, group: 'Detail', description: 'How far the barbs sweep back from the shaft.' },
    { key: 'split', label: 'Splits', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Detail', description: 'Gaps where the barbs have unzipped, as on a worn or wet bird.' },
    { key: 'sheen', label: 'Sheen', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const rows = p.float('rows')
    const cols = rows.mul(p.float('aspect'))

    const gridAt = (uvNode: V2) => brickGrid(vec2(uvNode.x.mul(cols), uvNode.y.mul(rows)), float(0.5))

    const featherAt = (uvNode: V2) => {
      const g = gridAt(uvNode)
      const local = g.xy.sub(0.5)
      // Teardrop: full at the base, tapering to a rounded tip.
      const taper = float(1).sub(local.y.add(0.5).mul(0.55))
      const d = vec2(local.x.div(max(taper, float(0.15))), local.y.mul(0.92)).length()
      const body = smoothstep(float(0.52), float(0.42), d)
      return { g, local, body, d }
    }

    const heightAt = (uvNode: V2): F => {
      const f = featherAt(uvNode)
      // Barbs, drawn in the feather's own coordinate: swept back from the shaft.
      const sweep = f.local.y.add(abs(f.local.x).mul(p.float('barbAngle')))
      const barb = sin(sweep.mul(p.float('barbs'))).mul(0.5).add(0.5)
      const shaft = smoothstep(float(0.045), float(0), abs(f.local.x)).mul(f.body)
      const lift = smoothstep(float(0.1), float(0.6), f.local.y.add(0.5)).mul(p.float('overlap'))
      return f.body.mul(float(0.4).add(lift.mul(0.35))).add(barb.mul(0.05).mul(f.body)).add(shaft.mul(0.12))
    }

    const f = featherAt(ctx.uv)
    const id = hash21(f.g.zw.add(vec2(offset, offset)))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.3))
    const h = heightAt(ctx.uv)

    const shaft = smoothstep(float(0.05), float(0.01), abs(f.local.x)).mul(f.body)
    const tipward = smoothstep(float(-0.1), float(0.45), f.local.y)
    // Splits run along the barbs, so they follow the same swept coordinate.
    const sweep = f.local.y.add(abs(f.local.x).mul(p.float('barbAngle')))
    const split = smoothstep(float(0.75), float(0.95), fbm01(vec3(sweep.mul(p.float('barbs').mul(0.4)), id.mul(9), offset), 2, 2, 0.5))
      .mul(p.float('split'))
      .mul(f.body)

    const vane = mix(p.color('vaneA'), p.color('vaneB'), tipward)

    return {
      baseColor: mix(tintVariation(vane, id, 0.012, 0.14, 0.18), p.color('shaftColor'), shaft.mul(0.85))
        .mul(split.mul(0.5).oneMinus()),
      metallic: float(0),
      roughness: mix(float(0.68), float(0.28), p.float('sheen').mul(f.body))
        .add(split.mul(0.25))
        .add(id.sub(0.5).mul(0.08))
        .clamp(0.08, 1),
      ao: cavityAO(h.div(float(0.85)).clamp(0, 1), normal, 0.7),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const bone = registerMaterial({
  id: 'bone',
  name: 'Bone',
  category: 'Creature',
  description: 'Dry bone: a dense outer shell pitted with nutrient foramina, stained where it lay against earth, and finely cracked from drying. Fresh bone is glossy and pale; the yellowing and the crazing are entirely the story of what happened to it afterwards.',
  params: [
    { key: 'pale', label: 'Bone', type: 'color', default: [0.86, 0.82, 0.72], group: 'Colour' },
    { key: 'aged', label: 'Aged', type: 'color', default: [0.63, 0.55, 0.4], group: 'Colour' },
    { key: 'earth', label: 'Earth Stain', type: 'color', default: [0.32, 0.25, 0.16], group: 'Colour' },
    { key: 'aging', label: 'Ageing', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'staining', label: 'Staining', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'foramina', label: 'Foramina', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The nutrient holes where blood vessels entered. Sparse, deep, and the single most identifiable feature of bone.' },
    { key: 'foraminaScale', label: 'Foramina Scale', type: 'float', default: 28, min: 2, max: 200, step: 0.5, group: 'Surface' },
    { key: 'crazing', label: 'Crazing', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Drying cracks running along the bone axis.' },
    { key: 'porosity', label: 'Cancellous Look', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Where the dense shell has worn through to the spongy bone underneath.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.45, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const fs = p.float('foraminaScale')

    const spongeAt = (uvNode: V2): F =>
      smoothstep(float(0.55), float(0.75), fbm01(vec3(uvNode.mul(fs.mul(2.2)), offset.add(13)), 4, 2.2, 0.55))
        .mul(p.float('porosity'))

    const heightAt = (uvNode: V2): F => {
      // Foramina are individual holes, so they come from a cell field with a
      // sparse threshold - a noise threshold would smear them into pores.
      const cells = voronoi2(uvNode.mul(fs).add(vec2(offset, offset)), float(0.95))
      const pick = smoothstep(float(0.86), float(0.94), voronoiCellValue(cells))
      const hole = smoothstep(float(0.2), float(0.02), cells.x).mul(pick).mul(p.float('foramina'))
      const craze = scratches(uvNode.add(vec2(offset, offset)), float(0.15), float(50), fs.mul(1.4))
        .mul(p.float('crazing'))
      const grain = fbm01(vec3(uvNode.mul(fs.mul(8)), offset.add(3)), 3, 2.2, 0.55).sub(0.5).mul(0.04)
      return grain.sub(hole.mul(0.6)).sub(craze.mul(0.15)).sub(spongeAt(uvNode).mul(0.3))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.5))
    const h = heightAt(ctx.uv)
    const sponge = spongeAt(ctx.uv)

    const age = fbm01(coord3(ctx, 3).add(23), 4, 2.1, 0.55)
    const colour = mix(p.color('pale'), p.color('aged'), age.mul(p.float('aging')))
    // Earth staining pools in the low ground: the cracks and holes go dark.
    const stain = smoothstep(float(0.4), float(0.8), fbm01(coord3(ctx, 5.5).add(41), 4, 2.2, 0.55))
      .mul(p.float('staining'))
      .mul(h.negate().mul(2.5).add(0.55).clamp(0, 1))

    return {
      baseColor: mix(tintVariation(colour, age, 0.012, 0.14, 0.12), p.color('earth'), stain.mul(0.75)),
      metallic: float(0),
      // Dense cortical bone is nearly polished; exposed cancellous bone is not.
      roughness: p.float('roughness').add(sponge.mul(0.4)).add(stain.mul(0.15)).clamp(0.1, 1),
      ao: cavityAO(h.mul(3).add(0.72).clamp(0, 1), normal, 0.6),
      height: h.mul(1.6).add(0.6).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const chitin = registerMaterial({
  id: 'chitin',
  name: 'Insect Chitin',
  category: 'Creature',
  description: 'An arthropod shell: hard plates separated by soft membrane, over a structural colour that shifts from green to bronze. Chitin is laid down in layers, so its surface carries fine parallel striae - and it is those striae, not the colour, that make it read as an exoskeleton.',
  params: [
    { key: 'shellA', label: 'Shell A', type: 'color', default: [0.08, 0.2, 0.1], group: 'Colour' },
    { key: 'shellB', label: 'Shell B', type: 'color', default: [0.35, 0.26, 0.06], group: 'Colour' },
    { key: 'membrane', label: 'Membrane', type: 'color', default: [0.14, 0.09, 0.06], group: 'Colour' },
    { key: 'shift', label: 'Colour Shift', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Structural colour: the hue depends on how the plate is tilted, not on pigment.' },
    { key: 'plateScale', label: 'Plate Scale', type: 'float', default: 6, min: 0.5, max: 40, step: 0.1, group: 'Plates' },
    { key: 'jitter', label: 'Plate Irregularity', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Plates' },
    { key: 'seam', label: 'Seam Width', type: 'float', default: 0.06, min: 0.005, max: 0.3, step: 0.001, group: 'Plates' },
    { key: 'dome', label: 'Plate Dome', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Plates' },
    { key: 'striae', label: 'Striae', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'setae', label: 'Setae', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The stiff bristles poking out of the shell. Sparse, and always at the plate seams.' },
    { key: 'gloss', label: 'Gloss', type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('plateScale')

    const cellsAt = (uvNode: V2) => voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), p.float('jitter'))

    const heightAt = (uvNode: V2): F => {
      const cells = cellsAt(uvNode)
      const border = voronoiBorder(cells)
      const plate = smoothstep(p.float('seam'), p.float('seam').mul(2.5), border)
      const dome = smoothstep(float(0), float(0.25), border).pow(0.6).mul(p.float('dome'))
      const striae = sin(uvNode.y.mul(scale.mul(60)).add(voronoiCellValue(cells).mul(9)))
        .mul(0.5)
        .add(0.5)
        .mul(p.float('striae'))
        .mul(0.03)
      return plate.mul(float(0.4).add(dome.mul(0.35))).add(striae.mul(plate))
    }

    const cells = cellsAt(ctx.uv)
    const id = voronoiCellValue(cells)
    const plate = smoothstep(p.float('seam'), p.float('seam').mul(2.5), voronoiBorder(cells))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    // Structural colour keys off the surface tilt, the way a real multilayer
    // reflector does: flat plate crowns go one hue, sloped rims the other.
    const tilt = normal.xy.length().mul(3).add(id.mul(0.5))
    const shell = mix(p.color('shellA'), p.color('shellB'), fract(tilt).mul(p.float('shift')))

    const setae = sparkle(ctx.uv, scale.mul(9), offset.add(31), float(0.07))
      .mul(plate.oneMinus().mul(0.6).add(0.4))
      .mul(p.float('setae'))

    return {
      baseColor: mix(mix(p.color('membrane'), tintVariation(shell, id, 0.02, 0.2, 0.18), plate), p.color('membrane'), setae.mul(0.7)),
      // Chitin is dielectric, but the reflector layer under it behaves partly
      // like a mirror - a little metalness is the honest shortcut.
      metallic: p.float('shift').mul(plate).mul(0.25),
      roughness: mix(float(0.72), mix(float(0.5), float(0.08), p.float('gloss')), plate)
        .add(setae.mul(0.4))
        .add(microVariation(ctx.uv, scale.mul(12), offset).sub(0.5).mul(0.06))
        .clamp(0.03, 1),
      ao: cavityAO(h.div(float(0.8)).clamp(0, 1), normal, 0.8),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const CREATURE = [skin, reptileScales, fishScales, fur, feathers, bone, chitin]
