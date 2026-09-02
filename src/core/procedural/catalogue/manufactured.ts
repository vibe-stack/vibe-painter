/**
 * Manufactured surfaces: things made in a mould or on a loom to a tolerance.
 * The giveaway is regularity - and then the small, deliberate irregularity that
 * keeps them from looking like a shader test.
 */

import { float, fract, max, min, mix, sin, smoothstep, step, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import { fbm01, hash21, hexGrid, normalFromHeightFn, voronoi2, warp } from '../noise'

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
      emissive: p.color('emissiveColor').mul(p.float('emissiveStrength')),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const ceramicTiles = registerMaterial({
  id: 'ceramic-tiles',
  name: 'Ceramic Tiles',
  category: 'Manufactured',
  description: 'Glazed tiles with a bevelled edge and recessed grout. Per-tile hue jitter and a tiny rotation keep the grid from reading as a decal.',
  params: [
    { key: 'tiles', label: 'Tiles Across', type: 'float', default: 8, min: 1, max: 60, step: 0.5, group: 'Layout' },
    { key: 'grout', label: 'Grout Width', type: 'float', default: 0.05, min: 0, max: 0.3, step: 0.001, group: 'Layout' },
    { key: 'bevel', label: 'Bevel', type: 'float', default: 0.08, min: 0, max: 0.4, step: 0.001, group: 'Layout' },
    { key: 'tileColor', label: 'Tile Colour', type: 'color', default: [0.85, 0.87, 0.86], group: 'Colour' },
    { key: 'tileColorB', label: 'Accent Colour', type: 'color', default: [0.35, 0.55, 0.6], group: 'Colour' },
    { key: 'accentChance', label: 'Accent Chance', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'groutColor', label: 'Grout Colour', type: 'color', default: [0.5, 0.48, 0.45], group: 'Colour' },
    { key: 'variation', label: 'Tile Variation', type: 'float', default: 0.12, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'glaze', label: 'Glaze', type: 'float', default: 0.9, min: 0, max: 1, step: 0.01, group: 'Surface' },
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

    const maskAt = (uvNode: F, other: F): F => min(uvNode, other)

    const heightAt = (uvNode: V2): F => {
      const t = tileAt(uvNode)
      const d = maskAt(min(t.local.x, t.local.x.oneMinus()), min(t.local.y, t.local.y.oneMinus()))
      const grout = p.float('grout')
      const bevel = p.float('bevel')
      // Flat plateau, bevelled shoulder, then a sharp drop into the grout line.
      return smoothstep(grout, grout.add(bevel), d).mul(p.float('depth'))
    }

    const t = tileAt(ctx.uv)
    const id = hash21(t.id.add(vec2(offset, offset)))
    const accent = step(id, p.float('accentChance'))
    const jitter = hash21(t.id.add(vec2(offset.add(17), offset.add(4))))
    const base = mix(p.color('tileColor'), p.color('tileColorB'), accent)
    const tinted = base.mul(mix(float(1).sub(p.float('variation').mul(0.5)), float(1).add(p.float('variation').mul(0.5)), jitter))

    const h = heightAt(ctx.uv)
    const tileMask = h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1)
    const crackle = fbm01(vec3(ctx.uv.mul(n.mul(20)), offset), 3, 2, 0.5)

    return {
      baseColor: mix(p.color('groutColor').mul(mix(float(0.85), float(1.05), crackle)), tinted, tileMask),
      metallic: float(0),
      roughness: mix(float(0.92), float(1).sub(p.float('glaze').mul(0.9)), tileMask).clamp(0.02, 1),
      ao: mix(float(0.45), float(1), tileMask),
      height: h,
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.5)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const hexScales = registerMaterial({
  id: 'hex-scales',
  name: 'Hex Scales',
  category: 'Manufactured',
  description: 'Hexagonal plating. Each cell is domed and randomly recessed, which gives armour panels and sci-fi hulls their broken-up read.',
  params: [
    { key: 'tint', label: 'Tint', type: 'color', default: [0.35, 0.38, 0.42], group: 'Colour' },
    { key: 'accent', label: 'Accent', type: 'color', default: [0.5, 0.53, 0.58], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 10, min: 1, max: 80, step: 0.1, group: 'Layout' },
    { key: 'gap', label: 'Gap', type: 'float', default: 0.12, min: 0, max: 0.5, step: 0.005, group: 'Layout' },
    { key: 'dome', label: 'Dome', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'recess', label: 'Random Recess', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'metallic', label: 'Metallic', type: 'float', default: 1, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const heightAt = (uvNode: V2): F => {
      const cell = hexGrid(uvNode.mul(p.float('scale')).add(vec2(offset, offset)))
      const d = cell.xy.length()
      const edge = smoothstep(float(0.5).sub(p.float('gap')), float(0.5).sub(p.float('gap')).sub(0.06), d)
      const dome = float(1).sub(d.mul(2).clamp(0, 1)).pow(0.6).mul(p.float('dome'))
      const recess = hash21(cell.zw).mul(p.float('recess'))
      return edge.mul(dome.add(0.4).sub(recess))
    }

    const cell = hexGrid(ctx.uv.mul(p.float('scale')).add(vec2(offset, offset)))
    const id = hash21(cell.zw.add(vec2(3.1, 7.7)))
    const h = heightAt(ctx.uv)
    const plate = h.clamp(0, 1)

    return {
      baseColor: mix(vec3(0.03, 0.03, 0.035), mix(p.color('tint'), p.color('accent'), id), plate),
      metallic: p.float('metallic').mul(plate),
      roughness: p.float('roughness').add(id.sub(0.5).mul(0.12)).clamp(0.03, 1),
      ao: plate.mul(0.55).add(0.45),
      height: plate,
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('dome').add(0.4).mul(1.5)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const carbonFibre = registerMaterial({
  id: 'carbon-fibre',
  name: 'Carbon Fibre',
  category: 'Manufactured',
  description: 'A 2x2 twill weave under clear coat. The diagonal step in the tow pattern is what distinguishes twill from the plain weave used by the fabric material.',
  params: [
    { key: 'tint', label: 'Tow Colour', type: 'color', default: [0.045, 0.045, 0.05], group: 'Colour' },
    { key: 'sheenColor', label: 'Sheen', type: 'color', default: [0.35, 0.36, 0.4], group: 'Colour' },
    { key: 'tows', label: 'Tow Count', type: 'float', default: 30, min: 4, max: 200, step: 1, group: 'Pattern' },
    { key: 'depth', label: 'Weave Depth', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'clearCoat', label: 'Clear Coat', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const n = p.float('tows')

    const twillAt = (uvNode: V2) => {
      const g = uvNode.mul(n)
      const cell = g.floor()
      const local = fract(g)
      // 2x2 twill: the "over" run shifts by one every row.
      const phase = fract(cell.x.sub(cell.y).mul(0.25)).mul(4)
      const over = step(phase, float(1.5))
      const fibre = sin(mix(local.y, local.x, over).mul(Math.PI))
      const ridge = sin(mix(local.x, local.y, over).mul(Math.PI * 8)).mul(0.5).add(0.5)
      return { over, height: fibre.mul(0.85).add(ridge.mul(0.15)) }
    }

    const heightAt = (uvNode: V2): F => twillAt(uvNode).height.mul(p.float('depth'))

    const w = twillAt(ctx.uv)
    const h = w.height.clamp(0, 1)
    // Anisotropic-looking sheen: the tow direction decides how bright it reads.
    const sheen = mix(float(0.2), float(1), h).mul(mix(float(0.6), float(1), w.over))

    return {
      baseColor: mix(p.color('tint'), p.color('sheenColor'), sheen.mul(0.55)),
      metallic: float(0.1),
      roughness: mix(float(0.45), float(0.06), p.float('clearCoat')).add(h.oneMinus().mul(0.1)).clamp(0.02, 1),
      ao: h.mul(0.35).add(0.65),
      height: h,
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.2)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const plastic = registerMaterial({
  id: 'plastic',
  name: 'Plastic',
  category: 'Manufactured',
  description: 'Injection-moulded plastic with an optional spark-eroded texture. The dimple pattern is Voronoi, matching how EDM texturing actually distributes.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: [0.2, 0.22, 0.26], group: 'Colour' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.35, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'texture', label: 'Mould Texture', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'textureScale', label: 'Texture Density', type: 'float', default: 160, min: 10, max: 900, step: 1, group: 'Surface' },
    { key: 'flowLines', label: 'Flow Lines', type: 'float', default: 0.15, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Faint streaks left by the melt front.' },
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
    return {
      baseColor: p.color('color'),
      metallic: float(0),
      roughness: p.float('roughness').add(h.mul(0.45)).clamp(0.02, 1),
      height: h.mul(0.3).add(0.5),
      normal: normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('texture').mul(0.5)),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const camouflage = registerMaterial({
  id: 'camouflage',
  name: 'Camouflage',
  category: 'Manufactured',
  description: 'Four-tone disruptive pattern. Thresholding one warped noise field at three levels guarantees the tones interlock instead of overlapping.',
  params: [
    { key: 'colorA', label: 'Colour A', type: 'color', default: [0.24, 0.26, 0.18], group: 'Colour' },
    { key: 'colorB', label: 'Colour B', type: 'color', default: [0.38, 0.36, 0.25], group: 'Colour' },
    { key: 'colorC', label: 'Colour C', type: 'color', default: [0.16, 0.17, 0.14], group: 'Colour' },
    { key: 'colorD', label: 'Colour D', type: 'color', default: [0.52, 0.48, 0.36], group: 'Colour' },
    { key: 'scale', label: 'Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.05, group: 'Pattern' },
    { key: 'hardness', label: 'Edge Hardness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Pattern' },
    { key: 'warpAmount', label: 'Distortion', type: 'float', default: 0.6, min: 0, max: 3, step: 0.01, group: 'Pattern' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.75, min: 0, max: 1, step: 0.001, group: 'Surface' },
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

    const colour = mix(mix(mix(p.color('colorC'), p.color('colorA'), t1), p.color('colorB'), t2), p.color('colorD'), t3)
    const fabric = fbm01(vec3(ctx.uv.mul(p.float('scale').mul(90)), offset.add(6)), 2, 2, 0.5)

    return {
      baseColor: colour.mul(mix(float(0.9), float(1.08), fabric)),
      metallic: float(0),
      roughness: p.float('roughness').add(fabric.sub(0.5).mul(0.12)).clamp(0.1, 1),
      height: fabric.mul(0.08).add(0.46),
    }
  },
} satisfies ProceduralMaterialDef)

export const MANUFACTURED = [plainSurface, ceramicTiles, hexScales, carbonFibre, plastic, camouflage]
