/**
 * Unique UV unwrap for imported meshes.
 *
 * Baking and painting both write a single 0..1 atlas. That only works if no
 * two triangles share a texel. glTF files routinely violate that: box-mapped
 * sculpts, mirrored character charts, one 0..1 layout per material, or no
 * UVs at all. The GPU rasteriser then lets the last triangle win, which is
 * exactly "the face's AO appearing on the back of the skull".
 *
 * This is Blender's Smart UV Project, trimmed to what we need: grow islands
 * from a seed face while the neighbour normal stays inside a cone, project
 * each island onto that seed, and pack the charts without overlap. It is not
 * a conformal unwrap - concavities pick up a little stretch - but every
 * texel maps to one surface point, which is the constraint the baker has.
 */

import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import type { InterleavedBufferAttribute } from 'three/webgpu'

type Attr = BufferAttribute | InterleavedBufferAttribute

/** Neighbour is kept in the island while the angle to the *seed* normal is below this. */
const ANGLE_LIMIT_COS = Math.cos((60 * Math.PI) / 180)

/** Gutter between packed charts, in UV units, so dilation has somewhere to bleed. */
const PACK_MARGIN = 0.02

export function uniqueUnwrap(geometry: BufferGeometry): BufferGeometry {
  const parts = geometry.userData.meshParts
  const geo = geometry.getIndex() ? geometry.toNonIndexed() : geometry
  if (parts) geo.userData.meshParts = parts
  const position = geo.getAttribute('position')
  const vertexCount = position.count
  const faceCount = Math.floor(vertexCount / 3)
  if (faceCount === 0) {
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(vertexCount * 2), 2))
    return geo
  }

  const weld = weldByPosition(position)
  const faces = buildFaces(position, faceCount)
  const islands = growIslands(faces, weld, vertexCount)

  const charts: Chart[] = []
  for (const members of islands) {
    if (members.length === 0) continue
    const chart = projectIsland(position, faces, members)
    if (chart) charts.push(chart)
  }

  const uvs = new Float32Array(vertexCount * 2)
  packCharts(charts, uvs)
  geo.setAttribute('uv', new BufferAttribute(uvs, 2))
  geo.deleteAttribute('tangent')
  return geo
}

/**
 * True when a meaningful fraction of UV-space interior pixels are claimed by
 * more than one triangle. Shared edges are ignored; stacked islands are not.
 */
export function uvsOverlap(geometry: BufferGeometry, size = 256): boolean {
  const uv = geometry.getAttribute('uv')
  if (!uv || uv.count === 0) return true
  const index = geometry.getIndex()
  const triCount = Math.floor((index ? index.count : uv.count) / 3)
  if (triCount === 0) return true

  const owner = new Int32Array(size * size)
  owner.fill(-1)
  let interior = 0
  let conflicts = 0

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
    const x0 = uv.getX(i0) * size
    const y0 = uv.getY(i0) * size
    const x1 = uv.getX(i1) * size
    const y1 = uv.getY(i1) * size
    const x2 = uv.getX(i2) * size
    const y2 = uv.getY(i2) * size

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)))
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)))
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(area) < 1e-12) continue
    const inv = 1 / area

    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5
        const w1 = ((cx - x0) * (y2 - y0) - (cy - y0) * (x2 - x0)) * inv
        const w2 = ((x1 - x0) * (cy - y0) - (y1 - y0) * (cx - x0)) * inv
        const w0 = 1 - w1 - w2
        // Strict interior, so triangles that only share an edge do not count.
        if (w0 <= 0.12 || w1 <= 0.12 || w2 <= 0.12) continue
        interior++
        const p = py * size + px
        if (owner[p] >= 0 && owner[p] !== t) conflicts++
        else owner[p] = t
      }
    }
  }

  if (interior === 0) return true
  // Dense unique unwraps still collide a few texels at this resolution.
  // Stacked charts (box-mapped sculpts, mirrored body halves) collide a lot.
  return conflicts / interior > 0.08
}

interface Face {
  nx: number
  ny: number
  nz: number
}

interface Chart {
  corners: number[]
  xs: Float32Array
  ys: Float32Array
  minX: number
  minY: number
  maxX: number
  maxY: number
  x: number
  y: number
  w: number
  h: number
}

function weldByPosition(position: Attr): Int32Array {
  const count = position.count
  const weld = new Int32Array(count)
  const map = new Map<string, number>()
  let next = 0
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * 1e5)}:${Math.round(position.getY(i) * 1e5)}:${Math.round(position.getZ(i) * 1e5)}`
    let id = map.get(key)
    if (id === undefined) {
      id = next++
      map.set(key, id)
    }
    weld[i] = id
  }
  return weld
}

function buildFaces(position: Attr, faceCount: number): Face[] {
  const faces: Face[] = new Array(faceCount)
  for (let f = 0; f < faceCount; f++) {
    const i0 = f * 3
    const ax = position.getX(i0), ay = position.getY(i0), az = position.getZ(i0)
    const bx = position.getX(i0 + 1), by = position.getY(i0 + 1), bz = position.getZ(i0 + 1)
    const cx = position.getX(i0 + 2), cy = position.getY(i0 + 2), cz = position.getZ(i0 + 2)
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz) || 1
    faces[f] = { nx: nx / len, ny: ny / len, nz: nz / len }
  }
  return faces
}

function growIslands(faces: Face[], weld: Int32Array, vertexCount: number): number[][] {
  const faceCount = faces.length
  const neighbors = adjacency(weld, faceCount, vertexCount)
  const visited = new Uint8Array(faceCount)
  const islands: number[][] = []

  for (let seed = 0; seed < faceCount; seed++) {
    if (visited[seed]) continue
    const members: number[] = []
    const snx = faces[seed].nx, sny = faces[seed].ny, snz = faces[seed].nz
    const stack = [seed]
    visited[seed] = 1
    while (stack.length > 0) {
      const f = stack.pop()!
      members.push(f)
      const adj = neighbors[f]
      for (let i = 0; i < adj.length; i++) {
        const n = adj[i]
        if (visited[n]) continue
        if (faces[n].nx * snx + faces[n].ny * sny + faces[n].nz * snz < ANGLE_LIMIT_COS) continue
        visited[n] = 1
        stack.push(n)
      }
    }
    islands.push(members)
  }
  return islands
}

function adjacency(weld: Int32Array, faceCount: number, vertexCount: number): number[][] {
  const neighbors: number[][] = Array.from({ length: faceCount }, () => [])
  const edgeFace = new Map<number, number>()
  const stride = vertexCount + 1

  const addEdge = (a: number, b: number, face: number) => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const key = lo * stride + hi
    const other = edgeFace.get(key)
    if (other === undefined) {
      edgeFace.set(key, face)
      return
    }
    neighbors[face].push(other)
    neighbors[other].push(face)
  }

  for (let f = 0; f < faceCount; f++) {
    const i0 = f * 3
    addEdge(weld[i0], weld[i0 + 1], f)
    addEdge(weld[i0 + 1], weld[i0 + 2], f)
    addEdge(weld[i0 + 2], weld[i0], f)
  }
  return neighbors
}

function projectIsland(position: Attr, faces: Face[], members: number[]): Chart | null {
  let nx = 0, ny = 0, nz = 0
  for (const f of members) {
    nx += faces[f].nx
    ny += faces[f].ny
    nz += faces[f].nz
  }
  const nlen = Math.hypot(nx, ny, nz)
  if (nlen < 1e-8) return null
  nx /= nlen
  ny /= nlen
  nz /= nlen

  // Tangent frame: pick an up vector that is not colinear with the seed.
  let tx: number
  let ty: number
  let tz: number
  if (Math.abs(ny) < 0.9) {
    tx = nz
    ty = 0
    tz = -nx
  } else {
    tx = 0
    ty = -nz
    tz = ny
  }
  const tlen = Math.hypot(tx, ty, tz) || 1
  tx /= tlen
  ty /= tlen
  tz /= tlen
  const bx = ny * tz - nz * ty
  const by = nz * tx - nx * tz
  const bz = nx * ty - ny * tx

  const corners = new Array<number>(members.length * 3)
  const xs = new Float32Array(members.length * 3)
  const ys = new Float32Array(members.length * 3)
  let k = 0
  for (const f of members) {
    for (let c = 0; c < 3; c++, k++) {
      const i = f * 3 + c
      const px = position.getX(i), py = position.getY(i), pz = position.getZ(i)
      corners[k] = i
      xs[k] = px * tx + py * ty + pz * tz
      ys[k] = px * bx + py * by + pz * bz
    }
  }

  const rotated = minAreaRotation(xs, ys)
  return {
    corners,
    xs,
    ys,
    minX: rotated.minX,
    minY: rotated.minY,
    maxX: rotated.maxX,
    maxY: rotated.maxY,
    x: 0,
    y: 0,
    w: Math.max(1e-8, rotated.maxX - rotated.minX),
    h: Math.max(1e-8, rotated.maxY - rotated.minY),
  }
}

function minAreaRotation(xs: Float32Array, ys: Float32Array): { minX: number; minY: number; maxX: number; maxY: number } {
  let bestArea = Infinity
  let best = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  let bestC = 1
  let bestS = 0
  for (let step = 0; step < 16; step++) {
    const ang = (Math.PI / 2) * (step / 16)
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] * c - ys[i] * s
      const y = xs[i] * s + ys[i] * c
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    const area = (maxX - minX) * (maxY - minY)
    if (area < bestArea) {
      bestArea = area
      best = { minX, minY, maxX, maxY }
      bestC = c
      bestS = s
    }
  }
  if (bestC !== 1 || bestS !== 0) {
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] * bestC - ys[i] * bestS
      const y = xs[i] * bestS + ys[i] * bestC
      xs[i] = x
      ys[i] = y
    }
  }
  return best
}

function packCharts(charts: Chart[], uvs: Float32Array): void {
  if (charts.length === 0) return

  // Padding in *world* units so small charts still get a gutter after scaling.
  let pad = 0
  for (const chart of charts) pad += chart.w * chart.h
  pad = Math.sqrt(Math.max(pad, 1e-8)) * 0.02
  for (const chart of charts) {
    chart.w += pad
    chart.h += pad
  }

  const sorted = [...charts].sort((a, b) => b.h - a.h)
  const area = sorted.reduce((sum, chart) => sum + chart.w * chart.h, 0)
  const targetW = Math.max(Math.sqrt(area), ...sorted.map((chart) => chart.w))
  let x = 0
  let y = 0
  let rowH = 0
  let width = 0
  let height = 0
  for (const chart of sorted) {
    if (x > 0 && x + chart.w > targetW) {
      x = 0
      y += rowH
      rowH = 0
    }
    chart.x = x
    chart.y = y
    x += chart.w
    rowH = Math.max(rowH, chart.h)
    width = Math.max(width, x)
    height = Math.max(height, y + chart.h)
  }

  const scale = (1 - PACK_MARGIN * 2) / Math.max(width, height, 1e-8)
  for (const chart of charts) {
    for (let i = 0; i < chart.corners.length; i++) {
      const u = PACK_MARGIN + (chart.x + (chart.xs[i] - chart.minX)) * scale
      const v = PACK_MARGIN + (chart.y + (chart.ys[i] - chart.minY)) * scale
      const o = chart.corners[i] * 2
      uvs[o] = u
      uvs[o + 1] = v
    }
  }
}
