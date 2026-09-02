/**
 * Export: flatten the composited channels into image files.
 *
 * The layer stack stays the document; export is a projection of it into
 * whatever packing a target engine expects. Presets are pure data, so adding
 * one is a table entry rather than code.
 */

import type { Renderer } from 'three/webgpu'
import type { Channel } from '../channels'
import { CHANNEL_INFO } from '../channels'
import type { SlotTargets } from './targets'

export type ChannelRef =
  | { channel: Channel; component: 0 | 1 | 2; encoding?: 'linear' | 'normal' | 'invert' }
  | { constant: number }

export interface ExportMapDef {
  suffix: string
  label: string
  /** Sources for R, G, B and A. A null alpha writes fully opaque. */
  sources: [ChannelRef, ChannelRef, ChannelRef, ChannelRef | null]
  /** Colour maps are encoded to sRGB on the way out; data maps are not. */
  srgb: boolean
}

export interface ExportPreset {
  id: string
  name: string
  description: string
  maps: ExportMapDef[]
}

const rgb = (channel: Channel, encoding?: 'linear' | 'normal' | 'invert'): ExportMapDef['sources'] => [
  { channel, component: 0, encoding },
  { channel, component: 1, encoding },
  { channel, component: 2, encoding },
  null,
]

const gray = (channel: Channel, encoding?: 'linear' | 'invert'): ExportMapDef['sources'] => [
  { channel, component: 0, encoding },
  { channel, component: 0, encoding },
  { channel, component: 0, encoding },
  null,
]

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'individual',
    name: 'Individual Channels',
    description: 'One image per channel. The most portable option and the easiest to inspect.',
    maps: [
      { suffix: 'basecolor', label: 'Base Color', sources: rgb('baseColor'), srgb: true },
      { suffix: 'roughness', label: 'Roughness', sources: gray('roughness'), srgb: false },
      { suffix: 'metallic', label: 'Metallic', sources: gray('metallic'), srgb: false },
      { suffix: 'normal', label: 'Normal', sources: rgb('normal', 'normal'), srgb: false },
      { suffix: 'height', label: 'Height', sources: gray('height'), srgb: false },
      { suffix: 'ao', label: 'Ambient Occlusion', sources: gray('ao'), srgb: false },
      { suffix: 'emissive', label: 'Emissive', sources: rgb('emissive'), srgb: true },
      { suffix: 'opacity', label: 'Opacity', sources: gray('opacity'), srgb: false },
    ],
  },
  {
    id: 'gltf',
    name: 'glTF / PBR Metallic Roughness',
    description: 'glTF 2.0 packing: roughness in green, metallic in blue, opacity in the base colour alpha.',
    maps: [
      {
        suffix: 'basecolor',
        label: 'Base Color + Alpha',
        sources: [
          { channel: 'baseColor', component: 0 },
          { channel: 'baseColor', component: 1 },
          { channel: 'baseColor', component: 2 },
          { channel: 'opacity', component: 0 },
        ],
        srgb: true,
      },
      {
        suffix: 'metallicroughness',
        label: 'Metallic Roughness',
        sources: [
          { constant: 1 },
          { channel: 'roughness', component: 0 },
          { channel: 'metallic', component: 0 },
          null,
        ],
        srgb: false,
      },
      { suffix: 'normal', label: 'Normal', sources: rgb('normal', 'normal'), srgb: false },
      { suffix: 'occlusion', label: 'Occlusion', sources: gray('ao'), srgb: false },
      { suffix: 'emissive', label: 'Emissive', sources: rgb('emissive'), srgb: true },
    ],
  },
  {
    id: 'orm',
    name: 'Unreal / ORM',
    description: 'Occlusion, roughness and metallic packed into one RGB image.',
    maps: [
      { suffix: 'BaseColor', label: 'Base Color', sources: rgb('baseColor'), srgb: true },
      {
        suffix: 'ORM',
        label: 'Occlusion / Roughness / Metallic',
        sources: [
          { channel: 'ao', component: 0 },
          { channel: 'roughness', component: 0 },
          { channel: 'metallic', component: 0 },
          null,
        ],
        srgb: false,
      },
      { suffix: 'Normal', label: 'Normal', sources: rgb('normal', 'normal'), srgb: false },
    ],
  },
  {
    id: 'unity',
    name: 'Unity URP',
    description: 'Metallic in red and smoothness (inverted roughness) in alpha, as URP expects.',
    maps: [
      {
        suffix: 'BaseMap',
        label: 'Base Map',
        sources: [
          { channel: 'baseColor', component: 0 },
          { channel: 'baseColor', component: 1 },
          { channel: 'baseColor', component: 2 },
          { channel: 'opacity', component: 0 },
        ],
        srgb: true,
      },
      {
        suffix: 'MetallicSmoothness',
        label: 'Metallic Smoothness',
        sources: [
          { channel: 'metallic', component: 0 },
          { constant: 0 },
          { constant: 0 },
          { channel: 'roughness', component: 0, encoding: 'invert' },
        ],
        srgb: false,
      },
      { suffix: 'NormalMap', label: 'Normal Map', sources: rgb('normal', 'normal'), srgb: false },
      { suffix: 'OcclusionMap', label: 'Occlusion', sources: gray('ao'), srgb: false },
    ],
  },
]

export interface ExportedMap {
  name: string
  label: string
  blob: Blob
  width: number
  height: number
}

/** IEEE 754 half-precision to float. Render targets read back as raw uint16. */
function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) >> 15
  const exponent = (bits & 0x7c00) >> 10
  const fraction = bits & 0x03ff
  let value: number
  if (exponent === 0) {
    value = fraction * 6.103515625e-5 / 1024
  } else if (exponent === 0x1f) {
    value = fraction ? NaN : Infinity
  } else {
    value = Math.pow(2, exponent - 15) * (1 + fraction / 1024)
  }
  return sign ? -value : value
}

function toFloatArray(raw: ArrayLike<number>): Float32Array {
  if (raw instanceof Float32Array) return raw
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = halfToFloat(raw[i])
  return out
}

function linearToSrgb(value: number): number {
  const v = Math.min(1, Math.max(0, value))
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * Reads back every slot once and slices the requested maps out of it. One
 * readback for the whole preset, not one per image - GPU readback is the
 * expensive part here, not the pixel shuffling.
 */
export async function exportMaps(
  renderer: Renderer,
  slots: SlotTargets,
  preset: ExportPreset,
  baseName: string,
): Promise<ExportedMap[]> {
  const size = slots.resolution
  const slotData: Float32Array[] = []
  for (let slot = 0; slot < slots.rt.textures.length; slot++) {
    const raw = await renderer.readRenderTargetPixelsAsync(slots.rt, 0, 0, size, size, slot)
    slotData.push(toFloatArray(raw as unknown as ArrayLike<number>))
  }

  const results: ExportedMap[] = []
  for (const map of preset.maps) {
    const pixels = new Uint8ClampedArray(new ArrayBuffer(size * size * 4))
    for (let i = 0; i < size * size; i++) {
      for (let c = 0; c < 4; c++) {
        const source = map.sources[c]
        let value: number
        if (source === null) {
          value = 1
        } else if ('constant' in source) {
          value = source.constant
        } else {
          value = readChannel(slotData, i, source)
        }
        // Alpha is always linear, even in an sRGB image.
        const encoded = map.srgb && c < 3 ? linearToSrgb(value) : Math.min(1, Math.max(0, value))
        pixels[i * 4 + c] = Math.round(encoded * 255)
      }
    }
    const blob = await pixelsToPng(pixels, size)
    results.push({ name: `${baseName}_${map.suffix}.png`, label: map.label, blob, width: size, height: size })
  }
  return results
}

function readChannel(slotData: Float32Array[], texel: number, ref: Extract<ChannelRef, { channel: Channel }>): number {
  const info = CHANNEL_INFO[ref.channel]
  const data = slotData[info.slot]
  if (!data) return 0
  const offset = info.swizzle === 'rgb' ? ref.component : { r: 0, g: 1, b: 2, a: 3 }[info.swizzle]
  const value = data[texel * 4 + offset]
  if (ref.encoding === 'normal') return value * 0.5 + 0.5
  if (ref.encoding === 'invert') return 1 - value
  return value
}

async function pixelsToPng(pixels: Uint8ClampedArray<ArrayBuffer>, size: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get a 2D context for export')
  // Render targets have their origin at the top, matching putImageData, so no
  // flip is needed here - the same convention `uvspace.ts` establishes.
  context.putImageData(new ImageData(pixels, size, size), 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png')
  })
}

export function getExportPreset(id: string): ExportPreset | null {
  return EXPORT_PRESETS.find((p) => p.id === id) ?? null
}
