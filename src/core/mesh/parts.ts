/**
 * Mesh parts: the source-mesh materials, objects and colour IDs a fill can
 * be dropped onto.
 *
 * Substance Painter treats the imported mesh as already partitioned - by
 * material slot, by object, or by vertex-colour ID - and a catalogue drag
 * assigns to one of those regions rather than the whole model. We stamp a
 * per-vertex `partId` so the viewport can colour the regions and a mask
 * generator can select one of them in UV space.
 */

import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import type { InterleavedBufferAttribute } from 'three/webgpu'
import type { MeshPart } from '../doc/types'
import { attributeToFloat32 } from './attributes'

export const PART_ID_ATTRIBUTE = 'partId'

export type MeshPartKind = MeshPart['kind']
export type { MeshPart }

export interface MeshPiece {
  geometry: BufferGeometry
  materialKey: string
  materialName: string
  objectName: string
}

export interface PartAssignment {
  parts: MeshPart[]
  source: MeshPartKind | 'none'
}

/** Golden-ratio hue walk, matching the overlay shader in `viewport.ts`. */
export function partDisplayColor(index: number): [number, number, number] {
  const h = (index * 0.61803398875 + 0.07) % 1
  return hsvToRgb(h, 0.72, 0.92)
}

export function ensurePartIdAttribute(geometry: BufferGeometry): void {
  if (geometry.getAttribute(PART_ID_ATTRIBUTE)) return
  const count = geometry.getAttribute('position')?.count ?? 0
  geometry.setAttribute(PART_ID_ATTRIBUTE, new BufferAttribute(new Float32Array(count), 1))
}

export function readMeshParts(geometry: BufferGeometry | null | undefined): MeshPart[] {
  const parts = geometry?.userData?.meshParts
  return Array.isArray(parts) ? (parts as MeshPart[]) : []
}

export function attachMeshParts(geometry: BufferGeometry, parts: MeshPart[]): void {
  geometry.userData.meshParts = parts
}

/**
 * Picks the most useful ID source and stamps `partId` on every piece.
 *
 * Preference matches Painter: source materials first, then discrete vertex
 * colours (the usual "ID map" authoring trick), then separate objects.
 */
export function assignPartIds(pieces: MeshPiece[]): PartAssignment {
  if (pieces.length === 0) return { parts: [], source: 'none' }

  const materials = uniqueKeys(pieces.map((piece) => piece.materialKey))
  const objects = uniqueKeys(pieces.map((piece) => piece.objectName))
  const colors = collectColorKeys(pieces)

  if (materials.length >= 2) {
    const assignment = stampByKey(
      pieces,
      (piece) => piece.materialKey,
      (key) => pieces.find((piece) => piece.materialKey === key)?.materialName ?? key,
      'material',
    )
    stripColor(pieces)
    return assignment
  }

  if (colors && colors.keys.length >= 2 && colors.keys.length <= 64) {
    return stampByColor(pieces, colors)
  }

  if (objects.length >= 2) {
    const assignment = stampByKey(pieces, (piece) => piece.objectName, (key) => key, 'object')
    stripColor(pieces)
    return assignment
  }

  stripColor(pieces)
  stampConstant(pieces, 0)
  const name = pieces[0].materialName && pieces[0].materialName !== 'Material'
    ? pieces[0].materialName
    : pieces[0].objectName
  const parts: MeshPart[] = [
    {
      index: 0,
      name: name || 'Mesh',
      kind: 'material',
      color: partDisplayColor(0),
      triangleCount: pieces.reduce((sum, piece) => sum + triangleCountOf(piece.geometry), 0),
    },
  ]
  return { parts, source: 'none' }
}

/** Stamps sequential vertex ranges - used by primitives that know their layout. */
export function stampVertexRanges(
  geometry: BufferGeometry,
  ranges: { name: string; kind: MeshPartKind; vertexCount: number }[],
): MeshPart[] {
  const position = geometry.getAttribute('position')
  const count = position?.count ?? 0
  const ids = new Float32Array(count)
  const parts: MeshPart[] = []
  let offset = 0
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]
    const end = Math.min(count, offset + range.vertexCount)
    for (let v = offset; v < end; v++) ids[v] = i
    parts.push({
      index: i,
      name: range.name,
      kind: range.kind,
      color: partDisplayColor(i),
      triangleCount: 0,
    })
    offset = end
  }
  geometry.setAttribute(PART_ID_ATTRIBUTE, new BufferAttribute(ids, 1))
  fillTriangleCounts(geometry, parts)
  attachMeshParts(geometry, parts)
  return parts
}

export function stampSinglePart(geometry: BufferGeometry, name: string): MeshPart[] {
  const count = geometry.getAttribute('position')?.count ?? 0
  return stampVertexRanges(geometry, [{ name, kind: 'object', vertexCount: count }])
}

export function partIdAtFace(geometry: BufferGeometry, faceIndex: number | undefined | null): number | null {
  if (faceIndex === undefined || faceIndex === null || faceIndex < 0) return null
  const attr = geometry.getAttribute(PART_ID_ATTRIBUTE)
  if (!attr) return null
  const index = geometry.getIndex()
  const vertex = index ? index.getX(faceIndex * 3) : faceIndex * 3
  if (vertex < 0 || vertex >= attr.count) return null
  return Math.round(attr.getX(vertex))
}

function stampByKey(
  pieces: MeshPiece[],
  keyOf: (piece: MeshPiece) => string,
  nameOf: (key: string) => string,
  kind: MeshPartKind,
): PartAssignment {
  const keys = uniqueKeys(pieces.map(keyOf))
  const counts = new Map<number, number>()
  for (const piece of pieces) {
    const index = keys.indexOf(keyOf(piece))
    stampConstant([piece], index)
    counts.set(index, (counts.get(index) ?? 0) + triangleCountOf(piece.geometry))
  }
  const parts: MeshPart[] = keys.map((key, index) => ({
    index,
    name: nameOf(key),
    kind,
    color: partDisplayColor(index),
    triangleCount: counts.get(index) ?? 0,
  }))
  return { parts, source: kind }
}

function stampByColor(pieces: MeshPiece[], catalog: ColorCatalog): PartAssignment {
  const counts = new Map<number, number>()
  for (const piece of pieces) {
    const color = piece.geometry.getAttribute('color')
    const count = piece.geometry.getAttribute('position').count
    const ids = new Float32Array(count)
    if (color) {
      for (let i = 0; i < count; i++) {
        const key = quantizeColor(color.getX(i), color.getY(i), color.getZ(i))
        const index = catalog.keys.indexOf(key)
        ids[i] = Math.max(0, index)
        counts.set(ids[i], (counts.get(ids[i]) ?? 0) + 1)
      }
    }
    piece.geometry.setAttribute(PART_ID_ATTRIBUTE, new BufferAttribute(ids, 1))
    piece.geometry.deleteAttribute('color')
  }
  const parts: MeshPart[] = catalog.keys.map((_key, index) => ({
    index,
    name: colorName(catalog.rgb[index] ?? [0.5, 0.5, 0.5], index),
    kind: 'color',
    color: catalog.rgb[index] ?? partDisplayColor(index),
    triangleCount: Math.round((counts.get(index) ?? 0) / 3),
  }))
  return { parts, source: 'color' }
}

function stampConstant(pieces: MeshPiece[], id: number): void {
  for (const piece of pieces) {
    const count = piece.geometry.getAttribute('position')?.count ?? 0
    const ids = new Float32Array(count)
    ids.fill(id)
    piece.geometry.setAttribute(PART_ID_ATTRIBUTE, new BufferAttribute(ids, 1))
  }
}

function stripColor(pieces: MeshPiece[]): void {
  for (const piece of pieces) piece.geometry.deleteAttribute('color')
}

function uniqueKeys(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

interface ColorCatalog {
  keys: number[]
  rgb: [number, number, number][]
}

function collectColorKeys(pieces: MeshPiece[]): ColorCatalog | null {
  if (!pieces.every((piece) => piece.geometry.getAttribute('color'))) return null
  const map = new Map<number, [number, number, number]>()
  for (const piece of pieces) {
    const color = piece.geometry.getAttribute('color')
    const packed = attributeToFloat32(color as BufferAttribute | InterleavedBufferAttribute, color.itemSize)
    const stride = color.itemSize
    for (let i = 0; i < color.count; i++) {
      const r = packed[i * stride]
      const g = packed[i * stride + 1]
      const b = packed[i * stride + 2]
      const key = quantizeColor(r, g, b)
      if (!map.has(key)) map.set(key, [r, g, b])
    }
  }
  if (map.size < 2) return null
  const keys = [...map.keys()].sort((a, b) => a - b)
  return { keys, rgb: keys.map((key) => map.get(key)!) }
}

/** 5 bits per channel: enough to tell ID colours apart, coarse enough to merge noise. */
function quantizeColor(r: number, g: number, b: number): number {
  const qr = Math.min(31, Math.max(0, Math.round(r * 31)))
  const qg = Math.min(31, Math.max(0, Math.round(g * 31)))
  const qb = Math.min(31, Math.max(0, Math.round(b * 31)))
  return (qr << 10) | (qg << 5) | qb
}

function colorName(rgb: [number, number, number], index: number): string {
  const [r, g, b] = rgb
  const hex = ((Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255))
    .toString(16)
    .padStart(6, '0')
  return `ID ${index + 1} (#${hex})`
}

function triangleCountOf(geometry: BufferGeometry): number {
  const index = geometry.getIndex()
  const count = index ? index.count : geometry.getAttribute('position')?.count ?? 0
  return Math.floor(count / 3)
}

function fillTriangleCounts(geometry: BufferGeometry, parts: MeshPart[]): void {
  for (const part of parts) part.triangleCount = 0
  const attr = geometry.getAttribute(PART_ID_ATTRIBUTE)
  if (!attr) return
  const index = geometry.getIndex()
  const triangles = Math.floor((index ? index.count : attr.count) / 3)
  for (let t = 0; t < triangles; t++) {
    const vertex = index ? index.getX(t * 3) : t * 3
    const id = Math.round(attr.getX(vertex))
    if (parts[id]) parts[id].triangleCount += 1
  }
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const channel = (offset: number) => {
    const t = (h + offset) % 1
    const p = Math.abs(t * 6 - 3)
    const c = Math.min(1, Math.max(0, p - 1))
    return v * (1 + (c - 1) * s)
  }
  return [channel(0), channel(2 / 3), channel(1 / 3)]
}
