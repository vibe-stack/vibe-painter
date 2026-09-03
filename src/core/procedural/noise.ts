/**
 * Procedural primitives. Everything the material catalogue is built from lives
 * here: hashes, noises, cellular patterns and the tiling grids.
 *
 * There are deliberately no image samplers anywhere in this file - the whole
 * catalogue is evaluated from coordinates alone, which is what lets a material
 * be resolution independent and serialise to a handful of numbers.
 */

import {
  Fn,
  If,
  Loop,
  abs,
  atan,
  cos,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_hsvtorgb,
  mx_noise_float,
  mod,
  mx_rgbtohsv,
  mx_worley_noise_float,
  normalize,
  sin,
  smoothstep,
  step,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { F, FloatIn, V2, V3, V4 } from '../gpu/nodes'
import { fl } from '../gpu/nodes'

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** 2D -> 2D hash in 0..1. */
export const hash22 = /*#__PURE__*/ Fn(([p]: [V2]): V2 => {
  const q = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))
  return fract(sin(q).mul(43758.5453123))
})

/** 2D -> 1D hash in 0..1. */
export const hash21 = /*#__PURE__*/ Fn(([p]: [V2]): F => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123))
})

/** 3D -> 1D hash in 0..1. */
export const hash31 = /*#__PURE__*/ Fn(([p]: [V3]): F => {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453123))
})

// ---------------------------------------------------------------------------
// Noises
// ---------------------------------------------------------------------------

/** Signed Perlin-style noise, -1..1. */
export function noise3(p: V3): F {
  return mx_noise_float(p)
}

/** Fractal Brownian motion, roughly -1..1. */
export function fbm(p: V3, octaves = 4, lacunarity = 2, gain = 0.5): F {
  return mx_fractal_noise_float(p, octaves, lacunarity, gain, 1)
}

/** fbm remapped to 0..1, which is what most patterns actually want. */
export function fbm01(p: V3, octaves = 4, lacunarity = 2, gain = 0.5): F {
  return fbm(p, octaves, lacunarity, gain).mul(0.5).add(0.5).clamp(0, 1)
}

/**
 * Ridged multifractal - sharp creases instead of smooth blobs. This is what
 * makes rock, rust crust and cracked paint read as *broken* rather than lumpy.
 */
export const ridged = /*#__PURE__*/ Fn(([p, octaves, gain]: [V3, F, F]): F => {
  // Unnamed vars: TSL renames explicit duplicates and logs a warning for each,
  // and this function is inlined many times per material.
  const sum = float(0).toVar()
  const amp = float(0.5).toVar()
  const freq = float(1).toVar()
  const norm = float(0).toVar()
  Loop({ start: 0, end: 8, type: 'int' }, ({ i }) => {
    If(float(i).lessThan(octaves), () => {
      const n = abs(mx_noise_float(p.mul(freq))).oneMinus()
      sum.addAssign(n.mul(n).mul(amp))
      norm.addAssign(amp)
      amp.mulAssign(gain)
      freq.mulAssign(2)
    })
  })
  return sum.div(max(norm, float(1e-4)))
})

/** Worley / cellular noise distance field, 0..1. */
export function worley(p: V3, jitter = 1): F {
  return mx_worley_noise_float(p, jitter)
}

/**
 * Domain warping: offsets the sample point by another noise field. One of the
 * highest value-per-instruction tricks in procedural texturing - it turns
 * regular patterns into organic ones (marble veins, rust bloom, cloud edges).
 */
export function warp(p: V3, amount: FloatIn, frequency: FloatIn = 1): V3 {
  const scaled = p.mul(frequency)
  const offset = vec3(
    mx_noise_float(scaled),
    mx_noise_float(scaled.add(vec3(37.2, 11.9, 5.3))),
    mx_noise_float(scaled.add(vec3(-13.7, 27.1, 91.4))),
  )
  return p.add(offset.mul(amount))
}

// ---------------------------------------------------------------------------
// Cellular patterns
// ---------------------------------------------------------------------------

/**
 * 2D Voronoi returning `(nearestDist, secondDist, cellId.x, cellId.y)`.
 *
 * The second distance is what gives you cell *borders* (`f2 - f1`), and the
 * cell id is what lets you randomise per-cell colour, height or rotation -
 * both essential for tiles, scales, pebbles and cracked surfaces.
 */
export const voronoi2 = /*#__PURE__*/ Fn(([p, jitter]: [V2, F]): V4 => {
  const cell = floor(p)
  const local = fract(p)
  const f1 = float(8).toVar('vorF1')
  const f2 = float(8).toVar('vorF2')
  const id = vec2(0, 0).toVar('vorId')

  Loop({ start: -1, end: 2, type: 'int' }, { start: -1, end: 2, type: 'int' }, ({ i, j }) => {
    const neighbour = vec2(float(i), float(j))
    const base = cell.add(neighbour)
    // jitter 0 collapses to a regular grid, jitter 1 is fully random.
    const offset = mix(vec2(0.5, 0.5), hash22(base), jitter)
    const delta = neighbour.add(offset).sub(local)
    const d = length(delta)
    If(d.lessThan(f1), () => {
      f2.assign(f1)
      f1.assign(d)
      id.assign(base)
    }).ElseIf(d.lessThan(f2), () => {
      f2.assign(d)
    })
  })

  return vec4(f1, f2, id)
})

/** Random value per Voronoi cell, 0..1. */
export function voronoiCellValue(v: V4): F {
  return hash21(v.zw)
}

/** Distance to the nearest cell border, 0 at the border. */
export function voronoiBorder(v: V4): F {
  return v.y.sub(v.x)
}

// ---------------------------------------------------------------------------
// Grids and tiling patterns
// ---------------------------------------------------------------------------

export interface GridSample {
  /** 0..1 coordinate inside the cell. */
  local: V2
  /** Integer cell coordinate, usable as a hash key. */
  id: V2
}

/** Brick-style grid with a per-row running bond offset. */
export const brickGrid = /*#__PURE__*/ Fn(([p, rowOffset]: [V2, F]): V4 => {
  const row = floor(p.y)
  const shifted = vec2(p.x.add(row.mul(rowOffset)), p.y)
  return vec4(fract(shifted), floor(shifted))
})

/** Signed distance to the edge of a unit cell, 0 at the edge, 0.5 at centre. */
export function cellEdgeDistance(local: V2): F {
  const d = min(local, local.oneMinus())
  return min(d.x, d.y)
}

/**
 * Hex grid. Returns `(localX, localY, cellId.x, cellId.y)` where the local
 * coordinate is relative to the nearest hex centre and the id is the centre
 * position - unique per cell and safe to hash.
 */
export const hexGrid = /*#__PURE__*/ Fn(([p]: [V2]): V4 => {
  // Two offset rectangular lattices; the nearer centre wins. This is the
  // cheapest exact hex tiling - no trigonometry, no branching per axis.
  const s = vec2(1, 1.7320508)
  const half = s.mul(0.5)
  const a = mod(p, s).sub(half)
  const b = mod(p.sub(half), s).sub(half)
  const useA = step(dot(a, a), dot(b, b))
  const local = mix(b, a, useA)
  const id = p.sub(local)
  return vec4(local, id)
})

export function checker(p: V2): F {
  const c = floor(p)
  return fract(c.x.add(c.y).mul(0.5)).mul(2)
}

/** Anti-aliased stripes. `duty` is the fraction of the period that is "on". */
export function stripes(x: F, duty: FloatIn, softness: FloatIn = 0.02): F {
  const t = fract(x)
  const d = fl(duty)
  const s = fl(softness)
  return smoothstep(float(0).sub(s), s, t).mul(smoothstep(d.sub(s), d.add(s), t).oneMinus())
}

/**
 * Directional scratch field. Stretching the sample space along one axis turns
 * isotropic noise into anisotropic streaks, which is how brushed metal, hair
 * and cloth sheen are all built.
 */
export const scratches = /*#__PURE__*/ Fn(([p, angle, stretch, density]: [V2, F, F, F]): F => {
  const c = cos(angle)
  const s = sin(angle)
  const rotated = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)))
  const stretched = vec2(rotated.x.mul(stretch), rotated.y)
  const n = fbm01(vec3(stretched.mul(density), 0), 4, 2.2, 0.55)
  return smoothstep(float(0.45), float(0.62), n)
})

/** Radial coordinate helper: `(radius, angle01)` around a centre. */
export function polar(p: V2, centre: V2): V2 {
  const d = p.sub(centre)
  const r = length(d)
  const a = atan(d.y, d.x).div(Math.PI * 2).add(0.5)
  return vec2(r, a)
}

// ---------------------------------------------------------------------------
// Height helpers
// ---------------------------------------------------------------------------

/**
 * Central-difference normal from a height function.
 *
 * Materials define height analytically, so we can sample the *function* at
 * offsets rather than differentiating a texture. That gives a clean normal at
 * any resolution, with no derivative artefacts at UV seams.
 */
export function normalFromHeightFn(
  heightAt: (uv: V2) => F,
  uvNode: V2,
  epsilon: FloatIn,
  strength: FloatIn,
): V3 {
  const e = fl(epsilon)
  const dx = heightAt(uvNode.add(vec2(e, 0))).sub(heightAt(uvNode.sub(vec2(e, 0))))
  const dy = heightAt(uvNode.add(vec2(0, e))).sub(heightAt(uvNode.sub(vec2(0, e))))
  const scale = fl(strength).div(e.mul(2))
  return normalize(vec3(dx.mul(scale).negate(), dy.mul(scale).negate(), 1))
}

/** Remaps 0..1 through the classic levels controls. */
export function levels(
  value: F,
  inLow: FloatIn,
  inHigh: FloatIn,
  gamma: FloatIn,
  outLow: FloatIn,
  outHigh: FloatIn,
): F {
  const lo = fl(inLow)
  const hi = fl(inHigh)
  const t = value.sub(lo).div(max(hi.sub(lo), float(1e-5))).clamp(0, 1)
  const shaped = t.pow(float(1).div(max(fl(gamma), float(1e-3))))
  return mix(fl(outLow), fl(outHigh), shaped)
}

/** Linear interpolation between three colours by a 0..1 selector. */
export function gradient3(t: F, a: V3, b: V3, c: V3): V3 {
  const first = mix(a, b, t.mul(2).clamp(0, 1))
  return mix(first, c, t.sub(0.5).mul(2).clamp(0, 1))
}

// ---------------------------------------------------------------------------
// Realism helpers
//
// The difference between a shader that reads as "a procedural pattern" and one
// that reads as "a surface" is rarely the pattern itself - it is the second
// order detail layered over it: colour that varies in hue rather than only in
// brightness, roughness that is never constant, cavities that actually catch
// dirt, and a fine normal riding on top of the coarse one. These are the
// primitives for that, shared so every material gets them the same way.
// ---------------------------------------------------------------------------

/**
 * Per-instance colour variation in HSV.
 *
 * Real materials vary in *hue* as well as value: two bricks from one kiln
 * differ by a few degrees of hue and a little saturation, not by a uniform
 * brightness multiplier. Scaling RGB - which is what a `mul()` does - keeps
 * the hue locked and is the single most recognisable "this is a shader" tell.
 *
 * `t` is a 0..1 selector (a per-cell hash, a noise field); 0.5 is no change.
 */
export function tintVariation(
  colour: V3,
  t: F,
  hue: FloatIn = 0.02,
  saturation: FloatIn = 0.12,
  value: FloatIn = 0.16,
): V3 {
  const hsv = mx_rgbtohsv(colour) as unknown as V3
  const d = t.sub(0.5).mul(2)
  const h = fract(hsv.x.add(d.mul(fl(hue))))
  const s = hsv.y.mul(float(1).add(d.mul(fl(saturation)))).clamp(0, 1)
  const v = hsv.z.mul(float(1).add(d.mul(fl(value)))).max(0)
  return mx_hsvtorgb(vec3(h, s, v)) as unknown as V3
}

/**
 * Reoriented normal mapping: puts a detail normal on top of a base normal.
 *
 * A plain add-and-normalise flattens the detail wherever the base is steep,
 * and a lerp destroys both. RNM rotates the detail into the base's frame,
 * which is what keeps fine grain visible on the walls of a deep dent.
 */
export function blendDetailNormal(base: V3, detail: V3, strength: FloatIn = 1): V3 {
  const scaled = normalize(vec3(detail.x.mul(fl(strength)), detail.y.mul(fl(strength)), detail.z))
  const t = base.add(vec3(0, 0, 1))
  const u = scaled.mul(vec3(-1, -1, 1))
  return normalize(t.mul(t.dot(u)).div(max(t.z, float(1e-4))).sub(u))
}

/**
 * Cavity occlusion from a height field and the normal already derived from it.
 *
 * Two signals, both free: low points are more enclosed than high ones, and a
 * steep local slope means a wall with something above it. Multiplying them
 * darkens the *inside* of a crevice rather than the whole low region, which is
 * what a real AO bake does. It costs nothing extra because both inputs have
 * already been computed by the time a material writes its bundle - the
 * alternative, re-sampling the height function in a ring, multiplies the cost
 * of every material by another four or eight evaluations.
 */
export function cavityAO(height01: F, normal: V3, strength: FloatIn = 0.6): F {
  const s = fl(strength).clamp(0, 1)
  const fromHeight = mix(float(1).sub(s), float(1), height01.clamp(0, 1))
  const fromSlope = mix(float(1).sub(s.mul(0.55)), float(1), normal.z.clamp(0, 1).pow(0.7))
  return fromHeight.mul(fromSlope).clamp(0, 1)
}

/**
 * Micro roughness break-up, 0..1 centred on 0.5.
 *
 * Constant roughness is physically impossible and reads instantly as CG: even
 * a polished surface has fingerprints, dust and polish swirl. Every material
 * in the catalogue folds a little of this in.
 */
export function microVariation(p: V2, scale: FloatIn, seed: FloatIn = 0): F {
  return fbm01(vec3(p.mul(fl(scale)), fl(seed)), 3, 2.3, 0.55)
}

/**
 * Isolated bright specks - snow crystals, sand quartz, metal flake.
 *
 * Built from a worley field rather than a thresholded noise: the specks land
 * one per cell, so density is controlled exactly and they never clump into
 * blobs the way a thresholded fbm does.
 */
export function sparkle(p: V2, scale: FloatIn, seed: FloatIn = 0, size: FloatIn = 0.12): F {
  const d = worley(vec3(p.mul(fl(scale)), fl(seed)), 1)
  return smoothstep(fl(size), float(0), d)
}

/**
 * Crack network. Voronoi borders thresholded to a width, then eroded by noise
 * so the crack fades out along its length instead of forming a closed mesh -
 * real cracks terminate, and a perfect polygon net is the giveaway.
 */
export function cracks(p: V2, scale: FloatIn, width: FloatIn, seed: FloatIn = 0): F {
  const cells = voronoi2(p.mul(fl(scale)), float(0.95))
  const border = voronoiBorder(cells)
  const line = smoothstep(fl(width), float(0), border)
  const erosion = fbm01(vec3(p.mul(fl(scale).mul(2.7)), fl(seed)), 3, 2.2, 0.55)
  return line.mul(smoothstep(float(0.3), float(0.62), erosion))
}

/**
 * Gravity-driven streaks: dirt and rust running *down* a surface.
 *
 * `down` is how strongly the streak stretches along -V. Materials pass this
 * only when they know which way is down, which under triplanar means the two
 * vertical planes (axis 0 and 2) - see `MatContext.axis`.
 */
export function drips(p: V2, scale: FloatIn, length: FloatIn, seed: FloatIn = 0): F {
  const s = fl(scale)
  // Stretching V compresses the noise vertically, turning blobs into runs.
  const stretched = vec2(p.x.mul(s), p.y.mul(s).div(max(fl(length), float(0.05))))
  const field = fbm01(vec3(stretched, fl(seed)), 4, 2.1, 0.55)
  // The run fades out downwards rather than ending abruptly.
  return smoothstep(float(0.52), float(0.78), field)
}

/**
 * Height-aware blend, the way a real coat sits on a substrate.
 *
 * Lerping two materials by a mask gives a soft, uniform transition. Blending
 * by height instead lets the substrate poke through wherever it is high -
 * gravel through asphalt, aggregate through a thin skim of cement - which is
 * what makes a two-material mix look layered rather than dissolved.
 */
export function heightBlend(maskValue: F, topHeight: F, bottomHeight: F, contrast: FloatIn = 0.15): F {
  const c = max(fl(contrast), float(1e-3))
  const bias = topHeight.sub(bottomHeight).mul(0.5)
  return smoothstep(float(0.5).sub(c), float(0.5).add(c), maskValue.add(bias).clamp(0, 1))
}

/**
 * Rounded-cell field: `(domeHeight, borderDistance, cellId.x, cellId.y)`.
 *
 * Pebbles, cobbles, leather grain and hammer dents are all the same shape -
 * a cell that rises to a rounded top and falls off at its border. Sharing one
 * function keeps the falloff consistent and saves every one of them
 * re-deriving it from the raw distances.
 */
export const pebbles = /*#__PURE__*/ Fn(([p, jitter, roundness]: [V2, F, F]): V4 => {
  const cells = voronoi2(p, jitter)
  const border = cells.y.sub(cells.x)
  // The dome is driven by the border distance, not by f1: that keeps the top
  // flat-ish in the middle of the cell and steep only near the seam, which is
  // how a worn stone actually sits.
  const dome = smoothstep(float(0), max(roundness, float(1e-3)), border).pow(0.65)
  return vec4(dome, border, cells.z, cells.w)
})
