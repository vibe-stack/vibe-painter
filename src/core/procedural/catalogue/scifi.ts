/**
 * Hard-surface science fiction: hull plate, tech panel, circuitry, trim.
 *
 * The family rule here is the opposite of the organic ones. Everything is
 * machined, so the *pattern* must be exact - straight edges, right angles,
 * repeating modules - and all the life has to come from what happened to it
 * afterwards: paint chipped off an edge, grime settled in a recess, one panel
 * replaced with a slightly different batch of metal.
 *
 * That split is why these materials build a clean panel field first and then
 * apply wear as a second pass driven by the panel field's own edges. Wear that
 * ignores the panel layout is the thing that makes sci-fi surfaces look like a
 * noise texture with rectangles drawn on top.
 */

import { Fn, float, max, min, mix, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2, V3 } from '../../gpu/nodes'
import {
  cavityAO,
  fbm01,
  hash21,
  hexGrid,
  microVariation,
  normalFromHeightFn,
  scratches,
  tintVariation,
  voronoi2,
  warp,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(31.7)

/** Vertical faces only: grime runs down a hull, it does not run across a deck. */
function gravityWeight(ctx: MatContext): number {
  return ctx.axis === 1 ? 0 : 1
}

/**
 * A recursively split rectangular panel field.
 *
 * Splitting a cell twice, each time on the axis chosen by its own hash, gives
 * panels of genuinely different proportions that still tile without gaps. A
 * plain grid gives one panel size and reads as graph paper; a Voronoi gives
 * angled seams, which no fabricator would ever cut.
 *
 * Given a WGSL layout rather than left to inline. The split loop unrolls into
 * a lot of arithmetic, the material evaluates it from three places, and under
 * triplanar that is nine copies: inlined, this one function made hull plating
 * the largest shader in the catalogue by a factor of two. As a real function it
 * is emitted once, for identical output.
 *
 * Returns `(edge, id.x, id.y)` - the only parts anything downstream reads.
 */
const panelFieldFn = /*#__PURE__*/ Fn(([uvNode, scale, offset, irregularity]: [V2, F, F, F]): V3 => {
  const g = uvNode.mul(scale)
  let cell: V2 = vec2(g.x.floor(), g.y.floor())
  let local: V2 = vec2(g.x.fract(), g.y.fract())
  let size: V2 = vec2(1, 1)

  for (let level = 0; level < 2; level++) {
    const h = hash21(cell.add(vec2(offset.add(level * 7), offset)))
    // Split the longer axis unless the hash says otherwise, so panels stay
    // plausible rather than degenerating into slivers.
    const splitX = step(h, float(0.5))
    const doSplit = step(hash21(cell.add(vec2(offset.add(level * 13 + 3), offset.add(2)))), irregularity)

    const half = mix(float(0.5), h.mul(0.4).add(0.3), irregularity)
    // Which side of the split this point falls on.
    const pickX = step(half, local.x).mul(splitX).mul(doSplit)
    const pickY = step(half, local.y).mul(splitX.oneMinus()).mul(doSplit)

    const lowX = mix(half, float(1).sub(half), pickX)
    const lowY = mix(half, float(1).sub(half), pickY)

    const nx = mix(local.x, mix(local.x.div(max(half, float(1e-3))), local.x.sub(half).div(max(float(1).sub(half), float(1e-3))), pickX), splitX.mul(doSplit))
    const ny = mix(local.y, mix(local.y.div(max(half, float(1e-3))), local.y.sub(half).div(max(float(1).sub(half), float(1e-3))), pickY), splitX.oneMinus().mul(doSplit))

    const sx = mix(size.x, size.x.mul(lowX), splitX.mul(doSplit))
    const sy = mix(size.y, size.y.mul(lowY), splitX.oneMinus().mul(doSplit))

    // Fold the branch taken into the id so sibling panels hash differently.
    cell = cell.add(vec2(pickX.mul(0.37).add(splitX.mul(0.11)), pickY.mul(0.53).add(doSplit.mul(0.19))).mul(level + 1))
    local = vec2(nx, ny)
    size = vec2(sx, sy)
  }

  // Distance to the panel edge, corrected for the panel's own size so a small
  // panel does not get a proportionally huge seam.
  const dx = min(local.x, local.x.oneMinus()).mul(size.x)
  const dy = min(local.y, local.y.oneMinus()).mul(size.y)
  return vec3(min(dx, dy), cell.x, cell.y)
}).setLayout({
  name: 'panelField',
  type: 'vec3',
  inputs: [
    { name: 'uv', type: 'vec2' },
    { name: 'scale', type: 'float' },
    { name: 'offset', type: 'float' },
    { name: 'irregularity', type: 'float' },
  ],
})

function panelField(uvNode: V2, scale: F, offset: F, irregularity: F): { edge: F; id: V2 } {
  const r = panelFieldFn(uvNode, scale, offset, irregularity)
  return { edge: r.x, id: vec2(r.y, r.z) }
}

export const hullPlating = registerMaterial({
  id: 'hull-plating',
  name: 'Hull Plating',
  category: 'Sci-Fi',
  description:
    'Riveted armour plate. Panels are split recursively so no two are the same size, each sits at its own height in the hull, and each carries its own batch of metal - so the seams read as assembly rather than as a texture grid. Rivets follow the panel edge they belong to.',
  params: [
    { key: 'scale', label: 'Panel Scale', type: 'float', default: 5, min: 0.5, max: 40, step: 0.1, group: 'Panels' },
    { key: 'irregularity', label: 'Irregularity', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Panels', description: 'How often a panel splits again. 0 is a plain grid.' },
    { key: 'seam', label: 'Seam Width', type: 'float', default: 0.02, min: 0.002, max: 0.12, step: 0.001, group: 'Panels' },
    { key: 'lippage', label: 'Panel Lippage', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Panels', description: 'How far plates sit proud of each other. A dead-flush hull looks moulded, not built.' },
    { key: 'rivets', label: 'Rivets', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Panels' },
    { key: 'rivetPitch', label: 'Rivet Pitch', type: 'float', default: 26, min: 4, max: 120, step: 0.5, group: 'Panels' },
    { key: 'metalColor', label: 'Metal Colour', type: 'color', default: [0.44, 0.46, 0.49], group: 'Colour' },
    { key: 'paintColor', label: 'Paint Colour', type: 'color', default: [0.28, 0.33, 0.38], group: 'Colour' },
    { key: 'paint', label: 'Paint Coverage', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'chipping', label: 'Edge Chipping', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Paint comes off an arris before it comes off a face, so this is driven by the panel edges.' },
    { key: 'grime', label: 'Grime', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'scratched', label: 'Scratches', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'batchVariation', label: 'Batch Variation', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.45, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const panelAt = (uvNode: V2) => panelField(uvNode, scale, offset, p.float('irregularity'))

    /** Domed rivet heads, spaced along a band just inside each panel edge. */
    const rivetAt = (uvNode: V2): F => {
      const grid = uvNode.mul(p.float('rivetPitch'))
      const local = vec2(grid.x.fract().sub(0.5), grid.y.fract().sub(0.5))
      const head = smoothstep(float(0.26), float(0.05), local.length())
      const panel = panelAt(uvNode)
      // Only in the band that runs around each panel, not across its face.
      const band = smoothstep(p.float('seam').mul(0.8), p.float('seam').mul(1.6), panel.edge)
        .mul(smoothstep(p.float('seam').mul(4.5), p.float('seam').mul(2.2), panel.edge))
      return head.mul(band).mul(p.float('rivets'))
    }

    const heightAt = (uvNode: V2): F => {
      const panel = panelAt(uvNode)
      const seam = p.float('seam')
      const gap = smoothstep(seam.mul(0.4), seam, panel.edge)
      // Each plate sits at its own depth in the hull.
      const lippage = hash21(panel.id.add(vec2(offset.add(5), offset)))
        .sub(0.5)
        .mul(p.float('lippage'))
        .mul(0.3)
      const dents = fbm01(vec3(uvNode.mul(scale.mul(2.5)), offset.add(11)), 3, 2.1, 0.55).sub(0.5).mul(0.08)
      return gap.mul(float(0.55).add(lippage)).add(rivetAt(uvNode).mul(0.35)).add(dents.mul(gap))
    }

    const panel = panelAt(ctx.uv)
    const seam = p.float('seam')
    const gap = smoothstep(seam.mul(0.4), seam, panel.edge)
    const rivet = rivetAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, 1.4)
    const h = heightAt(ctx.uv)
    const h01 = h.clamp(0, 1)

    // Each plate came from its own batch, so its metal is a slightly different
    // alloy tone and its paint a slightly different mix.
    const batch = hash21(panel.id.add(vec2(offset.add(29), offset.add(3))))
    const metal = tintVariation(p.color('metalColor'), batch, 0.008, 0.12, p.float('batchVariation').mul(0.3))
    const paintBase = tintVariation(p.color('paintColor'), batch, 0.015, 0.18, p.float('batchVariation').mul(0.35))

    /**
     * Chipping. The mask is the panel edge distance pushed around by noise, so
     * the paint tears back from the arris irregularly instead of stopping on a
     * clean offset line.
     */
    const chipNoise = fbm01(vec3(ctx.uv.mul(scale.mul(14)), offset.add(37)), 4, 2.2, 0.55)
    const edgeProximity = smoothstep(seam.mul(6), seam.mul(1.2), panel.edge)
    const chipped = smoothstep(float(0.42), float(0.6), chipNoise.mul(0.55).add(edgeProximity.mul(0.6)))
      .mul(p.float('chipping'))
    const painted = p.float('paint').mul(chipped.oneMinus()).mul(gap)

    const scratch = scratches(ctx.uv.mul(scale.mul(0.5)), float(0.6), float(7), float(60)).mul(p.float('scratched'))

    // Grime runs down from every seam and pools in them.
    const gravity = gravityWeight(ctx)
    const streaks =
      gravity === 0
        ? fbm01(vec3(ctx.uv.mul(scale.mul(3)), offset.add(53)), 3, 2, 0.5).mul(0.4)
        : fbm01(vec3(ctx.uv.x.mul(scale.mul(6)), ctx.uv.y.mul(scale.mul(0.7)), offset.add(53)), 4, 2.1, 0.55)
    const grime = smoothstep(float(0.45), float(0.85), streaks)
      .mul(gap.oneMinus().mul(0.5).add(0.5))
      .mul(p.float('grime'))

    const surface = mix(metal, paintBase, painted)
    const withScratch = mix(surface, metal.mul(1.15), scratch.mul(painted).mul(0.7))
    const colour = mix(withScratch, vec3(0.09, 0.085, 0.08), grime.mul(0.6)).mul(mix(float(0.35), float(1), gap))

    const micro = microVariation(ctx.uv, scale.mul(20), offset.add(19))

    return {
      baseColor: colour,
      // Bare metal is conductive; paint over it is not. Chipping therefore has
      // to move metalness, not just colour - that is what makes a chip read as
      // exposed metal rather than as a differently coloured patch of paint.
      metallic: painted.oneMinus().mul(gap).clamp(0, 1),
      roughness: p
        .float('roughness')
        .add(micro.sub(0.5).mul(0.12))
        .add(grime.mul(0.3))
        .sub(painted.mul(0.12))
        .sub(scratch.mul(0.1))
        .add(rivet.mul(0.05))
        .clamp(0.06, 1),
      ao: cavityAO(h01, normal, 0.8),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const hexTechPanel = registerMaterial({
  id: 'hex-tech-panel',
  name: 'Hex Tech Panel',
  category: 'Sci-Fi',
  description:
    'A hexagonal tile field with lit trim in the gaps. Only a fraction of the cells are powered, and which ones is a hash of the cell id - so the lit pattern is stable, sparse and readable rather than a uniform glow that flattens the whole surface.',
  params: [
    { key: 'scale', label: 'Cell Scale', type: 'float', default: 12, min: 1, max: 80, step: 0.25, group: 'Layout' },
    { key: 'gap', label: 'Gap Width', type: 'float', default: 0.08, min: 0.01, max: 0.4, step: 0.001, group: 'Layout' },
    { key: 'bevel', label: 'Bevel', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'inset', label: 'Inset Cells', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Fraction of cells recessed into the panel rather than flush with it.' },
    { key: 'panelColor', label: 'Panel Colour', type: 'color', default: [0.13, 0.14, 0.16], group: 'Colour' },
    { key: 'trimColor', label: 'Trim Colour', type: 'color', default: [0.3, 0.32, 0.35], group: 'Colour' },
    { key: 'glowColor', label: 'Glow Colour', type: 'color', default: [0.15, 0.75, 1], group: 'Glow' },
    { key: 'lit', label: 'Lit Fraction', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Glow' },
    { key: 'glow', label: 'Glow Strength', type: 'float', default: 3, min: 0, max: 30, step: 0.05, group: 'Glow' },
    { key: 'metallic', label: 'Metallic', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'wear', label: 'Wear', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.3, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const cellAt = (uvNode: V2) => {
      const hex = hexGrid(uvNode.mul(scale).add(vec2(offset, offset)))
      const local = vec2(hex.x, hex.y)
      // Hex distance: the max over the three lattice directions, which is what
      // gives a flat-sided cell instead of a circle.
      const q = local.abs()
      const d = max(q.x.mul(0.8660254).add(q.y.mul(0.5)), q.y)
      return { d, id: vec2(hex.z, hex.w) }
    }

    const heightAt = (uvNode: V2): F => {
      const cell = cellAt(uvNode)
      const g = p.float('gap')
      const face = smoothstep(float(0.5), float(0.5).sub(g), cell.d)
      const bevelled = smoothstep(float(0.5).sub(g), float(0.5).sub(g).sub(p.float('bevel').mul(0.12)), cell.d)
      const recessed = step(hash21(cell.id.add(vec2(offset.add(7), offset))), p.float('inset'))
      const plate = mix(face.mul(0.35).add(bevelled.mul(0.65)), float(0.25), recessed)
      const panelNoise = fbm01(vec3(uvNode.mul(scale.mul(4)), offset.add(3)), 3, 2.1, 0.55).sub(0.5).mul(0.04)
      return plate.add(panelNoise)
    }

    const cell = cellAt(ctx.uv)
    const g = p.float('gap')
    const face = smoothstep(float(0.5), float(0.5).sub(g), cell.d)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, 1.2)
    const h = heightAt(ctx.uv)
    const h01 = h.clamp(0, 1)

    // Only some cells are powered, and the trim around them carries the light.
    const powered = step(hash21(cell.id.add(vec2(offset.add(19), offset.add(5)))), p.float('lit'))
    const trim = face.oneMinus().mul(smoothstep(float(0.5).add(g.mul(1.6)), float(0.5), cell.d))
    const glowMask = trim.mul(powered)
    // A slow pulse in brightness per cell, so the array is not uniformly lit.
    const cellBrightness = hash21(cell.id.add(vec2(offset.add(31), offset.add(2)))).mul(0.5).add(0.5)

    const wear = smoothstep(float(0.5), float(0.85), fbm01(vec3(ctx.uv.mul(scale.mul(2.2)), offset.add(41)), 4, 2.2, 0.55))
      .mul(p.float('wear'))
    const panelColour = tintVariation(
      p.color('panelColor'),
      hash21(cell.id.add(vec2(offset.add(11), offset.add(3)))),
      0.006,
      0.1,
      0.16,
    )
    const base = mix(p.color('trimColor'), panelColour, face)
    const colour = mix(base, base.mul(1.25).add(vec3(0.02, 0.02, 0.02)), wear.mul(0.5))
    const glow = p.color('glowColor').mul(cellBrightness)

    return {
      baseColor: mix(colour, glow.mul(0.4), glowMask),
      metallic: p.float('metallic').mul(face.mul(0.7).add(0.3)).mul(glowMask.oneMinus()).clamp(0, 1),
      roughness: p.float('roughness').add(wear.mul(0.35)).sub(face.mul(0.06)).clamp(0.04, 1),
      ao: cavityAO(h01, normal, 0.75),
      height: h01,
      normal,
      emissive: glow.mul(glowMask.mul(p.float('glow'))),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const circuitBoard = registerMaterial({
  id: 'circuit-board',
  name: 'Circuit Board',
  category: 'Sci-Fi',
  description:
    'Copper traces on solder mask. The traces run on a grid and turn at right angles, because that is what a router does - the diagonal, organic "circuit noise" you get from thresholding an fbm is the one thing that never reads as a real board. Pads and vias sit on the same grid.',
  params: [
    { key: 'scale', label: 'Trace Density', type: 'float', default: 22, min: 2, max: 120, step: 0.5, group: 'Traces' },
    { key: 'traceWidth', label: 'Trace Width', type: 'float', default: 0.14, min: 0.02, max: 0.45, step: 0.001, group: 'Traces' },
    { key: 'density', label: 'Routing Density', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Traces' },
    { key: 'pads', label: 'Pads', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Traces' },
    { key: 'maskColor', label: 'Solder Mask', type: 'color', default: [0.04, 0.16, 0.09], group: 'Colour' },
    { key: 'copperColor', label: 'Copper', type: 'color', default: [0.72, 0.45, 0.2], group: 'Colour' },
    { key: 'silkColor', label: 'Silkscreen', type: 'color', default: [0.86, 0.87, 0.84], group: 'Colour' },
    { key: 'silk', label: 'Silkscreen', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'tarnish', label: 'Tarnish', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'relief', label: 'Trace Relief', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * Manhattan routing.
     *
     * Each grid cell independently decides whether it carries a horizontal
     * run, a vertical run, or both - so runs join into long straight tracks
     * with square corners, exactly like a routed board. The per-cell decision
     * is a hash, which keeps it stable and free of any accumulation.
     */
    const traceAt = (uvNode: V2) => {
      const g = uvNode.mul(scale)
      const id = vec2(g.x.floor(), g.y.floor())
      const local = vec2(g.x.fract().sub(0.5), g.y.fract().sub(0.5))
      const w = p.float('traceWidth')

      const hasH = step(hash21(id.add(vec2(offset, offset))), p.float('density'))
      const hasV = step(hash21(id.add(vec2(offset.add(7), offset.add(3)))), p.float('density'))

      // A run is a bar through the cell centre; two crossing bars make a corner.
      const horizontal = smoothstep(w, w.mul(0.6), local.y.abs()).mul(hasH)
      const vertical = smoothstep(w, w.mul(0.6), local.x.abs()).mul(hasV)
      // Cells with only one run stop at the centre rather than crossing it.
      const trace = max(horizontal, vertical)

      // Pads sit on the grid crossings, so they always land on a trace.
      const padHere = step(hash21(id.add(vec2(offset.add(13), offset.add(5)))), p.float('pads'))
      const padRadius = w.mul(2.4)
      const pad = smoothstep(padRadius, padRadius.mul(0.75), local.length()).mul(padHere)
      // The drilled hole through the middle of a via.
      const hole = smoothstep(padRadius.mul(0.4), padRadius.mul(0.25), local.length()).mul(padHere)

      return { copper: max(trace, pad).sub(hole).clamp(0, 1), hole, pad, id, local }
    }

    const silkAt = (uvNode: V2): F => {
      // Silkscreen outlines: thin rectangles on a coarser grid.
      const g = uvNode.mul(scale.mul(0.34));
      const id = vec2(g.x.floor(), g.y.floor())
      const local = vec2(g.x.fract().sub(0.5).abs(), g.y.fract().sub(0.5).abs())
      const box = max(local.x, local.y)
      const present = step(hash21(id.add(vec2(offset.add(23), offset))), p.float('silk'))
      return smoothstep(float(0.34), float(0.3), box).mul(smoothstep(float(0.26), float(0.3), box)).mul(present)
    }

    const heightAt = (uvNode: V2): F => {
      const t = traceAt(uvNode)
      const board = fbm01(vec3(uvNode.mul(scale.mul(6)), offset.add(17)), 3, 2.2, 0.55).sub(0.5).mul(0.08)
      return t.copper.mul(0.7).sub(t.hole.mul(0.9)).add(silkAt(uvNode).mul(0.15)).add(board).mul(p.float('relief'))
    }

    const t = traceAt(ctx.uv)
    const silk = silkAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(2))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('relief'), float(1e-3))).mul(0.5).add(0.5).clamp(0, 1)

    // Copper oxidises unevenly; the tarnish is what stops it looking chromed.
    const tarnishField = fbm01(vec3(ctx.uv.mul(scale.mul(1.6)), offset.add(29)), 4, 2.1, 0.55)
    const tarnish = smoothstep(float(0.4), float(0.75), tarnishField).mul(p.float('tarnish'))
    const copper = mix(p.color('copperColor'), p.color('copperColor').mul(vec3(0.5, 0.62, 0.55)), tarnish)

    const maskColour = p
      .color('maskColor')
      .mul(mix(float(0.85), float(1.15), fbm01(vec3(ctx.uv.mul(scale.mul(3)), offset.add(11)), 3, 2, 0.5)))

    let colour = mix(maskColour, copper, t.copper)
    colour = mix(colour, p.color('silkColor'), silk)
    colour = mix(colour, vec3(0.02, 0.02, 0.02), t.hole)

    return {
      baseColor: colour,
      metallic: t.copper.mul(tarnish.oneMinus().mul(0.6).add(0.4)).mul(silk.oneMinus()).clamp(0, 1),
      // Solder mask is a semi-gloss lacquer, silkscreen is flat ink, and
      // copper sits between the two depending on how far it has tarnished.
      roughness: mix(float(0.42), float(0.22), t.copper)
        .add(tarnish.mul(0.35).mul(t.copper))
        .add(silk.mul(0.4))
        .add(p.float('roughness').sub(0.35))
        .clamp(0.05, 1),
      ao: cavityAO(h01, normal, 0.7),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const wornHullPaint = registerMaterial({
  id: 'worn-hull-paint',
  name: 'Worn Hull Paint',
  category: 'Sci-Fi',
  description:
    'Two coats over bare alloy, wearing through in the order they were applied: primer shows before metal does, and both show at the edges before the middle. Layering the wear like that is the whole trick - a single chipping mask gives paint sitting directly on metal, which never happens.',
  params: [
    { key: 'scale', label: 'Wear Scale', type: 'float', default: 6, min: 0.5, max: 40, step: 0.1, group: 'Wear' },
    { key: 'wear', label: 'Wear Amount', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'chipSharpness', label: 'Chip Sharpness', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Hard edges are impact damage; soft edges are abrasion.' },
    { key: 'scratched', label: 'Scratches', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'topColor', label: 'Top Coat', type: 'color', default: [0.62, 0.19, 0.14], group: 'Colour' },
    { key: 'primerColor', label: 'Primer', type: 'color', default: [0.5, 0.44, 0.28], group: 'Colour' },
    { key: 'metalColor', label: 'Alloy', type: 'color', default: [0.5, 0.51, 0.53], group: 'Colour' },
    { key: 'grime', label: 'Grime', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'relief', label: 'Coat Thickness', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.4, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * One continuous "exposure" field, thresholded twice.
     *
     * Using a single field for both coats is what guarantees the primer always
     * surrounds the bare metal: wherever the field is high enough to remove the
     * alloy's covering it is necessarily high enough to have removed the top
     * coat first. Two independent masks would put top coat inside a chip.
     */
    const exposureAt = (uvNode: V2): F => {
      const w = warp(vec3(uvNode.mul(scale), offset), 0.5, 1.4)
      const broad = fbm01(w, 4, 2.1, 0.55)
      const fine = fbm01(vec3(uvNode.mul(scale.mul(7)), offset.add(13)), 4, 2.4, 0.55)
      // The fine field cuts the ragged edge of each chip.
      return broad.mul(0.72).add(fine.mul(0.28)).add(p.float('wear').sub(0.5).mul(0.6))
    }

    const heightAt = (uvNode: V2): F => {
      const e = exposureAt(uvNode)
      const sharp = mix(float(0.14), float(0.03), p.float('chipSharpness'))
      const topCoat = smoothstep(float(0.55).add(sharp), float(0.55), e)
      const primer = smoothstep(float(0.72).add(sharp), float(0.72), e)
      // Each coat is a physical thickness, so losing one steps the surface down.
      return topCoat.mul(0.55).add(primer.mul(0.45)).mul(p.float('relief'))
    }

    const e = exposureAt(ctx.uv)
    const sharp = mix(float(0.14), float(0.03), p.float('chipSharpness'))
    const hasTop = smoothstep(float(0.55).add(sharp), float(0.55), e)
    const hasPrimer = smoothstep(float(0.72).add(sharp), float(0.72), e)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(2.4))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('relief'), float(1e-3))).clamp(0, 1)

    const scratch = scratches(ctx.uv.mul(scale.mul(0.6)), float(0.9), float(9), float(70)).mul(p.float('scratched'))
    const metal = p.color('metalColor').mul(mix(float(0.9), float(1.1), microVariation(ctx.uv, scale.mul(12), offset)))
    const primerColour = p.color('primerColor')
    const topColour = tintVariation(p.color('topColor'), microVariation(ctx.uv, scale.mul(1.5), offset.add(3)), 0.008, 0.12, 0.14)

    // Applied in reverse order: metal, then primer over it, then top coat.
    let colour = metal
    colour = mix(colour, primerColour, hasPrimer)
    colour = mix(colour, topColour, hasTop)
    // A deep scratch cuts straight through both coats to the alloy.
    colour = mix(colour, metal.mul(1.2), scratch.mul(hasTop).mul(0.8))

    const gravity = gravityWeight(ctx)
    const grimeField =
      gravity === 0
        ? fbm01(vec3(ctx.uv.mul(scale.mul(2)), offset.add(31)), 3, 2, 0.5)
        : fbm01(vec3(ctx.uv.x.mul(scale.mul(4)), ctx.uv.y.mul(scale.mul(0.5)), offset.add(31)), 4, 2.1, 0.55)
    const grime = smoothstep(float(0.48), float(0.82), grimeField).mul(p.float('grime'))

    const bare = hasTop.oneMinus().max(scratch.mul(hasTop))
    const exposedMetal = hasPrimer.oneMinus().max(scratch.mul(0.8)).clamp(0, 1)

    return {
      baseColor: mix(colour, vec3(0.08, 0.075, 0.07), grime.mul(0.5)),
      metallic: exposedMetal,
      // Paint is smoother than primer, and primer is smoother than raw alloy.
      roughness: mix(float(0.62), p.float('roughness'), hasTop)
        .add(bare.mul(0.12))
        .add(grime.mul(0.25))
        .sub(scratch.mul(0.15))
        .clamp(0.05, 1),
      ao: cavityAO(h01, normal, 0.6),
      height: h01,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const energyTrim = registerMaterial({
  id: 'energy-trim',
  name: 'Energy Trim',
  category: 'Sci-Fi',
  description:
    'Conduit channels cut into a dark casing with something bright running through them. The channel is a recess, the glow sits at the bottom of it, and the casing around the lip picks up bounced light - so the emission reads as coming *from inside the surface* rather than being painted onto it.',
  params: [
    { key: 'scale', label: 'Channel Scale', type: 'float', default: 4, min: 0.5, max: 30, step: 0.1, group: 'Layout' },
    { key: 'width', label: 'Channel Width', type: 'float', default: 0.06, min: 0.005, max: 0.3, step: 0.001, group: 'Layout' },
    { key: 'branching', label: 'Branching', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'How much the conduit network wanders and splits rather than running straight.' },
    { key: 'nodes', label: 'Junction Nodes', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Layout' },
    { key: 'casingColor', label: 'Casing', type: 'color', default: [0.07, 0.075, 0.085], group: 'Colour' },
    { key: 'glowColor', label: 'Glow Colour', type: 'color', default: [0.25, 0.85, 0.95], group: 'Glow' },
    { key: 'coreColor', label: 'Core Colour', type: 'color', default: [0.9, 1, 1], group: 'Glow' },
    { key: 'glow', label: 'Glow Strength', type: 'float', default: 6, min: 0, max: 40, step: 0.05, group: 'Glow' },
    { key: 'bounce', label: 'Bounce Light', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Glow', description: 'How far the light spills onto the casing around each channel.' },
    { key: 'depth', label: 'Channel Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.32, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * The conduit network: Voronoi *borders*, which give a connected graph of
     * lines that actually meet at junctions. Thresholded noise gives blobs
     * that never connect, and a grid gives something that reads as tiling.
     */
    const conduitAt = (uvNode: V2) => {
      const w = warp(vec3(uvNode.mul(scale), offset), p.float('branching').mul(0.5), 1.2)
      const cells = voronoi2(vec2(w.x, w.y).add(vec2(offset, offset)), float(0.85))
      const border = cells.y.sub(cells.x)
      const line = smoothstep(p.float('width'), float(0), border)
      // Nodes sit on the junctions, where three cells meet and f2-f1 is
      // smallest across a wider area.
      const node = smoothstep(p.float('width').mul(2.4), float(0), border)
        .mul(step(hash21(cells.zw.add(vec2(offset.add(11), offset))), p.float('nodes')))
      return { line: max(line, node.mul(0.9)), border, id: cells.zw }
    }

    const heightAt = (uvNode: V2): F => {
      const c = conduitAt(uvNode)
      const casing = fbm01(vec3(uvNode.mul(scale.mul(8)), offset.add(7)), 3, 2.2, 0.55).sub(0.5).mul(0.06)
      // The channel is cut *into* the casing.
      return float(1).sub(c.line.mul(0.85)).add(casing).mul(p.float('depth'))
    }

    const c = conduitAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.2))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1)

    // The core is the very centre of the channel; the rest is falloff.
    const core = smoothstep(p.float('width').mul(0.45), float(0), c.border)
    const spill = smoothstep(p.float('width').mul(3.5), p.float('width'), c.border).mul(p.float('bounce'))
    // Energy is not steady: it varies along the run.
    const flow = fbm01(vec3(ctx.uv.mul(scale.mul(2.5)), offset.add(23)), 3, 2.1, 0.55).mul(0.55).add(0.45)

    const glowColour = mix(p.color('glowColor'), p.color('coreColor'), core.mul(flow))
    const casing = tintVariation(
      p.color('casingColor'),
      hash21(c.id.add(vec2(offset.add(19), offset.add(3)))),
      0.004,
      0.08,
      0.14,
    )
    // Bounce light on the lip of the channel, in albedo rather than emission -
    // it is reflected light, so it should still respond to the scene.
    const litCasing = casing.add(p.color('glowColor').mul(spill.mul(0.12)))

    const micro = microVariation(ctx.uv, scale.mul(16), offset.add(29))

    return {
      baseColor: mix(litCasing, glowColour.mul(0.35), c.line),
      metallic: c.line.oneMinus().mul(0.65),
      roughness: p.float('roughness').add(micro.sub(0.5).mul(0.14)).sub(c.line.mul(0.18)).clamp(0.04, 1),
      ao: cavityAO(h01, normal, 0.55),
      height: h01,
      normal,
      emissive: glowColour.mul(c.line.mul(flow).mul(p.float('glow'))).add(
        p.color('glowColor').mul(spill.mul(flow).mul(p.float('glow')).mul(0.06)),
      ),
    }
  },
} satisfies ProceduralMaterialDef)

export const SCIFI = [hullPlating, hexTechPanel, circuitBoard, wornHullPaint, energyTrim]
