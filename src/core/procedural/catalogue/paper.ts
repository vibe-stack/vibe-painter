/**
 * Paper, card and cork.
 *
 * Paper is the hardest easy material: it is nearly flat, nearly white and
 * nearly matt, so there is very little to hide behind. Everything that makes
 * it convincing is at the fibre scale - a felted mat of fibres that scatters
 * light sideways, takes ink unevenly and fluffs at every torn edge.
 *
 * The practical rule for all of these is: keep the height field tiny and the
 * normal busy. Paper that is modelled with deep relief immediately reads as
 * leather or plaster instead.
 */

import { abs, float, fract, max, min, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  fbm01,
  hash21,
  normalFromHeightFn,
  ridged,
  stripes,
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

/** The felted fibre mat every paper shares, as a fine height field. */
function fibreAt(uvNode: V2, scale: F, offset: F): F {
  // Two crossed stretched fields: paper fibres are laid down with a slight
  // machine direction bias rather than being isotropic.
  const a = fbm01(vec3(uvNode.mul(vec2(scale, scale.mul(0.45))), offset), 3, 2.4, 0.6)
  const b = fbm01(vec3(uvNode.mul(vec2(scale.mul(0.5), scale.mul(1.3))), offset.add(7)), 3, 2.3, 0.55)
  return a.mul(0.6).add(b.mul(0.4))
}

// ---------------------------------------------------------------------------

export const cardboard = registerMaterial({
  id: 'cardboard',
  name: 'Corrugated Cardboard',
  category: 'Paper',
  description: 'Kraft liner over a fluted core. The flutes are invisible until the board is damp or crushed, and then they are the only thing you see - so the flute is modelled as a shallow ripple that the damage parameter brings forward, which is exactly how the real material behaves.',
  params: [
    { key: 'kraft', label: 'Kraft', type: 'color', default: [0.62, 0.47, 0.31], group: 'Colour' },
    { key: 'coreColor', label: 'Exposed Core', type: 'color', default: [0.72, 0.6, 0.42], group: 'Colour' },
    { key: 'stain', label: 'Stain', type: 'color', default: [0.4, 0.3, 0.2], group: 'Colour' },
    { key: 'flutes', label: 'Flute Density', type: 'float', default: 28, min: 2, max: 160, step: 0.5, group: 'Board' },
    { key: 'fluteShow', label: 'Flute Visibility', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Board', description: 'How far the corrugation telegraphs through the liner. Rises with damp and with age.' },
    { key: 'fibreScale', label: 'Fibre Scale', type: 'float', default: 200, min: 20, max: 900, step: 5, group: 'Surface' },
    { key: 'scuffs', label: 'Scuffs', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Where the liner has been rubbed and the paler core fibres show.' },
    { key: 'creases', label: 'Creases', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'staining', label: 'Staining', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const fluteAt = (uvNode: V2): F =>
      sin(uvNode.y.mul(p.float('flutes')).mul(6.2832)).mul(0.5).add(0.5).mul(p.float('fluteShow'))

    const creaseAt = (uvNode: V2): F =>
      ridged(vec3(uvNode.mul(4), offset.add(13)), float(3), float(0.5)).mul(p.float('creases'))

    const heightAt = (uvNode: V2): F =>
      fluteAt(uvNode).mul(0.1)
        .add(fibreAt(uvNode, p.float('fibreScale'), offset).sub(0.5).mul(0.04))
        .sub(creaseAt(uvNode).mul(0.12))

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.8))
    const h = heightAt(ctx.uv)

    const scuff = smoothstep(float(0.5), float(0.8), fbm01(coord3(ctx, 7).add(23), 4, 2.2, 0.55))
      .mul(p.float('scuffs'))
    const stain = smoothstep(float(0.55), float(0.85), fbm01(warp(coord3(ctx, 3.5).add(41), 0.5, 1.2), 4, 2.1, 0.55))
      .mul(p.float('staining'))
    const fibre = fibreAt(ctx.uv, p.float('fibreScale'), offset)

    return {
      baseColor: mix(
        mix(p.color('kraft'), p.color('coreColor'), scuff.mul(0.8)),
        p.color('stain'),
        stain.mul(0.7),
      ).mul(mix(float(0.92), float(1.06), fibre)),
      metallic: float(0),
      // Paper is matt but not uniformly so: a calendered liner is smoother
      // than the fluffed fibres a scuff exposes.
      roughness: float(0.86).add(scuff.mul(0.08)).add(fibre.sub(0.5).mul(0.1)).sub(stain.mul(0.04)).clamp(0.4, 1),
      ao: cavityAO(h.mul(5).add(0.65).clamp(0, 1), normal, 0.45),
      height: h.mul(3).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const kraftPaper = registerMaterial({
  id: 'kraft-paper',
  name: 'Kraft Paper',
  category: 'Paper',
  description: 'Unbleached wrapping paper: a coarse fibre mat with visible wood shive and the faint laid lines of the machine wire. It is the plainest material in the catalogue, which makes the fibre detail the entire difference between paper and a beige rectangle.',
  params: [
    { key: 'paper', label: 'Paper', type: 'color', default: [0.68, 0.55, 0.38], group: 'Colour' },
    { key: 'shiveColor', label: 'Shive', type: 'color', default: [0.34, 0.24, 0.14], group: 'Colour', description: 'Unpulped wood fragments. Every sheet of kraft has them, and they are what says "unbleached".' },
    { key: 'fibreScale', label: 'Fibre Scale', type: 'float', default: 260, min: 20, max: 1200, step: 5, group: 'Surface' },
    { key: 'shive', label: 'Shive Amount', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'laidLines', label: 'Laid Lines', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The wire mark left by the paper machine. Very fine, perfectly parallel, and easy to miss - which is why leaving it out is noticeable.' },
    { key: 'crinkle', label: 'Crinkle', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const fs = p.float('fibreScale')

    const laidAt = (uvNode: V2): F =>
      stripes(uvNode.x.mul(fs.mul(0.12)), float(0.5), float(0.25)).mul(p.float('laidLines'))

    const crinkleAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(6), offset.add(9)), 3, 2.1, 0.55).sub(0.5).mul(p.float('crinkle'))

    const heightAt = (uvNode: V2): F =>
      fibreAt(uvNode, fs, offset).sub(0.5).mul(0.05)
        .add(laidAt(uvNode).mul(0.012))
        .add(crinkleAt(uvNode).mul(0.05))

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.7))
    // The fibre normal is separate and much finer, reoriented on top so it
    // survives inside a crinkle.
    const fibreNormal = normalFromHeightFn(
      (uvNode) => fibreAt(uvNode, fs.mul(2.4), offset.add(3)),
      ctx.uv,
      ctx.texel,
      float(0.1),
    )
    const h = heightAt(ctx.uv)

    // Shive: individual dark slivers, so a stretched cell field rather than noise.
    const shiveCells = voronoi2(ctx.uv.mul(vec2(fs.mul(0.25), fs.mul(0.06))).add(vec2(offset, offset)), float(0.95))
    const shive = smoothstep(float(0.88), float(0.96), voronoiCellValue(shiveCells))
      .mul(smoothstep(float(0.18), float(0.02), shiveCells.x))
      .mul(p.float('shive'))

    const fibre = fibreAt(ctx.uv, fs, offset)

    return {
      baseColor: mix(
        tintVariation(p.color('paper'), fibre, 0.008, 0.12, 0.14).mul(mix(float(0.9), float(1.08), fibre)),
        p.color('shiveColor'),
        shive,
      ),
      metallic: float(0),
      roughness: p.float('roughness').add(fibre.sub(0.5).mul(0.12)).add(shive.mul(0.06)).clamp(0.5, 1),
      ao: cavityAO(h.mul(8).add(0.8).clamp(0, 1), normal, 0.3),
      height: h.mul(4).add(0.5).clamp(0, 1),
      normal: blendDetailNormal(normal, fibreNormal, 0.8),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const crumpledPaper = registerMaterial({
  id: 'crumpled-paper',
  name: 'Crumpled Paper',
  category: 'Paper',
  description: 'A sheet screwed up and reopened. Like foil, the creases are a network of straight folds - but paper fibres tear along the fold, so the crease lines are also the lightest part of the sheet, where the coating has broken and the raw fibre shows.',
  params: [
    { key: 'paper', label: 'Paper', type: 'color', default: [0.88, 0.87, 0.84], group: 'Colour' },
    { key: 'creaseColor', label: 'Crease', type: 'color', default: [0.95, 0.94, 0.92], group: 'Colour' },
    { key: 'smudge', label: 'Smudge', type: 'color', default: [0.6, 0.58, 0.55], group: 'Colour' },
    { key: 'scale', label: 'Crumple Scale', type: 'float', default: 11, min: 1, max: 80, step: 0.5, group: 'Creases' },
    { key: 'depth', label: 'Crease Depth', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Creases' },
    { key: 'sharpness', label: 'Sharpness', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Creases' },
    { key: 'secondPass', label: 'Second Crumple', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Creases' },
    { key: 'flatten', label: 'Flattening', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Creases' },
    { key: 'fibreBreak', label: 'Fibre Break', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'How brightly the torn fibres along each fold catch the light.' },
    { key: 'grubbiness', label: 'Grubbiness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const creaseAt = (uvNode: V2, s: F): F => {
      const cells = voronoi2(uvNode.mul(s).add(vec2(offset, offset)), float(0.95))
      const ridge = smoothstep(float(0.32), float(0), voronoiBorder(cells))
        .pow(mix(float(1), float(3), p.float('sharpness')))
      const facet = voronoiCellValue(cells).sub(0.5).mul(0.4)
      return ridge.mul(0.55).add(facet)
    }

    const heightAt = (uvNode: V2): F => {
      const coarse = creaseAt(uvNode, scale)
      const fine = creaseAt(uvNode.add(vec2(5.1, 2.7)), scale.mul(2.6))
      return coarse
        .add(fine.mul(p.float('secondPass')).mul(0.4))
        .mul(p.float('depth'))
        .mul(mix(float(1), float(0.5), p.float('flatten')))
        .add(fibreAt(uvNode, float(320), offset.add(9)).sub(0.5).mul(0.02))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.8).add(0.15))
    const h = heightAt(ctx.uv)

    // The fold band, read off the normal: the steeper the surface, the more
    // likely it is a crease rather than a facet.
    const foldBand = smoothstep(float(0.85), float(0.35), normal.z)
    const grub = smoothstep(float(0.5), float(0.82), fbm01(coord3(ctx, 5).add(29), 4, 2.1, 0.55))
      .mul(p.float('grubbiness'))
      // Dirt is picked up by the raised folds, not the sheltered facets.
      .mul(foldBand.mul(0.6).add(0.4))

    const broken = foldBand.mul(p.float('fibreBreak'))

    return {
      baseColor: mix(mix(p.color('paper'), p.color('creaseColor'), broken), p.color('smudge'), grub.mul(0.6)),
      metallic: float(0),
      // Torn fibre scatters more than the calendered face, so the fold lines
      // are the roughest part of the sheet as well as the palest.
      roughness: float(0.8).add(broken.mul(0.15)).add(grub.mul(0.05)).clamp(0.45, 1),
      ao: cavityAO(h.mul(2).add(0.5).clamp(0, 1), normal, 0.55),
      height: h.add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const newsprint = registerMaterial({
  id: 'newsprint',
  name: 'Newsprint',
  category: 'Paper',
  description: 'Yellowed newspaper with halftone ink. The columns are blocks of text at a scale too fine to read, which is exactly right: at any sensible viewing distance printed text is a grey texture with hard edges, and drawing it as anything else is wasted.',
  params: [
    { key: 'paper', label: 'Paper', type: 'color', default: [0.78, 0.74, 0.62], group: 'Colour' },
    { key: 'ink', label: 'Ink', type: 'color', default: [0.11, 0.1, 0.1], group: 'Colour' },
    { key: 'yellowing', label: 'Yellowing', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Lignin browning. It goes from the edges inwards, which is why old newspaper is darkest at its margins.' },
    { key: 'columns', label: 'Columns', type: 'float', default: 5, min: 1, max: 20, step: 1, group: 'Layout' },
    { key: 'lineHeight', label: 'Line Density', type: 'float', default: 90, min: 10, max: 400, step: 1, group: 'Layout' },
    { key: 'coverage', label: 'Ink Coverage', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'headlines', label: 'Headlines', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Bands of much heavier type breaking up the body text.' },
    { key: 'halftone', label: 'Halftone', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Print', description: 'Photograph blocks, printed as a dot screen.' },
    { key: 'misregister', label: 'Misregister', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Print', description: 'The press ran slightly off: the ink is not quite where the plate said.' },
    { key: 'foxing', label: 'Foxing', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Age', description: 'The rust-coloured spots that bloom on old paper.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const uv = ctx.uv.add(
      // Misregistration: shift the whole ink layer relative to the paper.
      vec2(
        fbm01(coord3(ctx, 1.5), 2, 2, 0.5).sub(0.5).mul(p.float('misregister')).mul(0.01),
        fbm01(coord3(ctx, 1.5).add(5), 2, 2, 0.5).sub(0.5).mul(p.float('misregister')).mul(0.01),
      ),
    )

    const col = uv.x.mul(p.float('columns'))
    const gutter = smoothstep(float(0.04), float(0.09), min(fract(col), fract(col).oneMinus()))
    const colId = col.floor()

    // Lines of type: a stripe field whose per-line length is hashed, so lines
    // end at different points the way real ragged-right text does.
    const line = uv.y.mul(p.float('lineHeight'))
    const lineId = line.floor()
    const lineBand = smoothstep(float(0.55), float(0.35), abs(fract(line).sub(0.4)))
    const lineLength = hash21(vec2(lineId, colId.add(offset))).mul(0.35).add(0.65)
    const inLine = smoothstep(lineLength, lineLength.sub(0.05), fract(col))

    // Word breaks along the line.
    const words = smoothstep(float(0.25), float(0.4), fbm01(vec3(col.mul(70), lineId.mul(3), offset), 2, 2, 0.5))
    const body = lineBand.mul(inLine).mul(words).mul(gutter).mul(p.float('coverage'))

    const headline = smoothstep(float(0.72), float(0.78), hash21(vec2(lineId.mul(0.08).floor(), offset.add(3))))
      .mul(p.float('headlines'))
    const heavy = lineBand.mul(gutter).mul(headline).mul(smoothstep(float(0.9), float(0.85), fract(col)))

    // Halftone blocks: a dot screen at 45 degrees, gated to photo regions.
    const photoRegion = smoothstep(float(0.72), float(0.8), fbm01(coord3(ctx, 3).add(23), 3, 2, 0.5))
    const screen = uv.mul(220)
    const rot = vec2(screen.x.add(screen.y), screen.x.sub(screen.y)).mul(0.7071)
    const dot = smoothstep(float(0.36), float(0.26), fract(rot).sub(0.5).length())
    const halftone = dot.mul(photoRegion).mul(p.float('halftone'))

    const ink = max(body, max(heavy, halftone)).clamp(0, 1)

    const yellow = fbm01(coord3(ctx, 2).add(41), 3, 2, 0.5).mul(p.float('yellowing'))
    const paper = tintVariation(p.color('paper'), yellow, 0.03, 0.25, 0.12).mul(mix(float(1), float(0.86), yellow))
    const fox = smoothstep(float(0.78), float(0.9), fbm01(coord3(ctx, 26).add(53), 4, 2.2, 0.55)).mul(p.float('foxing'))

    const fibre = fibreAt(ctx.uv, float(300), offset)
    const normal = normalFromHeightFn(
      (uvNode) => fibreAt(uvNode, float(300), offset).sub(0.5).mul(0.03),
      ctx.uv,
      ctx.texel,
      float(0.5),
    )

    return {
      baseColor: mix(mix(paper, vec3(0.42, 0.28, 0.16), fox.mul(0.6)), p.color('ink'), ink),
      metallic: float(0),
      // Ink sits on the surface and fills the fibre: printed areas are
      // measurably smoother than bare newsprint.
      roughness: float(0.9).sub(ink.mul(0.12)).add(fibre.sub(0.5).mul(0.08)).clamp(0.5, 1),
      height: float(0.5).add(fibre.sub(0.5).mul(0.04)),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const parchment = registerMaterial({
  id: 'parchment',
  name: 'Parchment',
  category: 'Paper',
  description: 'Scraped animal skin, not paper at all. It keeps the follicle pattern of the hide, varies in thickness so it is translucent in patches, and cockles as it dries - which is why a flat parchment looks wrong however good the colour is.',
  params: [
    { key: 'pale', label: 'Parchment', type: 'color', default: [0.85, 0.78, 0.62], group: 'Colour' },
    { key: 'aged', label: 'Aged Edge', type: 'color', default: [0.55, 0.42, 0.26], group: 'Colour' },
    { key: 'stain', label: 'Stain', type: 'color', default: [0.42, 0.3, 0.16], group: 'Colour' },
    { key: 'follicles', label: 'Follicles', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Hide', description: 'The hair-root pattern left in the skin. It is the one detail that separates parchment from paper.' },
    { key: 'follicleScale', label: 'Follicle Scale', type: 'float', default: 90, min: 10, max: 500, step: 1, group: 'Hide' },
    { key: 'cockling', label: 'Cockling', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Hide', description: 'The slow buckle a drying hide takes on.' },
    { key: 'thinness', label: 'Thin Patches', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Hide', description: 'Where the scraper went too far and the skin has gone translucent.' },
    { key: 'staining', label: 'Staining', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Age' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.72, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const fs = p.float('follicleScale')

    const follicleAt = (uvNode: V2): F =>
      smoothstep(float(0.22), float(0.05), worley(vec3(uvNode.mul(fs), offset.add(3)), 1)).mul(p.float('follicles'))

    const cockleAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(vec2(3, 2.2)), offset), 4, 2.1, 0.55).sub(0.5).mul(p.float('cockling'))

    const heightAt = (uvNode: V2): F =>
      cockleAt(uvNode).mul(0.12).sub(follicleAt(uvNode).mul(0.05)).add(
        fibreAt(uvNode, fs.mul(3), offset.add(9)).sub(0.5).mul(0.02),
      )

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.9))
    const h = heightAt(ctx.uv)

    const thin = smoothstep(float(0.55), float(0.8), fbm01(coord3(ctx, 4).add(19), 4, 2.1, 0.55)).mul(p.float('thinness'))
    const age = fbm01(coord3(ctx, 2.2).add(31), 3, 2, 0.5)
    const stain = smoothstep(float(0.55), float(0.85), fbm01(warp(coord3(ctx, 6).add(43), 0.6, 1.2), 4, 2.2, 0.55))
      .mul(p.float('staining'))

    const skin = mix(p.color('pale'), p.color('aged'), age.mul(0.7))

    return {
      // Thin patches let light through, so they read *lighter*, not darker -
      // the opposite of the usual "thin means see-through means dark" instinct.
      baseColor: mix(tintVariation(skin, age, 0.015, 0.16, 0.14), p.color('stain'), stain.mul(0.6))
        .mul(mix(float(1), float(1.18), thin)),
      metallic: float(0),
      roughness: p.float('roughness').add(follicleAt(ctx.uv).mul(0.15)).sub(thin.mul(0.12)).add(stain.mul(0.06)).clamp(0.25, 1),
      ao: cavityAO(h.mul(4).add(0.7).clamp(0, 1), normal, 0.4),
      height: h.mul(3).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const cork = registerMaterial({
  id: 'cork',
  name: 'Cork',
  category: 'Paper',
  description: 'Agglomerated cork board: granules pressed together with a binder. Every granule is a separate piece with its own tone and its own tiny air cells, and the binder between them is darker and glossier - so the whole surface is a mosaic at two scales at once.',
  params: [
    { key: 'light', label: 'Granule Light', type: 'color', default: [0.72, 0.55, 0.34], group: 'Colour' },
    { key: 'dark', label: 'Granule Dark', type: 'color', default: [0.44, 0.31, 0.17], group: 'Colour' },
    { key: 'binder', label: 'Binder', type: 'color', default: [0.28, 0.19, 0.11], group: 'Colour' },
    { key: 'granules', label: 'Granule Size', type: 'float', default: 34, min: 2, max: 200, step: 0.5, group: 'Structure' },
    { key: 'variation', label: 'Tone Variation', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Structure' },
    { key: 'relief', label: 'Granule Relief', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Structure' },
    { key: 'cells', label: 'Air Cells', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Structure', description: 'The honeycomb inside each granule. Cork is 90 per cent air, and this is where it shows.' },
    { key: 'pinholes', label: 'Pin Holes', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.82, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const gs = p.float('granules')

    const granuleAt = (uvNode: V2) => voronoi2(uvNode.mul(gs).add(vec2(offset, offset)), float(0.95))

    const heightAt = (uvNode: V2): F => {
      const cells = granuleAt(uvNode)
      const body = smoothstep(float(0), float(0.14), voronoiBorder(cells)).mul(p.float('relief'))
      const level = voronoiCellValue(cells).sub(0.5).mul(0.15).mul(p.float('relief'))
      // Air cells inside each granule, at a much finer scale.
      const air = smoothstep(float(0.3), float(0), worley(vec3(uvNode.mul(gs.mul(7)), offset.add(3)), 1))
        .mul(p.float('cells'))
        .mul(0.15)
      const pin = smoothstep(float(0.1), float(0), worley(vec3(uvNode.mul(gs.mul(0.4)), offset.add(9)), 1))
        .mul(p.float('pinholes'))
        .mul(0.5)
      return body.mul(0.4).add(level).sub(air).sub(pin)
    }

    const cells = granuleAt(ctx.uv)
    const id = voronoiCellValue(cells)
    const body = smoothstep(float(0), float(0.1), voronoiBorder(cells))
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))
    const h = heightAt(ctx.uv)

    const grainTone = mix(float(0.5), id, p.float('variation'))
    const granule = tintVariation(mix(p.color('dark'), p.color('light'), grainTone), id, 0.014, 0.18, 0.22)
    const air = smoothstep(float(0.3), float(0), worley(coord3(ctx, gs.mul(7)).add(3), 1)).mul(p.float('cells'))

    return {
      baseColor: mix(p.color('binder'), granule, body).mul(mix(float(1), float(0.78), air.mul(0.6))),
      metallic: float(0),
      // The binder is a resin: it is the one glossy thing on the board.
      roughness: mix(float(0.5), p.float('roughness'), body).add(air.mul(0.06)).clamp(0.2, 1),
      ao: cavityAO(h.mul(2.5).add(0.55).clamp(0, 1), normal, 0.7),
      height: h.mul(1.6).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const PAPER = [cardboard, kraftPaper, crumpledPaper, newsprint, parchment, cork]
