/**
 * Per-channel blend modes, as TSL. These operate on `vec3` and are reused for
 * scalars by broadcasting, which keeps one implementation per mode.
 *
 * The normal channel is special: lerping two tangent-space normals is wrong
 * (it shortens the vector and washes out detail), so `blendNormalMap` does
 * Reoriented Normal Mapping instead - see `combineChannel`.
 */

import { abs, float, max, min, mix, normalize, step, vec3 } from 'three/tsl'
import type { BlendMode } from '../doc/types'
import type { F, V3 } from './nodes'

type BlendFn = (base: V3, src: V3) => V3

/** Component-wise lerp. `mix` only accepts a scalar factor. */
const lerp3 = (a: V3, b: V3, t: V3): V3 => a.add(b.sub(a).mul(t))

const softLightChannel = (b: V3, s: V3): V3 => {
  // Pegtop's continuous approximation - cheap and free of the seam the
  // piecewise W3C formula has at s = 0.5.
  return b.mul(b.oneMinus()).mul(s.mul(2).oneMinus()).add(b.mul(s.mul(2)))
}

const BLEND_FNS: Record<BlendMode, BlendFn> = {
  normal: (_b, s) => s,
  multiply: (b, s) => b.mul(s),
  screen: (b, s) => b.oneMinus().mul(s.oneMinus()).oneMinus(),
  // Component-wise, so each colour channel picks its own branch.
  overlay: (b, s) => lerp3(b.mul(s).mul(2), b.oneMinus().mul(s.oneMinus()).mul(2).oneMinus(), step(vec3(0.5), b)),
  darken: (b, s) => min(b, s),
  lighten: (b, s) => max(b, s),
  colorDodge: (b, s) => b.div(max(s.oneMinus(), vec3(1e-4))).clamp(0, 1),
  colorBurn: (b, s) => b.oneMinus().div(max(s, vec3(1e-4))).oneMinus().clamp(0, 1),
  hardLight: (b, s) => lerp3(b.mul(s).mul(2), b.oneMinus().mul(s.oneMinus()).mul(2).oneMinus(), step(vec3(0.5), s)),
  softLight: softLightChannel,
  difference: (b, s) => abs(b.sub(s)),
  exclusion: (b, s) => b.add(s).sub(b.mul(s).mul(2)),
  add: (b, s) => b.add(s),
  subtract: (b, s) => b.sub(s),
  divide: (b, s) => b.div(max(s, vec3(1e-4))),
  linearBurn: (b, s) => b.add(s).sub(1),
  negation: (b, s) => vec3(1).sub(abs(b.add(s).sub(vec3(1)))),
}

export function blendVec3(mode: BlendMode, base: V3, src: V3): V3 {
  return BLEND_FNS[mode](base, src)
}

export function blendFloat(mode: BlendMode, base: F, src: F): F {
  return BLEND_FNS[mode](vec3(base), vec3(src)).x
}

/**
 * Reoriented Normal Mapping (Barre-Brisebois & Hill). Rotates the source
 * normal into the frame defined by the base normal, so detail from two layers
 * accumulates instead of averaging away.
 */
export function blendNormalMap(base: V3, src: V3): V3 {
  const t = base.add(vec3(0, 0, 1))
  const u = src.mul(vec3(-1, -1, 1))
  return normalize(t.mul(t.dot(u)).div(max(t.z, float(1e-4))).sub(u))
}

/**
 * Blends one channel and applies the mask. `isNormal` routes the default mode
 * through RNM; every other mode stays available for deliberate effects.
 */
export function combineChannel(
  mode: BlendMode,
  base: V3,
  src: V3,
  amount: F,
  isNormal: boolean,
): V3 {
  const blended = isNormal && mode === 'normal' ? blendNormalMap(base, src) : blendVec3(mode, base, src)
  return mix(base, blended, amount)
}

/** Blend modes that make sense for a grayscale mask stack. */
export const MASK_BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'add',
  'subtract',
  'overlay',
  'darken',
  'lighten',
  'difference',
]
