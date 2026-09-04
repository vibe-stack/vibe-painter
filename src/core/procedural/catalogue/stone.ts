/**
 * Stone.
 *
 * The masonry file covers stone that has been *laid* - bricks, cobbles, tiles.
 * This one covers stone as a material: what a block looks like when you cut it
 * open. That means the pattern is not a grid, it is the record of how the rock
 * formed - crystals that grew into each other, layers that settled, gas that
 * froze in place.
 *
 * The single most useful idea here is that a mineral's colour and its hardness
 * are the same variable. Quartz is pale *and* proud *and* glossy; the softer
 * matrix around it is dark, recessed and matt. Once colour, height and
 * roughness all read off one field, a stone stops looking like tinted noise.
 */

import { float, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  cavityAO,
  fbm01,
  gradient3,
  hash21,
  hexGrid,
  microVariation,
  normalFromHeightFn,
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

export const granite = registerMaterial({
  id: 'granite',
  name: 'Granite',
  category: 'Stone',
  description: 'Three minerals crystallised into each other: pale feldspar, grey quartz and black mica. Each grain is one Voronoi cell, and because the mica flakes are both darker and glossier than the feldspar, the roughness map is as busy as the colour - which is what a photograph of granite never shows you but your eye expects.',
  params: [
    { key: 'feldspar', label: 'Feldspar', type: 'color', default: [0.76, 0.72, 0.68], group: 'Minerals' },
    { key: 'quartz', label: 'Quartz', type: 'color', default: [0.5, 0.5, 0.52], group: 'Minerals' },
    { key: 'mica', label: 'Mica', type: 'color', default: [0.06, 0.055, 0.06], group: 'Minerals' },
    { key: 'micaAmount', label: 'Mica Content', type: 'float', default: 0.28, min: 0, max: 1, step: 0.01, group: 'Minerals' },
    { key: 'grain', label: 'Grain Size', type: 'float', default: 45, min: 2, max: 300, step: 0.5, group: 'Minerals' },
    { key: 'veining', label: 'Banding', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Minerals', description: 'The slow drift in mineral mix across a slab. Without it every square inch looks identical.' },
    { key: 'polish', label: 'Polish', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'A cut slab is polished flat; drop this towards zero for a flamed or split face.' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'How far the harder grains stand proud. Only meaningful on an unpolished face.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const grain = p.float('grain')

    const cellsAt = (uvNode: V2) => voronoi2(uvNode.mul(grain).add(vec2(offset, offset)), float(0.95))

    // Which mineral this crystal is. Banding drifts the mix so the slab has
    // regions rather than a uniform salt-and-pepper.
    const mineralAt = (uvNode: V2): F => {
      const id = voronoiCellValue(cellsAt(uvNode))
      const band = fbm01(vec3(uvNode.mul(2.5), offset.add(11)), 4, 2.1, 0.55).sub(0.5).mul(p.float('veining'))
      return id.add(band).clamp(0, 1)
    }

    const isMicaAt = (uvNode: V2): F =>
      smoothstep(p.float('micaAmount'), p.float('micaAmount').mul(0.6), mineralAt(uvNode))

    const heightAt = (uvNode: V2): F => {
      const cells = cellsAt(uvNode)
      // Soft mica erodes below the hard quartz; the grain boundary is a groove.
      const hardness = float(1).sub(isMicaAt(uvNode))
      const boundary = smoothstep(float(0.06), float(0), voronoiBorder(cells))
      return hardness.mul(0.5).sub(boundary.mul(0.4)).mul(p.float('relief')).mul(p.float('polish').oneMinus().mul(0.7).add(0.3))
    }

    const mineral = mineralAt(ctx.uv)
    const mica = isMicaAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(1.4).add(0.05))
    const h = heightAt(ctx.uv)

    const stone = gradient3(mineral, p.color('mica'), p.color('quartz'), p.color('feldspar'))
    const jittered = tintVariation(stone, voronoiCellValue(cellsAt(ctx.uv)), 0.01, 0.14, 0.18)

    // Mica cleaves into flat plates that catch the light in sheets: it is the
    // one mineral here that is glossier than its neighbours despite being dark.
    const flake = sparkle(ctx.uv, grain.mul(0.9), offset.add(5), float(0.18)).mul(mica)

    return {
      baseColor: jittered,
      metallic: float(0),
      roughness: mix(float(0.55), float(0.08), p.float('polish'))
        .add(mica.mul(-0.03))
        .sub(flake.mul(0.06))
        .add(microVariation(ctx.uv, grain.mul(0.4), offset).sub(0.5).mul(0.08))
        .clamp(0.02, 1),
      ao: cavityAO(h.mul(3).add(0.6).clamp(0, 1), normal, 0.4),
      height: h.mul(2).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const sandstone = registerMaterial({
  id: 'sandstone',
  name: 'Sandstone',
  category: 'Stone',
  description: 'Sand that settled in beds and was pressed into rock. The bedding planes are what identify it: parallel layers of slightly different iron content, cut across by the block face so they run as stripes, with the softer beds weathered back into the surface.',
  params: [
    { key: 'pale', label: 'Pale Bed', type: 'color', default: [0.78, 0.68, 0.5], group: 'Colour' },
    { key: 'warm', label: 'Iron Bed', type: 'color', default: [0.63, 0.42, 0.24], group: 'Colour' },
    { key: 'shadowTone', label: 'Deep Bed', type: 'color', default: [0.42, 0.32, 0.22], group: 'Colour' },
    { key: 'beds', label: 'Bedding Density', type: 'float', default: 9, min: 0.5, max: 60, step: 0.1, group: 'Bedding' },
    { key: 'tilt', label: 'Bedding Tilt', type: 'float', default: 0.25, min: -1, max: 1, step: 0.01, group: 'Bedding', description: 'Beds are rarely square to the block. A little tilt reads as a real cut.' },
    { key: 'undulation', label: 'Undulation', type: 'float', default: 0.4, min: 0, max: 2, step: 0.01, group: 'Bedding', description: 'Cross-bedding: the layers were laid by moving water, so they curve.' },
    { key: 'grit', label: 'Grain Size', type: 'float', default: 120, min: 10, max: 600, step: 1, group: 'Surface' },
    { key: 'weathering', label: 'Weathering', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Soft beds cut back faster than hard ones, so the face becomes fluted.' },
    { key: 'pitting', label: 'Honeycombing', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Salt weathering hollows out cells in the face - the tafoni you see on coastal sandstone.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const bedAt = (uvNode: V2): F => {
      const tilted = uvNode.y.add(uvNode.x.mul(p.float('tilt')))
      const curve = fbm01(vec3(uvNode.mul(vec2(1.5, 0.4)), offset), 3, 2, 0.5).sub(0.5).mul(p.float('undulation'))
      return fbm01(vec3(float(0), tilted.add(curve).mul(p.float('beds')), offset.add(3)), 3, 2.4, 0.6)
    }

    const heightAt = (uvNode: V2): F => {
      const bed = bedAt(uvNode)
      // Soft beds weather back: the height follows bed hardness directly.
      const flute = bed.sub(0.5).mul(p.float('weathering')).mul(0.5)
      const grit = fbm01(vec3(uvNode.mul(p.float('grit')), offset.add(7)), 3, 2.3, 0.55).sub(0.5).mul(0.08)
      const honeycomb = smoothstep(float(0.4), float(0), worley(vec3(uvNode.mul(22), offset.add(13)), 1))
        .mul(p.float('pitting'))
        .mul(0.35)
      return flute.add(grit).sub(honeycomb)
    }

    const bed = bedAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.3))
    const h = heightAt(ctx.uv)

    const colour = gradient3(bed, p.color('shadowTone'), p.color('warm'), p.color('pale'))
    const grit = fbm01(coord3(ctx, p.float('grit').mul(0.5)).add(17), 3, 2.2, 0.55)

    return {
      // Individual sand grains catch light: the colour has to be noisy at the
      // grain scale as well as banded at the bed scale.
      baseColor: tintVariation(colour, grit, 0.012, 0.14, 0.22).mul(mix(float(0.9), float(1.08), grit)),
      metallic: float(0),
      roughness: p.float('roughness').add(grit.sub(0.5).mul(0.12)).sub(bed.sub(0.5).mul(0.06)).clamp(0.3, 1),
      ao: cavityAO(h.mul(2).add(0.6).clamp(0, 1), normal, 0.6),
      height: h.mul(1.4).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const slate = registerMaterial({
  id: 'slate',
  name: 'Slate',
  category: 'Stone',
  description: 'Slate splits along its cleavage into flat sheets with stepped edges. That step is the whole look: the surface is a set of slightly offset plates, each one flat but none of them at the same level, with the riven faces catching light in bands.',
  params: [
    { key: 'base', label: 'Slate', type: 'color', default: [0.16, 0.17, 0.19], group: 'Colour' },
    { key: 'accent', label: 'Accent', type: 'color', default: [0.3, 0.28, 0.26], group: 'Colour', description: 'Rusty or greenish veins - most slate is not pure grey.' },
    { key: 'accentAmount', label: 'Accent Amount', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'plateScale', label: 'Plate Scale', type: 'float', default: 5, min: 0.5, max: 40, step: 0.1, group: 'Cleavage' },
    { key: 'step', label: 'Step Height', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Cleavage', description: 'How far each cleaved plate sits above its neighbour.' },
    { key: 'anisotropy', label: 'Cleavage Direction', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Cleavage', description: 'Stretches the plates along the cleavage. At zero they are blobs; slate is strongly directional.' },
    { key: 'riven', label: 'Riven Texture', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The fine ripple left on a split face.' },
    { key: 'wet', label: 'Wetness', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Slate is nearly always seen wet, and wet slate is a different material: darker and far glossier.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.62, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('plateScale')

    // Stretching the sample space is what turns isotropic cells into the long
    // slabs a cleavage plane produces.
    const stretch = mix(float(1), float(0.22), p.float('anisotropy'))
    const plateCoord = (uvNode: V2): V2 => vec2(uvNode.x.mul(scale), uvNode.y.mul(scale).mul(stretch))

    const heightAt = (uvNode: V2): F => {
      const cells = voronoi2(plateCoord(uvNode).add(vec2(offset, offset)), float(0.85))
      // Each plate is flat, at its own level: a stepped field, not a smooth one.
      const level = voronoiCellValue(cells).mul(p.float('step')).mul(0.4)
      const edge = smoothstep(float(0.04), float(0), voronoiBorder(cells)).mul(0.25)
      const riven = fbm01(vec3(uvNode.mul(vec2(scale.mul(6), scale.mul(30))), offset.add(3)), 3, 2.2, 0.55)
        .sub(0.5)
        .mul(p.float('riven'))
        .mul(0.1)
      return level.sub(edge).add(riven)
    }

    const cells = voronoi2(plateCoord(ctx.uv).add(vec2(offset, offset)), float(0.85))
    const id = voronoiCellValue(cells)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.5))
    const h = heightAt(ctx.uv)

    const vein = smoothstep(float(0.55), float(0.85), fbm01(vec3(ctx.uv.mul(vec2(4, 1.2)), offset.add(23)), 4, 2.1, 0.55))
      .mul(p.float('accentAmount'))
    const stone = tintVariation(mix(p.color('base'), p.color('accent'), vein), id, 0.01, 0.12, 0.22)

    return {
      // Water fills the micro-relief, so it darkens and smooths at once.
      baseColor: stone.mul(mix(float(1), float(0.45), p.float('wet'))),
      metallic: float(0),
      roughness: mix(
        p.float('roughness').add(id.sub(0.5).mul(0.16)),
        float(0.08),
        p.float('wet'),
      ).clamp(0.03, 1),
      ao: cavityAO(h.mul(2.5).add(0.55).clamp(0, 1), normal, 0.65),
      height: h.mul(1.6).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const limestone = registerMaterial({
  id: 'limestone',
  name: 'Limestone',
  category: 'Stone',
  description: 'Compacted shell and coral. Fossil fragments are literally embedded in it, so the surface is a matrix full of small hard inclusions that weather proud, plus the pitting that acid rain dissolves into any carbonate.',
  params: [
    { key: 'matrix', label: 'Matrix', type: 'color', default: [0.79, 0.76, 0.68], group: 'Colour' },
    { key: 'fossil', label: 'Inclusions', type: 'color', default: [0.88, 0.86, 0.8], group: 'Colour' },
    { key: 'stain', label: 'Weather Stain', type: 'color', default: [0.45, 0.42, 0.34], group: 'Colour' },
    { key: 'fossilAmount', label: 'Fossil Content', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Structure' },
    { key: 'fossilScale', label: 'Fossil Scale', type: 'float', default: 30, min: 2, max: 200, step: 0.5, group: 'Structure' },
    { key: 'porosity', label: 'Porosity', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Structure', description: 'Dissolution pits. Limestone is soluble, so its surface is always being eaten.' },
    { key: 'staining', label: 'Staining', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Weather' },
    { key: 'toolMarks', label: 'Tool Marks', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Weather', description: 'Parallel claw-chisel grooves from dressing the block.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.8, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const fs = p.float('fossilScale')

    const fossilAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(fs).add(vec2(offset.add(3), offset)), float(0.95))
      // Only some cells are fossils; the rest are matrix.
      const pick = smoothstep(p.float('fossilAmount').oneMinus(), p.float('fossilAmount').oneMinus().add(0.08), voronoiCellValue(cells))
      const body = smoothstep(float(0), float(0.12), voronoiBorder(cells))
      return pick.mul(body)
    }

    const heightAt = (uvNode: V2): F => {
      const fossil = fossilAt(uvNode).mul(0.28)
      const pits = smoothstep(float(0.3), float(0), worley(vec3(uvNode.mul(fs.mul(1.6)), offset.add(9)), 1))
        .mul(p.float('porosity'))
        .mul(0.3)
      const tool = fbm01(vec3(uvNode.mul(vec2(3, 90)), offset.add(13)), 2, 2, 0.5).sub(0.5).mul(p.float('toolMarks')).mul(0.12)
      const grain = fbm01(vec3(uvNode.mul(fs.mul(6)), offset.add(19)), 3, 2.2, 0.55).sub(0.5).mul(0.05)
      return fossil.sub(pits).add(tool).add(grain)
    }

    const fossil = fossilAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))
    const h = heightAt(ctx.uv)

    // Stains run in the low ground, which is where water sits.
    const damp = smoothstep(float(0.5), float(0.85), fbm01(coord3(ctx, 3.5).add(31), 4, 2.1, 0.55))
      .mul(p.float('staining'))
      .mul(h.negate().mul(2).add(0.6).clamp(0, 1))

    const stone = mix(p.color('matrix'), p.color('fossil'), fossil)

    return {
      baseColor: mix(tintVariation(stone, fbm01(coord3(ctx, fs.mul(0.5)).add(41), 3, 2, 0.5), 0.008, 0.1, 0.14), p.color('stain'), damp.mul(0.7)),
      metallic: float(0),
      // Fossil calcite is denser than the matrix, so it takes a slight shine.
      roughness: p.float('roughness').sub(fossil.mul(0.15)).add(damp.mul(0.05)).clamp(0.25, 1),
      ao: cavityAO(h.mul(2.5).add(0.6).clamp(0, 1), normal, 0.7),
      height: h.mul(1.6).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const basaltColumns = registerMaterial({
  id: 'basalt-columns',
  name: 'Basalt Columns',
  category: 'Stone',
  description: 'Columnar jointing, as at the Giant’s Causeway. Lava cooling from the top down contracts into a near-hexagonal crack net, so the pattern wants a hex grid rather than a Voronoi one - the regularity is the point, and the small irregularity on top of it is what keeps it from looking tiled.',
  params: [
    { key: 'rock', label: 'Basalt', type: 'color', default: [0.11, 0.11, 0.115], group: 'Colour' },
    { key: 'weathered', label: 'Weathered Face', type: 'color', default: [0.3, 0.29, 0.26], group: 'Colour' },
    { key: 'lichen', label: 'Lichen', type: 'color', default: [0.44, 0.47, 0.32], group: 'Colour' },
    { key: 'scale', label: 'Column Size', type: 'float', default: 4, min: 0.5, max: 30, step: 0.1, group: 'Jointing' },
    { key: 'jointWidth', label: 'Joint Width', type: 'float', default: 0.12, min: 0.01, max: 0.5, step: 0.005, group: 'Jointing' },
    { key: 'irregular', label: 'Irregularity', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Jointing', description: 'Real columns are five-, six- and seven-sided. Pushing the grid around gets that without giving up the hexagonal average.' },
    { key: 'stepping', label: 'Column Stepping', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Jointing', description: 'Columns broke at different heights, so the top surface is a staircase.' },
    { key: 'vesicles', label: 'Gas Bubbles', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Frozen gas voids. Basalt is a lava, and lava had bubbles in it.' },
    { key: 'lichenAmount', label: 'Lichen', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const cellAt = (uvNode: V2) => {
      // Warping before the hex lookup bends the joints; warping after would
      // just smear the cell ids and break the per-column hashing.
      const warped = warp(vec3(uvNode.mul(scale), offset), p.float('irregular').mul(0.12), 1.8)
      return hexGrid(vec2(warped.x, warped.y).add(vec2(offset, offset)))
    }

    const heightAt = (uvNode: V2): F => {
      const cell = cellAt(uvNode)
      const d = cell.xy.length()
      const inner = float(0.5).sub(p.float('jointWidth').mul(0.5))
      const face = smoothstep(inner, inner.sub(0.06), d)
      const level = hash21(cell.zw).mul(p.float('stepping')).mul(0.5)
      const vesicle = smoothstep(float(0.25), float(0), worley(vec3(uvNode.mul(scale.mul(14)), offset.add(7)), 1))
        .mul(p.float('vesicles'))
        .mul(0.18)
      const rough = fbm01(vec3(uvNode.mul(scale.mul(20)), offset.add(3)), 3, 2.2, 0.55).sub(0.5).mul(0.05)
      return face.mul(level.add(0.45)).sub(vesicle.mul(face)).add(rough.mul(face))
    }

    const cell = cellAt(ctx.uv)
    const id = hash21(cell.zw.add(vec2(3.7, 1.1)))
    const face = smoothstep(float(0.5).sub(p.float('jointWidth').mul(0.5)), float(0.42).sub(p.float('jointWidth').mul(0.5)), cell.xy.length())
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.8))
    const h = heightAt(ctx.uv)

    // Weathering is per column: some faces have been exposed far longer.
    const weather = mix(id, fbm01(coord3(ctx, scale.mul(2)).add(23), 3, 2, 0.5), 0.4)
    const stone = mix(p.color('rock'), p.color('weathered'), weather.mul(0.8))
    const lichen = smoothstep(float(0.58), float(0.8), fbm01(coord3(ctx, scale.mul(5)).add(53), 4, 2.2, 0.55))
      .mul(p.float('lichenAmount'))
      .mul(face)

    return {
      baseColor: mix(tintVariation(stone, id, 0.01, 0.12, 0.2), p.color('lichen'), lichen.mul(0.8)),
      metallic: float(0),
      roughness: float(0.78).add(weather.mul(0.12)).add(lichen.mul(0.12)).sub(face.oneMinus().mul(0.05)).clamp(0.3, 1),
      ao: cavityAO(h.div(float(0.95)).clamp(0, 1), normal, 0.85),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const travertine = registerMaterial({
  id: 'travertine',
  name: 'Travertine',
  category: 'Stone',
  description: 'Limestone laid down by a hot spring, full of the voids where gas escaped as it precipitated. The voids are elongated along the bedding, which is the tell: round holes read as pumice, stretched ones read as travertine.',
  params: [
    { key: 'cream', label: 'Cream', type: 'color', default: [0.82, 0.75, 0.63], group: 'Colour' },
    { key: 'warm', label: 'Warm Band', type: 'color', default: [0.66, 0.55, 0.41], group: 'Colour' },
    { key: 'voidColor', label: 'Void', type: 'color', default: [0.28, 0.24, 0.19], group: 'Colour' },
    { key: 'bands', label: 'Banding', type: 'float', default: 8, min: 0.5, max: 50, step: 0.1, group: 'Bedding' },
    { key: 'bandContrast', label: 'Band Contrast', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Bedding' },
    { key: 'voids', label: 'Void Density', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Voids' },
    { key: 'voidScale', label: 'Void Scale', type: 'float', default: 26, min: 2, max: 160, step: 0.5, group: 'Voids' },
    { key: 'voidStretch', label: 'Void Stretch', type: 'float', default: 3, min: 1, max: 12, step: 0.1, group: 'Voids', description: 'How far the holes are drawn out along the bedding.' },
    { key: 'filled', label: 'Filled', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Commercial travertine is grouted and polished. At 1 the voids are level and glossy; at 0 they are open holes.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.55, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const bandAt = (uvNode: V2): F => {
      const wobble = fbm01(vec3(uvNode.mul(vec2(2, 0.3)), offset), 3, 2, 0.5).sub(0.5).mul(0.35)
      return fbm01(vec3(float(0), uvNode.y.add(wobble).mul(p.float('bands')), offset.add(3)), 3, 2.3, 0.6)
    }

    const voidAt = (uvNode: V2): F => {
      const stretched = vec2(uvNode.x.mul(p.float('voidScale')), uvNode.y.mul(p.float('voidScale')).mul(p.float('voidStretch')))
      const d = worley(vec3(stretched, offset.add(11)), 1)
      const size = p.float('voids').mul(0.42)
      // Voids cluster in the more porous bands rather than spreading evenly.
      const cluster = smoothstep(float(0.35), float(0.7), bandAt(uvNode))
      return smoothstep(size, float(0), d).mul(cluster.mul(0.7).add(0.3))
    }

    const heightAt = (uvNode: V2): F => {
      const hole = voidAt(uvNode).mul(p.float('filled').oneMinus())
      const band = bandAt(uvNode).sub(0.5).mul(0.06)
      const grain = fbm01(vec3(uvNode.mul(p.float('voidScale').mul(5)), offset.add(7)), 3, 2.2, 0.55).sub(0.5).mul(0.03)
      return band.add(grain).sub(hole.mul(0.55))
    }

    const band = bandAt(ctx.uv)
    const hole = voidAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.5))
    const h = heightAt(ctx.uv)

    const stone = mix(p.color('cream'), p.color('warm'), band.mul(p.float('bandContrast')))
    // A filled void is grout: the same stone tone, but it never quite matches.
    const voidColour = mix(p.color('voidColor'), p.color('cream').mul(0.92), p.float('filled'))

    return {
      baseColor: tintVariation(mix(stone, voidColour, hole.clamp(0, 1)), band, 0.008, 0.1, 0.14),
      metallic: float(0),
      roughness: mix(p.float('roughness'), float(0.12), p.float('filled'))
        .add(hole.mul(p.float('filled').oneMinus()).mul(0.3))
        .add(microVariation(ctx.uv, p.float('voidScale').mul(2), offset).sub(0.5).mul(0.08))
        .clamp(0.04, 1),
      ao: cavityAO(h.mul(2).add(0.6).clamp(0, 1), normal, 0.75),
      height: h.mul(1.5).add(0.55).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const quartzCountertop = registerMaterial({
  id: 'engineered-quartz',
  name: 'Engineered Quartz',
  category: 'Stone',
  description: 'Crushed quartz bound in resin and polished flat. Because it is manufactured, the aggregate is evenly sized and evenly spread - which is exactly what makes it read as engineered rather than quarried, and why the surface is perfectly flat while the colour is busy.',
  params: [
    { key: 'binder', label: 'Binder', type: 'color', default: [0.88, 0.87, 0.85], group: 'Colour' },
    { key: 'chipA', label: 'Aggregate A', type: 'color', default: [0.96, 0.95, 0.93], group: 'Colour' },
    { key: 'chipB', label: 'Aggregate B', type: 'color', default: [0.4, 0.39, 0.4], group: 'Colour' },
    { key: 'chipScale', label: 'Aggregate Size', type: 'float', default: 70, min: 5, max: 400, step: 1, group: 'Aggregate' },
    { key: 'chipDensity', label: 'Aggregate Density', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Aggregate' },
    { key: 'contrast', label: 'Contrast', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Aggregate' },
    { key: 'veining', label: 'Veining', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Aggregate', description: 'The soft marble-imitation swirl the better slabs are printed with.' },
    { key: 'sparkleAmount', label: 'Mirror Flecks', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Aggregate', description: 'Ground glass mixed into the batch. Small, bright and specular rather than coloured.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.07, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const cs = p.float('chipScale')

    const cells = voronoi2(ctx.uv.mul(cs).add(vec2(offset, offset)), float(0.95))
    const id = voronoiCellValue(cells)
    const present = smoothstep(p.float('chipDensity').oneMinus(), p.float('chipDensity').oneMinus().add(0.1), id)
    const body = smoothstep(float(0), float(0.08), voronoiBorder(cells))
    const chip = present.mul(body)

    const vein = fbm01(warp(vec3(ctx.uv.mul(2.2), offset.add(19)), 0.5, 1.4), 4, 2.1, 0.55)
    const aggregate = mix(p.color('chipA'), p.color('chipB'), hash21(cells.zw.add(vec2(5.5, 2.1))).mul(p.float('contrast')))
    const surface = mix(
      p.color('binder').mul(mix(float(1), mix(float(0.86), float(1.06), vein), p.float('veining'))),
      aggregate,
      chip,
    )

    const flecks = sparkle(ctx.uv, cs.mul(2.4), offset.add(31), float(0.09)).mul(p.float('sparkleAmount'))

    return {
      baseColor: tintVariation(surface, id, 0.006, 0.08, 0.1).add(flecks.mul(0.25)),
      metallic: float(0),
      // The slab is polished dead flat: only the resin/quartz index difference
      // and the mirror flecks disturb the roughness. There is no normal at all.
      roughness: p.float('roughness').add(chip.mul(0.02)).sub(flecks.mul(0.05)).clamp(0.01, 1),
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

export const STONE = [granite, sandstone, slate, limestone, basaltColumns, travertine, quartzCountertop]
