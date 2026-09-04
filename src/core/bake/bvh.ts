/**
 * A compact BVH for ray queries during baking.
 *
 * Everything lives in flat typed arrays and the traversal allocates nothing,
 * because the bake shoots tens of millions of rays and the garbage collector
 * is the difference between three seconds and thirty.
 *
 * Runs in a worker, so it must not touch three.js or the DOM.
 */

const LEAF_SIZE = 8
const STACK_SIZE = 64

export interface BvhGeometry {
  /** Flat xyz triples. */
  positions: Float32Array
  /** Triangle vertex indices. */
  indices: Uint32Array
}

export class Bvh {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  /** Per node: minX,minY,minZ,maxX,maxY,maxZ. */
  private bounds: Float32Array
  /** Per node: left, right, start, count. `left < 0` marks a leaf. */
  private nodes: Int32Array
  /** Triangle order after partitioning. */
  private order: Uint32Array
  /**
   * Index of the next node in depth-first order that is *not* under this one.
   *
   * This is what lets the GPU walk the tree without a stack: nodes are built in
   * DFS preorder, so a node's left child is always `node + 1` and a miss just
   * jumps to `escape`. A fragment shader has no cheap per-lane stack, and a
   * fixed-size one large enough for a deep tree costs registers on every lane
   * whether it needs them or not.
   */
  private escape: Int32Array
  private nodeCount = 0
  private stack = new Int32Array(STACK_SIZE)

  constructor(geometry: BvhGeometry) {
    this.positions = geometry.positions
    this.indices = geometry.indices

    const triangleCount = this.indices.length / 3
    this.order = new Uint32Array(triangleCount)
    for (let i = 0; i < triangleCount; i++) this.order[i] = i

    // A binary BVH with LEAF_SIZE per leaf needs at most 2*ceil(n/LEAF) nodes;
    // over-allocate slightly rather than growing during the build.
    const maxNodes = Math.max(1, 2 * Math.ceil(triangleCount / LEAF_SIZE) + 1) * 2
    this.bounds = new Float32Array(maxNodes * 6)
    this.nodes = new Int32Array(maxNodes * 4)
    this.escape = new Int32Array(maxNodes)

    const centroids = new Float32Array(triangleCount * 3)
    for (let t = 0; t < triangleCount; t++) {
      const i0 = this.indices[t * 3] * 3
      const i1 = this.indices[t * 3 + 1] * 3
      const i2 = this.indices[t * 3 + 2] * 3
      centroids[t * 3] = (this.positions[i0] + this.positions[i1] + this.positions[i2]) / 3
      centroids[t * 3 + 1] = (this.positions[i0 + 1] + this.positions[i1 + 1] + this.positions[i2 + 1]) / 3
      centroids[t * 3 + 2] = (this.positions[i0 + 2] + this.positions[i1 + 2] + this.positions[i2 + 2]) / 3
    }

    this.build(0, triangleCount, centroids)
  }

  private allocNode(): number {
    return this.nodeCount++
  }

  private build(start: number, count: number, centroids: Float32Array): number {
    const node = this.allocNode()
    const b = node * 6
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

    for (let i = start; i < start + count; i++) {
      const t = this.order[i]
      for (let v = 0; v < 3; v++) {
        const p = this.indices[t * 3 + v] * 3
        const x = this.positions[p], y = this.positions[p + 1], z = this.positions[p + 2]
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
    }
    this.bounds[b] = minX; this.bounds[b + 1] = minY; this.bounds[b + 2] = minZ
    this.bounds[b + 3] = maxX; this.bounds[b + 4] = maxY; this.bounds[b + 5] = maxZ

    const n = node * 4
    if (count <= LEAF_SIZE) {
      this.nodes[n] = -1
      this.nodes[n + 2] = start
      this.nodes[n + 3] = count
      this.escape[node] = this.nodeCount
      return node
    }

    // Spatial-median split on the widest centroid axis, partitioned in place.
    //
    // An object-median split would need a sort per node, and `Array.from` +
    // `sort` allocates at every level of the tree - which dominated build time
    // on a 25k-triangle mesh. A midpoint partition is O(n) with no allocation
    // and builds a comparable tree; it only needs the object-median fallback
    // below when the centroids all land on one side.
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ
    const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2

    let centroidMin = Infinity
    let centroidMax = -Infinity
    for (let i = start; i < start + count; i++) {
      const c = centroids[this.order[i] * 3 + axis]
      if (c < centroidMin) centroidMin = c
      if (c > centroidMax) centroidMax = c
    }

    let mid: number
    if (centroidMax - centroidMin < 1e-12) {
      // Every centroid coincides: nothing to separate, so split by count.
      mid = count >> 1
    } else {
      const pivot = (centroidMin + centroidMax) * 0.5
      let left = start
      let right = start + count - 1
      while (left <= right) {
        if (centroids[this.order[left] * 3 + axis] < pivot) {
          left++
        } else {
          const tmp = this.order[left]
          this.order[left] = this.order[right]
          this.order[right] = tmp
          right--
        }
      }
      mid = left - start
      // A degenerate partition would recurse forever; fall back to a halving.
      if (mid === 0 || mid === count) mid = count >> 1
    }
    const left = this.build(start, mid, centroids)
    const right = this.build(start + mid, count - mid, centroids)
    // Written after recursion: both child indices are known only then, and
    // storing the right child explicitly keeps traversal free of any walk.
    this.nodes[n] = left
    this.nodes[n + 1] = right
    // Everything under this node has now been allocated, so the next free index
    // is exactly where a miss should resume.
    this.escape[node] = this.nodeCount
    return node
  }

  /**
   * Closest-hit distance along `dir` from `origin`, or -1 for a miss.
   * `maxDistance` bounds the search, which is what makes AO's occluder
   * distance setting cheap rather than merely cosmetic.
   *
   * Both traversals below alias every typed array into a local first and
   * inline the triangle test. That is not premature: a bake shoots millions of
   * rays, and property loads and call frames dominate the profile otherwise.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minDistance: number,
    maxDistance: number,
  ): number {
    const bounds = this.bounds
    const nodes = this.nodes
    const order = this.order
    const pos = this.positions
    const idx = this.indices
    const stack = this.stack

    const invX = 1 / dx, invY = 1 / dy, invZ = 1 / dz
    let closest = maxDistance
    let hit = false
    let sp = 0
    stack[sp++] = 0

    while (sp > 0) {
      const node = stack[--sp]
      const b = node * 6

      let t0 = (bounds[b] - ox) * invX
      let t1 = (bounds[b + 3] - ox) * invX
      let tmin = t0 < t1 ? t0 : t1
      let tmax = t0 < t1 ? t1 : t0
      t0 = (bounds[b + 1] - oy) * invY
      t1 = (bounds[b + 4] - oy) * invY
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1)
      tmax = Math.min(tmax, t0 < t1 ? t1 : t0)
      t0 = (bounds[b + 2] - oz) * invZ
      t1 = (bounds[b + 5] - oz) * invZ
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1)
      tmax = Math.min(tmax, t0 < t1 ? t1 : t0)

      if (tmax < (tmin > minDistance ? tmin : minDistance) || tmin > closest) continue

      const n = node * 4
      const left = nodes[n]
      if (left < 0) {
        const start = nodes[n + 2]
        const end = start + nodes[n + 3]
        for (let i = start; i < end; i++) {
          const tri = order[i] * 3
          const a = idx[tri] * 3, bi = idx[tri + 1] * 3, c = idx[tri + 2] * 3
          const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
          const e1x = pos[bi] - ax, e1y = pos[bi + 1] - ay, e1z = pos[bi + 2] - az
          const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az
          const px = dy * e2z - dz * e2y
          const py = dz * e2x - dx * e2z
          const pz = dx * e2y - dy * e2x
          const det = e1x * px + e1y * py + e1z * pz
          if (det > -1e-12 && det < 1e-12) continue
          const inv = 1 / det
          const tvx = ox - ax, tvy = oy - ay, tvz = oz - az
          const u = (tvx * px + tvy * py + tvz * pz) * inv
          if (u < 0 || u > 1) continue
          const qx = tvy * e1z - tvz * e1y
          const qy = tvz * e1x - tvx * e1z
          const qz = tvx * e1y - tvy * e1x
          const v = (dx * qx + dy * qy + dz * qz) * inv
          if (v < 0 || u + v > 1) continue
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv
          if (t >= minDistance && t < closest) {
            closest = t
            hit = true
          }
        }
      } else if (sp + 2 <= STACK_SIZE) {
        stack[sp++] = left
        stack[sp++] = nodes[n + 1]
      }
    }

    return hit ? closest : -1
  }

  /**
   * Any-hit test. AO only needs to know *whether* something blocks the ray, so
   * returning on the first hit instead of finding the closest one is worth
   * several times the throughput - and AO is the bulk of a bake's ray budget.
   */
  occludes(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minDistance: number,
    maxDistance: number,
  ): boolean {
    const bounds = this.bounds
    const nodes = this.nodes
    const order = this.order
    const pos = this.positions
    const idx = this.indices
    const stack = this.stack

    const invX = 1 / dx, invY = 1 / dy, invZ = 1 / dz
    let sp = 0
    stack[sp++] = 0

    while (sp > 0) {
      const node = stack[--sp]
      const b = node * 6

      let t0 = (bounds[b] - ox) * invX
      let t1 = (bounds[b + 3] - ox) * invX
      let tmin = t0 < t1 ? t0 : t1
      let tmax = t0 < t1 ? t1 : t0
      t0 = (bounds[b + 1] - oy) * invY
      t1 = (bounds[b + 4] - oy) * invY
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1)
      tmax = Math.min(tmax, t0 < t1 ? t1 : t0)
      t0 = (bounds[b + 2] - oz) * invZ
      t1 = (bounds[b + 5] - oz) * invZ
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1)
      tmax = Math.min(tmax, t0 < t1 ? t1 : t0)

      if (tmax < (tmin > minDistance ? tmin : minDistance) || tmin > maxDistance) continue

      const n = node * 4
      const left = nodes[n]
      if (left < 0) {
        const start = nodes[n + 2]
        const end = start + nodes[n + 3]
        for (let i = start; i < end; i++) {
          const tri = order[i] * 3
          const a = idx[tri] * 3, bi = idx[tri + 1] * 3, c = idx[tri + 2] * 3
          const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
          const e1x = pos[bi] - ax, e1y = pos[bi + 1] - ay, e1z = pos[bi + 2] - az
          const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az
          const px = dy * e2z - dz * e2y
          const py = dz * e2x - dx * e2z
          const pz = dx * e2y - dy * e2x
          const det = e1x * px + e1y * py + e1z * pz
          if (det > -1e-12 && det < 1e-12) continue
          const inv = 1 / det
          const tvx = ox - ax, tvy = oy - ay, tvz = oz - az
          const u = (tvx * px + tvy * py + tvz * pz) * inv
          if (u < 0 || u > 1) continue
          const qx = tvy * e1z - tvz * e1y
          const qy = tvz * e1x - tvx * e1z
          const qz = tvx * e1y - tvy * e1x
          const v = (dx * qx + dy * qy + dz * qz) * inv
          if (v < 0 || u + v > 1) continue
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv
          if (t >= minDistance && t <= maxDistance) return true
        }
      } else if (sp + 2 <= STACK_SIZE) {
        stack[sp++] = left
        stack[sp++] = nodes[n + 1]
      }
    }
    return false
  }

  /**
   * The same tree, flattened for a shader.
   *
   * Two RGBA32F texels per node and three per triangle, both indexed linearly,
   * because a fragment shader can only fetch texels - not walk pointers into a
   * JS object graph. Triangles are emitted in `order`, so a leaf's `start` and
   * `count` address a contiguous run and the shader never has to indirect
   * through the permutation.
   *
   * The leaf payload rides in one float: `start * 16 + count + 1`, with zero
   * meaning "internal node". `count` is at most `LEAF_SIZE` (8) so four bits is
   * plenty, and float32 holds the product exactly up to a million triangles -
   * well past what a browser will bake.
   */
  packForGpu(): PackedBvh {
    const nodeCount = this.nodeCount
    const nodes = new Float32Array(nodeCount * 8)
    for (let i = 0; i < nodeCount; i++) {
      const b = i * 6
      const n = i * 4
      const o = i * 8
      nodes[o] = this.bounds[b]
      nodes[o + 1] = this.bounds[b + 1]
      nodes[o + 2] = this.bounds[b + 2]
      nodes[o + 3] = this.escape[i]
      nodes[o + 4] = this.bounds[b + 3]
      nodes[o + 5] = this.bounds[b + 4]
      nodes[o + 6] = this.bounds[b + 5]
      nodes[o + 7] = this.nodes[n] < 0 ? this.nodes[n + 2] * 16 + this.nodes[n + 3] + 1 : 0
    }

    const triangleCount = this.order.length
    // v0, e1, e2 rather than three corners: the edges are what the intersection
    // test wants, and precomputing them here takes two subtractions off every
    // triangle test in every ray.
    const triangles = new Float32Array(triangleCount * 12)
    for (let i = 0; i < triangleCount; i++) {
      const tri = this.order[i] * 3
      const a = this.indices[tri] * 3
      const b = this.indices[tri + 1] * 3
      const c = this.indices[tri + 2] * 3
      const o = i * 12
      for (let k = 0; k < 3; k++) {
        triangles[o + k] = this.positions[a + k]
        triangles[o + 4 + k] = this.positions[b + k] - this.positions[a + k]
        triangles[o + 8 + k] = this.positions[c + k] - this.positions[a + k]
      }
    }

    return { nodes, nodeCount, triangles, triangleCount }
  }
}

export interface PackedBvh {
  /** Two RGBA texels per node: (min.xyz, escape) and (max.xyz, leafPayload). */
  nodes: Float32Array
  nodeCount: number
  /** Three RGBA texels per triangle: v0, edge1, edge2 (w unused). */
  triangles: Float32Array
  triangleCount: number
}

/**
 * The stackless walk, in plain JS, exactly as the shader performs it.
 *
 * This exists to be tested. The GPU version cannot be stepped through or
 * asserted against anything, so the algorithm is written once here, checked
 * against `Bvh.raycast` on real meshes, and only then transcribed into TSL -
 * which leaves shader bugs as transcription bugs rather than logic bugs.
 */
export function packedRaycast(
  bvh: PackedBvh,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minDistance: number,
  maxDistance: number,
  anyHit: boolean,
): number {
  const { nodes, triangles, nodeCount } = bvh
  const invX = 1 / dx, invY = 1 / dy, invZ = 1 / dz
  let closest = maxDistance
  let hit = false
  let i = 0

  while (i < nodeCount) {
    const o = i * 8
    let t0 = (nodes[o] - ox) * invX
    let t1 = (nodes[o + 4] - ox) * invX
    let tnear = Math.min(t0, t1)
    let tfar = Math.max(t0, t1)
    t0 = (nodes[o + 1] - oy) * invY
    t1 = (nodes[o + 5] - oy) * invY
    tnear = Math.max(tnear, Math.min(t0, t1))
    tfar = Math.min(tfar, Math.max(t0, t1))
    t0 = (nodes[o + 2] - oz) * invZ
    t1 = (nodes[o + 6] - oz) * invZ
    tnear = Math.max(tnear, Math.min(t0, t1))
    tfar = Math.min(tfar, Math.max(t0, t1))

    if (tfar < Math.max(tnear, minDistance) || tnear > closest) {
      i = nodes[o + 3]
      continue
    }

    const payload = nodes[o + 7]
    if (payload > 0) {
      const p = payload - 1
      const start = Math.floor(p / 16)
      const count = p - start * 16
      for (let k = 0; k < count; k++) {
        const t = intersectTriangle(
          triangles, (start + k) * 12,
          ox, oy, oz, dx, dy, dz,
        )
        if (t >= minDistance && t < closest) {
          closest = t
          hit = true
          if (anyHit) return closest
        }
      }
    }
    // On a hit the left child is the very next node, and for a leaf that is the
    // same index its escape would name - so both cases advance by one.
    i += 1
  }

  return hit ? closest : -1
}

/** Moller-Trumbore against a packed (v0, e1, e2) triangle. -1 for a miss. */
function intersectTriangle(
  tri: Float32Array, o: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
): number {
  const ax = tri[o], ay = tri[o + 1], az = tri[o + 2]
  const e1x = tri[o + 4], e1y = tri[o + 5], e1z = tri[o + 6]
  const e2x = tri[o + 8], e2y = tri[o + 9], e2z = tri[o + 10]
  const px = dy * e2z - dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y - dy * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (det > -1e-12 && det < 1e-12) return -1
  const inv = 1 / det
  const tvx = ox - ax, tvy = oy - ay, tvz = oz - az
  const u = (tvx * px + tvy * py + tvz * pz) * inv
  if (u < 0 || u > 1) return -1
  const qx = tvy * e1z - tvz * e1y
  const qy = tvz * e1x - tvx * e1z
  const qz = tvx * e1y - tvy * e1x
  const v = (dx * qx + dy * qy + dz * qz) * inv
  if (v < 0 || u + v > 1) return -1
  return (e2x * qx + e2y * qy + e2z * qz) * inv
}
