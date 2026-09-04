/**
 * Synthetics: the polymers a modern object is actually made of.
 *
 * Plastics are the one family where the *manufacturing process* is legible in
 * the surface. Injection moulding leaves flow lines and a sink mark over every
 * rib; vacuum forming stretches the texture thin over corners; extrusion leaves
 * die lines. Reproducing the process rather than the look is what makes these
 * read as parts instead of as tinted noise.
 */

import { abs, float, fract, min, mix, sin, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  fbm01,
  gradient3,
  hash21,
  microVariation,
  normalFromHeightFn,
  ridged,
  scratches,
  sparkle,
  stripes,
  tintVariation,
  voronoi2,
  voronoiBorder,
  voronoiCellValue,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

// ---------------------------------------------------------------------------

export const bubbleWrap = registerMaterial({
  id: 'bubble-wrap',
  name: 'Bubble Wrap',
  category: 'Manufactured',
  description: 'Air pockets welded between two films. Some are popped, and a popped bubble is not simply flat - it is a wrinkled dish with a split in it, which is why the burst mask has to change the height field rather than just the mask.',
  params: [
    { key: 'film', label: 'Film', type: 'color', default: [0.86, 0.9, 0.9], group: 'Colour' },
    { key: 'opacity', label: 'Opacity', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'pitch', label: 'Bubble Pitch', type: 'float', default: 16, min: 2, max: 90, step: 0.5, group: 'Pattern' },
    { key: 'radius', label: 'Bubble Radius', type: 'float', default: 0.38, min: 0.1, max: 0.49, step: 0.005, group: 'Pattern' },
    { key: 'height', label: 'Bubble Height', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'popped', label: 'Popped', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'wrinkle', label: 'Film Wrinkle', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The backing sheet is never taut between bubbles.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.14, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const pitch = p.float('pitch')

    const bubbleAt = (uvNode: V2) => {
      const q = uvNode.mul(pitch)
      const cell = vec2(q.x.floor(), q.y.floor())
      const local = fract(q).sub(0.5)
      const d = local.length()
      const pop = smoothstep(p.float('popped').oneMinus(), p.float('popped').oneMinus().add(0.06), hash21(cell.add(vec2(offset, offset))))
      return { cell, local, d, pop }
    }

    const heightAt = (uvNode: V2): F => {
      const b = bubbleAt(uvNode)
      // Intact: a spherical cap. Popped: a shallow dish with a crease across it.
      const cap = smoothstep(p.float('radius'), float(0), b.d).pow(0.55).mul(p.float('height'))
      const collapsed = smoothstep(p.float('radius'), float(0), b.d)
        .mul(-0.12)
        .add(ridged(vec3(uvNode.mul(pitch.mul(9)), offset.add(3)), float(2), float(0.5)).mul(0.06))
      const sheet = fbm01(vec3(uvNode.mul(pitch.mul(0.6)), offset.add(9)), 3, 2.1, 0.55).sub(0.5).mul(p.float('wrinkle')).mul(0.06)
      return mix(cap, collapsed, b.pop).add(sheet)
    }

    const b = bubbleAt(ctx.uv)
    const intact = smoothstep(p.float('radius'), p.float('radius').mul(0.85), b.d).mul(b.pop.oneMinus())
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('height').mul(1.6).add(0.1))
    const h = heightAt(ctx.uv)

    return {
      baseColor: p.color('film'),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .add(b.pop.mul(0.2))
        .add(microVariation(ctx.uv, pitch.mul(8), offset).sub(0.5).mul(0.06))
        .clamp(0.02, 1),
      // Two films plus trapped air is more opaque than one film: the bubble
      // walls are the only part of the sheet you can genuinely see.
      opacity: p.float('opacity').add(intact.mul(0.3)).add(b.pop.mul(0.1)).clamp(0, 1),
      ao: cavityAO(h.mul(1.5).add(0.5).clamp(0, 1), normal, 0.35),
      height: h.add(0.3).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const vinylUpholstery = registerMaterial({
  id: 'vinyl-upholstery',
  name: 'Vinyl Upholstery',
  category: 'Manufactured',
  description: 'Embossed PVC pretending to be leather. The giveaway is that the grain repeats: it came off an engraved roller, so the pattern is a genuine tile, and it is uniform in a way that no hide ever is. Cranking the wear parameter cracks it back to the fabric scrim underneath.',
  params: [
    { key: 'vinyl', label: 'Vinyl', type: 'color', default: [0.16, 0.13, 0.12], group: 'Colour' },
    { key: 'scrim', label: 'Scrim', type: 'color', default: [0.5, 0.45, 0.4], group: 'Colour', description: 'The knitted backing cloth, which shows the moment the surface splits.' },
    { key: 'grainScale', label: 'Grain Scale', type: 'float', default: 40, min: 2, max: 200, step: 0.5, group: 'Emboss' },
    { key: 'grainDepth', label: 'Grain Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Emboss' },
    { key: 'uniformity', label: 'Roller Uniformity', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Emboss', description: 'How mechanically even the grain is. This is the parameter that separates vinyl from hide.' },
    { key: 'seams', label: 'Stitch Lines', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Emboss' },
    { key: 'seamPitch', label: 'Panel Size', type: 'float', default: 3, min: 0.5, max: 20, step: 0.1, group: 'Emboss' },
    { key: 'cracking', label: 'Cracking', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'shine', label: 'Shine', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Plasticiser at the surface. It is why old vinyl is shiny and sticky rather than matt like leather.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const gs = p.float('grainScale')

    const grainAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(gs).add(vec2(offset, offset)), float(0.9))
      const pebble = smoothstep(float(0), float(0.14), voronoiBorder(cells))
      // Uniformity blends the per-cell size jitter away: the roller stamps the
      // same shape every time, a hide never does.
      const jitter = voronoiCellValue(cells).sub(0.5).mul(p.float('uniformity').oneMinus()).mul(0.6)
      return pebble.add(jitter).clamp(0, 1)
    }

    const seamAt = (uvNode: V2): F => {
      const q = uvNode.mul(p.float('seamPitch'))
      const d = min(abs(fract(q.x).sub(0.5)), abs(fract(q.y).sub(0.5)))
      return smoothstep(float(0.03), float(0), d).mul(p.float('seams'))
    }

    const crackAt = (uvNode: V2): F =>
      smoothstep(float(0.55), float(0.85), ridged(vec3(uvNode.mul(gs.mul(0.4)), offset.add(13)), float(4), float(0.55)))
        .mul(p.float('cracking'))

    const heightAt = (uvNode: V2): F =>
      grainAt(uvNode).mul(p.float('grainDepth')).mul(0.2)
        .sub(seamAt(uvNode).mul(0.35))
        .sub(crackAt(uvNode).mul(0.3))

    const grain = grainAt(ctx.uv)
    const crack = crackAt(ctx.uv)
    const seam = seamAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.3))
    const h = heightAt(ctx.uv)

    const scrimWeave = ridged(vec3(ctx.uv.mul(vec2(260, 260)), offset.add(7)), float(2), float(0.5))

    return {
      baseColor: mix(
        tintVariation(p.color('vinyl'), grain, 0.006, 0.08, 0.12),
        p.color('scrim').mul(mix(float(0.8), float(1.1), scrimWeave)),
        crack.mul(0.85),
      ).mul(mix(float(1), float(0.6), seam)),
      metallic: float(0),
      // Vinyl shines on the raised grain and stays matt in the valleys, which
      // is the inverse of leather - there the valleys are polished by use.
      roughness: mix(float(0.62), float(0.2), p.float('shine').mul(grain))
        .add(crack.mul(0.4))
        .add(seam.mul(0.2))
        .clamp(0.06, 1),
      ao: cavityAO(h.mul(4).add(0.6).clamp(0, 1), normal, 0.6),
      height: h.mul(2).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const injectionMoulded = registerMaterial({
  id: 'injection-moulded',
  name: 'Injection Moulded Plastic',
  category: 'Manufactured',
  description: 'An ABS enclosure straight out of the tool: spark-eroded texture on the face, flow lines radiating from the gate, and a sink mark wherever a rib sits behind the wall. Those three are what every real moulding has and no generic plastic shader does.',
  params: [
    { key: 'tint', label: 'Plastic', type: 'color', default: [0.2, 0.21, 0.23], group: 'Colour' },
    { key: 'flowTint', label: 'Flow Tint', type: 'color', default: [0.26, 0.27, 0.29], group: 'Colour', description: 'Pigment aligns with the flow, so the colour streaks slightly along it.' },
    { key: 'textureScale', label: 'Tool Texture', type: 'float', default: 240, min: 20, max: 1200, step: 5, group: 'Tooling', description: 'Spark-eroded finish on the mould face. It is fine, isotropic and completely uniform.' },
    { key: 'textureDepth', label: 'Texture Depth', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Tooling' },
    { key: 'gateX', label: 'Gate X', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Tooling' },
    { key: 'gateY', label: 'Gate Y', type: 'float', default: 0, min: 0, max: 1, step: 0.01, group: 'Tooling' },
    { key: 'flowLines', label: 'Flow Lines', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Tooling' },
    { key: 'sinkMarks', label: 'Sink Marks', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Tooling', description: 'Shallow depressions over internal ribs, where the plastic shrank as it cooled.' },
    { key: 'ribPitch', label: 'Rib Pitch', type: 'float', default: 5, min: 0.5, max: 30, step: 0.1, group: 'Tooling' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.45, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'scuffs', label: 'Scuffs', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const gate = vec2(p.float('gateX'), p.float('gateY'))

    const flowAt = (uvNode: V2): F => {
      // Flow lines are concentric arcs around the gate, spaced by how fast the
      // front was moving - so they widen with distance.
      const d = uvNode.sub(gate).length()
      const arcs = sin(d.pow(0.75).mul(60)).mul(0.5).add(0.5)
      return arcs.mul(p.float('flowLines')).mul(smoothstep(float(0.02), float(0.3), d))
    }

    const sinkAt = (uvNode: V2): F =>
      stripes(uvNode.x.mul(p.float('ribPitch')), float(0.18), float(0.12)).mul(p.float('sinkMarks'))

    const toolAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(p.float('textureScale')), offset), 3, 2.4, 0.6).sub(0.5).mul(p.float('textureDepth'))

    const heightAt = (uvNode: V2): F =>
      toolAt(uvNode).mul(0.03).sub(sinkAt(uvNode).mul(0.06)).add(flowAt(uvNode).mul(0.004))

    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.6))
    const h = heightAt(ctx.uv)
    const flow = flowAt(ctx.uv)
    const sink = sinkAt(ctx.uv)
    const scuff = scratches(ctx.uv.add(vec2(offset, offset)), float(0.9), float(70), float(200)).mul(p.float('scuffs'))

    return {
      baseColor: mix(p.color('tint'), p.color('flowTint'), flow.mul(0.6)).mul(mix(float(1), float(1.12), scuff)),
      metallic: float(0),
      // The tool texture dominates roughness; the sink marks are smoother
      // because the plastic pulled away from the textured face as it shrank.
      roughness: p
        .float('roughness')
        .add(toolAt(ctx.uv).mul(0.4))
        .sub(sink.mul(0.15))
        .add(scuff.mul(0.2))
        .clamp(0.04, 1),
      ao: cavityAO(h.mul(8).add(0.75).clamp(0, 1), normal, 0.3),
      height: h.mul(4).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const packingFoam = registerMaterial({
  id: 'packing-foam',
  name: 'Expanded Foam',
  category: 'Manufactured',
  description: 'EPS packing foam: fused beads with visible boundaries between them, each bead pocked with its own cells. The bead is the unit - it moulds as a sphere and welds to its neighbours - so a Voronoi cell field is not an approximation here, it is the manufacturing process.',
  params: [
    { key: 'foam', label: 'Foam', type: 'color', default: [0.88, 0.88, 0.86], group: 'Colour' },
    { key: 'gapColor', label: 'Bead Gap', type: 'color', default: [0.62, 0.62, 0.6], group: 'Colour' },
    { key: 'beadScale', label: 'Bead Size', type: 'float', default: 30, min: 2, max: 200, step: 0.5, group: 'Structure' },
    { key: 'fusion', label: 'Fusion', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Structure', description: 'How completely the beads have welded. Poorly fused foam falls apart into balls.' },
    { key: 'cells', label: 'Cell Detail', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Structure' },
    { key: 'crumbs', label: 'Broken Beads', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Where beads have been torn out, leaving craters.' },
    { key: 'dirt', label: 'Dirt', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const bs = p.float('beadScale')

    const beadsAt = (uvNode: V2) => voronoi2(uvNode.mul(bs).add(vec2(offset, offset)), float(0.95))

    const heightAt = (uvNode: V2): F => {
      const cells = beadsAt(uvNode)
      const border = voronoiBorder(cells)
      // Fusion controls how far the bead is a dome versus a flat-topped plate.
      const dome = smoothstep(float(0), mix(float(0.4), float(0.12), p.float('fusion')), border).pow(0.6)
      const cellDetail = fbm01(vec3(uvNode.mul(bs.mul(7)), offset.add(3)), 3, 2.3, 0.6).sub(0.5).mul(p.float('cells')).mul(0.08)
      const crater = smoothstep(float(0.9), float(0.97), voronoiCellValue(cells)).mul(p.float('crumbs')).mul(0.5)
      return dome.mul(0.45).add(cellDetail).sub(crater)
    }

    const cells = beadsAt(ctx.uv)
    const id = voronoiCellValue(cells)
    const border = voronoiBorder(cells)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.5))
    const h = heightAt(ctx.uv)

    const gap = smoothstep(float(0.06), float(0), border)
    const dirt = smoothstep(float(0.55), float(0.85), fbm01(coord3(ctx, bs.mul(0.3)).add(23), 4, 2.1, 0.55))
      .mul(p.float('dirt'))
      .mul(gap.mul(0.6).add(0.4))

    return {
      baseColor: mix(p.color('foam').mul(mix(float(0.96), float(1.03), id)), p.color('gapColor'), gap)
        .mul(mix(float(1), float(0.7), dirt)),
      metallic: float(0),
      // Closed-cell foam is matt but has a faint waxy skin on each bead face,
      // so the borders are rougher than the bead crowns.
      roughness: float(0.82).add(gap.mul(0.12)).add(dirt.mul(0.05)).sub(h.mul(0.15)).clamp(0.4, 1),
      ao: cavityAO(h.mul(2).add(0.5).clamp(0, 1), normal, 0.65),
      height: h.add(0.4).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const astroturf = registerMaterial({
  id: 'astroturf',
  name: 'Artificial Turf',
  category: 'Manufactured',
  description: 'Tufted polyethylene blades with rubber crumb infill between them. What makes it read as fake rather than as grass is that the blades are identical, the colour has no seasonal variation, and the infill is jet black - so those three are exactly what this exaggerates.',
  params: [
    { key: 'bladeA', label: 'Blade Light', type: 'color', default: [0.2, 0.42, 0.14], group: 'Colour' },
    { key: 'bladeB', label: 'Blade Dark', type: 'color', default: [0.1, 0.24, 0.09], group: 'Colour' },
    { key: 'infill', label: 'Crumb Infill', type: 'color', default: [0.04, 0.04, 0.04], group: 'Colour' },
    { key: 'density', label: 'Blade Density', type: 'float', default: 220, min: 20, max: 900, step: 5, group: 'Pile' },
    { key: 'lean', label: 'Lean', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Pile', description: 'Which way the pile has been brushed. Turf shows mowing stripes for exactly this reason.' },
    { key: 'stripes', label: 'Mow Stripes', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Pile' },
    { key: 'stripePitch', label: 'Stripe Width', type: 'float', default: 4, min: 0.5, max: 30, step: 0.1, group: 'Pile' },
    { key: 'infillShow', label: 'Infill Visibility', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Pile' },
    { key: 'gloss', label: 'Plastic Gloss', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Polyethylene shines along the blade in a way real grass never does.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    // Mowing stripes flip the lean direction band by band.
    const stripeAt = (uvNode: V2): F =>
      stripes(uvNode.y.mul(p.float('stripePitch')), float(0.5), float(0.05)).mul(p.float('stripes'))

    const bladeAt = (uvNode: V2): F => {
      const dir = mix(float(-1), float(1), stripeAt(uvNode)).mul(p.float('lean'))
      const sheared = vec2(uvNode.x, uvNode.y.add(uvNode.x.mul(dir).mul(0.05)))
      return fbm01(vec3(sheared.mul(vec2(p.float('density'), p.float('density').mul(0.12))), offset), 3, 2.3, 0.6)
    }

    const heightAt = (uvNode: V2): F => bladeAt(uvNode).mul(0.35)

    const blade = bladeAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.4))
    const h = heightAt(ctx.uv)

    const infillMask = smoothstep(float(0.42), float(0.2), blade).mul(p.float('infillShow'))
    const crumb = sparkle(ctx.uv, p.float('density').mul(1.4), offset.add(3), float(0.2))

    // The blade colour is deliberately uniform: variation would make it grass.
    const bladeColour = mix(p.color('bladeB'), p.color('bladeA'), blade)
      .mul(mix(float(0.94), float(1.06), stripeAt(ctx.uv)))

    return {
      baseColor: mix(bladeColour, p.color('infill').mul(mix(float(1), float(1.6), crumb)), infillMask),
      metallic: float(0),
      roughness: mix(float(0.92), mix(float(0.7), float(0.3), p.float('gloss')), blade)
        .add(infillMask.mul(0.15))
        .clamp(0.15, 1),
      ao: cavityAO(blade, normal, 0.8),
      height: h.add(0.3).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const pearlescentPlastic = registerMaterial({
  id: 'pearlescent-plastic',
  name: 'Pearlescent Plastic',
  category: 'Manufactured',
  description: 'Mica-flake plastic under a clear coat. Two specular layers are doing different jobs: the flakes are small, bright and tilted every which way; the coat over them is a single smooth mirror. Keeping those two separate - flakes in the normal, coat in the roughness - is the whole effect.',
  params: [
    { key: 'baseTint', label: 'Base', type: 'color', default: [0.55, 0.2, 0.35], group: 'Colour' },
    { key: 'shiftA', label: 'Shift A', type: 'color', default: [0.75, 0.45, 0.85], group: 'Colour' },
    { key: 'shiftB', label: 'Shift B', type: 'color', default: [0.3, 0.6, 0.8], group: 'Colour' },
    { key: 'shift', label: 'Colour Travel', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'How far the hue travels with viewing angle, as a flip paint does.' },
    { key: 'flakeScale', label: 'Flake Density', type: 'float', default: 380, min: 20, max: 1500, step: 5, group: 'Flake' },
    { key: 'flakeAmount', label: 'Flake Amount', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Flake' },
    { key: 'flakeTilt', label: 'Flake Tilt', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Flake', description: 'How far the flakes lie off-plane. Zero gives a flat glitter; real mica settles at angles.' },
    { key: 'coatRoughness', label: 'Coat Roughness', type: 'float', default: 0.06, min: 0, max: 1, step: 0.001, group: 'Coat' },
    { key: 'orangePeel', label: 'Orange Peel', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Coat' },
    { key: 'swirls', label: 'Swirl Marks', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Coat', description: 'Fine polishing scratches in the clear coat.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const fs = p.float('flakeScale')

    const peelAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(70), offset.add(3)), 3, 2.2, 0.55).sub(0.5).mul(p.float('orangePeel'))

    // The flakes get their own high-frequency normal, tilted per cell.
    const flakeNormal = normalFromHeightFn(
      (uvNode) => {
        const cells = voronoi2(uvNode.mul(fs).add(vec2(offset, offset)), float(0.95))
        return voronoiCellValue(cells).sub(0.5).mul(p.float('flakeTilt')).mul(smoothstep(float(0.4), float(0), cells.x))
      },
      ctx.uv,
      ctx.texel,
      p.float('flakeTilt').mul(0.4).add(0.02),
    )
    const coatNormal = normalFromHeightFn(peelAt, ctx.uv, ctx.texel, p.float('orangePeel').mul(0.05).add(0.002))

    const cells = voronoi2(ctx.uv.mul(fs).add(vec2(offset, offset)), float(0.95))
    const flake = smoothstep(float(0.3), float(0.05), cells.x).mul(p.float('flakeAmount'))
    const id = voronoiCellValue(cells)

    // Hue travel from the combined tilt, so it moves as the model turns.
    const travel = flakeNormal.xy.length().mul(2.5).add(id.mul(0.4))
    const shifted = gradient3(fract(travel), p.color('baseTint'), p.color('shiftA'), p.color('shiftB'))
    const colour = mix(p.color('baseTint'), shifted, p.float('shift'))

    const swirl = scratches(ctx.uv.add(vec2(offset, offset)), float(0.6), float(60), float(320))
      .mul(p.float('swirls'))

    return {
      baseColor: tintVariation(colour, id, 0.01, 0.1, 0.12).add(flake.mul(0.12)),
      // Only the flakes are metal; the resin around them is not.
      metallic: flake.mul(0.7),
      // The clear coat is the smoothest thing on the surface and it covers
      // everything - so roughness stays low even where the flake normal is wild.
      roughness: p.float('coatRoughness').add(swirl.mul(0.25)).add(peelAt(ctx.uv).mul(0.06)).clamp(0.01, 1),
      normal: blendDetailNormal(coatNormal, flakeNormal, p.float('flakeAmount').mul(0.6)),
      height: float(0.5),
    }
  },
} satisfies ProceduralMaterialDef)

export const SYNTHETICS = [
  bubbleWrap,
  vinylUpholstery,
  injectionMoulded,
  packingFoam,
  astroturf,
  pearlescentPlastic,
]
