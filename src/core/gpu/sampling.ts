/**
 * Texture sampling helpers shared by the compositor and the painter.
 *
 * There is one UV convention in this app and it has no flips in it. Every pass
 * that writes a render target does so through either `QuadMesh` or
 * `uvClipPosition`, which agree on the mapping from uv to clip space, and
 * `TextureNode` already normalises render-target sampling across backends -
 * WGSL samples them as written, GLSL flips them because WebGL stores them
 * upside down. So a texel written at uv `u` is read back at uv `u`, and any
 * manual flip on either side is a bug.
 */

import { abs, float, floor, ivec2, max, mix, round, step, texture, vec2, vec4 } from 'three/tsl'
import type { Texture } from 'three/webgpu'
import type { F, V2, V4 } from './nodes'

const PART_TAPS: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
]

const WIDE_TAPS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [2, -1],
  [-1, 0], [2, 0],
  [-1, 1], [2, 1],
  [-1, 2], [0, 2], [1, 2], [2, 2],
]

/** 3x3 binomial kernel - a separable Gaussian collapsed into one pass. */
const KERNEL: [number, number, number][] = [
  [-1, -1, 1], [0, -1, 2], [1, -1, 1],
  [-1, 0, 2], [0, 0, 4], [1, 0, 2],
  [-1, 1, 1], [0, 1, 2], [1, 1, 1],
]
const KERNEL_SUM = 16

/**
 * Reads a coverage mask, optionally softened.
 *
 * `radius` is a node so mask blur stays a slider rather than a recompile; pass
 * `null` to skip the taps entirely, which is what an unblurred mask does.
 */
export function blurredCoverage(tex: Texture, uvNode: V2, radius: F | null, texelCoord: V2 | null = null): F {
  // Unblurred coverage is one texel fetch, so it can skip the sampler; see
  // `unpackSlots`. A blurred mask still interpolates and keeps sampling.
  if (!radius) return texelCoord ? texture(tex).load(texelCoord).x : texture(tex, uvNode).x

  let sum: F = float(0)
  for (const [dx, dy, weight] of KERNEL) {
    const offset = vec2(dx, dy).mul(radius)
    sum = sum.add(texture(tex, uvNode.add(offset)).x.mul(weight))
  }
  return sum.div(KERNEL_SUM)
}

/**
 * Bilinear sample that only uses texels belonging to `partId`.
 *
 * The compositor writes ID-masked fills as a UV texture. A regular bilinear
 * tap at a 3D part edge sits on a UV island border, so two of its four texels
 * are the neighbouring part (or empty gutter). Mixing those is exactly the
 * texel-grid staircase along every ID seam. Weighting by the mesh's own
 * `partId` keeps the geometric edge; the UV mask stays a rasterisation detail.
 */
export function sampleTexturesForPart(
  sources: Texture[],
  uvNode: V2,
  resolution: F,
  partId: F,
  idMap: Texture,
): V4[] {
  const texel = uvNode.mul(resolution).sub(0.5)
  const base = floor(texel)
  const frac = texel.sub(base)
  const fx = frac.x
  const fy = frac.y
  const bilinear: F[] = [
    fx.oneMinus().mul(fy.oneMinus()) as F,
    fx.mul(fy.oneMinus()) as F,
    fx.oneMinus().mul(fy) as F,
    fx.mul(fy) as F,
  ]
  const origin = ivec2(base)
  const target = round(partId)

  const matchAt = (coord: V2): F => {
    const idSample = texture(idMap).load(coord)
    const same = abs(round(idSample.x).sub(target)).lessThan(float(0.5)).select(float(1), float(0))
    return same.mul(step(float(0.5), idSample.w)) as F
  }

  let weightSum: F = float(0)
  const accum: V4[] = sources.map(() => vec4(0, 0, 0, 0))

  for (let i = 0; i < PART_TAPS.length; i++) {
    const [ox, oy] = PART_TAPS[i]
    const coord = origin.add(ivec2(ox, oy))
    const w = bilinear[i].mul(matchAt(coord as unknown as V2)) as F
    weightSum = weightSum.add(w)
    sources.forEach((tex, s) => {
      accum[s] = accum[s].add(texture(tex).load(coord).mul(w)) as V4
    })
  }

  // Unique-unwrap cuts extra charts inside a single part. Their 2x2
  // neighbourhood can be empty ID even though a texel one step over is this
  // part. Falling back to hardware bilinear then mixes in the default gray
  // fill — the spots in the middle of a part. Widen the gather instead.
  let wideSum: F = float(0)
  const wideAccum: V4[] = sources.map(() => vec4(0, 0, 0, 0))
  for (const [ox, oy] of WIDE_TAPS) {
    const coord = origin.add(ivec2(ox, oy))
    const w = matchAt(coord as unknown as V2)
    wideSum = wideSum.add(w)
    sources.forEach((tex, s) => {
      wideAccum[s] = wideAccum[s].add(texture(tex).load(coord).mul(w)) as V4
    })
  }

  const useBilinear = step(float(1e-5), weightSum)
  const useWide = step(float(1e-5), wideSum).mul(useBilinear.oneMinus())
  return sources.map((tex, s) => {
    const bilinearSample = accum[s].div(max(weightSum, float(1e-5)))
    const wideSample = wideAccum[s].div(max(wideSum, float(1e-5)))
    const nearest = texture(tex).load(ivec2(uvNode.mul(resolution)))
    const withoutHardware = mix(nearest, wideSample, useWide) as V4
    return mix(withoutHardware, bilinearSample, useBilinear) as V4
  })
}

/** One texture, same filter. Used for the height Sobel so lighting follows the part edge too. */
export function sampleTextureForPart(
  tex: Texture,
  uvNode: V2,
  resolution: F,
  partId: F,
  idMap: Texture,
): V4 {
  return sampleTexturesForPart([tex], uvNode, resolution, partId, idMap)[0]
}
