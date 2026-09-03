/**
 * Manufactured surfaces: things made in a mould or on a loom to a tolerance.
 * The giveaway is regularity - and then the small, deliberate irregularity that
 * keeps them from looking like a shader test.
 *
 * The irregularity is not decoration. A moulded part has draft, flow lines and
 * a texture the tool left behind; a tiled wall has grout that was worked by
 * hand; a woven composite has tows that are not perfectly parallel. Those are
 * the details that place an object in the world rather than in a viewport.
 */

import { float, fract, max, min, mix, sin, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  cavityAO,
  cracks,
  fbm01,
  hash21,
  hexGrid,
  microVariation,
  normalFromHeightFn,
  pebbles,
  scratches,
  tintVariation,
  voronoi2,
  warp,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

export const plainSurface = registerMaterial({
  id: 'plain',
  name: 'Plain',
  category: 'Basic',
  description: 'A flat value for every channel. The workhorse fill layer - use it as a base coat or as the colour a mask reveals.',
  params: [
    { key: 'color', label: 'Base Colour', type: 'color', default: [0.55, 0.55, 0.57], group: 'Channels' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.5, min: 0, max: 1, step: 0.001, group: 'Channels' },
    { key: 'metallic', label: 'Metallic', type: 'float', default: 0, min: 0, max: 1, step: 0.001, group: 'Channels' },
    { key: 'height', label: 'Height', type: 'float', default: 0.5, min: 0, max: 1, step: 0.001, group: 'Channels' },
    { key: 'opacity', label: 'Opacity', type: 'float', default: 1, min: 0, max: 1, step: 0.001, group: 'Channels' },
    { key: 'ao', label: 'Ambient Occlusion', type: 'float', default: 1, min: 0, max: 1, step: 0.001, group: 'Channels' },
    { key: 'emissiveColor', label: 'Emissive', type: 'color', default: [0, 0, 0], group: 'Channels' },
    { key: 'emissiveStrength', label: 'Emissive Strength', type: 'float', default: 0, min: 0, max: 20, step: 0.01, group: 'Channels' },
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    return {
      baseColor: p.color('color'),
      roughness: p.float('roughness'),
      metallic: p.float('metallic'),
      height: p.float('height'),
      opacity: p.float('opacity'),
      ao: p.float('ao'),
      emissive: p.color('emissiveColor').mul(p.float('emissiveStrength')),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const ceramicTiles = registerMaterial({
  id: 'ceramic-tiles',
  name: 'Ceramic Tiles',
  category: 'Manufactured',
  description: 'Glazed tiles with bevelled edges, crazed glaze and grout that has been worked by hand. Per-tile hue jitter and per-tile gloss keep the grid from reading as a decal - two tiles from the same box are never quite the same tile.',
  params: [
    { key: 'tiles', label: 'Tiles Across', type: 'float', default: 8, min: 1, max: 60, step: 0.5, group: 'Layout' },
    { key: 'grout', label: 'Grout Width', type: 'float', default: 0.05, min: 0, max: 0.3, step: 0.001, group: 'Layout' },
    { key: 'bevel', label: 'Bevel', type: 'float', default: 0.08, min: 0, max: 0.4, step: 0.001, group: 'Layout' },
    { key: 'wonk', label: 'Laying Wonk', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Per-tile height and lippage. A dead-flat tiled wall is a render, not a wall.' },
    { key: 'tileColor', label: 'Tile Colour', type: 'color', default: [0.85, 0.87, 0.86], group: 'Colour' },
    { key: 'tileColorB', label: 'Accent Colour', type: 'color', default: [0.32, 0.52, 0.58], group: 'Colour' },
    { key: 'accentChance', label: 'Accent Chance', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'groutColor', label: 'Grout Colour', type: 'color', default: [0.5, 0.48, 0.45], group: 'Colour' },
    { key: 'variation', label: 'Tile Variation', type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'grime', label: 'Grout Grime', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Grout is porous and sits low, so it is always the first thing to go dirty.' },
    { key: 'glaze', label: 'Glaze', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'crazing', label: 'Crazing', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The hairline crack network in an old glaze. Fired ceramic and its glaze shrink at different rates.' },
    { key: 'depth', label: 'Grout Depth', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const n = p.float('tiles')
    const offset = seedOffset(ctx)

    const tileAt = (uvNode: V2) => {
      const g = uvNode.mul(n)
      return { local: fract(g), id: g.floor() }
    }

    const heightAt = (uvNode: V2): F => {
      const t = tileAt(uvNode)
      const d = min(min(t.local.x, t.local.x.oneMinus()), min(t.local.y, t.local.y.oneMinus()))
      const grout = p.float('grout')
      const bevel = p.float('bevel')
      // Flat plateau, bevelled shoulder, then a sharp drop into the grout line.
      const face = smoothstep(grout, grout.add(bevel), d)
      // Lippage: each tile sits at its own height, so light catches the edges.
      const lippage = hash21(t.id.add(vec2(offset.add(5), offset))).sub(0.5).mul(p.float('wonk')).mul(0.18)
      // Grout is troweled: it sags in the middle of each run.
      const groutSag = smoothstep(grout, float(0), d).mul(0.06)
      return face.mul(p.float('depth').add(lippage)).sub(groutSag.mul(face.oneMinus()))
    }

    const t = tileAt(ctx.uv)
    const id = hash21(t.id.add(vec2(offset, offset)))
    const accent = step(id, p.float('accentChance'))
    const jitter = hash21(t.id.add(vec2(offset.add(17), offset.add(4))))
    const base = mix(p.color('tileColor'), p.color('tileColorB'), accent)
    const tinted = tintVariation(base, jitter, p.float('variation').mul(0.03), p.float('variation').mul(0.4), p.float('variation').mul(0.35))

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.5))
    const tileMask = h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1)

    // Crazing lives in the glaze, so it only exists on the tile face.
    const craze = cracks(ctx.uv.add(vec2(offset, offset)), n.mul(9), float(0.05), offset.add(11))
      .mul(p.float('crazing'))
      .mul(tileMask)
    const groutTexture = fbm01(vec3(ctx.uv.mul(n.mul(24)), offset), 3, 2, 0.5)
    const grime = smoothstep(float(0.35), float(0.75), fbm01(vec3(ctx.uv.mul(n.mul(1.6)), offset.add(29)), 4, 2.1, 0.55))
      .mul(tileMask.oneMinus())
      .mul(p.float('grime'))

    const groutColour = p.color('groutColor').mul(mix(float(0.82), float(1.06), groutTexture))
    const surface = mix(groutColour, tinted, tileMask)

    return {
      baseColor: mix(surface, vec3(0.09, 0.08, 0.07), max(grime.mul(0.8), craze.mul(0.35))),
      metallic: float(0),
      // Per-tile gloss: firing is never perfectly even across a batch.
      roughness: mix(float(0.92), float(1).sub(p.float('glaze').mul(0.9)).add(jitter.sub(0.5).mul(0.08)), tileMask)
        .add(craze.mul(0.25))
        .add(grime.mul(0.1))
        .clamp(0.02, 1),
      ao: cavityAO(tileMask, normal, 0.7),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const hexScales = registerMaterial({
  id: 'hex-scales',
  name: 'Hex Scales',
  category: 'Manufactured',
  description: 'Hexagonal plating with bevelled edges and per-plate finish. Panels are stamped from the same die, so they differ in wear and orientation rather than in shape - which is why the variation here is in roughness and edge damage, not in the outline.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.33, 0.36, 0.4], group: 'Colour' },
    { key: 'accent', label: 'Accent', type: 'color', default: [0.48, 0.51, 0.56], group: 'Colour' },
    { key: 'gapColor', label: 'Gap', type: 'color', default: [0.02, 0.02, 0.025], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 10, min: 1, max: 80, step: 0.1, group: 'Layout' },
    { key: 'gap', label: 'Gap', type: 'float', default: 0.12, min: 0, max: 0.5, step: 0.005, group: 'Layout' },
    { key: 'bevel', label: 'Bevel', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'A stamped plate has a rolled edge, not a knife edge.' },
    { key: 'dome', label: 'Dome', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'recess', label: 'Random Recess', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'edgeWear', label: 'Edge Wear', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Plate edges are what everything scrapes against, so they polish first.' },
    { key: 'grime', label: 'Panel Grime', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Dirt packed into the gaps between plates.' },
    { key: 'metallic', label: 'Metallic', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const cellAt = (uvNode: V2) => hexGrid(uvNode.mul(p.float('scale')).add(vec2(offset, offset)))

    const heightAt = (uvNode: V2): F => {
      const cell = cellAt(uvNode)
      const d = cell.xy.length()
      const inner = float(0.5).sub(p.float('gap'))
      // Two ramps: a wide bevel outside a flat face, instead of one hard edge.
      const bevelWidth = max(p.float('bevel').mul(0.12), float(0.005))
      const edge = smoothstep(inner, inner.sub(bevelWidth), d)
      const dome = float(1).sub(d.mul(2).clamp(0, 1)).pow(0.6).mul(p.float('dome'))
      const recess = hash21(cell.zw).mul(p.float('recess'))
      // Stamped panels carry the die's own fine texture.
      const tooling = fbm01(vec3(uvNode.mul(p.float('scale').mul(30)), offset.add(3)), 2, 2, 0.5).sub(0.5).mul(0.03)
      return edge.mul(dome.add(0.4).sub(recess)).add(tooling.mul(edge))
    }

    const cell = cellAt(ctx.uv)
    const id = hash21(cell.zw.add(vec2(3.1, 7.7)))
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('dome').add(0.4).mul(1.5))
    const plate = h.clamp(0, 1)

    // The bevel band: high slope, close to the plate boundary.
    const edgeBand = smoothstep(float(0.85), float(0.35), normal.z).mul(plate)
    const grime = smoothstep(float(0.4), float(0.85), fbm01(vec3(ctx.uv.mul(p.float('scale').mul(1.4)), offset.add(19)), 4, 2.1, 0.55))
      .mul(plate.oneMinus().mul(0.7).add(0.3))
      .mul(p.float('grime'))

    const metalColour = tintVariation(mix(p.color('tint'), p.color('accent'), id), id, 0.008, 0.12, 0.16)
    const worn = metalColour.mul(mix(float(1), float(1.18), edgeBand.mul(p.float('edgeWear'))))

    return {
      baseColor: mix(mix(p.color('gapColor'), worn, plate), vec3(0.06, 0.055, 0.05), grime.mul(0.7)),
      metallic: p.float('metallic').mul(plate).mul(grime.mul(0.5).oneMinus()),
      roughness: p
        .float('roughness')
        .add(id.sub(0.5).mul(0.14))
        .sub(edgeBand.mul(p.float('edgeWear')).mul(0.28))
        .add(grime.mul(0.35))
        .clamp(0.03, 1),
      ao: cavityAO(plate, normal, 0.75),
      height: plate,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const carbonFibre = registerMaterial({
  id: 'carbon-fibre',
  name: 'Carbon Fibre',
  category: 'Manufactured',
  description: 'A 2x2 twill weave under clear coat, down to the individual filaments in each tow. The diagonal step in the tow pattern is what distinguishes twill from the plain weave used by the fabric material, and the filament sheen running across the tow is what makes it look like carbon rather than a printed pattern.',
  params: [
    { key: 'tint', label: 'Tow Colour', type: 'color', default: [0.035, 0.035, 0.04], group: 'Colour' },
    { key: 'sheenColor', label: 'Sheen', type: 'color', default: [0.36, 0.38, 0.44], group: 'Colour' },
    { key: 'tows', label: 'Tow Count', type: 'float', default: 30, min: 4, max: 200, step: 1, group: 'Pattern' },
    { key: 'filaments', label: 'Filaments', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'The individual fibres inside each tow. This is the detail that reads as carbon at close range.' },
    { key: 'depth', label: 'Weave Depth', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'clearCoat', label: 'Clear Coat', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'orangePeel', label: 'Orange Peel', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The lacquer over the weave is sprayed, so it has its own gentle waviness.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('tows')

    const twillAt = (uvNode: V2) => {
      const g = uvNode.mul(n)
      const cell = g.floor()
      const local = fract(g)
      // 2x2 twill: the "over" run shifts by one every row.
      const phase = fract(cell.x.sub(cell.y).mul(0.25)).mul(4)
      const over = step(phase, float(1.5))
      const along = mix(local.y, local.x, over)
      const across = mix(local.x, local.y, over)
      const tow = sin(along.mul(Math.PI))
      // Filaments run *along* the tow, so they are ridges across it.
      const filament = sin(across.mul(Math.PI * 26)).mul(0.5).add(0.5).mul(p.float('filaments'))
      return { over, across, height: tow.mul(0.85).add(filament.mul(0.15)), tow }
    }

    const coatAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(n.mul(0.4)), offset), 3, 2, 0.5).mul(p.float('orangePeel')).mul(0.05)

    const heightAt = (uvNode: V2): F => twillAt(uvNode).height.mul(p.float('depth')).add(coatAt(uvNode))

    const w = twillAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.2))
    const h = w.height.clamp(0, 1)

    // Carbon is anisotropic: a tow reflects in a band perpendicular to its
    // fibres, so the two tow directions never light up at the same time.
    const sheen = mix(float(0.18), float(1), h).mul(mix(float(0.55), float(1), w.over))
    const filamentGloss = sin(w.across.mul(Math.PI * 26)).abs().mul(p.float('filaments'))

    return {
      baseColor: mix(p.color('tint'), p.color('sheenColor'), sheen.mul(0.55)),
      // The clear coat is dielectric; the fibres under it are near-conductive.
      metallic: float(0.08),
      roughness: mix(float(0.45), float(0.045), p.float('clearCoat'))
        .add(h.oneMinus().mul(0.12))
        .sub(filamentGloss.mul(0.05))
        .add(coatAt(ctx.uv).mul(2))
        .clamp(0.02, 1),
      ao: cavityAO(h, normal, 0.4),
      height: h,
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const plastic = registerMaterial({
  id: 'plastic',
  name: 'Plastic',
  category: 'Manufactured',
  description: 'Injection-moulded plastic with spark-eroded tool texture, flow lines from the melt front, and the scuffing any moulded part picks up in use. The dimple pattern is Voronoi, matching how EDM texturing actually distributes.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: [0.18, 0.2, 0.24], group: 'Colour' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'texture', label: 'Mould Texture', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'textureScale', label: 'Texture Density', type: 'float', default: 160, min: 10, max: 900, step: 1, group: 'Surface' },
    { key: 'flowLines', label: 'Flow Lines', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Faint streaks left by the melt front as it filled the cavity.' },
    { key: 'scuffs', label: 'Scuffs', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Plastic scuffs pale: the scratch scatters light rather than exposing anything underneath.' },
    { key: 'dust', label: 'Dust', type: 'float', default: 0.2, min: 0, max: 1, step: 0.01, group: 'Wear' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const heightAt = (uvNode: V2): F => {
      const cells = voronoi2(uvNode.mul(p.float('textureScale')).add(vec2(offset, offset)), float(1))
      const dimples = cells.x.clamp(0, 1).mul(p.float('texture'))
      const flow = fbm01(warp(vec3(uvNode.mul(vec2(2, 26)), offset), 0.4, 1.5), 3, 2, 0.5)
      return dimples.add(flow.mul(p.float('flowLines')).mul(0.15))
    }

    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('texture').mul(0.5))
    const scuff = scratches(ctx.uv.add(vec2(offset, offset)), float(0.4), float(60), float(320)).mul(p.float('scuffs'))
    const dust = smoothstep(float(0.5), float(0.85), fbm01(vec3(ctx.uv.mul(9), offset.add(23)), 4, 2.1, 0.55)).mul(p.float('dust'))

    return {
      // Scuffed plastic goes lighter and slightly desaturated, never darker.
      baseColor: mix(p.color('color'), vec3(0.62, 0.62, 0.63), max(scuff.mul(0.35), dust.mul(0.22))),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .add(h.mul(0.45))
        .add(scuff.mul(0.4))
        .add(dust.mul(0.25))
        .add(microVariation(ctx.uv, float(160), offset).sub(0.5).mul(0.05))
        .clamp(0.02, 1),
      ao: cavityAO(h.clamp(0, 1), normal, 0.2),
      height: h.mul(0.3).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const camouflage = registerMaterial({
  id: 'camouflage',
  name: 'Camouflage',
  category: 'Manufactured',
  description: 'Four-tone disruptive pattern printed on cloth. Thresholding one warped noise field at three levels guarantees the tones interlock instead of overlapping, and the print sits *on* a ripstop weave rather than replacing it - the fabric structure has to survive the pattern.',
  params: [
    { key: 'colorA', label: 'Colour A', type: 'color', default: [0.22, 0.24, 0.16], group: 'Colour' },
    { key: 'colorB', label: 'Colour B', type: 'color', default: [0.36, 0.34, 0.23], group: 'Colour' },
    { key: 'colorC', label: 'Colour C', type: 'color', default: [0.14, 0.15, 0.12], group: 'Colour' },
    { key: 'colorD', label: 'Colour D', type: 'color', default: [0.5, 0.46, 0.34], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.05, group: 'Pattern' },
    { key: 'hardness', label: 'Edge Hardness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'warpAmount', label: 'Distortion', type: 'float', default: 0.6, min: 0, max: 3, step: 0.01, group: 'Pattern' },
    { key: 'threads', label: 'Thread Count', type: 'float', default: 260, min: 20, max: 1200, step: 5, group: 'Fabric', description: 'The weave the pattern is printed on.' },
    { key: 'ripstop', label: 'Ripstop Grid', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Fabric', description: 'The reinforcing threads woven in every few millimetres.' },
    { key: 'fade', label: 'Sun Fade', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Printed cloth fades unevenly, and the dark tones go first.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.78, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const field = fbm01(warp(vec3(ctx.uv.mul(p.float('scale')), offset), p.float('warpAmount'), 1.3), 4, 2.1, 0.55)
    const soft = float(0.16).mul(p.float('hardness').oneMinus().add(0.05))

    const t1 = smoothstep(float(0.38).sub(soft), float(0.38).add(soft), field)
    const t2 = smoothstep(float(0.52).sub(soft), float(0.52).add(soft), field)
    const t3 = smoothstep(float(0.68).sub(soft), float(0.68).add(soft), field)

    const printed = mix(mix(mix(p.color('colorC'), p.color('colorA'), t1), p.color('colorB'), t2), p.color('colorD'), t3)

    // The cloth underneath: a plain weave plus the ripstop reinforcement grid.
    const n = p.float('threads')
    const weaveAt = (uvNode: V2): F => {
      const g = uvNode.mul(n)
      const cell = g.floor()
      const local = fract(g)
      const over = fract(cell.x.add(cell.y).mul(0.5)).mul(2)
      const warpThread = sin(local.x.mul(Math.PI))
      const weftThread = sin(local.y.mul(Math.PI))
      const weave = mix(weftThread, warpThread, over)
      // Ripstop: every 12th thread is doubled, so it stands proud.
      const gridX = smoothstep(float(0.85), float(1), sin(uvNode.x.mul(n.div(12)).mul(Math.PI)).abs())
      const gridY = smoothstep(float(0.85), float(1), sin(uvNode.y.mul(n.div(12)).mul(Math.PI)).abs())
      return weave.mul(0.7).add(max(gridX, gridY).mul(p.float('ripstop')).mul(0.3))
    }

    const normal = normalFromHeightFn(weaveAt, ctx.uv, ctx.texel, float(0.35))
    const weave = weaveAt(ctx.uv)

    // Sun fade lifts value and drops saturation, and it does neither evenly.
    // It is one-directional - cloth never gets *more* saturated in the sun -
    // so the bleached colour is computed once and mixed in by how exposed the
    // patch is, rather than jittered symmetrically about the printed one.
    const fadeField = fbm01(vec3(ctx.uv.mul(p.float('scale').mul(0.4)), offset.add(37)), 3, 2, 0.6)
    const bleached = tintVariation(printed, float(1), 0.004, -0.55, 0.4)
    const faded = mix(printed, bleached, smoothstep(float(0.4), float(0.85), fadeField).mul(p.float('fade')))

    return {
      baseColor: faded.mul(mix(float(0.78), float(1.08), weave)),
      metallic: float(0),
      roughness: p.float('roughness').add(weave.oneMinus().mul(0.12)).add(p.float('fade').mul(0.06)).clamp(0.1, 1),
      ao: cavityAO(weave.clamp(0, 1), normal, 0.45),
      height: weave.mul(0.12).add(0.44).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const diamondPlate = registerMaterial({
  id: 'diamond-plate',
  name: 'Diamond Plate',
  category: 'Manufactured',
  description: 'Rolled tread plate. The pattern is two crossed sets of raised bars offset row by row, which is exactly how the rolling die works - and the tops of the bars are the only part anything ever touches, so that is the only part that polishes.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.62, 0.63, 0.65], group: 'Colour' },
    { key: 'scale', label: 'Pattern Scale', type: 'float', default: 7, min: 1, max: 50, step: 0.1, group: 'Layout' },
    { key: 'barLength', label: 'Bar Length', type: 'float', default: 0.62, min: 0.1, max: 0.95, step: 0.01, group: 'Layout' },
    { key: 'barWidth', label: 'Bar Width', type: 'float', default: 0.2, min: 0.02, max: 0.5, step: 0.005, group: 'Layout' },
    { key: 'height', label: 'Tread Height', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'wear', label: 'Tread Wear', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Boots polish the bar tops to a shine and leave the plate between them dull.' },
    { key: 'grime', label: 'Grime', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Everything that gets walked in ends up in the valleys.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.42, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    /**
     * One bar: a rounded rectangle rotated 45 degrees one way or the other,
     * alternating by row. Rotating the *coordinate* rather than the shape is
     * what keeps both diagonals identical, which the real die guarantees.
     */
    const barAt = (uvNode: V2): F => {
      const g = uvNode.mul(scale)
      const cell = g.floor()
      const local = fract(g).sub(0.5)
      // Alternate the diagonal every row, and offset every other row by half.
      const flip = fract(cell.y.mul(0.5)).mul(2)
      const rotated = mix(
        vec2(local.x.add(local.y), local.x.sub(local.y)),
        vec2(local.x.sub(local.y), local.x.add(local.y)),
        flip,
      ).mul(0.7071)
      const halfLength = p.float('barLength').mul(0.5)
      const halfWidth = p.float('barWidth').mul(0.5)
      // Rounded ends: the long axis clamps, the short axis is a smooth ramp.
      const along = max(rotated.x.abs().sub(halfLength.sub(halfWidth)), float(0))
      const d = vec2(along, rotated.y).length()
      return smoothstep(halfWidth, halfWidth.mul(0.35), d)
    }

    const heightAt = (uvNode: V2): F => {
      const bar = barAt(uvNode)
      // Between the treads the plate is not smooth: it is mill-finished steel.
      const mill = fbm01(vec3(uvNode.mul(scale.mul(40)), offset), 2, 2, 0.5).sub(0.5).mul(0.04)
      return bar.pow(0.6).mul(p.float('height')).add(mill)
    }

    const bar = barAt(ctx.uv)
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('height').mul(2.2))

    // Only the crown of each bar gets walked on.
    const polished = smoothstep(float(0.55), float(0.95), bar).mul(p.float('wear'))
    const grime = smoothstep(float(0.35), float(0.8), fbm01(vec3(ctx.uv.mul(scale.mul(1.5)), offset.add(19)), 4, 2.1, 0.55))
      .mul(bar.oneMinus())
      .mul(p.float('grime'))
    const mill = scratches(ctx.uv.add(vec2(offset, offset)), float(0.2), float(70), scale.mul(30))

    return {
      baseColor: p.color('tint').mul(mix(float(0.86), float(1.08), polished)).mul(mix(float(1), float(0.35), grime)),
      metallic: grime.mul(0.7).oneMinus(),
      roughness: p
        .float('roughness')
        .sub(polished.mul(0.34))
        .add(mill.mul(0.12))
        .add(grime.mul(0.4))
        .clamp(0.03, 1),
      ao: cavityAO(bar.clamp(0, 1), normal, 0.6),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const rubberTread = registerMaterial({
  id: 'rubber-tread',
  name: 'Rubber Tread',
  category: 'Manufactured',
  description: 'Moulded tyre rubber: tread blocks cut by sipes, with the mould-release texture that gives new rubber its dead-matte finish. Rubber is the darkest common material and reflects almost nothing diffusely - the trick is resisting the urge to make it grey.',
  params: [
    { key: 'color', label: 'Rubber', type: 'color', default: [0.032, 0.032, 0.034], group: 'Colour' },
    { key: 'blockScale', label: 'Block Scale', type: 'float', default: 7, min: 1, max: 60, step: 0.1, group: 'Pattern' },
    { key: 'grooveWidth', label: 'Groove Width', type: 'float', default: 0.16, min: 0.02, max: 0.5, step: 0.005, group: 'Pattern' },
    { key: 'stagger', label: 'Block Stagger', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'Tread blocks are offset row to row so the tyre does not hum at one frequency.' },
    { key: 'sipes', label: 'Sipes', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'The fine slits cut across each block for wet grip.' },
    { key: 'depth', label: 'Tread Depth', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'mouldTexture', label: 'Mould Texture', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'wear', label: 'Wear', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Road use burnishes the block tops, which is the only part of a tyre that ever shines.' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.92, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('blockScale')

    const blockAt = (uvNode: V2): F => {
      const row = uvNode.y.mul(scale).floor()
      const shift = hash21(vec2(row, offset)).mul(p.float('stagger'))
      const g = vec2(uvNode.x.mul(scale).add(shift), uvNode.y.mul(scale))
      const local = fract(g)
      const d = min(min(local.x, local.x.oneMinus()), min(local.y, local.y.oneMinus()))
      const w = p.float('grooveWidth')
      const block = smoothstep(w.mul(0.5), w, d)
      // Sipes: thin cuts across the block, not through the groove.
      const sipe = smoothstep(float(0.9), float(1), sin(local.y.mul(Math.PI * 6)).abs())
        .mul(p.float('sipes'))
        .mul(block)
      return block.sub(sipe.mul(0.75))
    }

    const heightAt = (uvNode: V2): F => {
      const block = blockAt(uvNode)
      // Mould release leaves a fine, non-directional pebbling on every face.
      const grain = pebbles(uvNode.mul(scale.mul(60)).add(vec2(offset, offset)), float(0.95), float(0.5)).x
      return block.mul(p.float('depth')).add(grain.mul(p.float('mouldTexture')).mul(0.04))
    }

    const block = blockAt(ctx.uv)
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2))
    const burnish = smoothstep(float(0.6), float(0.98), block).mul(p.float('wear'))

    return {
      // Even burnished, rubber stays near-black: the sheen is specular only.
      baseColor: p.color('color').mul(mix(float(1), float(1.35), burnish)),
      metallic: float(0),
      roughness: p
        .float('roughness')
        .sub(burnish.mul(0.45))
        .add(p.float('mouldTexture').mul(0.04))
        .add(microVariation(ctx.uv, scale.mul(24), offset).sub(0.5).mul(0.06))
        .clamp(0.08, 1),
      ao: cavityAO(block.clamp(0, 1), normal, 0.8),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const knittedWool = registerMaterial({
  id: 'knitted-wool',
  name: 'Knitted Wool',
  category: 'Manufactured',
  description: 'Stockinette knit. Each stitch is a V of two crossing loops, and the halo of loose fibre around them is what makes wool look warm: it softens every edge and lifts the roughness where the yarn is thinnest.',
  params: [
    { key: 'yarn', label: 'Yarn', type: 'color', default: [0.55, 0.28, 0.24], group: 'Colour' },
    { key: 'shadowColor', label: 'Between Stitches', type: 'color', default: [0.12, 0.06, 0.05], group: 'Colour' },
    { key: 'stitches', label: 'Stitch Density', type: 'float', default: 22, min: 2, max: 120, step: 0.5, group: 'Pattern' },
    { key: 'aspect', label: 'Stitch Aspect', type: 'float', default: 1.35, min: 0.4, max: 3, step: 0.01, group: 'Pattern', description: 'Knit stitches are wider than they are tall. 1.0 gives a machine-perfect square that no knitter produces.' },
    { key: 'twist', label: 'Yarn Twist', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Pattern', description: 'The plies spiralling along the yarn.' },
    { key: 'depth', label: 'Loop Depth', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'halo', label: 'Fibre Halo', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.88, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('stitches')

    /**
     * A stockinette stitch is two arcs meeting at the bottom. Each arc is a
     * distance to a slanted line inside the cell, so the pair naturally forms
     * the V that knitting is famous for.
     */
    const stitchAt = (uvNode: V2) => {
      const g = vec2(uvNode.x.mul(n), uvNode.y.mul(n).div(p.float('aspect')))
      const cell = g.floor()
      const local = fract(g)
      const centred = local.sub(0.5)
      // Two mirrored arcs: x displaced by a parabola in y.
      const curve = centred.y.mul(centred.y).mul(1.6).sub(0.22)
      const left = centred.x.add(0.24).add(curve).abs()
      const right = centred.x.sub(0.24).sub(curve).abs()
      const d = min(left, right)
      const loop = smoothstep(float(0.2), float(0.02), d)
      // Ply twist runs along the loop, perpendicular to its length.
      const twist = sin(centred.y.mul(Math.PI * 7).add(d.mul(30))).mul(0.5).add(0.5).mul(p.float('twist'))
      return { loop, twist, id: cell, d }
    }

    const haloAt = (uvNode: V2): F =>
      fbm01(vec3(uvNode.mul(n.mul(7)), offset), 3, 2.2, 0.5).sub(0.5).mul(p.float('halo')).mul(0.14)

    const heightAt = (uvNode: V2): F => {
      const s = stitchAt(uvNode)
      return s.loop.pow(0.7).mul(p.float('depth')).add(s.twist.mul(s.loop).mul(0.12)).add(haloAt(uvNode))
    }

    const s = stitchAt(ctx.uv)
    const h = heightAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.5))
    const loop = s.loop.clamp(0, 1)

    const dyed = tintVariation(p.color('yarn'), hash21(s.id.add(vec2(offset, offset))), 0.006, 0.12, 0.12)

    return {
      baseColor: mix(p.color('shadowColor'), dyed.mul(mix(float(0.8), float(1.06), s.twist)), loop),
      metallic: float(0),
      // Wool scatters: it has no real specular, and the halo kills what little
      // there is at every stitch edge.
      roughness: p
        .float('roughness')
        .add(loop.oneMinus().mul(0.08))
        .add(p.float('halo').mul(0.06))
        .clamp(0.3, 1),
      ao: cavityAO(loop, normal, 0.85),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const MANUFACTURED = [
  plainSurface,
  ceramicTiles,
  hexScales,
  carbonFibre,
  plastic,
  camouflage,
  diamondPlate,
  rubberTread,
  knittedWool,
]
