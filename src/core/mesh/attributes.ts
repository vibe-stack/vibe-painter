/**
 * Pull vertex attributes out as ordinary float arrays.
 *
 * glTF accessors are often interleaved, integer, and `normalized`. The GPU
 * vertex fetch applies all of that automatically, so a rasterised bake looks
 * fine. The CPU ray baker copies `.array` and would then treat a 0..65535 UV
 * as if it were 0..1, which writes AO into the wrong texels and makes the map
 * look like it was applied with the wrong unwrap.
 *
 * `getX` / `getY` / `getZ` already denormalise and deinterleave, so we read
 * through those and write a tightly packed Float32Array.
 */

import { BufferAttribute } from 'three/webgpu'
import type { BufferGeometry, InterleavedBufferAttribute } from 'three/webgpu'

type VertexAttr = BufferAttribute | InterleavedBufferAttribute

export function attributeToFloat32(attr: VertexAttr, itemSize = attr.itemSize): Float32Array {
  const count = attr.count
  const out = new Float32Array(count * itemSize)
  for (let i = 0; i < count; i++) {
    const o = i * itemSize
    out[o] = attr.getX(i)
    if (itemSize > 1) out[o + 1] = attr.getY(i)
    if (itemSize > 2) out[o + 2] = attr.getZ(i)
    if (itemSize > 3) out[o + 3] = attr.getW(i)
  }
  return out
}

/** Replaces an attribute with an unnormalised, tightly packed float copy. */
export function toFloatAttribute(attr: VertexAttr): BufferAttribute {
  const interleaved = (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute
  if (
    !interleaved
    && attr.array instanceof Float32Array
    && !attr.normalized
    && attr.array.length === attr.count * attr.itemSize
  ) {
    return attr as BufferAttribute
  }
  return new BufferAttribute(attributeToFloat32(attr), attr.itemSize)
}

export function compactGeometryAttributes(geometry: BufferGeometry, names: string[]): void {
  for (const name of names) {
    const attr = geometry.getAttribute(name)
    if (!attr) continue
    const packed = toFloatAttribute(attr as VertexAttr)
    if (packed !== attr) geometry.setAttribute(name, packed)
  }
}
