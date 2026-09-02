/**
 * Texture sampling helpers shared by the compositor and the painter.
 */

import { float, texture, vec2 } from 'three/tsl'
import type { Texture } from 'three/webgpu'
import type { F, V2 } from './nodes'

/**
 * TextureNode always applies flipY to render-target textures. UV-space writers
 * (the compositor quad and the paint commit) already match that framebuffer
 * layout, so sampling them in another UV pass must cancel the extra flip —
 * otherwise paint lands on the UV-v opposite of the stroke.
 */
export function rtUv(uvNode: V2): V2 {
  return vec2(uvNode.x, float(1).sub(uvNode.y))
}

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
export function blurredCoverage(tex: Texture, uvNode: V2, radius: F | null, cancelRTFlip = false): F {
  const uv = cancelRTFlip ? rtUv(uvNode) : uvNode
  if (!radius) return texture(tex, uv).x

  let sum: F = float(0)
  for (const [dx, dy, weight] of KERNEL) {
    const offset = vec2(dx, dy).mul(radius)
    sum = sum.add(texture(tex, uv.add(offset)).x.mul(weight))
  }
  return sum.div(KERNEL_SUM)
}
