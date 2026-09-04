/**
 * Liquids and coatings - the things that sit *on* a surface rather than being
 * one.
 *
 * These are the materials where roughness and normal carry almost all of the
 * information and albedo carries almost none. Water is not blue; it is smooth.
 * Frost is not white because of its pigment but because of the way a thousand
 * crystal facets scatter. So every material here spends its effort on the
 * normal and the roughness, and keeps base colour nearly flat.
 *
 * Two of them are iridescent. Thin-film interference is a real, cheap function
 * of film thickness, and approximating it with a hue ramp rather than a
 * hand-picked gradient is what makes an oil slick look wet instead of tie-dyed.
 */

import { float, max, mix, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2, V3 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  fbm01,
  hash21,
  microVariation,
  normalFromHeightFn,
  sparkle,
  tintVariation,
  voronoi2,
  warp,
  worley,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(13.9)

/** Vertical faces only: a drip runs down, and on a floor it simply pools. */
function gravityWeight(ctx: MatContext): number {
  return ctx.axis === 1 ? 0 : 1
}

/**
 * Thin-film interference colour for a film of thickness `t` (0..1 arbitrary).
 *
 * Light reflecting off the top of a film and off the bottom travels different
 * distances, so some wavelengths cancel and others reinforce. The result is a
 * colour that cycles through the spectrum as the film thickens - and cycles
 * *faster* the thicker it gets, which is why the bands crowd together at the
 * edge of a soap bubble.
 *
 * Three offset cosines is the standard cheap stand-in: it has the right cyclic
 * structure and the right crowding, without integrating anything.
 */
function thinFilm(t: F, order: F): V3 {
  const phase = t.mul(order).mul(6.2831853)
  const r = phase.cos().mul(0.5).add(0.5)
  const g = phase.add(2.0944).cos().mul(0.5).add(0.5)
  const b = phase.add(4.1888).cos().mul(0.5).add(0.5)
  // Interference tints reflected light; it never goes fully black.
  return vec3(r, g, b).mul(0.7).add(vec3(0.3, 0.3, 0.3))
}

export const waterSurface = registerMaterial({
  id: 'water-surface',
  name: 'Water',
  category: 'Coatings',
  description:
    'Open water. The ripples are two wave trains crossing at an angle rather than one noise field, because real water always carries a swell and a local chop at the same time - a single frequency reads as gelatin. Roughness rises in the troughs where the surface is disturbed.',
  params: [
    { key: 'scale', label: 'Wave Scale', type: 'float', default: 8, min: 0.5, max: 60, step: 0.1, group: 'Waves' },
    { key: 'chop', label: 'Chop', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Waves', description: 'The fine cross-hatched ripple riding on the main swell.' },
    { key: 'direction', label: 'Swell Direction', type: 'float', default: 0.6, min: 0, max: 3.1416, step: 0.001, group: 'Waves' },
    { key: 'stretch', label: 'Swell Stretch', type: 'float', default: 3, min: 1, max: 12, step: 0.05, group: 'Waves', description: 'How far the swell is drawn out along its direction. Open ocean is very stretched.' },
    { key: 'foam', label: 'Foam', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Breaks on the wave crests, where the surface actually tears.' },
    { key: 'waterColor', label: 'Water Colour', type: 'color', default: [0.02, 0.09, 0.13], group: 'Colour' },
    { key: 'deepColor', label: 'Deep Colour', type: 'color', default: [0.005, 0.03, 0.06], group: 'Colour' },
    { key: 'foamColor', label: 'Foam Colour', type: 'color', default: [0.86, 0.9, 0.92], group: 'Colour' },
    { key: 'amplitude', label: 'Amplitude', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.06, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const heightAt = (uvNode: V2): F => {
      const a = p.float('direction')
      const c = a.cos()
      const s = a.sin()
      const rotated = vec2(uvNode.x.mul(c).sub(uvNode.y.mul(s)), uvNode.x.mul(s).add(uvNode.y.mul(c)))

      // The swell: stretched hard along its direction of travel.
      const swell = fbm01(
        vec3(rotated.x.mul(scale).div(p.float('stretch')), rotated.y.mul(scale), offset),
        3,
        2.1,
        0.55,
      )
      // The chop: a second train crossing the first, unstretched and finer.
      const chop = fbm01(
        vec3(rotated.y.mul(scale.mul(3.7)).div(2), rotated.x.mul(scale.mul(3.7)), offset.add(11)),
        4,
        2.3,
        0.55,
      )
      // Capillary ripple, the finest scale, riding on everything else.
      const capillary = fbm01(vec3(uvNode.mul(scale.mul(19)), offset.add(23)), 3, 2.4, 0.6)

      return swell
        .mul(0.6)
        .add(chop.mul(p.float('chop')).mul(0.3))
        .add(capillary.mul(0.1).mul(p.float('chop')))
        .mul(p.float('amplitude'))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('amplitude').mul(3.5))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('amplitude'), float(1e-3))).clamp(0, 1)

    // Foam breaks on the crests and is torn into streaks, never a smooth cap.
    const foamNoise = fbm01(vec3(ctx.uv.mul(scale.mul(6)), offset.add(31)), 4, 2.2, 0.55)
    const foam = smoothstep(float(0.72), float(0.95), h01.mul(0.6).add(foamNoise.mul(0.4)))
      .mul(p.float('foam'))

    // Deep water in the troughs, lighter where the surface is thin at a crest.
    const colour = mix(p.color('deepColor'), p.color('waterColor'), h01.pow(0.7))

    return {
      baseColor: mix(colour, p.color('foamColor'), foam),
      metallic: float(0),
      // Undisturbed water is a mirror; foam is the opposite. Nothing between.
      roughness: p.float('roughness').add(foam.mul(0.85)).add(h01.oneMinus().mul(0.05)).clamp(0.01, 1),
      ao: float(1),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const oilSlick = registerMaterial({
  id: 'oil-slick',
  name: 'Oil Slick',
  category: 'Coatings',
  description:
    'A film of oil on wet ground. The colour is thin-film interference driven by the film thickness, so the bands crowd together where the film thins toward its edge and spread out where it pools - which is the behaviour that reads as oil rather than as a rainbow gradient.',
  params: [
    { key: 'scale', label: 'Slick Scale', type: 'float', default: 3.5, min: 0.2, max: 30, step: 0.05, group: 'Film' },
    { key: 'coverage', label: 'Coverage', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Film', description: 'How much of the ground the film covers. The rest is bare wet substrate.' },
    { key: 'order', label: 'Interference Order', type: 'float', default: 4, min: 0.5, max: 16, step: 0.05, group: 'Film', description: 'How many colour cycles the film passes through. Higher is a thicker, more banded film.' },
    { key: 'swirl', label: 'Swirl', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Film' },
    { key: 'groundColor', label: 'Wet Ground', type: 'color', default: [0.035, 0.033, 0.032], group: 'Colour' },
    { key: 'tint', label: 'Oil Tint', type: 'color', default: [0.12, 0.1, 0.06], group: 'Colour' },
    { key: 'saturation', label: 'Saturation', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'ripple', label: 'Ripple', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.05, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * Film thickness.
     *
     * Warping the field is what produces the swirl: oil spreads by advection,
     * so its contours stretch and fold rather than sitting as round blobs. The
     * same field drives the colour, the coverage and the ripple, which keeps
     * all three consistent - the colour bands always run parallel to the edge
     * of the slick, because they are contours of the same function.
     */
    const thicknessAt = (uvNode: V2): F => {
      const w = warp(vec3(uvNode.mul(scale), offset), p.float('swirl').mul(1.2), 1.6)
      const broad = fbm01(w, 4, 2.1, 0.55)
      const fine = fbm01(vec3(uvNode.mul(scale.mul(5.5)), offset.add(7)), 3, 2.3, 0.55)
      return broad.mul(0.78).add(fine.mul(0.22))
    }

    const heightAt = (uvNode: V2): F => {
      const t = thicknessAt(uvNode)
      const ripple = fbm01(vec3(uvNode.mul(scale.mul(14)), offset.add(19)), 3, 2.4, 0.6).sub(0.5)
      return t.mul(0.1).add(ripple.mul(p.float('ripple')).mul(0.06))
    }

    const thickness = thicknessAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, 0.8)

    // The film has an edge: below the coverage threshold there is no oil.
    const film = smoothstep(
      float(1).sub(p.float('coverage')),
      float(1).sub(p.float('coverage')).add(0.12),
      thickness,
    )
    // Thickness measured from the film's own edge, so the bands crowd there.
    const relative = thickness.sub(float(1).sub(p.float('coverage'))).div(max(p.float('coverage'), float(1e-3))).clamp(0, 1)

    const iridescence = thinFilm(relative, p.float('order'))
    const desaturated = mix(vec3(0.5, 0.5, 0.5), iridescence, p.float('saturation'))
    const oil = desaturated.mul(p.color('tint').add(vec3(0.35, 0.35, 0.35)))

    const ground = p
      .color('groundColor')
      .mul(mix(float(0.7), float(1.3), microVariation(ctx.uv, scale.mul(9), offset.add(29))))

    return {
      baseColor: mix(ground, oil, film),
      // Oil on water is dielectric, but the interference makes it read like a
      // coated surface; a little metalness under the film sells the sheen.
      metallic: film.mul(0.25),
      roughness: p.float('roughness').add(film.oneMinus().mul(0.28)).clamp(0.01, 1),
      ao: float(1),
      height: relative.mul(film).mul(0.5).add(0.25),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const frostIce = registerMaterial({
  id: 'frost-ice',
  name: 'Frost',
  category: 'Coatings',
  description:
    'Frost growing across a cold surface. Crystals nucleate at sparse points and grow outward in feathery arms, so the pattern radiates from centres rather than filling space evenly - which is why a thresholded noise never looks like frost no matter how it is tuned.',
  params: [
    { key: 'scale', label: 'Crystal Scale', type: 'float', default: 9, min: 0.5, max: 60, step: 0.1, group: 'Crystals' },
    { key: 'coverage', label: 'Coverage', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Crystals', description: 'How far the frost has spread from its nucleation points.' },
    { key: 'feathering', label: 'Feathering', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Crystals', description: 'How strongly the crystal arms branch out from each centre.' },
    { key: 'sparkleAmount', label: 'Sparkle', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Crystals' },
    { key: 'iceColor', label: 'Ice Colour', type: 'color', default: [0.82, 0.89, 0.95], group: 'Colour' },
    { key: 'substrateColor', label: 'Substrate', type: 'color', default: [0.1, 0.12, 0.15], group: 'Colour' },
    { key: 'clarity', label: 'Clarity', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Clear ice lets the substrate through; hoar frost is opaque white.' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.25, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * Radial growth from nucleation points.
     *
     * The Voronoi cell centres are the nuclei. Modulating the distance to a
     * nucleus by a noise sampled in the *direction* of that nucleus turns the
     * smooth circular falloff into arms radiating outward - dendritic growth,
     * which is what frost actually is.
     */
    const frostAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), float(0.95))
      const distance = cells.x
      // Feathering: high-frequency angular noise, so arms and gaps alternate
      // around each centre.
      const arms = fbm01(vec3(uvNode.mul(scale.mul(7)), offset.add(13)), 4, 2.3, 0.55)
      const branched = distance.add(arms.sub(0.5).mul(p.float('feathering')).mul(0.7))
      const reach = mix(float(0.1), float(0.95), p.float('coverage'))
      return smoothstep(reach, reach.mul(0.35), branched)
    }

    const heightAt = (uvNode: V2): F => {
      const frost = frostAt(uvNode)
      // Facets: individual crystal planes within the frost.
      const facets = worley(vec3(uvNode.mul(scale.mul(16)), offset.add(7)), 1)
      const grain = fbm01(vec3(uvNode.mul(scale.mul(30)), offset.add(19)), 3, 2.4, 0.6).sub(0.5)
      return frost.mul(0.7).add(facets.mul(frost).mul(0.22)).add(grain.mul(frost).mul(0.12)).mul(p.float('relief'))
    }

    const frost = frostAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(3))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('relief'), float(1e-3))).clamp(0, 1)

    // Thin frost is translucent and shows the substrate through it.
    const opacity = frost.mul(mix(float(1), frost.pow(1.6), p.float('clarity')))
    const glint = sparkle(ctx.uv, scale.mul(22), offset.add(29), float(0.1)).mul(p.float('sparkleAmount')).mul(frost)

    const ice = p.color('iceColor').mul(mix(float(0.88), float(1.06), microVariation(ctx.uv, scale.mul(4), offset)))
    const colour = mix(p.color('substrateColor'), ice, opacity)

    return {
      baseColor: colour.add(vec3(glint.mul(0.5), glint.mul(0.5), glint.mul(0.5))),
      metallic: float(0),
      // Crystal facets are smooth; the fractured edges between them are not.
      roughness: p
        .float('roughness')
        .add(frost.mul(0.3))
        .sub(glint.mul(0.22))
        .sub(frost.oneMinus().mul(0.1))
        .clamp(0.02, 1),
      ao: cavityAO(h01, normal, 0.5),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const enamelDrips = registerMaterial({
  id: 'enamel-drips',
  name: 'Enamel Drips',
  category: 'Coatings',
  description:
    'Thick gloss paint applied too heavily and allowed to run. Each run has a rolled bead at its leading edge, where surface tension gathered the paint before it set - that bead is the entire reason a drip reads as a drip rather than as a vertical stripe.',
  params: [
    { key: 'scale', label: 'Run Density', type: 'float', default: 9, min: 0.5, max: 50, step: 0.1, group: 'Drips' },
    { key: 'runs', label: 'Runs', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Drips', description: 'How many of the potential runs actually formed.' },
    { key: 'runLength', label: 'Run Length', type: 'float', default: 0.5, min: 0.05, max: 1, step: 0.01, group: 'Drips' },
    { key: 'bead', label: 'Bead', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Drips', description: 'The rolled lip of paint at the bottom of each run.' },
    { key: 'orangePeel', label: 'Orange Peel', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The dimpled texture a sprayed or brushed gloss coat always has.' },
    { key: 'paintColor', label: 'Paint Colour', type: 'color', default: [0.75, 0.72, 0.66], group: 'Colour' },
    { key: 'substrateColor', label: 'Substrate', type: 'color', default: [0.16, 0.15, 0.14], group: 'Colour' },
    { key: 'thinning', label: 'Thin Coverage', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Where the coat got thin enough for the substrate to read through.' },
    { key: 'thickness', label: 'Coat Thickness', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.12, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    // On a floor there is no "down", so the runs become a pooled coat instead.
    const gravity = gravityWeight(ctx)

    /**
     * One run per column that has one.
     *
     * Columns are hashed so a run either exists or does not - fading runs in
     * and out with a noise gives a smear. Each run has its own start height,
     * its own length and its own width.
     */
    const runAt = (uvNode: V2) => {
      const col = uvNode.x.mul(scale)
      const id = col.floor()
      const local = col.fract().sub(0.5)

      const present = step(hash21(vec2(id, offset)), p.float('runs'))
      const width = mix(float(0.12), float(0.34), hash21(vec2(id, offset.add(3))))
      const start = hash21(vec2(id, offset.add(7))).mul(0.5)
      const length = mix(float(0.15), float(1), hash21(vec2(id, offset.add(11)))).mul(p.float('runLength'))
      const end = start.add(length)

      // Distance down the run, 0 at the top, 1 at the bead.
      const t = uvNode.y.sub(start).div(max(length, float(1e-3)))
      const inside = step(float(0), t).mul(step(t, float(1))).mul(present)

      // The run narrows as it descends - it is running out of paint.
      const localWidth = width.mul(mix(float(1), float(0.55), t.clamp(0, 1)))
      const across = smoothstep(localWidth, localWidth.mul(0.4), local.abs())

      // The bead: surface tension gathered the paint at the leading edge.
      const bead = smoothstep(float(0.82), float(1), t.clamp(0, 1))
        .mul(smoothstep(float(1.06), float(0.98), t.clamp(0, 1.1)))
        .mul(p.float('bead'))

      const body = across.mul(inside)
      return { body, bead: bead.mul(across).mul(present), end, t }
    }

    const coatAt = (uvNode: V2): F => {
      // The coat itself: uneven thickness from the application.
      const laid = fbm01(vec3(uvNode.mul(scale.mul(0.6)), offset.add(17)), 3, 2, 0.5)
      const peel = fbm01(vec3(uvNode.mul(scale.mul(11)), offset.add(23)), 3, 2.3, 0.55).sub(0.5)
      return laid.mul(0.35).add(0.55).add(peel.mul(p.float('orangePeel')).mul(0.12))
    }

    const heightAt = (uvNode: V2): F => {
      const coat = coatAt(uvNode)
      if (gravity === 0) return coat.mul(p.float('thickness'))
      const run = runAt(uvNode)
      return coat.add(run.body.mul(0.5)).add(run.bead.mul(0.75)).mul(p.float('thickness'))
    }

    const coat = coatAt(ctx.uv)
    const run = gravity === 0 ? null : runAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('thickness').mul(2.4))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('thickness'), float(1e-3))).clamp(0, 1)

    const runMask = run ? run.body.max(run.bead).clamp(0, 1) : float(0)
    // Thin coat lets the substrate through; a run is the thickest paint there is.
    const thin = smoothstep(float(0.62), float(0.4), coat).mul(p.float('thinning')).mul(runMask.oneMinus())
    const paint = tintVariation(p.color('paintColor'), microVariation(ctx.uv, scale.mul(1.5), offset), 0.004, 0.06, 0.08)
    const colour = mix(paint, p.color('substrateColor'), thin)

    return {
      baseColor: colour,
      metallic: float(0),
      // Thick paint flows out smoother than thin paint; orange peel is a
      // normal effect, not a roughness one, so roughness stays low and even.
      roughness: p
        .float('roughness')
        .add(thin.mul(0.35))
        .sub(runMask.mul(0.04))
        .clamp(0.02, 1),
      ao: cavityAO(h01, normal, 0.35),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const soapBubble = registerMaterial({
  id: 'soap-bubble',
  name: 'Soap Film',
  category: 'Coatings',
  description:
    'A soap film, thinning as it drains. Gravity pulls the liquid down, so the film is thinnest at the top - which is why the interference bands stack horizontally and why the very top goes black just before it bursts. Both fall out of using the projection axis to find "up".',
  params: [
    { key: 'scale', label: 'Flow Scale', type: 'float', default: 2.5, min: 0.2, max: 20, step: 0.05, group: 'Film' },
    { key: 'order', label: 'Interference Order', type: 'float', default: 6, min: 0.5, max: 20, step: 0.05, group: 'Film' },
    { key: 'drain', label: 'Drainage', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Film', description: 'How far the film has thinned at the top. At 1 the crown goes black and the bubble is about to go.' },
    { key: 'turbulence', label: 'Turbulence', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Film', description: 'The churn in the draining film, which is what makes the bands writhe rather than lie flat.' },
    { key: 'tint', label: 'Tint', type: 'color', default: [0.9, 0.95, 1], group: 'Colour' },
    { key: 'saturation', label: 'Saturation', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'glow', label: 'Sheen', type: 'float', default: 0.35, min: 0, max: 4, step: 0.01, group: 'Colour', description: 'Films are lit from both sides, so a little emission stands in for the light coming through the back.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.03, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * Which way is down.
     *
     * Under triplanar the two vertical planes see V as the vertical axis and
     * the horizontal plane has no meaningful "up" at all. Drainage is the one
     * effect here that genuinely needs to know, so it is switched off on the
     * flat plane rather than being applied in an arbitrary direction.
     */
    const draining = gravityWeight(ctx)

    const thickness = (() => {
      // Churn: the film is a moving liquid, so the bands writhe.
      const w = warp(vec3(ctx.uv.mul(scale), offset), p.float('turbulence').mul(1.4), 1.8)
      const churn = fbm01(w, 4, 2.1, 0.55)
      // Drainage: thinnest at the top, which is V = 0 in the projected frame.
      const gradient = draining === 0 ? float(0.5) : ctx.uv.y.fract()
      const drained = mix(float(0.5), gradient, p.float('drain'))
      return drained.mul(0.62).add(churn.mul(0.38)).clamp(0, 1)
    })()

    const iridescence = thinFilm(thickness, p.float('order'))
    const colour = mix(vec3(0.5, 0.5, 0.5), iridescence, p.float('saturation')).mul(p.color('tint'))

    // The black spot: below a few tens of nanometres the film reflects nothing
    // at all, which is the last thing you see before a bubble pops.
    const black = smoothstep(float(0.12), float(0.02), thickness)

    // The film is very slightly non-flat, and the highlight has to move over it.
    const ripple = fbm01(vec3(ctx.uv.mul(scale.mul(8)), offset.add(13)), 3, 2.3, 0.55).sub(0.5)
    const normal = blendDetailNormal(
      vec3(0, 0, 1),
      vec3(ripple.mul(0.35), ripple.mul(0.35), float(1)),
      p.float('turbulence'),
    )

    return {
      baseColor: colour.mul(black.oneMinus()),
      // A soap film reflects like a coated dielectric, and reads far better
      // with a little metalness than with none - the tint has to survive.
      metallic: float(0.35).mul(black.oneMinus()),
      roughness: p.float('roughness').add(black.mul(0.4)).clamp(0.01, 1),
      ao: float(1),
      height: thickness,
      normal,
      emissive: colour.mul(p.float('glow')).mul(black.oneMinus()).mul(0.25),
    }
  },
} satisfies ProceduralMaterialDef)

export const COATINGS = [waterSurface, oilSlick, frostIce, enamelDrips, soapBubble]
