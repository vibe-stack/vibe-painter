/**
 * Ground. The materials you stand on rather than the ones you build with.
 *
 * Ground is different from the other families in one specific way: it is
 * *layered*, not patterned. A gravel path is stones with fines washed between
 * them; a forest floor is litter over soil over litter again. So almost every
 * material here builds two or three separate surfaces and combines them with
 * `heightBlend` rather than a plain mask - which is what lets the lower layer
 * poke through wherever it happens to be high, the way it does outdoors.
 *
 * The second rule is that ground is never level. Every one of these carries a
 * low-frequency undulation under the detail, because a perfectly flat plane of
 * pebbles reads as wallpaper no matter how good the pebbles are.
 */

import { float, max, min, mix, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  cracks,
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

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(23.1)

export const gravel = registerMaterial({
  id: 'gravel',
  name: 'Gravel',
  category: 'Terrain',
  description:
    'Crushed aggregate with fines washed down between the stones. The stones are angular rather than rounded - crushed rock has flat faces and sharp arrises, which is the whole difference between gravel and shingle - and the fines are a separate surface blended by height, so they fill the gaps without ever coating the stones.',
  params: [
    { key: 'scale', label: 'Stone Density', type: 'float', default: 26, min: 2, max: 160, step: 0.5, group: 'Layout' },
    { key: 'sizeSpread', label: 'Size Spread', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Graded aggregate has a wide spread; a screened single-size does not.' },
    { key: 'angularity', label: 'Angularity', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Flattens the stone tops into faces. 0 is river shingle, 1 is freshly crushed.' },
    { key: 'packing', label: 'Packing', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How deeply the stones sit in the fines.' },
    { key: 'stoneA', label: 'Stone Colour A', type: 'color', default: [0.42, 0.4, 0.37], group: 'Colour' },
    { key: 'stoneB', label: 'Stone Colour B', type: 'color', default: [0.55, 0.52, 0.47], group: 'Colour' },
    { key: 'stoneC', label: 'Stone Colour C', type: 'color', default: [0.28, 0.25, 0.23], group: 'Colour' },
    { key: 'finesColor', label: 'Fines Colour', type: 'color', default: [0.3, 0.27, 0.23], group: 'Colour' },
    { key: 'variation', label: 'Stone Variation', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'damp', label: 'Damp', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Water collects in the fines first, so this darkens and glosses the low ground before the stones.' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    // Two lattices at different densities, so the aggregate is graded rather
    // than one screened size. The coarse one wins where it is present.
    const stoneAt = (uvNode: V2) => {
      const coarse = pebbles(uvNode.mul(scale).add(vec2(offset, offset)), float(0.95), float(0.42))
      const fine = pebbles(uvNode.mul(scale.mul(2.3)).add(vec2(offset.add(9), offset)), float(0.95), float(0.34))
      const pick = step(voronoiCellValue(coarse), p.float('sizeSpread').mul(0.75).add(0.25))
      const dome = mix(fine.x.mul(0.6), coarse.x, pick)
      const id = mix(fine.zw, coarse.zw, pick)
      return { dome, border: mix(fine.y, coarse.y, pick), id }
    }

    /**
     * Crushed stone has faces, not domes. Flattening the top of the falloff
     * with a `min` gives a plateau whose edge is still the cell border, which
     * is exactly what an angular fragment looks like from above.
     */
    const faceted = (dome: F): F => {
      const flat = min(dome.mul(1.45), float(1))
      return mix(dome, flat, p.float('angularity'))
    }

    const heightAt = (uvNode: V2): F => {
      const s = stoneAt(uvNode)
      const stone = faceted(s.dome)
      // The fines are their own low, lumpy surface under the stones.
      const fines = fbm01(vec3(uvNode.mul(scale.mul(1.6)), offset.add(3)), 4, 2.1, 0.55).mul(0.22)
      const undulation = fbm01(vec3(uvNode.mul(2.2), offset.add(17)), 3, 2, 0.5).sub(0.5).mul(0.5)
      const bed = mix(float(0.55), float(0.12), p.float('packing'))
      return stone.mul(bed).add(fines.mul(stone.oneMinus())).add(undulation).mul(p.float('relief'))
    }

    const s = stoneAt(ctx.uv)
    const stoneMask = faceted(s.dome)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(1.6))
    const h = heightAt(ctx.uv)

    // Per-stone grit riding on the faceted normal, so each face has its own tooth.
    const grit = fbm01(vec3(ctx.uv.mul(scale.mul(26)), offset.add(31)), 3, 2.4, 0.55).sub(0.5)
    const detailNormal = vec3(grit.mul(0.6), grit.mul(0.6), float(1))

    const tone = mix(float(0.5), hash21(s.id.add(vec2(offset, offset.add(5)))), p.float('variation'))
    const stoneColour = tintVariation(
      gradient3(tone, p.color('stoneC'), p.color('stoneA'), p.color('stoneB')),
      hash21(s.id.add(vec2(offset.add(41), offset.add(7)))),
      0.014,
      0.24,
      0.24,
    )

    const finesColour = p
      .color('finesColor')
      .mul(mix(float(0.8), float(1.12), fbm01(vec3(ctx.uv.mul(scale.mul(3)), offset.add(11)), 3, 2, 0.5)))

    // Height-blended, not lerped: a stone that stands proud is never dusted over.
    const surface = heightBlend(stoneMask, s.dome, float(0.2), 0.12)
    const colour = mix(finesColour, stoneColour, surface)

    const h01 = h.div(max(p.float('relief'), float(1e-3))).mul(0.9).clamp(0, 1)
    // Damp pools low. Wet ground is darker *and* smoother, never one alone.
    const wet = smoothstep(float(0.5), float(0.08), h01).mul(p.float('damp'))
    const micro = microVariation(ctx.uv, scale.mul(8), offset.add(23))

    return {
      baseColor: colour.mul(mix(float(1), float(0.45), wet)),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .add(micro.sub(0.5).mul(0.16))
        .sub(surface.mul(0.06))
        .sub(wet.mul(0.55))
        .clamp(0.04, 1),
      ao: cavityAO(h01, normal, 0.85),
      height: h01,
      normal: blendDetailNormal(normal, detailNormal, float(0.5).add(surface.mul(0.5))),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const crackedMud = registerMaterial({
  id: 'cracked-mud',
  name: 'Cracked Mud',
  category: 'Terrain',
  description:
    'A dried lakebed. The plates curl up at their edges as the clay shrinks, which is why the cracks read as *deep* - the relief comes from the lifted rim far more than from the gap itself. Wind-blown dust settles in the cracks and is scoured off the curled edges.',
  params: [
    { key: 'scale', label: 'Plate Size', type: 'float', default: 7, min: 1, max: 60, step: 0.25, group: 'Layout' },
    { key: 'crackWidth', label: 'Crack Width', type: 'float', default: 0.05, min: 0.002, max: 0.25, step: 0.001, group: 'Layout' },
    { key: 'curl', label: 'Edge Curl', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How far each plate lifts at its rim as it dries. This is what makes a dry bed look dry.' },
    { key: 'subCracks', label: 'Secondary Cracks', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'The finer network that appears inside each plate on a second drying.' },
    { key: 'mudColor', label: 'Mud Colour', type: 'color', default: [0.4, 0.31, 0.22], group: 'Colour' },
    { key: 'dryColor', label: 'Sun-bleached', type: 'color', default: [0.62, 0.55, 0.44], group: 'Colour' },
    { key: 'crackColor', label: 'Crack Colour', type: 'color', default: [0.13, 0.1, 0.075], group: 'Colour' },
    { key: 'dust', label: 'Dust', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'depth', label: 'Crack Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.92, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    // The plate lattice is warped, or every crack junction meets at the same
    // angle and the whole bed reads as a Voronoi diagram - which it is, but it
    // should not look like one.
    const plateAt = (uvNode: V2) => {
      const w = warp(vec3(uvNode.mul(scale.mul(0.6)), offset), 0.35, 1.1)
      return voronoi2(vec2(w.x, w.y).mul(1.65).add(vec2(offset, offset)), float(0.9))
    }

    const heightAt = (uvNode: V2): F => {
      const cells = plateAt(uvNode)
      const border = voronoiBorder(cells)
      const gap = smoothstep(p.float('crackWidth'), p.float('crackWidth').mul(2.2), border)

      /**
       * The curl: a narrow band just inside the crack that rises above the
       * plate centre. Modelling it as a ridge rather than sloping the whole
       * plate is what keeps the middle flat, which is how a dried plate sits.
       */
      const rim = smoothstep(p.float('crackWidth').mul(4.5), p.float('crackWidth').mul(1.6), border)
        .mul(gap)
        .mul(p.float('curl'))
        .mul(0.42)

      const fine = cracks(uvNode, scale.mul(3.4), float(0.035), offset.add(19)).mul(p.float('subCracks'))
      const clay = fbm01(vec3(uvNode.mul(scale.mul(9)), offset.add(5)), 4, 2.2, 0.55).sub(0.5).mul(0.05)

      return gap.mul(0.55).add(rim).sub(fine.mul(0.12)).add(clay).mul(p.float('depth'))
    }

    const cells = plateAt(ctx.uv)
    const border = voronoiBorder(cells)
    const gap = smoothstep(p.float('crackWidth'), p.float('crackWidth').mul(2.2), border)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.2))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1)

    // Each plate dried at its own rate, so each has its own bleach level.
    const plateTone = hash21(cells.zw.add(vec2(offset.add(3), offset)))
    const clay = tintVariation(
      mix(p.color('mudColor'), p.color('dryColor'), plateTone.mul(0.7).add(microVariation(ctx.uv, scale.mul(2.5), offset).mul(0.3))),
      hash21(cells.zw.add(vec2(offset.add(27), offset.add(2)))),
      0.01,
      0.16,
      0.18,
    )

    // Dust is scoured off the curled rims and collects in the cracks.
    const dustMask = smoothstep(float(0.62), float(0.08), h01).mul(p.float('dust'))
    const withDust = mix(clay, p.color('dryColor').mul(1.06), dustMask.mul(0.55))
    const colour = mix(p.color('crackColor'), withDust, gap)

    const micro = microVariation(ctx.uv, scale.mul(14), offset.add(9))

    return {
      baseColor: colour,
      metallic: float(0),
      roughness: p.float('roughness').add(micro.sub(0.5).mul(0.1)).sub(gap.oneMinus().mul(0.05)).clamp(0.3, 1),
      ao: cavityAO(h01, normal, 0.9),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const forestFloor = registerMaterial({
  id: 'forest-floor',
  name: 'Forest Floor',
  category: 'Terrain',
  description:
    'Leaf litter over dark humus, with twigs and the odd stone coming through. Leaves are individual shapes with their own rotation and colour rather than a noise field, because litter reads entirely by its silhouette - a brown fbm over soil looks like mud, not leaves.',
  params: [
    { key: 'scale', label: 'Leaf Density', type: 'float', default: 20, min: 2, max: 120, step: 0.5, group: 'Layout' },
    { key: 'coverage', label: 'Litter Coverage', type: 'float', default: 0.72, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How much of the soil the leaves hide. Drops toward bare earth on a path.' },
    { key: 'twigs', label: 'Twigs', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'stones', label: 'Stones', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'leafA', label: 'Fresh Leaf', type: 'color', default: [0.36, 0.24, 0.09], group: 'Colour' },
    { key: 'leafB', label: 'Old Leaf', type: 'color', default: [0.22, 0.15, 0.08], group: 'Colour' },
    { key: 'leafC', label: 'Bright Leaf', type: 'color', default: [0.52, 0.33, 0.12], group: 'Colour' },
    { key: 'soilColor', label: 'Humus', type: 'color', default: [0.08, 0.06, 0.045], group: 'Colour' },
    { key: 'mossColor', label: 'Moss', type: 'color', default: [0.16, 0.24, 0.09], group: 'Colour' },
    { key: 'moss', label: 'Moss', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'variation', label: 'Leaf Variation', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'damp', label: 'Damp', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * One leaf per cell, as an ellipse in the cell's own rotated frame.
     *
     * The rotation comes from the cell hash, so no two neighbouring leaves lie
     * the same way. Without it the litter combs itself into rows, which is the
     * most obvious tell there is.
     */
    const leafAt = (uvNode: V2) => {
      const cells = voronoi2(uvNode.mul(scale).add(vec2(offset, offset)), float(1))
      const id = cells.zw
      const angle = hash21(id.add(vec2(offset.add(13), offset))).mul(6.2831)
      const c = angle.cos()
      const s = angle.sin()
      // Position within the cell, rotated into the leaf's own axes.
      const local = uvNode.mul(scale).sub(id).sub(vec2(0.5, 0.5))
      const rotated = vec2(local.x.mul(c).sub(local.y.mul(s)), local.x.mul(s).add(local.y.mul(c)))
      const stretch = mix(float(1.9), float(3.1), hash21(id.add(vec2(offset.add(5), offset.add(2)))))
      const d = vec2(rotated.x.mul(stretch), rotated.y).length()
      const size = mix(float(0.3), float(0.52), hash21(id.add(vec2(offset.add(29), offset))))
      const present = step(hash21(id.add(vec2(offset.add(3), offset.add(11)))), p.float('coverage'))
      const mask = smoothstep(size, size.mul(0.6), d).mul(present)
      // The midrib, as a crease along the leaf's long axis.
      const rib = smoothstep(float(0.045), float(0), rotated.y.abs()).mul(mask)
      return { mask, rib, id, local: rotated }
    }

    const twigAt = (uvNode: V2): F => {
      const w = warp(vec3(uvNode.mul(scale.mul(0.4)), offset.add(31)), 0.6, 1.4)
      const line = fbm01(vec3(w.x.mul(scale.mul(0.5)), w.y.mul(scale.mul(9)), offset.add(7)), 3, 2.1, 0.55)
      return smoothstep(float(0.72), float(0.82), line).mul(p.float('twigs'))
    }

    const stoneAt = (uvNode: V2): F => {
      const cell = pebbles(uvNode.mul(scale.mul(0.55)).add(vec2(offset.add(17), offset)), float(0.95), float(0.4))
      const present = step(voronoiCellValue(cell), p.float('stones').mul(0.3))
      return cell.x.mul(present)
    }

    const heightAt = (uvNode: V2): F => {
      const leaf = leafAt(uvNode)
      const soil = fbm01(vec3(uvNode.mul(scale.mul(1.3)), offset.add(23)), 4, 2.1, 0.55).mul(0.3)
      const litter = leaf.mask.mul(0.55).sub(leaf.rib.mul(0.12))
      const stone = stoneAt(uvNode).mul(0.5)
      return soil.add(litter).add(twigAt(uvNode).mul(0.32)).add(stone).mul(p.float('relief'))
    }

    const leaf = leafAt(ctx.uv)
    const twig = twigAt(ctx.uv)
    const stone = stoneAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(1.5))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('relief'), float(1e-3))).clamp(0, 1)

    const leafTone = mix(float(0.5), hash21(leaf.id.add(vec2(offset.add(37), offset))), p.float('variation'))
    const leafColour = tintVariation(
      gradient3(leafTone, p.color('leafB'), p.color('leafA'), p.color('leafC')),
      hash21(leaf.id.add(vec2(offset.add(43), offset.add(3)))),
      0.02,
      0.28,
      0.26,
    ).mul(mix(float(1), float(0.72), leaf.rib))

    const soilColour = p
      .color('soilColor')
      .mul(mix(float(0.7), float(1.3), fbm01(vec3(ctx.uv.mul(scale.mul(2.5)), offset.add(9)), 3, 2, 0.5)))

    // Moss finds the damp low ground between the leaves, not the leaves themselves.
    const mossField = fbm01(warp(vec3(ctx.uv.mul(scale.mul(0.5)), offset.add(51)), 0.8, 1.2), 4, 2.2, 0.55)
    const mossMask = smoothstep(float(0.58), float(0.8), mossField)
      .mul(smoothstep(float(0.45), float(0.05), h01))
      .mul(p.float('moss'))

    let colour = mix(soilColour, leafColour, leaf.mask)
    colour = mix(colour, p.color('mossColor'), mossMask.mul(0.8))
    colour = mix(colour, p.color('leafB').mul(0.7), twig.mul(twig))
    colour = mix(colour, vec3(0.34, 0.32, 0.3), stone)

    const wet = smoothstep(float(0.5), float(0.05), h01).mul(p.float('damp'))
    const micro = microVariation(ctx.uv, scale.mul(6), offset.add(13))

    return {
      baseColor: colour.mul(mix(float(1), float(0.5), wet)),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .add(micro.sub(0.5).mul(0.14))
        .sub(leaf.mask.mul(0.12))
        .sub(wet.mul(0.4))
        .clamp(0.08, 1),
      ao: cavityAO(h01, normal, 0.9),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const grassTufts = registerMaterial({
  id: 'grass-tufts',
  name: 'Grass',
  category: 'Terrain',
  description:
    'Grass as a surface rather than as geometry: clumps of blades with a shared lean, soil showing through the thin patches, and dead thatch at the base. The blades within a clump all lean the same way and clumps disagree with each other, which is what makes it read as grass instead of green noise.',
  params: [
    { key: 'scale', label: 'Blade Density', type: 'float', default: 90, min: 10, max: 400, step: 1, group: 'Layout' },
    { key: 'clumping', label: 'Clumping', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'coverage', label: 'Coverage', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Below about 0.6 the soil starts showing through, which is what a worn path looks like.' },
    { key: 'lean', label: 'Lean', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'grassA', label: 'Grass Colour', type: 'color', default: [0.19, 0.31, 0.09], group: 'Colour' },
    { key: 'grassB', label: 'Lush Colour', type: 'color', default: [0.27, 0.44, 0.13], group: 'Colour' },
    { key: 'thatchColor', label: 'Dead Thatch', type: 'color', default: [0.42, 0.35, 0.15], group: 'Colour' },
    { key: 'soilColor', label: 'Soil', type: 'color', default: [0.14, 0.1, 0.07], group: 'Colour' },
    { key: 'dryness', label: 'Dryness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'variation', label: 'Blade Variation', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.7, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * Clumps first, blades second.
     *
     * The clump field supplies both the local lean and the density, so blades
     * inside one tuft agree with each other. Sampling a single blade field and
     * calling it grass gives an even mat with no structure at any scale above
     * one blade.
     */
    const clumpAt = (uvNode: V2) => {
      const cells = voronoi2(uvNode.mul(scale.mul(0.09)).add(vec2(offset, offset)), float(0.95))
      const lean = hash21(cells.zw.add(vec2(offset.add(7), offset))).sub(0.5).mul(2)
      const vigour = hash21(cells.zw.add(vec2(offset.add(19), offset.add(3))))
      return { dome: smoothstep(float(0.7), float(0.05), cells.x), lean, vigour, id: cells.zw }
    }

    const bladeAt = (uvNode: V2) => {
      const clump = clumpAt(uvNode)
      // Blades are noise stretched hard along the lean direction.
      const lean = clump.lean.mul(p.float('lean'))
      const sheared = vec2(uvNode.x.add(uvNode.y.mul(lean.mul(0.35))), uvNode.y)
      const field = fbm01(vec3(sheared.x.mul(scale), sheared.y.mul(scale.mul(0.16)), offset.add(11)), 3, 2.2, 0.55)
      const density = p.float('coverage').mul(mix(float(1), clump.dome, p.float('clumping')))
      const mask = smoothstep(float(0.52).sub(density.mul(0.34)), float(0.72).sub(density.mul(0.34)), field)
      return { mask, field, clump }
    }

    const heightAt = (uvNode: V2): F => {
      const b = bladeAt(uvNode)
      const ground = fbm01(vec3(uvNode.mul(scale.mul(0.05)), offset.add(29)), 3, 2, 0.5).mul(0.4)
      return ground.add(b.mask.mul(0.6)).add(b.clump.dome.mul(0.25)).mul(p.float('relief'))
    }

    const b = bladeAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(1.8))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('relief'), float(1e-3))).clamp(0, 1)

    const tone = mix(float(0.5), hash21(b.clump.id.add(vec2(offset.add(23), offset))), p.float('variation'))
    const green = tintVariation(
      mix(p.color('grassA'), p.color('grassB'), tone.mul(0.6).add(b.clump.vigour.mul(0.4))),
      hash21(b.clump.id.add(vec2(offset.add(47), offset.add(5)))),
      0.025,
      0.3,
      0.28,
    )

    // Thatch is dead grass lying under the living blades, so it shows in the
    // gaps and at the base - never on top of a standing blade.
    const thatch = smoothstep(float(0.55), float(0.15), h01).mul(p.float('dryness'))
    const withThatch = mix(green, p.color('thatchColor'), thatch.mul(0.75))
    const colour = mix(p.color('soilColor'), withThatch, b.mask.mul(0.75).add(0.25).mul(smoothstep(float(0.05), float(0.3), h01).mul(0.5).add(0.5)))

    return {
      baseColor: colour,
      metallic: float(0),
      // Live grass has a waxy cuticle; dead thatch does not.
      roughness: p.float('roughness').sub(b.mask.mul(0.18)).add(thatch.mul(0.15)).clamp(0.15, 1),
      ao: cavityAO(h01, normal, 0.95),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const lavaRock = registerMaterial({
  id: 'lava-rock',
  name: 'Lava Rock',
  category: 'Terrain',
  description:
    'Cooled basalt crust with molten rock still showing in the fissures. The glow is driven by the *height* field, so it appears wherever the crust has actually broken rather than wherever a separate mask says it should - crack the surface further and more of it lights up, which is the whole point.',
  params: [
    { key: 'scale', label: 'Crust Scale', type: 'float', default: 5, min: 0.5, max: 40, step: 0.1, group: 'Layout' },
    { key: 'fracture', label: 'Fracture', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How far the crust has broken apart. Also how much of the melt below shows through.' },
    { key: 'ropiness', label: 'Ropiness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'The folded rope texture of pahoehoe flow, as opposed to blocky aa rubble.' },
    { key: 'vesicles', label: 'Gas Bubbles', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'rockColor', label: 'Crust Colour', type: 'color', default: [0.045, 0.04, 0.042], group: 'Colour' },
    { key: 'ashColor', label: 'Ash Colour', type: 'color', default: [0.19, 0.18, 0.18], group: 'Colour' },
    { key: 'hotColor', label: 'Hot Colour', type: 'color', default: [1, 0.32, 0.04], group: 'Glow' },
    { key: 'coreColor', label: 'Core Colour', type: 'color', default: [1, 0.86, 0.42], group: 'Glow' },
    { key: 'glow', label: 'Glow Strength', type: 'float', default: 4, min: 0, max: 30, step: 0.05, group: 'Glow' },
    { key: 'depth', label: 'Fissure Depth', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.8, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    // Ropy folds: a ridged field stretched along one axis, warped by a slower
    // one so the ropes meander the way a cooling flow front does.
    const ropesAt = (uvNode: V2): F => {
      const w = warp(vec3(uvNode.mul(scale), offset), 0.55, 0.8)
      const stretched = vec3(w.x.mul(1), w.y.mul(4.5), w.z)
      return ridged(stretched.mul(1.4), float(4), float(0.55)).mul(p.float('ropiness'))
    }

    const heightAt = (uvNode: V2): F => {
      const plates = voronoi2(uvNode.mul(scale.mul(1.4)).add(vec2(offset.add(3), offset)), float(0.95))
      const border = voronoiBorder(plates)
      // Fracture widens the gap between crust plates.
      const gapWidth = mix(float(0.012), float(0.11), p.float('fracture'))
      const gap = smoothstep(gapWidth, gapWidth.mul(2.4), border)
      const rope = ropesAt(uvNode).mul(0.3)
      // Vesicles are gas bubbles frozen into the crust: pits, not bumps.
      const bubbles = worley(vec3(uvNode.mul(scale.mul(11)), offset.add(13)), 1)
      const pits = smoothstep(float(0.28), float(0), bubbles).mul(p.float('vesicles')).mul(0.16)
      const grain = fbm01(vec3(uvNode.mul(scale.mul(24)), offset.add(7)), 3, 2.3, 0.55).sub(0.5).mul(0.06)
      return gap.mul(0.72).add(rope).sub(pits).add(grain).mul(p.float('depth'))
    }

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1)

    /**
     * Everything below the crust line is melt. One threshold on the height
     * field gives the crack pattern, the cooling gradient and the emissive
     * mask at once, and they can never disagree with each other.
     */
    const melt = smoothstep(float(0.42), float(0.02), h01)
    const core = smoothstep(float(0.22), float(0), h01)
    // Molten rock flickers in temperature along the fissure, not uniformly.
    const heat = fbm01(vec3(ctx.uv.mul(scale.mul(3.5)), offset.add(37)), 4, 2.1, 0.55).mul(0.5).add(0.5)

    const crust = mix(
      p.color('rockColor'),
      p.color('ashColor'),
      smoothstep(float(0.55), float(0.95), h01).mul(fbm01(vec3(ctx.uv.mul(scale.mul(5)), offset.add(17)), 3, 2, 0.5)),
    )
    // Crust nearest a fissure is heat-stained before it is actually glowing.
    const scorched = mix(crust, p.color('hotColor').mul(0.22), smoothstep(float(0.62), float(0.3), h01).mul(0.6))
    const glowColour = mix(p.color('hotColor'), p.color('coreColor'), core.mul(heat))

    const micro = microVariation(ctx.uv, scale.mul(20), offset.add(29))

    return {
      baseColor: mix(scorched, glowColour.mul(0.5), melt),
      metallic: float(0),
      // Melt is a smooth liquid; crust is a rough, ash-dusted solid.
      roughness: p.float('roughness').add(micro.sub(0.5).mul(0.18)).sub(melt.mul(0.55)).clamp(0.08, 1),
      ao: cavityAO(h01, normal, 0.7),
      height: h01,
      normal,
      emissive: glowColour.mul(melt.mul(heat).mul(p.float('glow'))),
    }
  },
} satisfies ProceduralMaterialDef)

export const TERRAIN = [gravel, crackedMud, forestFloor, grassTufts, lavaRock]
