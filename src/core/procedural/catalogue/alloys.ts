/**
 * More metals, chosen to cover the finishes the base metals file does not:
 * a true mirror, a leaf, an anodised film, a chemical patina, a heat oxide and
 * a crumpled foil.
 *
 * The thread running through all six is that the *colour* of a metal is almost
 * never what identifies it - the finish is. Chrome and stainless have nearly
 * the same reflectance; what separates them is that one is a mirror and one is
 * not. So these materials spend nearly all their effort on roughness, and
 * almost none on albedo.
 */

import { abs, float, fract, max, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  cavityAO,
  cracks,
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

const gravityWeight = (ctx: MatContext): number => (ctx.axis === 1 ? 0 : 1)

// ---------------------------------------------------------------------------

export const chrome = registerMaterial({
  id: 'chrome',
  name: 'Chrome',
  category: 'Metal',
  description: 'A true mirror. Chrome is the hardest metal to make convincing precisely because it has no texture of its own: everything you see in it belongs to the environment. What sells it is therefore the plating flaws - orange peel from the substrate, pinholes, and the microscopic haze that keeps a real mirror from being perfect.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.96, 0.97, 0.99], group: 'Colour' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.02, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'orangePeel', label: 'Orange Peel', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Plating', description: 'The substrate showing through the plate. Nothing else says "chromed part" as clearly.' },
    { key: 'peelScale', label: 'Peel Scale', type: 'float', default: 90, min: 5, max: 500, step: 1, group: 'Plating' },
    { key: 'pinholes', label: 'Pinholes', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Plating', description: 'Tiny plating voids that go dull and eventually rust.' },
    { key: 'haze', label: 'Polish Haze', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Plating' },
    { key: 'pitting', label: 'Pitting', type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Where the plate has failed and the steel underneath has bloomed.' },
    { key: 'pitColor', label: 'Pit Colour', type: 'color', default: [0.34, 0.2, 0.12], group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const peelAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(p.float('peelScale')), offset), 3, 2.2, 0.55).sub(0.5).mul(p.float('orangePeel'))

    // Chrome carries almost no height, so the normal is doing all the work.
    const normal = normalFromHeightFn(peelAt, ctx.uv, ctx.texel, p.float('orangePeel').mul(0.02).add(0.002))

    const pinhole = smoothstep(float(0.06), float(0), worley(coord3(ctx, 240).add(3), 1)).mul(p.float('pinholes'))
    const haze = fbm01(coord3(ctx, 12).add(9), 3, 2.1, 0.55).sub(0.5).mul(p.float('haze'))
    const pit = smoothstep(float(0.6), float(0.85), fbm01(warp(coord3(ctx, 7).add(19), 0.6, 1.3), 4, 2.1, 0.55))
      .mul(p.float('pitting'))

    return {
      baseColor: mix(p.color('tint'), p.color('pitColor'), pit),
      metallic: pit.mul(0.7).oneMinus(),
      // Every term here is tiny. A mirror is defined by how *little* its
      // roughness varies, not by how smooth it is on average.
      roughness: p
        .float('roughness')
        .add(haze.mul(0.05))
        .add(pinhole.mul(0.35))
        .add(pit.mul(0.55))
        .clamp(0.004, 1),
      normal,
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const goldLeaf = registerMaterial({
  id: 'gold-leaf',
  name: 'Gold Leaf',
  category: 'Metal',
  description: 'Beaten gold applied in overlapping squares. Leaf is a few atoms thick, so it takes the shape of whatever is underneath and tears where the bole was uneven - the visible seams between sheets and the small bare patches are the entire craft, and a smooth gold surface is a different material altogether.',
  params: [
    { key: 'gold', label: 'Gold', type: 'color', default: [1, 0.76, 0.33], group: 'Colour' },
    { key: 'bole', label: 'Bole', type: 'color', default: [0.35, 0.11, 0.08], group: 'Colour', description: 'The red clay ground under the leaf. It shows through every tear, and it is why gilding looks warm.' },
    { key: 'sheets', label: 'Sheet Size', type: 'float', default: 5, min: 0.5, max: 40, step: 0.1, group: 'Leaf' },
    { key: 'seams', label: 'Seam Visibility', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Leaf' },
    { key: 'tears', label: 'Tears', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Leaf' },
    { key: 'crinkle', label: 'Crinkle', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Leaf', description: 'The fine wrinkling of beaten metal settling onto its ground.' },
    { key: 'burnish', label: 'Burnishing', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Agate-burnished areas go to a mirror; unburnished leaf stays satin.' },
    { key: 'tarnish', label: 'Tarnish', type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const s = p.float('sheets')

    const sheetAt = (uvNode: V2) => {
      // Square sheets, laid with a small random rotation and overlap: a grid
      // whose cell is jittered rather than a Voronoi, because leaf is cut
      // square and stays square.
      const q = uvNode.mul(s)
      const cell = vec2(q.x.floor(), q.y.floor())
      const jitter = hash21(cell.add(vec2(offset, offset))).sub(0.5).mul(0.12)
      const local = fract(q).add(jitter)
      return { cell, local }
    }

    const seamAt = (uvNode: V2): F => {
      const sh = sheetAt(uvNode)
      const d = abs(sh.local.sub(0.5)).mul(2)
      return smoothstep(float(0.86), float(1), max(d.x, d.y)).mul(p.float('seams'))
    }

    const crinkleAt = (uvNode: V2): F =>
      ridged(vec3(uvNode.mul(s.mul(26)), offset.add(3)), float(3), float(0.5)).mul(p.float('crinkle')).mul(0.05)

    const heightAt = (uvNode: V2): F => seamAt(uvNode).mul(0.06).add(crinkleAt(uvNode))

    const sh = sheetAt(ctx.uv)
    const seam = seamAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.6))
    const h = heightAt(ctx.uv)

    const tear = smoothstep(float(0.68), float(0.86), fbm01(coord3(ctx, s.mul(4)).add(23), 4, 2.2, 0.55))
      .mul(p.float('tears'))
      .add(seam.mul(p.float('tears')).mul(0.4))
      .clamp(0, 1)

    const id = hash21(sh.cell.add(vec2(offset.add(7), offset)))
    const burnish = smoothstep(float(0.35), float(0.75), fbm01(coord3(ctx, s.mul(0.8)).add(41), 3, 2, 0.5))
      .mul(p.float('burnish'))
    const tarnish = smoothstep(float(0.6), float(0.85), fbm01(coord3(ctx, s.mul(2.4)).add(53), 4, 2.1, 0.55))
      .mul(p.float('tarnish'))

    const leaf = tintVariation(p.color('gold'), id, 0.006, 0.1, 0.08).mul(mix(float(1), float(0.7), tarnish))

    return {
      baseColor: mix(leaf, p.color('bole'), tear),
      // The bole is clay: where the leaf has torn away, the surface stops
      // being metal entirely.
      metallic: tear.oneMinus(),
      roughness: mix(mix(float(0.34), float(0.06), burnish), float(0.85), tear)
        .add(seam.mul(0.12))
        .add(tarnish.mul(0.25))
        .add(microVariation(ctx.uv, s.mul(20), offset).sub(0.5).mul(0.06))
        .clamp(0.02, 1),
      ao: cavityAO(h.mul(6).add(0.75).clamp(0, 1), normal, 0.3),
      height: h.mul(3).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const anodisedAluminium = registerMaterial({
  id: 'anodised-aluminium',
  name: 'Anodised Aluminium',
  category: 'Metal',
  description: 'Extruded aluminium with a dyed oxide film. The anodic layer is a dielectric over metal, so the colour sits *above* the reflection rather than in it - which is why anodised parts look saturated and slightly soft where a painted part would look flat.',
  params: [
    { key: 'dye', label: 'Dye', type: 'color', default: [0.12, 0.32, 0.55], group: 'Colour' },
    { key: 'metalTint', label: 'Metal', type: 'color', default: [0.91, 0.91, 0.92], group: 'Colour' },
    { key: 'filmStrength', label: 'Film Density', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Anodising', description: 'How heavily dyed the oxide is. Near zero gives clear anodising, which is just satin aluminium.' },
    { key: 'unevenness', label: 'Bath Unevenness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Anodising', description: 'Dye uptake varies across a part; a perfectly even colour is a paint job.' },
    { key: 'extrusionLines', label: 'Extrusion Lines', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Die lines running along the direction of extrusion. Fine, straight and absolutely parallel.' },
    { key: 'beadBlast', label: 'Bead Blast', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The uniform satin finish most anodised parts are blasted to before dyeing.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'wear', label: 'Edge Wear', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'The oxide is thin and hard; where it is worn through, bright metal shows.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const blastAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(420), offset), 3, 2.4, 0.6).sub(0.5).mul(p.float('beadBlast'))

    const linesAt = (uvNode: V2): F =>
      scratches(uvNode.add(vec2(offset, offset)), float(0), float(400), float(120)).mul(p.float('extrusionLines'))

    const heightAt = (uvNode: V2): F => blastAt(uvNode).mul(0.02).sub(linesAt(uvNode).mul(0.01))

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.35))
    const blast = blastAt(ctx.uv)
    const lines = linesAt(ctx.uv)

    const uptake = mix(float(1), fbm01(coord3(ctx, 4).add(13), 4, 2.1, 0.55).add(0.5), p.float('unevenness')).clamp(0, 1.4)
    const film = p.float('filmStrength').mul(uptake).clamp(0, 1)
    const wear = smoothstep(float(0.66), float(0.86), fbm01(coord3(ctx, 9).add(29), 4, 2.2, 0.55)).mul(p.float('wear'))
    const filmLeft = film.mul(wear.oneMinus())

    return {
      // The dye is *in* the film, so it tints the metal rather than replacing
      // it: multiplying keeps the metallic reflection coloured.
      baseColor: mix(p.color('metalTint'), p.color('dye').mul(p.color('metalTint')).mul(1.6), filmLeft),
      metallic: float(1),
      roughness: p
        .float('roughness')
        .add(blast.mul(0.35))
        .add(lines.mul(0.18))
        .sub(wear.mul(0.12))
        .clamp(0.03, 1),
      normal,
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const bronzePatina = registerMaterial({
  id: 'bronze-patina',
  name: 'Patinated Bronze',
  category: 'Metal',
  description: 'Cast bronze with a chemical patina. Unlike rust, patina protects: it forms a stable crust that stays where it is, so the exposed metal survives only on the high points where hands and weather rub it back - the classic bright-on-raised, green-in-recess reading of every public statue.',
  params: [
    { key: 'bronze', label: 'Bronze', type: 'color', default: [0.72, 0.45, 0.2], group: 'Colour' },
    { key: 'patinaDeep', label: 'Patina Deep', type: 'color', default: [0.09, 0.24, 0.2], group: 'Colour' },
    { key: 'patinaMid', label: 'Patina Mid', type: 'color', default: [0.24, 0.47, 0.38], group: 'Colour' },
    { key: 'patinaLight', label: 'Verdigris', type: 'color', default: [0.42, 0.66, 0.5], group: 'Colour' },
    { key: 'coverage', label: 'Coverage', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Patina' },
    { key: 'scale', label: 'Patina Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.1, group: 'Patina' },
    { key: 'crust', label: 'Crust Thickness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Patina' },
    { key: 'runs', label: 'Weather Runs', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Patina', description: 'Copper salts washing down the casting. Vertical faces only.' },
    { key: 'handling', label: 'Handling Polish', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Where the patina has been rubbed back to bare metal.' },
    { key: 'porosity', label: 'Casting Porosity', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const patinaAt = (uvNode: V2): F => {
      const warped = warp(vec3(uvNode.mul(scale), offset), 0.55, 0.8)
      const field = fbm01(warped, 5, 2.1, 0.55)
      const t = p.float('coverage').oneMinus()
      return smoothstep(t.sub(0.12), t.add(0.12), field)
    }

    const heightAt = (uvNode: V2): F => {
      const patina = patinaAt(uvNode)
      // Patina builds up, so it is additive - the exact opposite of rust,
      // which eats into the metal first.
      const crust = ridged(vec3(uvNode.mul(scale.mul(4)), offset.add(3)), float(4), float(0.55))
        .mul(p.float('crust'))
        .mul(patina)
      const pores = smoothstep(float(0.18), float(0), worley(vec3(uvNode.mul(scale.mul(20)), offset.add(9)), 1))
        .mul(p.float('porosity'))
        .mul(0.3)
      const flake = cracks(uvNode, scale.mul(6), float(0.05), offset.add(17)).mul(patina).mul(0.15)
      return crust.mul(0.4).sub(pores).sub(flake)
    }

    const patina = patinaAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.2))
    const h = heightAt(ctx.uv)

    // Handling polishes the high ground: read it off the height field itself.
    const polish = smoothstep(float(0.02), float(0.14), h).mul(p.float('handling'))
    const exposed = patina.oneMinus().add(polish.mul(patina)).clamp(0, 1)

    const tone = fbm01(coord3(ctx, scale.mul(2.5)).add(23), 4, 2, 0.5)
    const patinaColour = tintVariation(
      gradient3(tone, p.color('patinaDeep'), p.color('patinaMid'), p.color('patinaLight')),
      fbm01(coord3(ctx, scale.mul(0.7)).add(41), 3, 2, 0.5),
      0.02,
      0.22,
      0.24,
    )

    const gravity = gravityWeight(ctx)
    const runs =
      gravity === 0
        ? float(0)
        : smoothstep(float(0.5), float(0.8), fbm01(vec3(ctx.uv.mul(vec2(scale.mul(1.6), scale.mul(0.2))), offset.add(61)), 4, 2.1, 0.55))
            .mul(p.float('runs'))
            .mul(patina.mul(0.5).add(0.5))

    const bronze = p.color('bronze').mul(mix(float(0.9), float(1.08), microVariation(ctx.uv, scale.mul(9), offset)))

    return {
      baseColor: mix(mix(bronze, patinaColour, patina), patinaColour.mul(1.15), runs.mul(0.5)),
      metallic: exposed.mul(runs.mul(0.3).oneMinus()),
      roughness: mix(float(0.92), float(0.24), exposed).add(runs.mul(0.08)).clamp(0.05, 1),
      ao: cavityAO(h.mul(2).add(0.6).clamp(0, 1), normal, 0.6),
      height: h.mul(1.4).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const bluedSteel = registerMaterial({
  id: 'blued-steel',
  name: 'Blued Steel',
  category: 'Metal',
  description: 'Heat-tinted steel. The oxide film thickens with temperature and each thickness reflects a different colour - straw, then bronze, then purple, then blue - so the colour band is a direct readout of a temperature gradient. Driving hue from one scalar field is not a stylisation here; it is the physics.',
  params: [
    { key: 'steel', label: 'Steel', type: 'color', default: [0.52, 0.53, 0.55], group: 'Colour' },
    { key: 'straw', label: 'Straw', type: 'color', default: [0.66, 0.5, 0.2], group: 'Temper' },
    { key: 'purple', label: 'Purple', type: 'color', default: [0.34, 0.2, 0.34], group: 'Temper' },
    { key: 'blue', label: 'Blue', type: 'color', default: [0.14, 0.2, 0.42], group: 'Temper' },
    { key: 'heat', label: 'Peak Heat', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Temper', description: 'How far up the temper scale this part went.' },
    { key: 'gradient', label: 'Heat Gradient', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Temper', description: 'How localised the heat was. Low values give an evenly blued part; high values give the banding of a torch-heated one.' },
    { key: 'gradientScale', label: 'Gradient Scale', type: 'float', default: 2.2, min: 0.1, max: 20, step: 0.05, group: 'Temper' },
    { key: 'polish', label: 'Polish', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Bluing is applied over a polished surface, and it takes on whatever finish was underneath.' },
    { key: 'grind', label: 'Grind Marks', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'wear', label: 'Wear', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'The film is microns thick: handling takes it straight back to white steel.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const grindAt = (uvNode: V2): F =>
      scratches(uvNode.add(vec2(offset, offset)), float(0.2), float(160), float(90)).mul(p.float('grind'))

    const normal = normalFromHeightFn((uvNode) => grindAt(uvNode).mul(-0.02), ctx.uv, ctx.texel, float(0.4))

    // The temperature field: broad, smooth, and biased by the peak setting.
    const temperature = mix(
      p.float('heat'),
      fbm01(coord3(ctx, p.float('gradientScale')).add(13), 3, 2, 0.5).mul(p.float('heat').mul(1.6)),
      p.float('gradient'),
    ).clamp(0, 1)

    const wear = smoothstep(float(0.62), float(0.85), fbm01(coord3(ctx, 8).add(29), 4, 2.2, 0.55)).mul(p.float('wear'))
    const filmLeft = wear.oneMinus()

    // Straw to purple to blue, in that order, exactly as a real temper runs.
    const temperColour = gradient3(temperature, p.color('straw'), p.color('purple'), p.color('blue'))
    const colour = mix(p.color('steel'), temperColour, filmLeft.mul(smoothstep(float(0.02), float(0.2), temperature)))

    return {
      baseColor: tintVariation(colour, fbm01(coord3(ctx, 5).add(41), 3, 2, 0.5), 0.012, 0.14, 0.1),
      metallic: float(1),
      roughness: mix(float(0.4), float(0.06), p.float('polish'))
        .add(grindAt(ctx.uv).mul(0.3))
        .add(sparkle(ctx.uv, float(300), offset.add(3), float(0.05)).mul(0.06))
        .sub(wear.mul(0.05))
        .clamp(0.02, 1),
      normal,
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const crumpledFoil = registerMaterial({
  id: 'crumpled-foil',
  name: 'Crumpled Foil',
  category: 'Metal',
  description: 'Kitchen foil that has been screwed up and flattened again. Crumpling is a network of straight creases meeting at points, not a smooth wobble - so the height field is built from Voronoi *borders*, whose sharp ridges is exactly what a fold is, and the facets between them stay flat.',
  params: [
    { key: 'tint', label: 'Foil', type: 'color', default: [0.9, 0.91, 0.92], group: 'Colour' },
    { key: 'scale', label: 'Crumple Scale', type: 'float', default: 16, min: 1, max: 100, step: 0.5, group: 'Creases' },
    { key: 'sharpness', label: 'Crease Sharpness', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Creases' },
    { key: 'depth', label: 'Crease Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Creases' },
    { key: 'flatten', label: 'Flattening', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Creases', description: 'Pressing the sheet back out. It never recovers, but the facets do go flat.' },
    { key: 'secondPass', label: 'Second Crumple', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Creases', description: 'A finer crease network over the coarse one. Foil crumpled once looks like a shader; twice looks like foil.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.2, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'dullSide', label: 'Dull Side', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Foil has a bright rolled face and a matt one. This mixes towards the matt.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const creaseAt = (uvNode: V2, s: F, sharp: F): F => {
      const cells = voronoi2(uvNode.mul(s).add(vec2(offset, offset)), float(0.95))
      const border = voronoiBorder(cells)
      // A facet is flat and a crease is a line: the ridge comes from the
      // border distance, not from the cell distance.
      const ridge = smoothstep(float(0.3), float(0), border).pow(mix(float(1), float(3), sharp))
      const facet = voronoiCellValue(cells).sub(0.5).mul(0.35)
      return ridge.mul(0.6).add(facet)
    }

    const heightAt = (uvNode: V2): F => {
      const coarse = creaseAt(uvNode, scale, p.float('sharpness'))
      const fine = creaseAt(uvNode.add(vec2(3.7, 1.3)), scale.mul(2.8), p.float('sharpness'))
      const combined = coarse.add(fine.mul(p.float('secondPass')).mul(0.45))
      return combined.mul(p.float('depth')).mul(mix(float(1), float(0.45), p.float('flatten')))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2).add(0.2))
    const h = heightAt(ctx.uv)

    // A crease work-hardens and scuffs, so the fold lines are duller than the
    // facets they separate - the reverse of the usual edge-wear rule.
    const creaseBand = smoothstep(float(0.8), float(0.3), normal.z)
    const dull = fbm01(coord3(ctx, scale.mul(3)).add(19), 3, 2.2, 0.55).mul(p.float('dullSide'))

    return {
      baseColor: p.color('tint').mul(mix(float(1), float(0.9), creaseBand.mul(0.5))),
      metallic: float(1),
      roughness: p
        .float('roughness')
        .add(creaseBand.mul(0.28))
        .add(dull.mul(0.35))
        .add(microVariation(ctx.uv, scale.mul(14), offset).sub(0.5).mul(0.08))
        .clamp(0.02, 1),
      ao: cavityAO(h.mul(1.5).add(0.5).clamp(0, 1), normal, 0.45),
      height: h.mul(0.8).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const meteoriteIron = registerMaterial({
  id: 'meteorite-iron',
  name: 'Meteorite Iron',
  category: 'Metal',
  description: 'An etched iron meteorite showing its Widmanstätten pattern: interlocking crystal bands that could only form by cooling over millions of years. The bands run in a few fixed directions, so a set of rotated stripe fields is not an approximation of the structure - it is the structure.',
  params: [
    { key: 'kamacite', label: 'Kamacite', type: 'color', default: [0.58, 0.57, 0.55], group: 'Colour' },
    { key: 'taenite', label: 'Taenite', type: 'color', default: [0.82, 0.82, 0.83], group: 'Colour' },
    { key: 'etchTone', label: 'Etch Shadow', type: 'color', default: [0.2, 0.19, 0.18], group: 'Colour' },
    { key: 'scale', label: 'Band Scale', type: 'float', default: 14, min: 1, max: 80, step: 0.5, group: 'Pattern' },
    { key: 'bandWidth', label: 'Band Width', type: 'float', default: 0.35, min: 0.05, max: 0.9, step: 0.01, group: 'Pattern' },
    { key: 'directions', label: 'Directionality', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'How cleanly the bands hold their three directions. Lower values give a fine octahedrite.' },
    { key: 'etchDepth', label: 'Etch Depth', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Acid attacks the two alloys at different rates, which is the only reason the pattern is visible at all.' },
    { key: 'inclusions', label: 'Inclusions', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Dark troilite nodules scattered through the iron.' },
    { key: 'polish', label: 'Polish', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const bandsAt = (uvNode: V2): F => {
      const q = uvNode.mul(scale).add(vec2(offset, offset))
      // Three lattice directions, as an octahedrite actually has.
      const w = p.float('bandWidth')
      const a = smoothstep(w, w.mul(0.4), abs(fract(q.x.mul(0.5).add(q.y.mul(0.866))).sub(0.5)))
      const b = smoothstep(w, w.mul(0.4), abs(fract(q.x.mul(0.5).sub(q.y.mul(0.866))).sub(0.5)))
      const c = smoothstep(w, w.mul(0.4), abs(fract(q.x).sub(0.5)))
      const lattice = max(a, max(b, c))
      // Blending towards noise loosens the crystal without losing the axes.
      const noisy = fbm01(vec3(q.mul(0.6), offset.add(3)), 4, 2.1, 0.55)
      return mix(noisy, lattice, p.float('directions'))
    }

    const inclusionAt = (uvNode: V2): F =>
      smoothstep(float(0.13), float(0.02), worley(vec3(uvNode.mul(scale.mul(0.5)), offset.add(9)), 1))
        .mul(p.float('inclusions'))

    const heightAt = (uvNode: V2): F =>
      bandsAt(uvNode).mul(p.float('etchDepth')).mul(0.1).sub(inclusionAt(uvNode).mul(0.2))

    const bands = bandsAt(ctx.uv)
    const inclusion = inclusionAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1))
    const h = heightAt(ctx.uv)

    const alloy = mix(p.color('kamacite'), p.color('taenite'), bands)
    const etched = mix(alloy, p.color('etchTone'), bands.oneMinus().mul(p.float('etchDepth')).mul(0.35))

    return {
      baseColor: mix(etched, vec3(0.06, 0.055, 0.05), inclusion),
      // Troilite is a sulphide, not a metal: the inclusions break the metallic
      // field, and that break is what makes them read as inclusions.
      metallic: inclusion.oneMinus(),
      roughness: mix(float(0.4), float(0.1), p.float('polish'))
        .add(bands.oneMinus().mul(p.float('etchDepth')).mul(0.3))
        .add(inclusion.mul(0.5))
        .clamp(0.03, 1),
      ao: cavityAO(h.mul(5).add(0.7).clamp(0, 1), normal, 0.4),
      height: h.mul(3).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const ALLOYS = [
  chrome,
  goldLeaf,
  anodisedAluminium,
  bronzePatina,
  bluedSteel,
  crumpledFoil,
  meteoriteIron,
]
