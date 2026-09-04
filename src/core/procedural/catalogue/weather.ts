/**
 * Ground and weather, extending the terrain set.
 *
 * The organising idea across all of these is *water*, in one state or another.
 * Wet ground is not dry ground with a darker albedo: water fills the micro
 * relief, so roughness collapses, the normal flattens, and the colour darkens
 * because light now enters the surface instead of bouncing off the grains.
 * Every material here that involves moisture moves all four of those together,
 * because moving only the colour is the single most common way to get wet
 * ground wrong.
 */

import { float, fract, max, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  cracks,
  fbm01,
  gradient3,
  heightBlend,
  microVariation,
  normalFromHeightFn,
  pebbles,
  ridged,
  sparkle,
  tintVariation,
  voronoiCellValue,
  voronoi2,
  warp,
  worley,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

/** 1 on upward-facing planes under triplanar, 0 on the vertical ones. */
const upWeight = (ctx: MatContext): number => (ctx.axis === 1 || ctx.axis === -1 ? 1 : 0)

// ---------------------------------------------------------------------------

export const wetMud = registerMaterial({
  id: 'wet-mud',
  name: 'Wet Mud',
  category: 'Terrain',
  description: 'Churned ground with standing water in the ruts. The puddles are found by flooding the height field to a level rather than by painting a separate mask, so water sits where water would actually sit - and the wet ring around each puddle comes free.',
  params: [
    { key: 'mud', label: 'Mud', type: 'color', default: [0.24, 0.18, 0.13], group: 'Colour' },
    { key: 'dryMud', label: 'Dry Mud', type: 'color', default: [0.44, 0.36, 0.27], group: 'Colour' },
    { key: 'water', label: 'Water', type: 'color', default: [0.1, 0.09, 0.07], group: 'Colour' },
    { key: 'churn', label: 'Churn', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Ground', description: 'How badly the ground has been worked over by feet and wheels.' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.1, group: 'Ground' },
    { key: 'ruts', label: 'Ruts', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Ground', description: 'Parallel tyre tracks cut into the churn.' },
    { key: 'waterLevel', label: 'Water Level', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Water', description: 'Flood level. Everything below it is under water; the band just above it is merely damp.' },
    { key: 'dampBand', label: 'Damp Margin', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Water' },
    { key: 'debris', label: 'Grit and Debris', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const heightAt = (uvNode: V2): F => {
      const churn = ridged(warp(vec3(uvNode.mul(scale), offset), 0.5, 1.2), float(4), float(0.55))
        .mul(p.float('churn'))
      const rut = sin(uvNode.x.mul(scale.mul(1.4)).mul(6.2832)).mul(0.5).add(0.5).mul(p.float('ruts')).mul(0.35)
      const grit = fbm01(vec3(uvNode.mul(scale.mul(30)), offset.add(3)), 3, 2.3, 0.55).sub(0.5).mul(0.05)
      return churn.mul(0.6).sub(rut).add(grit)
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.8))
    const h = heightAt(ctx.uv)

    // Flooding: everything below the level is submerged, and the band just
    // above it is wicking. One threshold gives both.
    const level = p.float('waterLevel').mul(0.6).sub(0.1)
    const submerged = smoothstep(level.add(0.02), level.sub(0.02), h).mul(upWeight(ctx))
    const damp = smoothstep(level.add(p.float('dampBand').mul(0.3)), level, h).mul(upWeight(ctx))

    const tone = fbm01(coord3(ctx, scale.mul(2)).add(19), 4, 2.1, 0.55)
    const ground = mix(p.color('dryMud'), p.color('mud'), tone.mul(0.6).add(damp.mul(0.6)).clamp(0, 1))
    const grit = sparkle(ctx.uv, scale.mul(80), offset.add(9), float(0.1)).mul(p.float('debris'))

    return {
      // Wet earth is genuinely darker, not just glossier: water fills the pore
      // space, so far less light comes back out.
      baseColor: mix(tintVariation(ground, tone, 0.01, 0.14, 0.18), p.color('water'), submerged)
        .mul(mix(float(1), float(0.7), damp.mul(0.6)))
        .add(grit.mul(0.06).mul(submerged.oneMinus())),
      metallic: float(0),
      // Standing water is a mirror; damp mud is halfway there; dry churn is
      // as rough as anything in the catalogue.
      roughness: mix(mix(float(0.95), float(0.55), damp), float(0.04), submerged)
        .add(microVariation(ctx.uv, scale.mul(20), offset).sub(0.5).mul(0.08).mul(submerged.oneMinus()))
        .clamp(0.02, 1),
      // Water is flat: the puddle surface has to erase the mud normal under it.
      normal: mix(normal, vec3(0, 0, 1), submerged),
      ao: cavityAO(h.mul(1.5).add(0.5).clamp(0, 1), normal, 0.7),
      height: h.add(0.45).clamp(0, 1),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const duneSand = registerMaterial({
  id: 'dune-sand',
  name: 'Dune Sand',
  category: 'Terrain',
  description: 'Wind-rippled sand. The ripples are asymmetric - a long windward slope and a short slip face - and that asymmetry is what makes a dune read as wind-blown rather than as corrugated metal. Skewing a sine wave gives it for one extra operation.',
  params: [
    { key: 'sand', label: 'Sand', type: 'color', default: [0.79, 0.68, 0.46], group: 'Colour' },
    { key: 'shadowTone', label: 'Shadow Tone', type: 'color', default: [0.56, 0.45, 0.29], group: 'Colour' },
    { key: 'mineral', label: 'Dark Mineral', type: 'color', default: [0.3, 0.22, 0.16], group: 'Colour', description: 'Heavy minerals that the wind sorts into the ripple troughs.' },
    { key: 'ripples', label: 'Ripple Density', type: 'float', default: 22, min: 1, max: 120, step: 0.5, group: 'Ripples' },
    { key: 'rippleDepth', label: 'Ripple Depth', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Ripples' },
    { key: 'skew', label: 'Wind Skew', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Ripples', description: 'How asymmetric the ripple profile is. Zero is a sine wave; higher is a real dune.' },
    { key: 'meander', label: 'Ripple Meander', type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, group: 'Ripples', description: 'Ripple crests are not straight lines: they fork and rejoin.' },
    { key: 'sorting', label: 'Grain Sorting', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'How strongly the dark minerals collect in the troughs.' },
    { key: 'sparkleAmount', label: 'Quartz Sparkle', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'tracks', label: 'Footprints', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Disturbance that flattens the ripples and churns the sorting.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const trackAt = (uvNode: V2): F =>
      smoothstep(float(0.55), float(0.75), fbm01(vec3(uvNode.mul(vec2(2, 6)), offset.add(23)), 4, 2.1, 0.55))
        .mul(p.float('tracks'))

    const rippleAt = (uvNode: V2): F => {
      const meander = fbm01(vec3(uvNode.mul(vec2(2.5, 0.6)), offset), 3, 2, 0.5).sub(0.5).mul(p.float('meander'))
      const t = fract(uvNode.y.add(meander).mul(p.float('ripples')))
      // Skewing the phase before the sine steepens one flank and stretches the
      // other: the windward slope and the slip face.
      const skewed = t.pow(mix(float(1), float(2.2), p.float('skew')))
      return sin(skewed.mul(6.2832)).mul(0.5).add(0.5)
    }

    const heightAt = (uvNode: V2): F => {
      const ripple = rippleAt(uvNode).mul(p.float('rippleDepth')).mul(0.25)
      const dune = fbm01(vec3(uvNode.mul(1.2), offset.add(5)), 3, 2, 0.5).sub(0.5).mul(0.2)
      const grain = fbm01(vec3(uvNode.mul(400), offset.add(9)), 2, 2, 0.5).sub(0.5).mul(0.01)
      const churn = trackAt(uvNode)
      return mix(ripple, ripple.mul(0.2).sub(0.06), churn).add(dune).add(grain)
    }

    const ripple = rippleAt(ctx.uv)
    const track = trackAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    // Wind sorts by density: the heavy dark grains end up in the troughs.
    const sorting = mix(float(0.5), ripple.oneMinus(), p.float('sorting')).mul(track.oneMinus().mul(0.7).add(0.3))
    const colour = mix(
      gradient3(ripple, p.color('shadowTone'), p.color('sand'), p.color('sand').mul(1.08)),
      p.color('mineral'),
      sorting.mul(0.35),
    )
    const quartz = sparkle(ctx.uv, float(700), offset.add(31), float(0.06)).mul(p.float('sparkleAmount'))

    return {
      baseColor: tintVariation(colour, fbm01(coord3(ctx, 6).add(41), 3, 2, 0.5), 0.01, 0.12, 0.14).add(quartz.mul(0.18)),
      metallic: float(0),
      roughness: float(0.9).sub(quartz.mul(0.4)).add(track.mul(0.04)).clamp(0.3, 1),
      ao: cavityAO(ripple.mul(0.6).add(0.4), normal, 0.4),
      height: h.add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const glacierIce = registerMaterial({
  id: 'glacier-ice',
  name: 'Glacier Ice',
  category: 'Terrain',
  description: 'Compressed glacial ice: dense, blue, and full of trapped air bubbles and dirt bands from the seasons it accumulated. The blue is not a tint - it is what survives after long-wavelength light has been absorbed on the way through, so the deeper and clearer the ice, the bluer it reads.',
  params: [
    { key: 'iceLight', label: 'Surface Ice', type: 'color', default: [0.82, 0.9, 0.94], group: 'Colour' },
    { key: 'iceDeep', label: 'Deep Ice', type: 'color', default: [0.24, 0.52, 0.72], group: 'Colour' },
    { key: 'dirtColor', label: 'Dirt Band', type: 'color', default: [0.4, 0.36, 0.3], group: 'Colour' },
    { key: 'clarity', label: 'Clarity', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Ice', description: 'Bubble-free ice transmits further, so it goes blue. Bubbly ice scatters and stays white.' },
    { key: 'bubbles', label: 'Air Bubbles', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Ice' },
    { key: 'bubbleScale', label: 'Bubble Scale', type: 'float', default: 60, min: 5, max: 400, step: 1, group: 'Ice' },
    { key: 'bands', label: 'Dirt Bands', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Ice', description: 'One band per year of accumulation, folded by the ice flow.' },
    { key: 'crevasses', label: 'Crevasses', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'meltPolish', label: 'Melt Polish', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Sun-melted ice refreezes glassy; wind-scoured ice does not.' },
    { key: 'opacity', label: 'Opacity', type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const crevasseAt = (uvNode: V2): F =>
      cracks(uvNode, float(4), float(0.09), offset.add(3)).mul(p.float('crevasses'))

    const heightAt = (uvNode: V2): F => {
      const flow = fbm01(vec3(uvNode.mul(vec2(2, 0.8)), offset), 4, 2.1, 0.55).sub(0.5).mul(0.25)
      const scallop = ridged(vec3(uvNode.mul(24), offset.add(9)), float(3), float(0.5)).mul(0.07)
      return flow.add(scallop).sub(crevasseAt(uvNode).mul(0.5))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.7))
    const h = heightAt(ctx.uv)
    const crevasse = crevasseAt(ctx.uv)

    const bubble = smoothstep(float(0.28), float(0), worley(coord3(ctx, p.float('bubbleScale')).add(13), 1))
      .mul(p.float('bubbles'))
    // Depth: crevasses and low ground look through more ice, so they go bluer.
    const depth = crevasse.mul(0.7).add(h.negate().mul(1.2).clamp(0, 0.5))
      .mul(p.float('clarity'))
      .mul(bubble.oneMinus())
      .clamp(0, 1)

    const bands = smoothstep(float(0.62), float(0.72), fbm01(vec3(ctx.uv.mul(vec2(1.5, 14)), offset.add(23)), 4, 2.1, 0.55))
      .mul(p.float('bands'))

    const ice = mix(p.color('iceLight'), p.color('iceDeep'), depth)
    const polish = smoothstep(float(0.4), float(0.75), fbm01(coord3(ctx, 5).add(41), 3, 2, 0.5)).mul(p.float('meltPolish'))

    return {
      baseColor: mix(ice.add(bubble.mul(0.15)), p.color('dirtColor'), bands.mul(0.7)),
      metallic: float(0),
      roughness: mix(float(0.42), float(0.04), polish).add(bubble.mul(0.2)).add(bands.mul(0.3)).clamp(0.02, 1),
      // Bubbly and dirty ice blocks light; clear ice does not.
      opacity: p.float('opacity').mul(bubble.mul(0.3).add(bands.mul(0.4)).add(0.6)).clamp(0, 1),
      ao: cavityAO(h.mul(1.5).add(0.6).clamp(0, 1), normal, 0.5),
      height: h.add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const volcanicAsh = registerMaterial({
  id: 'volcanic-ash',
  name: 'Volcanic Ash',
  category: 'Terrain',
  description: 'A fresh ash fall over older ground. Ash is angular glass shards rather than rounded grains, so it holds a slope and cracks as it dries instead of flowing - which is why it drapes over what is underneath rather than filling it in.',
  params: [
    { key: 'ash', label: 'Ash', type: 'color', default: [0.28, 0.27, 0.26], group: 'Colour' },
    { key: 'ashPale', label: 'Dry Ash', type: 'color', default: [0.52, 0.5, 0.48], group: 'Colour' },
    { key: 'underRock', label: 'Rock Under', type: 'color', default: [0.13, 0.11, 0.1], group: 'Colour' },
    { key: 'coverage', label: 'Ash Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Fall', description: 'How thickly the fall has buried the ground. Low values leave the rock reading through.' },
    { key: 'scale', label: 'Scale', type: 'float', default: 6, min: 0.2, max: 40, step: 0.1, group: 'Fall' },
    { key: 'drape', label: 'Drape', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Fall', description: 'Ash settles into hollows first, so it fills before it covers.' },
    { key: 'cracking', label: 'Drying Cracks', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'lapilli', label: 'Lapilli', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The coarser pebbles that fell with the ash and sit on top of it.' },
    { key: 'disturbance', label: 'Disturbance', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Wind and rain scouring the fall back down to the rock.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const rockAt = (uvNode: V2): F =>
      ridged(warp(vec3(uvNode.mul(scale.mul(0.8)), offset), 0.4, 1.1), float(4), float(0.55))

    // pebbles() returns (dome, border, id.x, id.y), so the same call gives both
    // the stone shape and its per-cell id - no second Voronoi evaluation.
    const lapilliAt = (uvNode: V2): F => {
      const cells = pebbles(uvNode.mul(scale.mul(9)).add(vec2(offset, offset)), float(0.95), float(0.25))
      return cells.x.mul(smoothstep(float(0.72), float(0.86), voronoiCellValue(cells))).mul(p.float('lapilli'))
    }

    const ashAt = (uvNode: V2): F => {
      const rock = rockAt(uvNode)
      const field = fbm01(vec3(uvNode.mul(scale.mul(1.6)), offset.add(13)), 4, 2.1, 0.55)
      const scour = smoothstep(float(0.55), float(0.8), fbm01(vec3(uvNode.mul(scale.mul(0.7)), offset.add(29)), 3, 2, 0.5))
        .mul(p.float('disturbance'))
      // Height-aware coverage: ash fills the low ground before it buries the
      // high ground, which is what "drape" means physically.
      return heightBlend(
        p.float('coverage').mul(field.mul(0.4).add(0.8)).sub(scour),
        float(0.5),
        rock.mul(p.float('drape')).add(0.2),
        0.2,
      )
    }

    const heightAt = (uvNode: V2): F => {
      const ash = ashAt(uvNode)
      const rock = rockAt(uvNode).mul(0.4)
      const crack = cracks(uvNode, scale.mul(5), float(0.05), offset.add(17)).mul(p.float('cracking')).mul(ash)
      const grain = fbm01(vec3(uvNode.mul(scale.mul(40)), offset.add(3)), 3, 2.3, 0.55).sub(0.5).mul(0.03)
      return mix(rock, float(0.3), ash).add(lapilliAt(uvNode).mul(0.12)).sub(crack.mul(0.25)).add(grain)
    }

    const ash = ashAt(ctx.uv)
    const lapilli = lapilliAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    const dryness = fbm01(coord3(ctx, scale.mul(2.5)).add(41), 4, 2.1, 0.55)
    const ashColour = mix(p.color('ash'), p.color('ashPale'), dryness)

    return {
      baseColor: mix(p.color('underRock'), tintVariation(ashColour, dryness, 0.008, 0.1, 0.16), ash)
        .mul(mix(float(1), float(0.82), lapilli)),
      metallic: float(0),
      // Ash is angular glass: it is the most light-eating surface here, and
      // dry ash is rougher than damp ash by a wide margin.
      roughness: mix(float(0.8), float(0.95), ash.mul(dryness)).add(lapilli.mul(0.03)).clamp(0.45, 1),
      ao: cavityAO(h.mul(1.6).add(0.5).clamp(0, 1), normal, 0.65),
      height: h.add(0.4).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const riverbed = registerMaterial({
  id: 'riverbed',
  name: 'Riverbed',
  category: 'Terrain',
  description: 'Water-worn cobbles with silt packed between them. Running water sorts stones by size and rounds them completely, so the cobbles here are near-spherical and graded - and the silt fills from the bottom up, which a plain mask blend cannot express but a height blend can.',
  params: [
    { key: 'stoneA', label: 'Stone A', type: 'color', default: [0.42, 0.4, 0.37], group: 'Colour' },
    { key: 'stoneB', label: 'Stone B', type: 'color', default: [0.55, 0.48, 0.4], group: 'Colour' },
    { key: 'stoneC', label: 'Stone C', type: 'color', default: [0.26, 0.25, 0.26], group: 'Colour' },
    { key: 'silt', label: 'Silt', type: 'color', default: [0.36, 0.31, 0.24], group: 'Colour' },
    { key: 'scale', label: 'Cobble Size', type: 'float', default: 13, min: 1, max: 90, step: 0.5, group: 'Bed' },
    { key: 'grading', label: 'Size Grading', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Bed', description: 'Water sorts stones: a graded bed has bands of one size rather than a random mix.' },
    { key: 'roundness', label: 'Roundness', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Bed' },
    { key: 'siltLevel', label: 'Silt Level', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Bed', description: 'How far the fines have buried the cobbles.' },
    { key: 'wetness', label: 'Wetness', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'algae', label: 'Algae', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Slick green film on the stone tops, where light reaches.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const bedAt = (uvNode: V2) => {
      // Grading varies the local cell size, so the bed has bands of one calibre.
      const grade = fbm01(vec3(uvNode.mul(1.4), offset.add(5)), 3, 2, 0.5).sub(0.5).mul(p.float('grading'))
      const s = scale.mul(grade.mul(0.8).add(1))
      return pebbles(uvNode.mul(s).add(vec2(offset, offset)), float(0.95), mix(float(0.08), float(0.32), p.float('roundness')))
    }

    const heightAt = (uvNode: V2): F => {
      const cobbles = bedAt(uvNode)
      const stone = cobbles.x.mul(0.55)
      const grain = fbm01(vec3(uvNode.mul(scale.mul(16)), offset.add(3)), 3, 2.2, 0.55).sub(0.5).mul(0.03)
      // Silt fills from the bottom: everything below the level goes flat.
      const level = p.float('siltLevel').mul(0.5)
      return max(stone.add(grain), level)
    }

    const cobbles = bedAt(ctx.uv)
    const id = cobbles.z.add(cobbles.w).mul(0.37).fract()
    const stone = cobbles.x
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.7))
    const h = heightAt(ctx.uv)

    const siltMask = smoothstep(p.float('siltLevel').mul(0.5).add(0.05), p.float('siltLevel').mul(0.5), stone.mul(0.55))
    const stoneColour = tintVariation(gradient3(id, p.color('stoneA'), p.color('stoneB'), p.color('stoneC')), id, 0.012, 0.16, 0.2)
    const algae = smoothstep(float(0.5), float(0.8), fbm01(coord3(ctx, scale.mul(0.8)).add(23), 4, 2.1, 0.55))
      .mul(p.float('algae'))
      .mul(stone.clamp(0, 1))

    const surface = mix(stoneColour, p.color('silt'), siltMask)
    const wet = p.float('wetness')

    return {
      baseColor: mix(surface, vec3(0.14, 0.24, 0.13), algae.mul(0.7)).mul(mix(float(1), float(0.55), wet)),
      metallic: float(0),
      // Under water everything converges on the same low roughness: the water
      // surface, not the stone, is what you are actually seeing.
      roughness: mix(mix(float(0.82), float(0.55), algae), float(0.06), wet)
        .add(siltMask.mul(0.1).mul(wet.oneMinus()))
        .clamp(0.03, 1),
      // Wet stone reads flatter as well as glossier: the film bridges the grain.
      normal: mix(normal, blendDetailNormal(normal, vec3(0, 0, 1), 0.4), wet.mul(0.5)),
      ao: cavityAO(h.mul(1.6).clamp(0, 1), normal, 0.75),
      height: h.clamp(0, 1),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const permafrost = registerMaterial({
  id: 'permafrost',
  name: 'Frozen Ground',
  category: 'Terrain',
  description: 'Ground with ice in it. Freezing sorts stones into polygons and heaves the fines into the middle, so the surface organises itself into cells - a pattern that looks designed but is entirely produced by repeated freeze and thaw.',
  params: [
    { key: 'soil', label: 'Frozen Soil', type: 'color', default: [0.3, 0.26, 0.22], group: 'Colour' },
    { key: 'frost', label: 'Frost', type: 'color', default: [0.86, 0.89, 0.92], group: 'Colour' },
    { key: 'stone', label: 'Sorted Stone', type: 'color', default: [0.42, 0.4, 0.38], group: 'Colour' },
    { key: 'cells', label: 'Polygon Size', type: 'float', default: 3.5, min: 0.3, max: 30, step: 0.05, group: 'Sorting' },
    { key: 'sorting', label: 'Stone Sorting', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Sorting', description: 'How completely the stones have migrated to the polygon borders.' },
    { key: 'heave', label: 'Frost Heave', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Sorting', description: 'The doming of each polygon centre as ice grows underneath it.' },
    { key: 'frostAmount', label: 'Surface Frost', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'needleIce', label: 'Needle Ice', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Ice crystals pushing out of the soil. They form on the exposed faces, not in the shelter.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const cs = p.float('cells')

    const polyAt = (uvNode: V2) => voronoi2(uvNode.mul(cs).add(vec2(offset, offset)), float(0.85))

    const stoneAt = (uvNode: V2): F => {
      const cells = polyAt(uvNode)
      const border = cells.y.sub(cells.x)
      // Stones migrate outwards to the borders; the centre keeps the fines.
      const belt = smoothstep(float(0.16), float(0.02), border).mul(p.float('sorting'))
      const grain = pebbles(uvNode.mul(cs.mul(22)).add(vec2(offset.add(3), offset)), float(0.95), float(0.25))
      return belt.mul(grain.x.mul(0.6).add(0.4))
    }

    const heightAt = (uvNode: V2): F => {
      const cells = polyAt(uvNode)
      const border = cells.y.sub(cells.x)
      const dome = smoothstep(float(0), float(0.4), border).pow(0.7).mul(p.float('heave'))
      const stones = stoneAt(uvNode).mul(0.18)
      const needle = fbm01(vec3(uvNode.mul(cs.mul(60)), offset.add(9)), 3, 2.3, 0.6).sub(0.5).mul(p.float('needleIce')).mul(0.08)
      return dome.mul(0.4).add(stones).add(needle)
    }

    const stone = stoneAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    // Frost forms where the surface is exposed: on the up-facing high ground.
    const exposure = normal.z.clamp(0, 1).pow(1.5).mul(h.mul(1.5).add(0.4).clamp(0, 1))
    const frost = smoothstep(float(0.35), float(0.7), fbm01(coord3(ctx, cs.mul(4)).add(23), 4, 2.1, 0.55))
      .mul(p.float('frostAmount'))
      .mul(exposure)
    const needles = sparkle(ctx.uv, cs.mul(90), offset.add(31), float(0.08)).mul(p.float('needleIce')).mul(exposure)

    const ground = mix(p.color('soil'), p.color('stone'), stone)

    return {
      baseColor: mix(tintVariation(ground, fbm01(coord3(ctx, cs.mul(2)).add(41), 3, 2, 0.5), 0.008, 0.1, 0.16), p.color('frost'), frost.add(needles.mul(0.6)).clamp(0, 1)),
      metallic: float(0),
      // Frost is crystalline: it scatters hard, so it is rougher than the soil
      // it sits on, not glossier. Only meltwater would make it shine.
      roughness: p.float('roughness').sub(frost.mul(0.12)).sub(needles.mul(0.3)).add(stone.mul(0.04)).clamp(0.25, 1),
      ao: cavityAO(h.mul(1.8).add(0.5).clamp(0, 1), normal, 0.6),
      height: h.add(0.4).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const WEATHER = [wetMud, duneSand, glacierIce, volcanicAsh, riverbed, permafrost]
