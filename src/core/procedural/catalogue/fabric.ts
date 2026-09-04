/**
 * Cloth and soft goods.
 *
 * Fabric is the family where getting the *normal* right matters more than
 * getting the colour right. A weave is almost flat in albedo - two threads dyed
 * the same colour - and reads entirely through the way light catches the
 * curvature of each thread. So every material here derives its normal from a
 * height field describing thread geometry, and most of them then ride a second,
 * much finer normal on top for the fibres that make up each thread.
 *
 * The other thing cloth has that hard surfaces do not is *fuzz*: a halo of
 * stray fibres that softens every edge and lifts the roughness slightly
 * everywhere. It is a small effect and its absence is instantly noticeable.
 */

import { float, max, min, mix, smoothstep, vec2, vec3 } from 'three/tsl'
import type { MatContext, ProceduralMaterialDef } from '../material'
import { SEED_PARAM, registerMaterial } from '../material'
import type { F, PartialBundle, V2 } from '../../gpu/nodes'
import {
  blendDetailNormal,
  cavityAO,
  fbm01,
  hash21,
  normalFromHeightFn,
  tintVariation,
  warp,
} from '../noise'

const seedOffset = (ctx: MatContext): F => ctx.params.float('seed').mul(11.3)

/**
 * Stray fibre halo, shared by every fabric here.
 *
 * Real cloth is never a clean surface: broken fibres stand up off it and catch
 * light on their own. Modelled as a very high frequency field folded into the
 * normal and the roughness, it costs almost nothing and it is the difference
 * between "cloth" and "a bumpy plastic sheet".
 */
function fuzz(uvNode: V2, scale: F, offset: F): F {
  return fbm01(vec3(uvNode.mul(scale.mul(9)), offset.add(61)), 3, 2.6, 0.6)
}

export const denim = registerMaterial({
  id: 'denim',
  name: 'Denim',
  category: 'Fabric',
  description:
    'A 3/1 right-hand twill: the warp threads are indigo-dyed only on their surface and the weft is left white, which is why denim shows diagonal ridges and why it fades to white at every wear point. Both of those come out of the same twill offset here rather than being drawn separately.',
  params: [
    { key: 'threads', label: 'Thread Count', type: 'float', default: 90, min: 8, max: 400, step: 1, group: 'Weave' },
    { key: 'twill', label: 'Twill Step', type: 'float', default: 3, min: 1, max: 6, step: 1, group: 'Weave', description: 'How many warps the weft passes over before going under. 3 is classic denim.' },
    { key: 'depth', label: 'Weave Depth', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Weave' },
    { key: 'slub', label: 'Slub', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Weave', description: 'Thick spots in the yarn. Ring-spun denim is full of them; a smooth yarn looks synthetic.' },
    { key: 'indigo', label: 'Indigo', type: 'color', default: [0.08, 0.13, 0.26], group: 'Colour' },
    { key: 'weftColor', label: 'Weft Colour', type: 'color', default: [0.72, 0.7, 0.64], group: 'Colour' },
    { key: 'fade', label: 'Wear Fade', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Abrasion takes the dye off the crown of each warp thread first, exposing the white core.' },
    { key: 'whiskers', label: 'Whiskering', type: 'float', default: 0.25, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'The pale creases that form where the fabric folds repeatedly.' },
    { key: 'fuzz', label: 'Fuzz', type: 'float', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.86, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('threads')

    /**
     * The twill float.
     *
     * A plain weave alternates every thread; a twill shifts the crossing point
     * by one warp each row, and the diagonal wale is the accumulation of that
     * shift. Deriving it from `floor(row)` rather than drawing diagonal stripes
     * means the ridges land exactly on threads, which is what makes the weave
     * survive close inspection.
     */
    const weaveAt = (uvNode: V2) => {
      const col = uvNode.x.mul(n)
      const row = uvNode.y.mul(n)
      const step_ = p.float('twill')
      const shifted = col.add(row.floor()).div(step_)
      const over = shifted.fract()
      // 1 where the weft floats over the warp, 0 where it dives under.
      const weft = smoothstep(float(0.5), float(0.42), over.sub(0.5).abs())

      // Each thread is a rounded cylinder across its own width.
      const warpProfile = col.fract().sub(0.5).abs().mul(2).oneMinus()
      const weftProfile = row.fract().sub(0.5).abs().mul(2).oneMinus()
      const warpRound = warpProfile.pow(0.6)
      const weftRound = weftProfile.pow(0.6)

      // Slub: per-thread thickness variation, constant along the thread.
      const warpSlub = hash21(vec2(col.floor(), offset)).sub(0.5).mul(p.float('slub')).mul(0.5)
      const weftSlub = hash21(vec2(offset.add(3), row.floor())).sub(0.5).mul(p.float('slub')).mul(0.5)

      const height = mix(warpRound.add(warpSlub), weftRound.add(weftSlub), weft)
      return { height, weft, warpRound, weftRound, col, row }
    }

    const heightAt = (uvNode: V2): F => {
      const w = weaveAt(uvNode)
      // Cloth drapes: a slow undulation under the weave, or it reads as a
      // printed pattern on a rigid board.
      const drape = fbm01(vec3(uvNode.mul(6), offset.add(19)), 3, 2, 0.5).sub(0.5).mul(0.35)
      return w.height.mul(p.float('depth')).add(drape.mul(p.float('depth')))
    }

    const w = weaveAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.6))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('depth'), float(1e-3))).mul(0.8).clamp(0, 1)

    // Ring dyeing: only the outside of the warp took the indigo, so abrasion
    // on the crown of a thread shows the white core underneath.
    const crown = w.warpRound.pow(3)
    const abrasion = fbm01(vec3(ctx.uv.mul(9), offset.add(29)), 4, 2.1, 0.55)
    const worn = smoothstep(float(0.5), float(0.85), abrasion).mul(crown).mul(p.float('fade'))

    // Whiskers run across the fabric where it creases, so they are stretched.
    const whiskerField = fbm01(vec3(ctx.uv.x.mul(3.5), ctx.uv.y.mul(26), offset.add(41)), 3, 2.2, 0.55)
    const whisker = smoothstep(float(0.62), float(0.82), whiskerField).mul(p.float('whiskers'))

    const warpColour = tintVariation(
      p.color('indigo'),
      hash21(vec2(w.col.floor(), offset.add(7))),
      0.012,
      0.2,
      0.3,
    )
    const weftColour = p.color('weftColor')

    let colour = mix(warpColour, weftColour, w.weft.mul(0.85))
    colour = mix(colour, weftColour, worn.max(whisker).clamp(0, 1).mul(0.8))

    const f = fuzz(ctx.uv, n, offset).sub(0.5).mul(p.float('fuzz'))
    const detailNormal = vec3(f.mul(0.5), f.mul(0.5), float(1))

    return {
      baseColor: colour,
      metallic: float(0),
      roughness: p
        .float('roughness')
        .add(f.mul(0.12))
        .add(worn.mul(0.06))
        .sub(w.height.mul(0.05))
        .clamp(0.3, 1),
      ao: cavityAO(h01, normal, 0.75),
      height: h01,
      normal: blendDetailNormal(normal, detailNormal, p.float('fuzz')),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const corduroy = registerMaterial({
  id: 'corduroy',
  name: 'Corduroy',
  category: 'Fabric',
  description:
    'Cut pile in wales. Each wale is a tuft of cut fibre standing up off a plain ground weave, so the top of a wale scatters light in every direction while the channel between them shows the flat backing - which is why corduroy looks striped even in a single colour.',
  params: [
    { key: 'wales', label: 'Wales', type: 'float', default: 22, min: 2, max: 120, step: 0.5, group: 'Pile' },
    { key: 'walleWidth', label: 'Wale Width', type: 'float', default: 0.68, min: 0.15, max: 0.95, step: 0.01, group: 'Pile', description: 'Fraction of the pitch the pile covers. The rest is the exposed channel.' },
    { key: 'pileHeight', label: 'Pile Height', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Pile' },
    { key: 'crush', label: 'Crush', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Pile', description: 'Flattened patches where the pile has been sat on. Corduroy never recovers evenly.' },
    { key: 'pileColor', label: 'Pile Colour', type: 'color', default: [0.35, 0.19, 0.1], group: 'Colour' },
    { key: 'groundColor', label: 'Ground Colour', type: 'color', default: [0.2, 0.11, 0.06], group: 'Colour' },
    { key: 'sheen', label: 'Sheen', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Cut pile catches light along the fibre tips. Raising this brightens the crown of each wale.' },
    { key: 'fuzz', label: 'Fuzz', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.9, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const wales = p.float('wales')

    const waleAt = (uvNode: V2) => {
      // A slight wander, so the wales are not perfectly parallel rules.
      const wander = fbm01(vec3(uvNode.y.mul(3), offset, 0), 2, 2, 0.5).sub(0.5).mul(0.06)
      const t = uvNode.x.add(wander).mul(wales)
      const local = t.fract().sub(0.5).abs().mul(2)
      const width = p.float('walleWidth')
      // Flat-topped: the pile is cut level, so this is a plateau, not a dome.
      const pile = smoothstep(width, width.mul(0.55), local)
      const crown = smoothstep(float(1), float(0.2), local)
      return { pile, crown, id: t.floor() }
    }

    const crushAt = (uvNode: V2): F =>
      smoothstep(float(0.45), float(0.75), fbm01(vec3(uvNode.mul(5), offset.add(13)), 4, 2.1, 0.55)).mul(p.float('crush'))

    const heightAt = (uvNode: V2): F => {
      const w = waleAt(uvNode)
      // The backing weave, visible in the channels.
      const ground = vec2(uvNode.x.mul(wales.mul(4)), uvNode.y.mul(wales.mul(4)))
      const weave = ground.x.fract().sub(0.5).abs().add(ground.y.fract().sub(0.5).abs()).mul(0.12)
      const fibre = fbm01(vec3(uvNode.mul(vec2(wales.mul(3), wales.mul(14))), offset.add(7)), 3, 2.3, 0.55).sub(0.5).mul(0.18)
      const crushed = crushAt(uvNode)
      return w.pile
        .mul(p.float('pileHeight'))
        .mul(mix(float(1), float(0.45), crushed))
        .add(fibre.mul(w.pile).mul(p.float('pileHeight')))
        .add(weave.mul(w.pile.oneMinus()))
    }

    const w = waleAt(ctx.uv)
    const crushed = crushAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('pileHeight').mul(2))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('pileHeight'), float(1e-3))).clamp(0, 1)

    const pileColour = tintVariation(p.color('pileColor'), hash21(vec2(w.id, offset)), 0.008, 0.14, 0.16)
    // Cut fibre ends scatter forward, so the crown of a wale reads lighter.
    const lit = pileColour.mul(float(1).add(w.crown.mul(p.float('sheen')).mul(0.45)))
    const colour = mix(p.color('groundColor'), lit, w.pile)

    const f = fuzz(ctx.uv, wales.mul(2), offset).sub(0.5).mul(p.float('fuzz'))
    const detailNormal = vec3(f.mul(0.8), f.mul(0.8), float(1))

    return {
      baseColor: colour.mul(mix(float(1), float(0.88), crushed)),
      metallic: float(0),
      // Crushed pile lies flat and becomes shinier, exactly like worn velvet.
      roughness: p.float('roughness').add(f.mul(0.1)).sub(crushed.mul(0.25)).sub(w.crown.mul(0.05)).clamp(0.2, 1),
      ao: cavityAO(h01, normal, 0.85),
      height: h01,
      normal: blendDetailNormal(normal, detailNormal, p.float('fuzz')),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const knitWool = registerMaterial({
  id: 'knit-wool',
  name: 'Knit Wool',
  category: 'Fabric',
  description:
    'Stocking-stitch knitting. Each stitch is a V of yarn looped through the row below, and the loops interlock rather than sitting side by side - which is why knit fabric stretches and why the V shape has to be built as two arcs meeting at a point rather than as a chevron stamp.',
  params: [
    { key: 'stitches', label: 'Stitches Across', type: 'float', default: 16, min: 2, max: 90, step: 0.5, group: 'Knit' },
    { key: 'rowRatio', label: 'Row Ratio', type: 'float', default: 1.35, min: 0.5, max: 3, step: 0.01, group: 'Knit', description: 'Rows per stitch. Knitting is always wider than it is tall per loop.' },
    { key: 'yarnWidth', label: 'Yarn Width', type: 'float', default: 0.32, min: 0.1, max: 0.6, step: 0.01, group: 'Knit' },
    { key: 'depth', label: 'Loop Depth', type: 'float', default: 0.65, min: 0, max: 1, step: 0.01, group: 'Knit' },
    { key: 'ply', label: 'Ply Twist', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Knit', description: 'The spiral of the plies that make up the yarn, running along each loop.' },
    { key: 'yarnColor', label: 'Yarn Colour', type: 'color', default: [0.62, 0.55, 0.44], group: 'Colour' },
    { key: 'shadowColor', label: 'Gap Colour', type: 'color', default: [0.14, 0.12, 0.1], group: 'Colour' },
    { key: 'heather', label: 'Heather', type: 'float', default: 0.4, min: 0, max: 1, step: 0.01, group: 'Colour', description: 'Undyed and differently dyed fibres spun together, which is what stops wool being a flat colour.' },
    { key: 'fuzz', label: 'Halo', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.92, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const n = p.float('stitches')

    /**
     * One stitch: two arcs of yarn forming a V, offset half a stitch on
     * alternate rows so the loops interlock.
     *
     * Each arc is a distance to a circle, not to a line - the yarn genuinely
     * curves round the loop below it, and a straight-legged V reads as a
     * printed chevron rather than as knitting.
     */
    const stitchAt = (uvNode: V2) => {
      const rows = n.mul(p.float('rowRatio'))
      const gx = uvNode.x.mul(n)
      const gy = uvNode.y.mul(rows)
      const rowIndex = gy.floor()
      // Alternate rows shift by half a stitch: that is the interlock.
      const shifted = gx.add(rowIndex.mul(0.5))
      const local = vec2(shifted.fract().sub(0.5), gy.fract().sub(0.5))

      const w = p.float('yarnWidth')
      // Two arcs, centred left and right, meeting at the bottom of the V.
      const left = vec2(local.x.add(0.5), local.y.mul(1.25)).length().sub(0.5).abs()
      const right = vec2(local.x.sub(0.5), local.y.mul(1.25)).length().sub(0.5).abs()
      const d = min(left, right)
      const yarn = smoothstep(w, w.mul(0.35), d)
      // Round profile across the yarn's own width.
      const profile = smoothstep(w, float(0), d).pow(0.55)
      return { yarn, profile, d, id: vec2(shifted.floor(), rowIndex), local }
    }

    const heightAt = (uvNode: V2): F => {
      const s = stitchAt(uvNode)
      // Plies spiral along the yarn, so the twist runs across the loop.
      const twist = fbm01(
        vec3(s.local.x.mul(38).add(s.local.y.mul(22)), s.local.y.mul(8), offset.add(3)),
        2,
        2,
        0.5,
      )
        .sub(0.5)
        .mul(p.float('ply'))
        .mul(0.28)
      const drape = fbm01(vec3(uvNode.mul(4), offset.add(23)), 3, 2, 0.5).sub(0.5).mul(0.3)
      return s.profile.add(twist.mul(s.yarn)).add(drape).mul(p.float('depth'))
    }

    const s = stitchAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(2.2))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('depth'), float(1e-3))).mul(0.85).clamp(0, 1)

    // Heather is fibre-scale colour noise, finer than a stitch.
    const heatherField = fbm01(vec3(ctx.uv.mul(n.mul(14)), offset.add(31)), 3, 2.4, 0.55)
    const yarnColour = tintVariation(
      p.color('yarnColor'),
      heatherField,
      p.float('heather').mul(0.05),
      p.float('heather').mul(0.4),
      p.float('heather').mul(0.45),
    ).mul(tintVariation(vec3(1, 1, 1), hash21(s.id.add(vec2(offset, offset.add(5)))), 0.004, 0.06, 0.1))

    const colour = mix(p.color('shadowColor'), yarnColour, s.yarn)

    const f = fuzz(ctx.uv, n.mul(3), offset).sub(0.5).mul(p.float('fuzz'))
    const detailNormal = vec3(f.mul(0.9), f.mul(0.9), float(1))

    return {
      baseColor: colour,
      metallic: float(0),
      // Wool is matte and the halo makes it more so; the gaps are darker but
      // no shinier, so roughness barely moves with the pattern.
      roughness: p.float('roughness').add(f.mul(0.08)).sub(s.profile.mul(0.04)).clamp(0.5, 1),
      ao: cavityAO(h01, normal, 0.95),
      height: h01,
      normal: blendDetailNormal(normal, detailNormal, p.float('fuzz')),
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const velvet = registerMaterial({
  id: 'velvet',
  name: 'Velvet',
  category: 'Fabric',
  description:
    'Dense upright pile. Velvet is almost pure normal and roughness: the albedo is one colour, and everything you recognise about it comes from the pile leaning in patches, which makes light run across it in soft bands. The lean direction is a warped vector field, so brushing marks flow rather than dapple.',
  params: [
    { key: 'density', label: 'Pile Density', type: 'float', default: 140, min: 20, max: 500, step: 1, group: 'Pile' },
    { key: 'lean', label: 'Lean', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Pile', description: 'How far the pile is pushed over. This is what a brushed handprint on velvet actually is.' },
    { key: 'leanScale', label: 'Lean Scale', type: 'float', default: 3.5, min: 0.5, max: 20, step: 0.05, group: 'Pile', description: 'Size of the patches that lean together.' },
    { key: 'pileColor', label: 'Pile Colour', type: 'color', default: [0.24, 0.04, 0.09], group: 'Colour' },
    { key: 'sheenColor', label: 'Sheen Colour', type: 'color', default: [0.85, 0.45, 0.5], group: 'Colour', description: 'The colour of light grazing the fibre tips, which is usually much lighter and less saturated than the body.' },
    { key: 'sheen', label: 'Sheen', type: 'float', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'crush', label: 'Crush', type: 'float', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Colour' },
    { key: 'relief', label: 'Relief', type: 'float', default: 0.22, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.75, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)

    /**
     * The lean field. Two warped noises give a direction per point; the pile
     * tips over that way and the normal follows. Everything velvet does under
     * light comes out of this one vector.
     */
    const leanAt = (uvNode: V2) => {
      const w = warp(vec3(uvNode.mul(p.float('leanScale')), offset), 0.7, 1.3)
      const lx = fbm01(w, 3, 2, 0.5).sub(0.5).mul(2)
      const ly = fbm01(w.add(vec3(19.3, 7.1, 3.7)), 3, 2, 0.5).sub(0.5).mul(2)
      return vec2(lx, ly).mul(p.float('lean'))
    }

    const heightAt = (uvNode: V2): F => {
      const fibres = fbm01(vec3(uvNode.mul(p.float('density')), offset.add(11)), 2, 2.4, 0.6)
      const lean = leanAt(uvNode)
      // Pile pushed flat sits lower than pile standing upright.
      const upright = lean.length().oneMinus().clamp(0, 1)
      return fibres.mul(0.35).add(upright.mul(0.65)).mul(p.float('relief'))
    }

    const lean = leanAt(ctx.uv)
    const leanAmount = lean.length().clamp(0, 1)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('relief').mul(3))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('relief'), float(1e-3))).clamp(0, 1)

    /**
     * The pile's own tilt, added straight into the normal.
     *
     * This is the part a height field cannot express: the fibres are *leaning*,
     * which tilts the surface they present to the light without the surface
     * itself moving. It is what makes velvet change colour as you turn it.
     */
    const tilted = blendDetailNormal(normal, vec3(lean.x.mul(0.8), lean.y.mul(0.8), float(1)), 1)

    // Light grazes leaning pile and is absorbed by upright pile.
    const grazing = leanAmount.pow(0.7).mul(p.float('sheen'))
    const crushed = smoothstep(float(0.4), float(0.9), leanAmount).mul(p.float('crush'))
    const body = tintVariation(p.color('pileColor'), fbm01(vec3(ctx.uv.mul(6), offset.add(29)), 3, 2, 0.5), 0.01, 0.12, 0.14)
    const colour = mix(body, p.color('sheenColor'), grazing.mul(0.7))

    return {
      baseColor: colour.mul(mix(float(1), float(1.12), crushed)),
      metallic: float(0),
      // Flattened pile presents aligned fibres, so it is markedly smoother.
      roughness: p.float('roughness').sub(grazing.mul(0.35)).sub(crushed.mul(0.15)).clamp(0.12, 1),
      ao: cavityAO(h01, normal, 0.6),
      height: h01,
      normal: tilted,
    }
  },
} satisfies ProceduralMaterialDef)

// ---------------------------------------------------------------------------

export const quiltedPadding = registerMaterial({
  id: 'quilted-padding',
  name: 'Quilted Padding',
  category: 'Fabric',
  description:
    'Wadding puffed up between stitch lines. The puff is a dome that falls off toward each seam, and the seam itself pulls the fabric into a pucker - a dimple with a raised lip on both sides. The pucker is what sells it; a plain grid of domes looks like bubble wrap.',
  params: [
    { key: 'cells', label: 'Cells Across', type: 'float', default: 5, min: 1, max: 40, step: 0.25, group: 'Quilt' },
    { key: 'diamond', label: 'Diamond', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Quilt', description: 'Rotates the grid from squares toward the classic diamond quilt.' },
    { key: 'puff', label: 'Puff', type: 'float', default: 0.7, min: 0, max: 1, step: 0.01, group: 'Quilt' },
    { key: 'seamWidth', label: 'Seam Width', type: 'float', default: 0.06, min: 0.005, max: 0.3, step: 0.001, group: 'Quilt' },
    { key: 'pucker', label: 'Pucker', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Quilt', description: 'How hard the thread pulls the two faces together at the seam.' },
    { key: 'stitchPitch', label: 'Stitch Pitch', type: 'float', default: 90, min: 10, max: 400, step: 1, group: 'Quilt' },
    { key: 'shellColor', label: 'Shell Colour', type: 'color', default: [0.16, 0.18, 0.24], group: 'Colour' },
    { key: 'threadColor', label: 'Thread Colour', type: 'color', default: [0.6, 0.6, 0.58], group: 'Colour' },
    { key: 'sheen', label: 'Shell Sheen', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Surface', description: 'Quilted shells are usually a tight synthetic, so the crown of each puff catches a highlight.' },
    { key: 'depth', label: 'Depth', type: 'float', default: 0.8, min: 0, max: 1, step: 0.01, group: 'Surface' },
    { key: 'roughness', label: 'Roughness', type: 'float', default: 0.55, min: 0, max: 1, step: 0.001, group: 'Surface' },
    SEED_PARAM,
  ],
  build(ctx): PartialBundle {
    const p = ctx.params
    const offset = seedOffset(ctx)
    const cells = p.float('cells')

    const gridAt = (uvNode: V2) => {
      // Rotate toward 45 degrees for a diamond quilt.
      const a = p.float('diamond').mul(0.7854)
      const c = a.cos()
      const s = a.sin()
      const rotated = vec2(uvNode.x.mul(c).sub(uvNode.y.mul(s)), uvNode.x.mul(s).add(uvNode.y.mul(c)))
      const g = rotated.mul(cells)
      const local = vec2(g.x.fract(), g.y.fract())
      // Distance to the nearest seam, in cell units.
      const dx = min(local.x, local.x.oneMinus())
      const dy = min(local.y, local.y.oneMinus())
      return { d: min(dx, dy), dx, dy, id: vec2(g.x.floor(), g.y.floor()), g }
    }

    const heightAt = (uvNode: V2): F => {
      const grid = gridAt(uvNode)
      const seam = p.float('seamWidth')

      // The puff: a dome that reaches full height well away from the seams.
      const dome = smoothstep(seam, float(0.5), grid.d).pow(0.55).mul(p.float('puff'))

      /**
       * The pucker: the thread pulls the shell down at the seam, and the
       * fabric it displaces has to go somewhere, so a lip rises on each side.
       * That lip is the whole reason quilting reads as soft.
       */
      const valley = smoothstep(seam.mul(2.2), float(0), grid.d).mul(p.float('pucker')).mul(0.5)
      const lip = smoothstep(seam.mul(1.2), seam.mul(2.6), grid.d)
        .mul(smoothstep(seam.mul(5), seam.mul(2.6), grid.d))
        .mul(p.float('pucker'))
        .mul(0.18)

      /**
       * The stitches themselves, as beads along each seam line.
       *
       * Both seam directions are evaluated and the stronger wins, rather than
       * selecting an axis: at a crossing the two seams genuinely overlap, and
       * picking one leaves a gap exactly where the thread is densest.
       */
      const stitchOn = (t: F, distance: F): F => {
        const phase = t.mul(p.float('stitchPitch').div(cells)).fract().sub(0.5).abs().mul(2)
        return smoothstep(float(0.6), float(0.1), phase).mul(smoothstep(seam.mul(1.5), float(0), distance))
      }
      const stitchBump = max(stitchOn(grid.g.x, grid.dy), stitchOn(grid.g.y, grid.dx)).mul(0.1)

      const wrinkle = fbm01(vec3(uvNode.mul(cells.mul(6)), offset.add(7)), 3, 2.2, 0.55).sub(0.5).mul(0.08)
      return dome.sub(valley).add(lip).add(stitchBump).add(wrinkle.mul(dome.add(0.3))).mul(p.float('depth'))
    }

    const grid = gridAt(ctx.uv)
    const normal = normalFromHeightFn(heightAt, ctx.uv, ctx.texel, p.float('depth').mul(1.6))
    const h = heightAt(ctx.uv)
    const h01 = h.div(max(p.float('depth'), float(1e-3))).mul(0.9).add(0.1).clamp(0, 1)

    const seamMask = smoothstep(p.float('seamWidth').mul(0.9), float(0), grid.d)
    const shell = tintVariation(p.color('shellColor'), hash21(grid.id.add(vec2(offset, offset.add(3)))), 0.006, 0.08, 0.1)
    // Tight woven shells hold a highlight on the crown of each puff.
    const crown = smoothstep(float(0.35), float(0.9), h01).mul(p.float('sheen'))
    const colour = mix(shell.mul(float(1).add(crown.mul(0.25))), p.color('threadColor'), seamMask.mul(0.8))

    const weave = fbm01(vec3(ctx.uv.mul(cells.mul(90)), offset.add(19)), 2, 2.5, 0.6).sub(0.5)

    return {
      baseColor: colour,
      metallic: float(0),
      roughness: p.float('roughness').add(weave.mul(0.1)).sub(crown.mul(0.2)).add(seamMask.mul(0.15)).clamp(0.1, 1),
      ao: cavityAO(h01, normal, 0.8),
      height: h01,
      normal: blendDetailNormal(normal, vec3(weave.mul(0.35), weave.mul(0.35), float(1)), 0.6),
    }
  },
} satisfies ProceduralMaterialDef)

export const FABRIC = [denim, corduroy, knitWool, velvet, quiltedPadding]
