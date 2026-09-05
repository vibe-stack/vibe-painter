/**
 * Packing and unpacking channel bundles to and from the RGBA slot textures.
 *
 * Both directions are generated from `CHANNEL_INFO`, so adding a channel means
 * editing that table and nothing else - the compositor's MRT outputs and the
 * paint-layer reads both follow automatically.
 */

import { float, texture, vec4 } from 'three/tsl'
import type { Texture } from 'three/webgpu'
import type { Channel } from '../channels'
import { CHANNEL_INFO, CHANNEL_LIST, SLOT_COUNT, SLOT_NAMES } from '../channels'
import type { ChannelBundle, F, V2, V3, V4 } from './nodes'
import { defaultBundle } from './nodes'
import { sampleTexturesForPart } from './sampling'

const SWIZZLE_INDEX = { r: 0, g: 1, b: 2, a: 3 } as const

/** Bundle -> one vec4 per slot, keyed by the MRT attachment name. */
export function packBundle(bundle: ChannelBundle): Record<string, V4> {
  const components: (F | null)[][] = Array.from({ length: SLOT_COUNT }, () => [null, null, null, null])

  for (const info of CHANNEL_LIST) {
    const value = bundle[info.id]
    if (info.swizzle === 'rgb') {
      const v = value as V3
      components[info.slot][0] = v.x
      components[info.slot][1] = v.y
      components[info.slot][2] = v.z
    } else {
      components[info.slot][SWIZZLE_INDEX[info.swizzle]] = value as F
    }
  }

  const out: Record<string, V4> = {}
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const c = components[slot]
    out[SLOT_NAMES[slot]] = vec4(c[0] ?? float(0), c[1] ?? float(0), c[2] ?? float(0), c[3] ?? float(0))
  }
  return out
}

/** Slot textures -> bundle, for reading a paint layer or the composite back. */
export function unpackSlots(textures: readonly Texture[], uvNode: V2, texelCoord: V2 | null = null): ChannelBundle {
  // `texelCoord` switches these reads to `textureLoad`, which needs no sampler.
  // WebGPU caps samplers at 16 per shader stage and that cap is hardware, not a
  // default that can be raised - so a compositor that sampled five textures per
  // paint layer ran out of samplers at the third layer. A 1:1 fullscreen pass
  // over same-sized targets is reading texel centres anyway, so there is
  // nothing for a sampler to interpolate.
  const samples = textures.map((tex) => (texelCoord ? texture(tex).load(texelCoord) : texture(tex, uvNode)))
  const bundle = defaultBundle()

  for (const info of CHANNEL_LIST) {
    const sample = samples[info.slot]
    if (!sample) continue
    if (info.swizzle === 'rgb') {
      ;(bundle as Record<Channel, unknown>)[info.id] = sample.xyz
    } else {
      ;(bundle as Record<Channel, unknown>)[info.id] = sample[info.swizzle]
    }
  }
  return bundle
}

/**
 * Same unpack, but bilinear taps that belong to a different source-mesh part
 * (or to empty gutter) are discarded. See `sampleTexturesForPart`.
 */
export function unpackSlotsForPart(
  textures: readonly Texture[],
  uvNode: V2,
  resolution: F,
  partId: F,
  idMap: Texture,
): ChannelBundle {
  const samples = sampleTexturesForPart([...textures], uvNode, resolution, partId, idMap)
  const bundle = defaultBundle()

  for (const info of CHANNEL_LIST) {
    const sample = samples[info.slot]
    if (!sample) continue
    if (info.swizzle === 'rgb') {
      ;(bundle as Record<Channel, unknown>)[info.id] = sample.xyz
    } else {
      ;(bundle as Record<Channel, unknown>)[info.id] = sample[info.swizzle]
    }
  }
  return bundle
}

/** Where a channel ends up, for the exporter and for channel-solo debugging. */
export function channelLocation(channel: Channel): { slot: number; swizzle: ChannelSwizzle } {
  const info = CHANNEL_INFO[channel]
  return { slot: info.slot, swizzle: info.swizzle }
}

export type ChannelSwizzle = 'r' | 'g' | 'b' | 'a' | 'rgb'
