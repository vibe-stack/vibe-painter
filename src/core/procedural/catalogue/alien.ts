/**
 * Sci-fi, part two: the surfaces a hard-surface panel set does not cover -
 * grown structures, emissive displays, machinery guts.
 *
 * Emission is the tool that makes this category its own thing, and the rule
 * that keeps it from looking like a light-up toy is that an emissive surface
 * still has a *material* underneath. A dark display panel is glass with dust
 * on it; a glowing vein is wet tissue. Writing base colour, roughness and
 * normal as carefully as for anything else, then adding emission last, is
 * what makes the light look like it is coming out of something.
 */

import { abs, float, fract, max, min, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  cavityAO,
  cracks,
  fbm01,
  gradient3,
  hash21,
  hexGrid,
  microVariation,
  normalFromHeightFn,
  ridged,
  scratches,
  sparkle,
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

// ---------------------------------------------------------------------------

export const alienHive = registerMaterial({
  id: 'alien-hive',
  name: 'Alien Hive',
  category: 'Sci-Fi',
  description: 'Resin secreted over a structure until it is buried: ribbed, wet, and organised into strands that run in one direction because they were laid down by something moving. Domain-warping a ridged field along a flow direction is the difference between "biological" and "lumpy noise".',
  params: [
    { key: 'resinDark', label: 'Resin Deep', type: 'color', default: [0.06, 0.05, 0.06], group: 'Colour' },
    { key: 'resinMid', label: 'Resin', type: 'color', default: [0.17, 0.14, 0.15], group: 'Colour' },
    { key: 'membrane', label: 'Membrane', type: 'color', default: [0.36, 0.2, 0.22], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.1, group: 'Structure' },
    { key: 'flow', label: 'Strand Flow', type: 'float', default: 0.8, min: 0, max: 3, step: 0.01, group: 'Structure', description: 'How strongly the strands follow one direction. Zero gives foam; higher gives sinew.' },
    { key: 'ribs', label: 'Ribbing', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Structure' },
    { key: 'depth', label: 'Relief', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Structure' },
    { key: 'pods', label: 'Pods', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Structure', description: 'Swollen chambers embedded in the resin, thinner and warmer than the mass around them.' },
    { key: 'wetness', label: 'Wetness', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'glow', label: 'Inner Glow', type: 'float', default: 0.25, min: 0, max: 2, step: 0.01, group: 'Surface' },
    { key: 'glowColor', label: 'Glow', type: 'color', default: [0.7, 0.25, 0.3], group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const strandAt = (uvNode: V2): F => {
      // Stretch first, then warp: stretching makes the strands directional,
      // warping makes them wander like something that was extruded by hand.
      const stretched = vec3(uvNode.x.mul(scale), uvNode.y.mul(scale).mul(0.35), offset)
      const warped = warp(stretched, p.float('flow'), 0.9)
      return ridged(warped, float(4), float(0.6))
    }

    const podAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(scale.mul(0.7)).add(vec2(offset.add(7), offset)), float(0.9))
      return smoothstep(float(0.78), float(0.9), voronoiCellValue(cells))
        .mul(smoothstep(float(0.36), float(0.1), cells.x))
        .mul(p.float('pods'))
    }

    const heightAt = (uvNode: V2): F => {
      const strand = strandAt(uvNode)
      const rib = sin(strand.mul(scale.mul(3))).mul(0.5).add(0.5).mul(p.float('ribs')).mul(0.12)
      const pod = podAt(uvNode).mul(0.25)
      return strand.mul(p.float('depth')).mul(0.5).add(rib).add(pod)
    }

    const strand = strandAt(ctx.uv)
    const pod = podAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2).add(0.2))
    const h = heightAt(ctx.uv)

    const resin = gradient3(strand.clamp(0, 1), p.color('resinDark'), p.color('resinMid'), p.color('membrane'))
    const colour = mix(resin, p.color('membrane'), pod.mul(0.8))

    return {
      baseColor: tintVariation(colour, fbm01(coord3(ctx, scale.mul(2)).add(23), 3, 2, 0.5), 0.02, 0.2, 0.2),
      metallic: float(0),
      // Wet organic surfaces are glossy in the hollows, where the fluid pools,
      // and drier on the exposed ridges - the opposite of a varnished object.
      roughness: mix(float(0.75), float(0.12), p.float('wetness').mul(h.oneMinus().clamp(0, 1).mul(0.6).add(0.4)))
        .add(microVariation(ctx.uv, scale.mul(20), offset).sub(0.5).mul(0.1))
        .clamp(0.03, 1),
      // The glow comes from inside the pods, so it follows their mask, not the
      // surface pattern.
      emissive: p.color('glowColor').mul(pod.mul(p.float('glow'))),
      ao: cavityAO(h.mul(1.5).add(0.4).clamp(0, 1), normal, 0.8),
      height: h.add(0.35).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const holoPanel = registerMaterial({
  id: 'holo-panel',
  name: 'Holo Display',
  category: 'Sci-Fi',
  description: 'A dark display running an interface. The whole trick is that the panel is a real object first: glass with dust, fingerprints and a bezel reflection, and only then a grid of lit elements. A display drawn as pure emission always looks pasted on.',
  params: [
    { key: 'glass', label: 'Glass', type: 'color', default: [0.02, 0.025, 0.03], group: 'Colour' },
    { key: 'uiColor', label: 'Interface', type: 'color', default: [0.3, 0.8, 1], group: 'Colour' },
    { key: 'alertColor', label: 'Alert', type: 'color', default: [1, 0.5, 0.15], group: 'Colour' },
    { key: 'cols', label: 'Grid Columns', type: 'float', default: 9, min: 1, max: 60, step: 1, group: 'Interface' },
    { key: 'rows', label: 'Grid Rows', type: 'float', default: 14, min: 1, max: 80, step: 1, group: 'Interface' },
    { key: 'fill', label: 'Element Density', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Interface', description: 'How much of the grid is actually lit. A full grid reads as a texture; a sparse one reads as data.' },
    { key: 'bars', label: 'Bar Graphs', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Interface' },
    { key: 'alerts', label: 'Alerts', type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Interface' },
    { key: 'scanlines', label: 'Scanlines', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Screen' },
    { key: 'glow', label: 'Brightness', type: 'float', default: 1.4, min: 0, max: 5, step: 0.01, group: 'Screen' },
    { key: 'smudge', label: 'Fingerprints', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Screen', description: 'The detail that puts the panel in the room rather than in a compositing pass.' },
    { key: 'dust', label: 'Dust', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Screen' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const q = vec2(ctx.uv.x.mul(p.float('cols')), ctx.uv.y.mul(p.float('rows')))
    const cell = vec2(q.x.floor(), q.y.floor())
    const local = fract(q)
    const id = hash21(cell.add(vec2(offset, offset)))

    // Which cells are lit at all.
    const lit = smoothstep(p.float('fill').oneMinus(), p.float('fill').oneMinus().add(0.05), id)

    // Two element types: a filled block, or a bar whose length is hashed.
    const inset = smoothstep(float(0.06), float(0.12), min(min(local.x, local.x.oneMinus()), min(local.y, local.y.oneMinus())))
    const barLength = hash21(cell.add(vec2(offset.add(3), offset))).mul(0.8).add(0.15)
    const bar = smoothstep(barLength, barLength.sub(0.04), local.x).mul(
      smoothstep(float(0.3), float(0.38), local.y).mul(smoothstep(float(0.7), float(0.62), local.y)),
    )
    const isBar = smoothstep(float(0.45), float(0.55), hash21(cell.add(vec2(offset.add(9), offset.add(2)))))
      .mul(p.float('bars'))
    const element = mix(inset, bar, isBar).mul(lit)

    const isAlert = smoothstep(float(0.9), float(0.96), hash21(cell.add(vec2(offset.add(17), offset)))).mul(p.float('alerts'))
    const uiColour = mix(p.color('uiColor'), p.color('alertColor'), isAlert)

    // Scanlines dim the emission without touching the panel material.
    const scan = mix(float(1), stripes(ctx.uv.y.mul(p.float('rows')).mul(6), float(0.6), float(0.25)).mul(0.4).add(0.7), p.float('scanlines'))

    const smudge = smoothstep(float(0.45), float(0.78), fbm01(coord3(ctx, 8).add(23), 4, 2.2, 0.55)).mul(p.float('smudge'))
    const dust = sparkle(ctx.uv, float(360), offset.add(31), float(0.07)).mul(p.float('dust'))

    const normal = normalFromHeightFn(
      (uvNode) => fbm01(vec3(uvNode.mul(50), offset), 3, 2.2, 0.55).sub(0.5).mul(0.02),
      ctx.uv,
      ctx.texel,
      float(0.25),
    )

    return {
      // The glass keeps its own dark base colour: the lit elements add light,
      // they do not replace the surface.
      baseColor: p.color('glass').add(uiColour.mul(element).mul(0.06)).add(dust.mul(0.1)),
      metallic: float(0),
      roughness: float(0.08).add(smudge.mul(0.3)).add(dust.mul(0.4)).clamp(0.02, 1),
      emissive: uiColour.mul(element).mul(scan).mul(p.float('glow')).mul(smudge.mul(0.3).oneMinus()),
      normal,
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const reactorVent = registerMaterial({
  id: 'reactor-vent',
  name: 'Reactor Vent',
  category: 'Sci-Fi',
  description: 'A louvred vent over something very hot. The heat is a gradient that discolours the metal exactly the way a temper does - straw, blue, then white - and it glows only in the gaps, because that is where you can see through to the source.',
  params: [
    { key: 'metal', label: 'Housing', type: 'color', default: [0.3, 0.31, 0.32], group: 'Colour' },
    { key: 'heatTint', label: 'Heat Tint', type: 'color', default: [0.45, 0.25, 0.12], group: 'Colour' },
    { key: 'glowCool', label: 'Glow Cool', type: 'color', default: [0.8, 0.2, 0.05], group: 'Colour' },
    { key: 'glowHot', label: 'Glow Hot', type: 'color', default: [1, 0.85, 0.5], group: 'Colour' },
    { key: 'louvres', label: 'Louvres', type: 'float', default: 16, min: 1, max: 80, step: 0.5, group: 'Vent' },
    { key: 'gap', label: 'Gap Width', type: 'float', default: 0.3, min: 0.02, max: 0.8, step: 0.01, group: 'Vent' },
    { key: 'bevel', label: 'Blade Bevel', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Vent', description: 'Louvre blades are angled, not square: one edge catches the light and the other is in shadow.' },
    { key: 'heat', label: 'Heat', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Heat' },
    { key: 'heatGradient', label: 'Heat Spread', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Heat', description: 'How far the heat has crept out from the vent into the housing.' },
    { key: 'glow', label: 'Glow Strength', type: 'float', default: 2, min: 0, max: 8, step: 0.05, group: 'Heat' },
    { key: 'soot', label: 'Soot', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const louvreAt = (uvNode: V2) => {
      const q = uvNode.y.mul(p.float('louvres'))
      const local = fract(q)
      const gap = p.float('gap')
      // The blade occupies the part of the cell the gap does not.
      const blade = smoothstep(gap, gap.add(p.float('bevel').mul(0.2).add(0.02)), local)
      // The angled face: one side of the blade rises, the other drops away.
      const tilt = smoothstep(gap, float(1), local).mul(p.float('bevel'))
      return { blade, tilt, local }
    }

    const heightAt = (uvNode: V2): F => {
      const l = louvreAt(uvNode)
      const grain = fbm01(vec3(uvNode.mul(160), offset), 2, 2, 0.5).sub(0.5).mul(0.02)
      return l.blade.mul(float(0.4).add(l.tilt.mul(0.35))).add(grain)
    }

    const l = louvreAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    // Heat is strongest at the vent openings and falls off into the housing.
    const heat = p
      .float('heat')
      .mul(mix(l.blade.oneMinus(), float(1), p.float('heatGradient').mul(0.7)))
      .mul(fbm01(coord3(ctx, 4).add(13), 3, 2, 0.5).mul(0.4).add(0.8))
      .clamp(0, 1)

    const soot = smoothstep(float(0.45), float(0.8), fbm01(coord3(ctx, 9).add(29), 4, 2.1, 0.55))
      .mul(p.float('soot'))
      .mul(l.blade)

    const tempered = mix(p.color('metal'), p.color('heatTint'), heat.mul(0.7))
    const glow = gradient3(heat, p.color('glowCool'), p.color('glowCool'), p.color('glowHot'))

    return {
      baseColor: mix(tempered, vec3(0.03, 0.028, 0.026), soot.mul(0.8)),
      // Soot is carbon on top of metal: it kills the metallic response.
      metallic: soot.mul(0.85).oneMinus(),
      roughness: float(0.42).add(soot.mul(0.45)).add(heat.mul(0.1)).clamp(0.06, 1),
      // Only the gaps glow: through the blades you are looking at metal.
      emissive: glow.mul(l.blade.oneMinus()).mul(heat).mul(p.float('glow')),
      ao: cavityAO(h.mul(2).clamp(0, 1), normal, 0.8),
      height: h.add(0.2).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const cableBundle = registerMaterial({
  id: 'cable-bundle',
  name: 'Cable Bundle',
  category: 'Sci-Fi',
  description: 'Loomed cable running under a panel. Each cable is a cylinder with its own colour and its own specular highlight down its length, and they cross over each other - the crossings are what make it a loom rather than a set of stripes.',
  params: [
    { key: 'jacketA', label: 'Jacket A', type: 'color', default: [0.06, 0.06, 0.07], group: 'Colour' },
    { key: 'jacketB', label: 'Jacket B', type: 'color', default: [0.35, 0.25, 0.08], group: 'Colour' },
    { key: 'jacketC', label: 'Jacket C', type: 'color', default: [0.1, 0.2, 0.3], group: 'Colour' },
    { key: 'backing', label: 'Behind', type: 'color', default: [0.03, 0.03, 0.035], group: 'Colour' },
    { key: 'count', label: 'Cable Count', type: 'float', default: 16, min: 2, max: 90, step: 1, group: 'Loom' },
    { key: 'wander', label: 'Wander', type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, group: 'Loom', description: 'How far the cables drift across each other. Zero is a ribbon cable; higher is a loom.' },
    { key: 'thickness', label: 'Cable Diameter', type: 'float', default: 0.75, min: 0.1, max: 1, step: 0.01, group: 'Loom' },
    { key: 'ties', label: 'Cable Ties', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Loom' },
    { key: 'tiePitch', label: 'Tie Spacing', type: 'float', default: 3, min: 0.3, max: 20, step: 0.1, group: 'Loom' },
    { key: 'gloss', label: 'Jacket Gloss', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'grime', label: 'Grime', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const count = p.float('count')

    const cableAt = (uvNode: V2) => {
      // Each cable's x position drifts along its length, so they weave.
      const drift = fbm01(vec3(uvNode.y.mul(2), uvNode.x.mul(count).floor().mul(0.3), offset), 3, 2, 0.5)
        .sub(0.5)
        .mul(p.float('wander'))
        .mul(0.06)
      const q = uvNode.x.add(drift).mul(count)
      const id = q.floor()
      const local = fract(q).sub(0.5)
      const r = abs(local).mul(2).div(max(p.float('thickness'), float(0.05)))
      // Cylinder cross-section: this is what gives the highlight down the run.
      const round = float(1).sub(r.clamp(0, 1).pow(2)).clamp(0, 1)
      return { id, local, r, round }
    }

    const tieAt = (uvNode: V2): F =>
      smoothstep(float(0.06), float(0), abs(fract(uvNode.y.mul(p.float('tiePitch'))).sub(0.5)))
        .mul(p.float('ties'))

    const heightAt = (uvNode: V2): F => {
      const c = cableAt(uvNode)
      // Alternate cables sit slightly deeper, so the bundle has layers.
      const layer = hash21(vec2(c.id, offset)).mul(0.2)
      const tie = tieAt(uvNode)
      return c.round.mul(float(0.5).sub(layer)).mul(tie.mul(0.25).oneMinus()).add(tie.mul(0.06))
    }

    const c = cableAt(ctx.uv)
    const cover = smoothstep(float(1), float(0.9), c.r)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.5))
    const h = heightAt(ctx.uv)

    const id = hash21(vec2(c.id.add(offset), offset.add(3)))
    const jacket = gradient3(id, p.color('jacketA'), p.color('jacketB'), p.color('jacketC'))
    // A printed stripe or a text band along the jacket, as real cable carries.
    const marking = stripes(ctx.uv.y.mul(40).add(id.mul(10)), float(0.3), float(0.1))
      .mul(smoothstep(float(0.55), float(0.6), id))
      .mul(cover)
    const tie = tieAt(ctx.uv)
    const grime = smoothstep(float(0.5), float(0.85), fbm01(coord3(ctx, 6).add(29), 4, 2.1, 0.55)).mul(p.float('grime'))

    return {
      baseColor: mix(p.color('backing'), tintVariation(jacket, id, 0.01, 0.14, 0.16).add(marking.mul(0.35)), cover)
        .mul(mix(float(1), float(0.62), grime.mul(0.7)))
        .mul(mix(float(1), float(0.5), tie)),
      metallic: float(0),
      // PVC jacket: glossy along the crown of the cylinder, matt at the edges
      // where the surface turns away - a highlight that runs, not a spot.
      roughness: mix(float(0.8), mix(float(0.7), float(0.18), p.float('gloss')), c.round)
        .add(grime.mul(0.25))
        .add(tie.mul(0.2))
        .clamp(0.05, 1),
      ao: cavityAO(h.mul(2).clamp(0, 1), normal, 0.8),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const forceField = registerMaterial({
  id: 'force-field',
  name: 'Force Field',
  category: 'Sci-Fi',
  description: 'A hex-cell energy barrier. It is mostly transparent, so what you see is the cell edges and the interference patterns crossing them - the field is defined by where it is *not* solid, which is why opacity does most of the work here and base colour almost none.',
  params: [
    { key: 'fieldColor', label: 'Field', type: 'color', default: [0.25, 0.65, 1], group: 'Colour' },
    { key: 'edgeColor', label: 'Cell Edge', type: 'color', default: [0.6, 0.9, 1], group: 'Colour' },
    { key: 'stressColor', label: 'Stress', type: 'color', default: [1, 0.45, 0.2], group: 'Colour', description: 'Where the field is being hit and overloading.' },
    { key: 'scale', label: 'Cell Size', type: 'float', default: 11, min: 1, max: 70, step: 0.5, group: 'Field' },
    { key: 'edgeWidth', label: 'Edge Width', type: 'float', default: 0.12, min: 0.01, max: 0.5, step: 0.005, group: 'Field' },
    { key: 'baseOpacity', label: 'Cell Opacity', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01, group: 'Field' },
    { key: 'interference', label: 'Interference', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Field', description: 'Bands rolling across the field, independent of the cell grid.' },
    { key: 'stress', label: 'Stress', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Field' },
    { key: 'glow', label: 'Glow', type: 'float', default: 2.5, min: 0, max: 10, step: 0.05, group: 'Field' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const cell = hexGrid(ctx.uv.mul(p.float('scale')).add(vec2(offset, offset)))
    const d = cell.xy.length()
    const edge = smoothstep(float(0.5).sub(p.float('edgeWidth')), float(0.5), d)
    const id = hash21(cell.zw)

    // Interference: broad bands that ignore the hex grid entirely, so the two
    // patterns beat against each other instead of moving together.
    const bands = ridged(vec3(ctx.uv.mul(vec2(3, 7)), offset.add(13)), float(3), float(0.5))
      .mul(p.float('interference'))

    // Stress concentrates in whole cells: the grid is what fails, not points.
    const stress = smoothstep(float(0.7), float(0.9), fbm01(coord3(ctx, 2.5).add(29), 3, 2, 0.5).add(id.mul(0.3)))
      .mul(p.float('stress'))

    const colour = mix(p.color('fieldColor'), p.color('edgeColor'), edge)
    const withStress = mix(colour, p.color('stressColor'), stress)

    const intensity = edge.add(bands.mul(0.5)).add(stress.mul(0.6)).clamp(0, 1.6)

    return {
      baseColor: withStress.mul(0.3),
      metallic: float(0),
      roughness: float(0.1),
      // Almost nothing is solid: the cells are a haze and the edges are lines.
      opacity: p.float('baseOpacity').add(edge.mul(0.55)).add(bands.mul(0.15)).add(stress.mul(0.25)).clamp(0, 1),
      emissive: withStress.mul(intensity).mul(p.float('glow')),
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const naniteSwarm = registerMaterial({
  id: 'nanite-swarm',
  name: 'Nanite Swarm',
  category: 'Sci-Fi',
  description: 'A metal surface mid-reconfiguration. Half of it is solid plate and half has dissolved into a granular cloud, and the boundary between them is where the interesting material behaviour lives: the plate is smooth and metallic, the swarm is rough, dark and lit from within.',
  params: [
    { key: 'plate', label: 'Plate', type: 'color', default: [0.6, 0.61, 0.63], group: 'Colour' },
    { key: 'swarm', label: 'Swarm', type: 'color', default: [0.12, 0.12, 0.14], group: 'Colour' },
    { key: 'energy', label: 'Energy', type: 'color', default: [0.3, 0.9, 0.8], group: 'Colour' },
    { key: 'dissolve', label: 'Dissolve', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'State', description: 'How far the plate has broken down. The boundary is the whole point, so mid values are where it lives.' },
    { key: 'edgeSharp', label: 'Edge Sharpness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'State' },
    { key: 'grainScale', label: 'Nanite Scale', type: 'float', default: 140, min: 10, max: 800, step: 2, group: 'State' },
    { key: 'plateScale', label: 'Plate Scale', type: 'float', default: 7, min: 0.5, max: 50, step: 0.1, group: 'State' },
    { key: 'churn', label: 'Churn', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'State', description: 'How much the swarm boils rather than sitting still.' },
    { key: 'glow', label: 'Edge Glow', type: 'float', default: 1.6, min: 0, max: 6, step: 0.05, group: 'Surface' },
    { key: 'roughness', label: 'Plate Roughness', type: 'float', default: 0.2, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const fieldAt = (uvNode: V2): F => {
      const warped = warp(vec3(uvNode.mul(p.float('plateScale')), offset), p.float('churn').mul(0.8), 1.4)
      return fbm01(warped, 5, 2.1, 0.55)
    }

    const solidAt = (uvNode: V2): F => {
      const soft = mix(float(0.2), float(0.02), p.float('edgeSharp'))
      const t = p.float('dissolve')
      return smoothstep(t.sub(soft), t.add(soft), fieldAt(uvNode))
    }

    const grainAt = (uvNode: V2): F =>
      smoothstep(float(0.35), float(0.02), worley(vec3(uvNode.mul(p.float('grainScale')), offset.add(3)), 1))

    const heightAt = (uvNode: V2): F => {
      const solid = solidAt(uvNode)
      const panel = cracks(uvNode, p.float('plateScale').mul(1.4), float(0.04), offset.add(9)).mul(0.2)
      const grain = grainAt(uvNode).mul(0.3)
      return solid.mul(float(0.5).sub(panel)).add(grain.mul(solid.oneMinus()))
    }

    const solid = solidAt(ctx.uv)
    const grain = grainAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))
    const h = heightAt(ctx.uv)

    // The dissolution front: a narrow band where the field crosses threshold.
    const front = smoothstep(float(0.4), float(0), abs(solid.sub(0.5)))
    const scuff = scratches(ctx.uv.add(vec2(offset, offset)), float(0.8), float(80), float(200)).mul(0.3)

    return {
      baseColor: mix(p.color('swarm').mul(mix(float(0.7), float(1.3), grain)), p.color('plate'), solid)
        .mul(mix(float(1), float(0.92), scuff.mul(solid))),
      // Loose nanites scatter like a powder: only the reassembled plate is
      // continuous enough to behave as metal.
      metallic: solid,
      roughness: mix(float(0.85), p.float('roughness').add(scuff.mul(0.2)), solid).clamp(0.03, 1),
      emissive: p.color('energy').mul(front.mul(p.float('glow')).add(grain.mul(solid.oneMinus()).mul(0.4))),
      ao: cavityAO(h.mul(2).clamp(0, 1), normal, 0.6),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const ALIEN = [alienHive, holoPanel, reactorVent, cableBundle, forceField, naniteSwarm]
