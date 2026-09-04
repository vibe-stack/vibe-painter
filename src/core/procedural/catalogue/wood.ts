/**
 * Wood, beyond the plain plank.
 *
 * Every wood in here is built from the same primitive: growth rings made by
 * taking a distance field, multiplying it up and taking the fractional part.
 * What separates oak from bamboo from a burl is entirely *what distance* you
 * ring - straight rows, concentric circles, a warped field - and how hard the
 * late wood is relative to the early wood, which is what carries the roughness
 * and the height.
 *
 * The second thing that sells wood is that grain is not a colour: it is a
 * density difference. Late wood is darker, harder, smoother and stands proud
 * once a surface has been sanded or worn, so all four channels move together.
 */

import { abs, float, fract, max, min, mix, smoothstep, vec2, vec3 } from 'three/tsl'
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
  tintVariation,
  warp,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(19.7)

function coord3(ctx: MatContext, scale: F | number = 1) {
  const s = typeof scale === 'number' ? float(scale) : scale
  return vec3(ctx.uv.mul(s), seedOffset(ctx))
}

/**
 * Growth rings around an arbitrary distance field.
 *
 * `distance` is whatever geometry you are ringing; `warpAmount` bends it so
 * the rings wander the way a trunk actually grew. Returned 0..1, with 1 on
 * the dense late wood.
 */
function rings(distance: F, count: F, sharpness: F): F {
  const t = fract(distance.mul(count))
  // Asymmetric: early wood is a wide soft band, late wood a narrow hard one.
  return smoothstep(float(0), sharpness.mul(0.5).add(0.05), t).mul(
    smoothstep(float(1), float(1).sub(sharpness.mul(0.5).add(0.05)), t),
  ).oneMinus()
}

// ---------------------------------------------------------------------------

export const plywood = registerMaterial({
  id: 'plywood',
  name: 'Plywood',
  category: 'Wood',
  description: 'Rotary-peeled veneer: the blade unrolls the log, so the grain comes off as long sweeping arcs rather than as rings, and the sheet is covered in the lathe checks and patch football the mill left behind.',
  params: [
    { key: 'light', label: 'Light Wood', type: 'color', default: [0.75, 0.58, 0.36], group: 'Colour' },
    { key: 'dark', label: 'Dark Grain', type: 'color', default: [0.42, 0.27, 0.14], group: 'Colour' },
    { key: 'patchColor', label: 'Patch', type: 'color', default: [0.6, 0.45, 0.28], group: 'Colour', description: 'The oval plugs the mill drops in where a knot fell out.' },
    { key: 'grainScale', label: 'Grain Scale', type: 'float', default: 5, min: 0.2, max: 40, step: 0.1, group: 'Grain' },
    { key: 'sweep', label: 'Peel Sweep', type: 'float', default: 0.6, min: 0, max: 2, step: 0.01, group: 'Grain', description: 'How strongly the grain arcs. Zero gives sawn boards; this is what says "peeled".' },
    { key: 'ringCount', label: 'Ring Density', type: 'float', default: 14, min: 1, max: 80, step: 0.5, group: 'Grain' },
    { key: 'checks', label: 'Lathe Checks', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Fine cracks left across the veneer by the peeling knife.' },
    { key: 'patches', label: 'Patches', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.68, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'fuzz', label: 'Surface Fuzz', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Raised fibres. Unsanded ply is hairy, and it is why it never goes glossy.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('grainScale')

    // The peel arc: a broad low-frequency bend applied to the ring coordinate.
    const grainAt = (uvNode: V2): F => {
      const bent = uvNode.y.add(
        fbm01(vec3(uvNode.x.mul(scale.mul(0.4)), uvNode.y.mul(scale.mul(0.1)), offset), 3, 2, 0.5)
          .sub(0.5)
          .mul(p.float('sweep')),
      )
      const jitter = fbm01(vec3(uvNode.mul(scale.mul(3)), offset.add(9)), 3, 2.2, 0.55).sub(0.5).mul(0.05)
      return rings(bent.add(jitter), p.float('ringCount'), float(0.6))
    }

    const checkAt = (uvNode: V2): F =>
      scratches(uvNode.add(vec2(offset, offset)), float(1.5708), float(40), scale.mul(10)).mul(p.float('checks'))

    const heightAt = (uvNode: V2): F =>
      grainAt(uvNode).mul(0.12).sub(checkAt(uvNode).mul(0.3)).add(
        fbm01(vec3(uvNode.mul(scale.mul(30)), offset.add(3)), 2, 2, 0.5).sub(0.5).mul(p.float('fuzz')).mul(0.06),
      )

    const grain = grainAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.9))
    const h = heightAt(ctx.uv)

    // Patches: sparse ovals, found by squashing a hash cell.
    const patchCell = vec2(ctx.uv.x.mul(scale.mul(0.5)), ctx.uv.y.mul(scale.mul(0.9)))
    const patchId = hash21(vec2(patchCell.x.floor(), patchCell.y.floor()).add(vec2(offset, offset)))
    const patchLocal = fract(patchCell).sub(0.5)
    const patchDist = vec2(patchLocal.x.mul(0.55), patchLocal.y).length()
    const patch = smoothstep(float(0.34), float(0.28), patchDist)
      .mul(smoothstep(float(0.62), float(0.72), patchId))
      .mul(p.float('patches'))

    const wood = tintVariation(
      mix(p.color('light'), p.color('dark'), grain),
      fbm01(coord3(ctx, scale.mul(0.6)).add(19), 3, 2, 0.5),
      0.01,
      0.16,
      0.18,
    )

    return {
      baseColor: mix(wood, p.color('patchColor'), patch).mul(checkAt(ctx.uv).mul(0.25).oneMinus()),
      metallic: float(0),
      // Late wood is denser and takes a shine; the fuzz kills it everywhere else.
      roughness: p
        .float('roughness')
        .sub(grain.mul(0.12))
        .add(microVariation(ctx.uv, scale.mul(20), offset).mul(p.float('fuzz')).mul(0.2))
        .clamp(0.08, 1),
      ao: cavityAO(h.mul(3).add(0.5).clamp(0, 1), normal, 0.4),
      height: h.mul(2).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const parquet = registerMaterial({
  id: 'parquet',
  name: 'Parquet Floor',
  category: 'Wood',
  description: 'Herringbone blocks, each one a separate piece of timber laid at ninety degrees to its neighbour. The grain direction has to rotate with the block or the whole floor reads as a printed pattern - that rotation is the entire material.',
  params: [
    { key: 'light', label: 'Light Wood', type: 'color', default: [0.6, 0.4, 0.22], group: 'Colour' },
    { key: 'dark', label: 'Dark Grain', type: 'color', default: [0.28, 0.16, 0.08], group: 'Colour' },
    { key: 'variation', label: 'Block Variation', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Every block came from a different board.' },
    { key: 'blocks', label: 'Blocks Across', type: 'float', default: 8, min: 1, max: 40, step: 0.5, group: 'Layout' },
    { key: 'aspect', label: 'Block Aspect', type: 'float', default: 4, min: 1, max: 10, step: 0.1, group: 'Layout' },
    { key: 'gap', label: 'Joint Width', type: 'float', default: 0.02, min: 0, max: 0.2, step: 0.001, group: 'Layout' },
    { key: 'ringCount', label: 'Grain Density', type: 'float', default: 26, min: 1, max: 120, step: 0.5, group: 'Grain' },
    { key: 'gloss', label: 'Lacquer', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'A sealed floor: the film flows over the grain, so gloss is smooth where the colour is not.' },
    { key: 'wear', label: 'Traffic Wear', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Walking paths that scuff the lacquer back to bare timber.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('blocks')

    /**
     * Herringbone by parity: on a square lattice, cells alternate between a
     * block running in x and a block running in y. Hashing the pair index
     * gives every block its own timber without any extra field.
     */
    const blockAt = (uvNode: V2) => {
      const q = uvNode.mul(n)
      const cell = vec2(q.x.floor(), q.y.floor())
      const flip = fract(cell.x.add(cell.y).mul(0.5)).mul(2)
      const local = fract(q)
      // Rotate the block's interior coordinate a quarter turn on alternate cells.
      const rotated = vec2(mix(local.x, local.y, flip), mix(local.y, local.x, flip))
      return { cell, local, rotated, flip }
    }

    const grainAt = (uvNode: V2): F => {
      const b = blockAt(uvNode)
      const id = hash21(b.cell.add(vec2(offset, offset)))
      // Along-block grain, so it turns with the block.
      const along = b.rotated.y.mul(p.float('aspect')).add(id.mul(7))
      const wander = fbm01(vec3(b.rotated.mul(vec2(2, 0.4)).add(id.mul(13)), offset), 3, 2, 0.5).sub(0.5).mul(0.25)
      return rings(along.add(wander), p.float('ringCount').div(p.float('aspect')), float(0.7))
    }

    const jointAt = (uvNode: V2): F => {
      const b = blockAt(uvNode)
      const d = min(min(b.local.x, b.local.x.oneMinus()), min(b.local.y, b.local.y.oneMinus()))
      return smoothstep(p.float('gap').add(0.004), p.float('gap'), d)
    }

    const heightAt = (uvNode: V2): F => {
      const b = blockAt(uvNode)
      const id = hash21(b.cell.add(vec2(offset.add(3), offset)))
      // Blocks are not perfectly co-planar; a floor is a set of separate pieces.
      const lift = id.sub(0.5).mul(0.08)
      return jointAt(uvNode).oneMinus().mul(float(0.5).add(lift)).sub(grainAt(uvNode).mul(0.03))
    }

    const b = blockAt(ctx.uv)
    const grain = grainAt(ctx.uv)
    const joint = jointAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.2))
    const h = heightAt(ctx.uv)

    const id = hash21(b.cell.add(vec2(offset.add(11), offset.add(5))))
    const wood = tintVariation(
      mix(p.color('light'), p.color('dark'), grain),
      id,
      0.014,
      0.2,
      p.float('variation').mul(0.3),
    )

    // Traffic follows broad paths, not the block layout, so it crosses joints.
    const traffic = smoothstep(float(0.42), float(0.78), fbm01(coord3(ctx, 2.4).add(31), 3, 2, 0.5))
      .mul(p.float('wear'))

    return {
      baseColor: mix(wood, vec3(0.05, 0.035, 0.02), joint).mul(mix(float(1), float(0.92), traffic)),
      metallic: float(0),
      roughness: mix(
        mix(float(0.6), float(0.12), p.float('gloss')).add(traffic.mul(0.45)),
        float(0.95),
        joint,
      ).add(microVariation(ctx.uv, n.mul(30), offset).mul(0.05)).clamp(0.04, 1),
      ao: cavityAO(h.mul(2).clamp(0, 1), normal, 0.6),
      height: h.add(0.4).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const bamboo = registerMaterial({
  id: 'bamboo',
  name: 'Bamboo',
  category: 'Wood',
  description: 'Culms with a raised node ring at each joint. Bamboo is not ringed like a hardwood - it is a bundle of fibres, so the grain runs as fine parallel streaks with no growth rings at all, and the nodes are where all the structure lives.',
  params: [
    { key: 'light', label: 'Culm', type: 'color', default: [0.78, 0.72, 0.44], group: 'Colour' },
    { key: 'dark', label: 'Fibre', type: 'color', default: [0.52, 0.44, 0.22], group: 'Colour' },
    { key: 'nodeColor', label: 'Node', type: 'color', default: [0.44, 0.38, 0.2], group: 'Colour' },
    { key: 'culms', label: 'Culms Across', type: 'float', default: 6, min: 1, max: 40, step: 0.5, group: 'Layout' },
    { key: 'nodeSpacing', label: 'Node Spacing', type: 'float', default: 2.2, min: 0.3, max: 12, step: 0.05, group: 'Layout' },
    { key: 'round', label: 'Culm Roundness', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Layout', description: 'Each culm is a cylinder, so it falls away at its edges.' },
    { key: 'fibre', label: 'Fibre Density', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Grain' },
    { key: 'nodeRelief', label: 'Node Relief', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.42, min: 0, max: 1, step: 0.001, group: 'Surface' },
    { key: 'sheen', label: 'Waxy Sheen', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'The silica skin on a fresh culm, which is why bamboo is shinier than timber.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const culms = p.float('culms')

    const culmAt = (uvNode: V2) => {
      const q = uvNode.x.mul(culms)
      const id = q.floor()
      const local = fract(q)
      return { id, local }
    }

    const nodeAt = (uvNode: V2): F => {
      const c = culmAt(uvNode)
      // Node positions are offset per culm; they never line up across a stand.
      const y = uvNode.y.mul(p.float('nodeSpacing')).add(hash21(vec2(c.id, offset)).mul(3))
      const t = abs(fract(y).sub(0.5)).mul(2)
      return smoothstep(float(0.78), float(0.97), t)
    }

    const heightAt = (uvNode: V2): F => {
      const c = culmAt(uvNode)
      // Cylinder cross-section, plus a groove between culms.
      const round = float(1).sub(abs(c.local.sub(0.5)).mul(2).pow(2)).mul(p.float('round'))
      const seam = smoothstep(float(0.06), float(0), min(c.local, c.local.oneMinus())).mul(0.35)
      const node = nodeAt(uvNode).mul(p.float('nodeRelief')).mul(0.18)
      const fibre = fbm01(vec3(uvNode.mul(vec2(culms.mul(24), 1.5)), offset.add(3)), 3, 2.2, 0.55)
        .sub(0.5)
        .mul(p.float('fibre'))
        .mul(0.05)
      return round.mul(0.5).sub(seam).add(node).add(fibre)
    }

    const c = culmAt(ctx.uv)
    const node = nodeAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.3))
    const h = heightAt(ctx.uv)

    const fibreStreak = fbm01(vec3(ctx.uv.mul(vec2(culms.mul(30), 1.2)), offset.add(7)), 4, 2.3, 0.55)
    const id = hash21(vec2(c.id.add(offset), offset.add(2)))
    const culmColour = tintVariation(
      mix(p.color('light'), p.color('dark'), fibreStreak.mul(p.float('fibre'))),
      id,
      0.02,
      0.2,
      0.22,
    )

    return {
      baseColor: mix(culmColour, p.color('nodeColor'), node.mul(0.85)),
      metallic: float(0),
      // The waxy skin is smoothest on the culm face and scuffed at the nodes.
      roughness: p
        .float('roughness')
        .sub(p.float('sheen').mul(0.25).mul(node.oneMinus()))
        .add(node.mul(0.25))
        .add(fibreStreak.sub(0.5).mul(0.08))
        .clamp(0.05, 1),
      ao: cavityAO(h.mul(2).add(0.3).clamp(0, 1), normal, 0.5),
      height: h.add(0.45).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const charredWood = registerMaterial({
  id: 'charred-wood',
  name: 'Charred Wood',
  category: 'Wood',
  description: 'Shou sugi ban: timber burnt until the surface cracks into an alligator-skin crust. The char is nearly black and very rough, but the crack floors show unburnt wood, and that glimpse of colour underneath is what stops it from reading as flat black paint.',
  params: [
    { key: 'char', label: 'Char', type: 'color', default: [0.035, 0.03, 0.028], group: 'Colour' },
    { key: 'ember', label: 'Under Wood', type: 'color', default: [0.35, 0.19, 0.09], group: 'Colour' },
    { key: 'ash', label: 'Ash', type: 'color', default: [0.42, 0.41, 0.4], group: 'Colour' },
    { key: 'crackScale', label: 'Crust Scale', type: 'float', default: 20, min: 2, max: 120, step: 0.5, group: 'Char' },
    { key: 'crackWidth', label: 'Crack Width', type: 'float', default: 0.1, min: 0.01, max: 0.4, step: 0.005, group: 'Char' },
    { key: 'depth', label: 'Crack Depth', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Char' },
    { key: 'burn', label: 'Burn Depth', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Char', description: 'How completely the surface went to carbon. Lower values leave scorched timber showing through.' },
    { key: 'ashAmount', label: 'Ash Bloom', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Char', description: 'Grey powder sitting on the high points, where a brush has not reached.' },
    { key: 'grainScale', label: 'Grain Scale', type: 'float', default: 12, min: 0.5, max: 80, step: 0.5, group: 'Grain', description: 'Fire follows the grain: the soft early wood burns away first.' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const grainAt = (uvNode: V2): F => {
      const wander = fbm01(vec3(uvNode.mul(vec2(2, 0.5)), offset), 3, 2, 0.5).sub(0.5).mul(0.3)
      return rings(uvNode.y.add(wander), p.float('grainScale'), float(0.75))
    }

    const crackAt = (uvNode: V2): F => {
      // Two crack scales: the big plate boundaries and the fine crazing inside.
      const coarse = cracks(uvNode, p.float('crackScale'), p.float('crackWidth'), offset.add(3))
      const fine = cracks(uvNode, p.float('crackScale').mul(3.2), p.float('crackWidth').mul(0.6), offset.add(29))
      return max(coarse, fine.mul(0.55))
    }

    const heightAt = (uvNode: V2): F =>
      crackAt(uvNode).negate().mul(p.float('depth')).add(grainAt(uvNode).mul(0.12)).add(
        fbm01(vec3(uvNode.mul(p.float('crackScale').mul(6)), offset.add(9)), 3, 2.3, 0.6).sub(0.5).mul(0.08),
      )

    const crack = crackAt(ctx.uv)
    const grain = grainAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2))
    const h = heightAt(ctx.uv)

    // Burn is deepest in the soft early wood; the hard grain resists.
    const burn = p.float('burn').mul(mix(float(1.1), float(0.75), grain)).clamp(0, 1)
    const exposed = crack.mul(burn.oneMinus().mul(0.5).add(0.5))
    const ash = smoothstep(float(0.55), float(0.85), fbm01(coord3(ctx, p.float('crackScale').mul(0.5)).add(41), 4, 2.1, 0.55))
      .mul(crack.oneMinus())
      .mul(p.float('ashAmount'))

    const surface = mix(p.color('ember').mul(0.6), p.color('char'), burn)
    const withCracks = mix(surface, p.color('ember'), exposed.mul(0.75))

    return {
      baseColor: mix(withCracks, p.color('ash'), ash.mul(0.6)),
      metallic: float(0),
      // Carbon is one of the roughest things there is; ash is rougher still.
      roughness: mix(float(0.72), float(0.96), burn).add(ash.mul(0.04)).sub(exposed.mul(0.1)).clamp(0.2, 1),
      ao: cavityAO(h.mul(1.6).add(0.55).clamp(0, 1), normal, 0.8),
      height: h.mul(0.8).add(0.55).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const driftwood = registerMaterial({
  id: 'driftwood',
  name: 'Driftwood',
  category: 'Wood',
  description: 'Timber that has been in the sea. Salt and sun strip the colour to grey while the water erodes the soft early wood away entirely, leaving the hard grain standing proud - so unlike fresh timber, here the grain is a ridge you can feel, not a stripe.',
  params: [
    { key: 'pale', label: 'Bleached', type: 'color', default: [0.66, 0.65, 0.62], group: 'Colour' },
    { key: 'shadowWood', label: 'Deep Grain', type: 'color', default: [0.32, 0.29, 0.25], group: 'Colour' },
    { key: 'stain', label: 'Water Stain', type: 'color', default: [0.36, 0.31, 0.24], group: 'Colour' },
    { key: 'ringCount', label: 'Grain Density', type: 'float', default: 22, min: 1, max: 120, step: 0.5, group: 'Grain' },
    { key: 'wander', label: 'Grain Wander', type: 'float', default: 0.5, min: 0, max: 2, step: 0.01, group: 'Grain' },
    { key: 'erosion', label: 'Erosion', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'How far the soft wood has been washed out from between the hard rings.' },
    { key: 'splits', label: 'Splits', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Wear', description: 'Checks running along the grain, opened by repeated wetting and drying.' },
    { key: 'bleach', label: 'Bleaching', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Wear' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.85, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    const grainAt = (uvNode: V2): F => {
      const wander = fbm01(vec3(uvNode.mul(vec2(1.6, 0.35)), offset), 4, 2.1, 0.55).sub(0.5).mul(p.float('wander'))
      return rings(uvNode.y.add(wander), p.float('ringCount'), float(0.85))
    }

    const splitAt = (uvNode: V2): F =>
      scratches(uvNode.add(vec2(offset, offset)), float(0), float(90), p.float('ringCount').mul(0.8))
        .mul(p.float('splits'))

    const heightAt = (uvNode: V2): F => {
      const grain = grainAt(uvNode)
      // Erosion is subtractive: it removes the *soft* wood, so the hard ring
      // is left standing rather than being built up.
      const eroded = grain.oneMinus().mul(p.float('erosion')).mul(0.35)
      const fibre = fbm01(vec3(uvNode.mul(vec2(160, 8)), offset.add(5)), 3, 2.3, 0.55).sub(0.5).mul(0.05)
      return eroded.negate().add(fibre).sub(splitAt(uvNode).mul(0.3))
    }

    const grain = grainAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.6))
    const h = heightAt(ctx.uv)

    const stainField = smoothstep(float(0.45), float(0.8), fbm01(coord3(ctx, 3).add(23), 4, 2.1, 0.55))
    const bleached = mix(p.color('shadowWood'), p.color('pale'), p.float('bleach').mul(mix(float(0.6), float(1), grain)))
    const colour = mix(bleached, p.color('stain'), stainField.mul(0.5))

    return {
      baseColor: tintVariation(colour, stainField, 0.008, 0.12, 0.16),
      metallic: float(0),
      // Weathered wood has no film left at all: it is uniformly, deeply matt.
      roughness: p.float('roughness').add(grain.oneMinus().mul(0.08)).sub(grain.mul(0.05)).clamp(0.35, 1),
      ao: cavityAO(h.mul(2).add(0.7).clamp(0, 1), normal, 0.65),
      height: h.mul(1.2).add(0.6).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const burlWood = registerMaterial({
  id: 'burl-wood',
  name: 'Burl Wood',
  category: 'Wood',
  description: 'A burl is a growth where the grain lost its direction entirely: rings collapse into swirling eyes around dormant buds. Domain-warping the ring coordinate hard - far harder than any straight-grain wood would take - is exactly that loss of direction.',
  params: [
    { key: 'light', label: 'Light', type: 'color', default: [0.62, 0.4, 0.2], group: 'Colour' },
    { key: 'mid', label: 'Mid', type: 'color', default: [0.4, 0.22, 0.1], group: 'Colour' },
    { key: 'dark', label: 'Eye', type: 'color', default: [0.14, 0.07, 0.03], group: 'Colour' },
    { key: 'scale', label: 'Figure Scale', type: 'float', default: 6, min: 0.5, max: 40, step: 0.1, group: 'Figure' },
    { key: 'swirl', label: 'Swirl', type: 'float', default: 1.1, min: 0, max: 3, step: 0.01, group: 'Figure', description: 'How completely the grain has lost its direction. This is the whole material.' },
    { key: 'ringCount', label: 'Ring Density', type: 'float', default: 18, min: 1, max: 90, step: 0.5, group: 'Figure' },
    { key: 'eyes', label: 'Eyes', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Figure', description: 'The dark bud clusters a burl is prized for.' },
    { key: 'gloss', label: 'Polish', type: 'float', default: 0.75, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Burl is a veneer material: it is nearly always seen under a thick finish.' },
    { key: 'pores', label: 'Open Pores', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const figureAt = (uvNode: V2): F => {
      const base = vec3(uvNode.mul(scale), offset)
      const warped = warp(base, p.float('swirl'), 1.3)
      // Ridged noise gives the sharp reversals a burl has; plain fbm is too soft.
      const d = ridged(warped, float(4), float(0.6))
      return rings(d, p.float('ringCount').mul(0.1), float(0.85))
    }

    const eyeAt = (uvNode: V2): F => {
      const warped = warp(vec3(uvNode.mul(scale.mul(2.2)), offset.add(13)), p.float('swirl').mul(0.5), 2)
      return smoothstep(float(0.62), float(0.86), fbm01(warped, 4, 2.2, 0.55)).mul(p.float('eyes'))
    }

    const heightAt = (uvNode: V2): F =>
      figureAt(uvNode).mul(0.06).sub(eyeAt(uvNode).mul(0.1)).sub(
        smoothstep(float(0.7), float(0.95), fbm01(vec3(uvNode.mul(scale.mul(40)), offset.add(3)), 2, 2, 0.5))
          .mul(p.float('pores'))
          .mul(0.12),
      )

    const figure = figureAt(ctx.uv)
    const eye = eyeAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(0.8))
    const h = heightAt(ctx.uv)

    const wood = gradient3(figure.clamp(0, 1), p.color('light'), p.color('mid'), p.color('dark'))
    const colour = mix(wood, p.color('dark'), eye)

    return {
      baseColor: tintVariation(colour, fbm01(coord3(ctx, scale.mul(0.4)).add(37), 3, 2, 0.5), 0.012, 0.18, 0.2),
      metallic: float(0),
      // A finished veneer: the film is smooth, so roughness varies far less
      // than colour does. Only the open pores break it.
      roughness: mix(float(0.55), float(0.09), p.float('gloss'))
        .add(smoothstep(float(0.7), float(0.95), fbm01(coord3(ctx, scale.mul(40)).add(3), 2, 2, 0.5)).mul(p.float('pores')).mul(0.35))
        .clamp(0.03, 1),
      ao: cavityAO(h.mul(4).add(0.65).clamp(0, 1), normal, 0.35),
      height: h.mul(3).add(0.5).clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const wicker = registerMaterial({
  id: 'wicker',
  name: 'Wicker Weave',
  category: 'Wood',
  description: 'Split cane woven over and under. It is a brick grid read twice - once for the horizontal strands, once for the vertical - with the parity of the cell deciding which one is on top, so the strands genuinely interleave instead of one layer being drawn over the other.',
  params: [
    { key: 'cane', label: 'Cane', type: 'color', default: [0.68, 0.52, 0.3], group: 'Colour' },
    { key: 'caneDark', label: 'Cane Dark', type: 'color', default: [0.42, 0.3, 0.16], group: 'Colour' },
    { key: 'gapColor', label: 'Shadow', type: 'color', default: [0.06, 0.045, 0.03], group: 'Colour' },
    { key: 'scale', label: 'Weave Density', type: 'float', default: 10, min: 1, max: 60, step: 0.5, group: 'Weave' },
    { key: 'width', label: 'Strand Width', type: 'float', default: 0.78, min: 0.2, max: 1, step: 0.01, group: 'Weave', description: 'Below 1 the strands separate and you see through the basket.' },
    { key: 'round', label: 'Strand Round', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Weave' },
    { key: 'depth', label: 'Weave Depth', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Weave' },
    { key: 'fibre', label: 'Cane Fibre', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.6, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const scale = p.float('scale')

    const strandAt = (uvNode: V2) => {
      const q = uvNode.mul(scale)
      const cell = vec2(q.x.floor(), q.y.floor())
      const local = fract(q)
      const w = p.float('width').mul(0.5)
      // Rounded cross-section for each strand, in its own axis.
      const dx = float(1).sub(abs(local.x.sub(0.5)).div(max(w, float(1e-3))).clamp(0, 1)).pow(mix(float(1), float(0.4), p.float('round')))
      const dy = float(1).sub(abs(local.y.sub(0.5)).div(max(w, float(1e-3))).clamp(0, 1)).pow(mix(float(1), float(0.4), p.float('round')))
      // Parity decides which strand is over: the checker is the weave.
      const over = fract(cell.x.add(cell.y).mul(0.5)).mul(2)
      return { cell, local, dx, dy, over }
    }

    const heightAt = (uvNode: V2): F => {
      const s = strandAt(uvNode)
      const vertical = s.dx.mul(mix(float(0.55), float(1), s.over))
      const horizontal = s.dy.mul(mix(float(1), float(0.55), s.over))
      const fibre = fbm01(vec3(uvNode.mul(scale.mul(vec2(3, 40))), offset), 3, 2.2, 0.55).sub(0.5).mul(p.float('fibre')).mul(0.06)
      return max(vertical, horizontal).mul(p.float('depth')).add(fibre)
    }

    const s = strandAt(ctx.uv)
    const cover = max(s.dx, s.dy).clamp(0, 1)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, float(1.5))
    const h = heightAt(ctx.uv)

    // Which strand won here decides which cell id to hash, so neighbouring
    // strands are different pieces of cane rather than one tinted field.
    const pickV = smoothstep(float(0), float(0.02), s.dx.sub(s.dy))
    const id = mix(
      hash21(vec2(s.cell.x, offset)),
      hash21(vec2(offset, s.cell.y)),
      pickV,
    )
    const fibreStreak = fbm01(vec3(ctx.uv.mul(scale.mul(vec2(2, 30))), offset.add(7)), 3, 2.2, 0.55)
    const caneColour = tintVariation(
      mix(p.color('caneDark'), p.color('cane'), fibreStreak.mul(0.6).add(0.4)),
      id,
      0.015,
      0.18,
      0.24,
    )

    return {
      baseColor: mix(p.color('gapColor'), caneColour, cover),
      metallic: float(0),
      roughness: p.float('roughness').add(fibreStreak.sub(0.5).mul(0.2)).add(cover.oneMinus().mul(0.2)).clamp(0.1, 1),
      ao: cavityAO(h.div(max(p.float('depth'), float(1e-3))).clamp(0, 1), normal, 0.8),
      height: h.clamp(0, 1),
      normal,
    }
  },
} satisfies ProceduralMaterialDef)

export const WOOD = [plywood, parquet, bamboo, charredWood, driftwood, burlWood, wicker]
