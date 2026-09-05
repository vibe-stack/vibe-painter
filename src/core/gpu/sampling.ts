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

import { float, texture, vec2 } from 'three/tsl'
import type { Texture } from 'three/webgpu'
import type { F, V2 } from './nodes'

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
