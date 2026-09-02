/**
 * Shared TSL type aliases and the "channel bundle" - the value every layer,
 * material and generator produces. Keeping one bundle shape means the
 * compositor, the brush and the exporter all speak the same language.
 */

import type { Node } from 'three/webgpu'
import { float, vec3 } from 'three/tsl'
import type { Channel } from '../channels'
import { CHANNEL_INFO, CHANNELS } from '../channels'

export type F = Node<'float'>
export type V2 = Node<'vec2'>
export type V3 = Node<'vec3'>
export type V4 = Node<'vec4'>

/** Anywhere an API accepts "a float or a literal". */
export type FloatIn = F | number
export type Vec3In = V3 | [number, number, number]

/** Lifts a literal into a node. TSL's own `float()` rejects the union type. */
export const fl = (v: FloatIn): F => (typeof v === 'number' ? float(v) : v)
export const v3 = (v: Vec3In): V3 => (Array.isArray(v) ? vec3(v[0], v[1], v[2]) : v)

export interface ChannelBundle {
  baseColor: V3
  opacity: F
  roughness: F
  metallic: F
  normal: V3
  height: F
  ao: F
  emissive: V3
}

export type PartialBundle = Partial<ChannelBundle>

/** A bundle filled with each channel's documented default. */
export function defaultBundle(): ChannelBundle {
  const out = {} as Record<Channel, unknown>
  for (const id of CHANNELS) {
    const info = CHANNEL_INFO[id]
    out[id] = Array.isArray(info.defaultValue)
      ? vec3(info.defaultValue[0], info.defaultValue[1], info.defaultValue[2])
      : float(info.defaultValue)
  }
  return out as unknown as ChannelBundle
}

/** Fills any channel a material did not write with the channel default. */
export function completeBundle(partial: PartialBundle): ChannelBundle {
  return { ...defaultBundle(), ...stripUndefined(partial) }
}

function stripUndefined(partial: PartialBundle): PartialBundle {
  const out: PartialBundle = {}
  for (const key of CHANNELS) {
    const value = partial[key]
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

export function isVectorChannel(channel: Channel): boolean {
  return CHANNEL_INFO[channel].components === 3
}
