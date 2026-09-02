/**
 * Channel definitions and the GPU slot packing table.
 *
 * A texture set owns a fixed list of *channels* (base colour, roughness, ...).
 * On the GPU those channels are packed into a small number of RGBA render
 * targets ("slots") so the compositor can flatten the whole layer stack in a
 * single MRT pass. Everything that needs to know where a channel lives reads
 * this table, so adding a channel is a one-file change.
 */

export const CHANNELS = [
  'baseColor',
  'opacity',
  'roughness',
  'metallic',
  'normal',
  'height',
  'ao',
  'emissive',
] as const

export type Channel = (typeof CHANNELS)[number]

export type ChannelKind = 'color' | 'scalar' | 'vector'

export interface ChannelInfo {
  id: Channel
  label: string
  /** Number of components the channel carries. */
  components: 1 | 3
  kind: ChannelKind
  /** Value used where no layer writes the channel. */
  defaultValue: number | [number, number, number]
  /** Colour channels are authored in sRGB and stored linear. */
  srgb: boolean
  /** Which packed slot this channel lives in, and at which offset. */
  slot: number
  /** Component offsets inside the slot's RGBA vector. */
  swizzle: 'r' | 'g' | 'b' | 'a' | 'rgb'
}

/**
 * Four RGBA16F targets. Half-float everywhere keeps one uniform format (three's
 * `RenderTarget({count})` clones a single texture descriptor for every
 * attachment) and gives height/normal the precision an 8-bit target would not.
 */
export const SLOT_COUNT = 4

export const SLOT_NAMES = ['slotAlbedo', 'slotSurface', 'slotNormal', 'slotEmissive'] as const
export type SlotName = (typeof SLOT_NAMES)[number]

export const CHANNEL_INFO: Record<Channel, ChannelInfo> = {
  baseColor: {
    id: 'baseColor',
    label: 'Base Color',
    components: 3,
    kind: 'color',
    defaultValue: [0.5, 0.5, 0.5],
    srgb: true,
    slot: 0,
    swizzle: 'rgb',
  },
  opacity: {
    id: 'opacity',
    label: 'Opacity',
    components: 1,
    kind: 'scalar',
    defaultValue: 1,
    srgb: false,
    slot: 0,
    swizzle: 'a',
  },
  roughness: {
    id: 'roughness',
    label: 'Roughness',
    components: 1,
    kind: 'scalar',
    defaultValue: 0.5,
    srgb: false,
    slot: 1,
    swizzle: 'r',
  },
  metallic: {
    id: 'metallic',
    label: 'Metallic',
    components: 1,
    kind: 'scalar',
    defaultValue: 0,
    srgb: false,
    slot: 1,
    swizzle: 'g',
  },
  ao: {
    id: 'ao',
    label: 'Ambient Occlusion',
    components: 1,
    kind: 'scalar',
    defaultValue: 1,
    srgb: false,
    slot: 1,
    swizzle: 'b',
  },
  height: {
    id: 'height',
    label: 'Height',
    components: 1,
    kind: 'scalar',
    defaultValue: 0.5,
    srgb: false,
    slot: 1,
    swizzle: 'a',
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    components: 3,
    kind: 'vector',
    // Tangent space, stored raw (not 0..1 encoded) because the slot is float.
    defaultValue: [0, 0, 1],
    srgb: false,
    slot: 2,
    swizzle: 'rgb',
  },
  emissive: {
    id: 'emissive',
    label: 'Emissive',
    components: 3,
    kind: 'color',
    defaultValue: [0, 0, 0],
    srgb: true,
    slot: 3,
    swizzle: 'rgb',
  },
}

export const CHANNEL_LIST: ChannelInfo[] = CHANNELS.map((c) => CHANNEL_INFO[c])

/** Channels that live in a given slot. */
export function channelsInSlot(slot: number): ChannelInfo[] {
  return CHANNEL_LIST.filter((c) => c.slot === slot)
}

export function isColorChannel(c: Channel): boolean {
  return CHANNEL_INFO[c].kind === 'color'
}
