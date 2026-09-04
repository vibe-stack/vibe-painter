/**
 * Ray tracing the mesh from a shader.
 *
 * The depth-map version of AO this replaces could only ever see occluders at
 * the resolution of the depth buffer it gathered from, which is why an eyelid
 * crease baked to nothing while a 64-direction sweep left the surface covered
 * in overlapping hard-edged patches - each direction is one hard shadow, and
 * stacking them is not the same as integrating a hemisphere.
 *
 * So the mesh is traced directly instead. The BVH in `bake/bvh.ts` is flattened
 * into two float textures and walked in the fragment shader:
 *
 *  - **Nodes**, two texels each: `(min.xyz, escape)` and `(max.xyz, payload)`.
 *  - **Triangles**, three texels each: `v0`, `edge1`, `edge2`, in the BVH's own
 *    permutation so a leaf addresses a contiguous run.
 *
 * The walk is stackless. Nodes are laid out in depth-first preorder, so a hit
 * descends to `node + 1` and a miss jumps to `escape` - the index of the next
 * node outside this subtree. A per-lane stack in a fragment shader costs
 * registers on every lane whether it uses them or not, and the depth bound
 * would have to be conservative.
 *
 * The traversal below is a transcription of `packedRaycast`, which is tested
 * against the reference raycaster. Keeping the two in step is the point: a
 * shader cannot be stepped through, so the algorithm is proven on the CPU and
 * only then written out in TSL.
 */

import { ClampToEdgeWrapping, DataTexture, FloatType, NearestFilter, NoColorSpace, RGBAFormat } from 'three/webgpu'
import { Fn, Loop, If, Break, float, int, ivec2, max, min, textureLoad, uniform, vec3, vec4 } from 'three/tsl'
import type { PackedBvh } from '../bake/bvh'
import type { Node } from 'three/webgpu'
import type { F, V3 } from './nodes'

type I = Node<'int'>
type IV2 = Node<'ivec2'>

/**
 * Texture width for both buffers. A row is one dimension of the texture size
 * limit; splitting the index across two keeps a multi-million-texel triangle
 * buffer inside the 8192 that every WebGPU adapter guarantees.
 */
const BUFFER_WIDTH = 2048

export class BvhTextures {
  readonly nodes: DataTexture
  readonly triangles: DataTexture

  #nodeCount = uniform(0, 'int')
  /**
   * Loop bound. Every step either descends one node or jumps forward past a
   * subtree, so no walk can visit more nodes than the tree holds - but WGSL
   * still wants a bound it can see.
   */
  #stepLimit = uniform(0, 'int')

  constructor(packed: PackedBvh) {
    this.nodes = createBuffer(packed.nodes, packed.nodeCount * 2)
    this.triangles = createBuffer(packed.triangles, packed.triangleCount * 3)
    this.#nodeCount.value = packed.nodeCount
    this.#stepLimit.value = packed.nodeCount + 1
  }

  /**
   * Closest hit along `dir` in `[tMin, tMax]`.
   *
   * Closest-hit rather than any-hit even for AO, which only needs a yes/no:
   * breaking out of a nested loop early is awkward in TSL, and the distance is
   * wanted anyway - AO attenuates by it and thickness *is* it. With `tMax`
   * bounding the search the two cost nearly the same.
   */
  trace = Fn(([origin, dir, tMin, tMax]: [V3, V3, F, F]) => {
    // Never divide by a zero component. WGSL leaves float division by zero
    // *indeterminate* rather than defining it as infinity, and a NaN here is
    // not a wrong pixel - it is a runaway. Every slab comparison against a NaN
    // is false, so the node reads as a hit, the walk descends into the entire
    // tree instead of pruning it, and the cost of a ray goes from tens of steps
    // to tens of thousands. Nudging the component off zero keeps the slab test
    // doing what it should: an axis the ray is parallel to yields a huge
    // interval that rejects nothing.
    const safeDir = dir.abs().max(float(1e-20)).mul(dir.sign().add(dir.sign().abs().oneMinus()))
    const invDir = vec3(1, 1, 1).div(safeDir)
    const closest = tMax.toVar('closest')
    const found = float(0).toVar('found')
    const node = int(0).toVar('node')

    Loop({ start: int(0), end: this.#stepLimit, type: 'int', condition: '<' }, () => {
      If(node.greaterThanEqual(this.#nodeCount), () => {
        Break()
      })

      const lo = textureLoad(this.nodes, bufferCoord(node.mul(int(2)) as I))
      const hi = textureLoad(this.nodes, bufferCoord(node.mul(int(2)).add(int(1)) as I))

      const ta = lo.xyz.sub(origin).mul(invDir)
      const tb = hi.xyz.sub(origin).mul(invDir)
      const near = min(ta, tb)
      const far = max(ta, tb)
      const tNear = max(max(near.x, near.y), near.z)
      const tFar = min(min(far.x, far.y), far.z)

      If(tFar.lessThan(max(tNear, tMin)).or(tNear.greaterThan(closest)), () => {
        // `max` with the next index, not the escape index alone. A correct tree
        // always escapes forward, so this changes nothing - but it makes the
        // walk *unable* to revisit a node whatever the buffer holds, and that
        // matters more than it looks: a cycle here would spin the loop up to
        // its full bound on every ray, and a fragment shader that runs long
        // enough gets killed a tile at a time, which shows up as rectangular
        // blocks of garbage rather than as an error.
        const forward = node.add(int(1)) as I
        node.assign(int(lo.w).greaterThan(forward).select(int(lo.w), forward))
      }).Else(() => {
        // Payload is `start * 16 + count + 1` for a leaf and 0 for an internal
        // node, so one comparison distinguishes them and one divide unpacks it.
        If(hi.w.greaterThan(float(0)), () => {
          const payload = hi.w.sub(1)
          const start = payload.div(16).floor()
          const count = int(payload.sub(start.mul(16)))
          const base = int(start).mul(int(3))

          Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
            const at = base.add(i.mul(int(3))) as I
            const v0 = textureLoad(this.triangles, bufferCoord(at)).xyz
            const e1 = textureLoad(this.triangles, bufferCoord(at.add(int(1)) as I)).xyz
            const e2 = textureLoad(this.triangles, bufferCoord(at.add(int(2)) as I)).xyz

            // Moller-Trumbore. A degenerate triangle divides by zero here, but
            // every use of the result is gated on `det` being non-zero, and an
            // inf or NaN fails every one of those comparisons.
            const pv = dir.cross(e2)
            const det = e1.dot(pv)
            const inv = float(1).div(det)
            const tv = origin.sub(v0)
            const u = tv.dot(pv).mul(inv)
            const qv = tv.cross(e1)
            const v = dir.dot(qv).mul(inv)
            const t = e2.dot(qv).mul(inv)

            const inside = det.abs().greaterThan(float(1e-12))
              .and(u.greaterThanEqual(float(0)))
              .and(v.greaterThanEqual(float(0)))
              .and(u.add(v).lessThanEqual(float(1)))
            If(inside.and(t.greaterThanEqual(tMin)).and(t.lessThan(closest)), () => {
              closest.assign(t)
              found.assign(float(1))
            })
          })
        })
        // Depth-first order puts the left child immediately after its parent,
        // and a leaf's escape index is the very same place.
        node.addAssign(int(1))
      })
    })

    return vec4(found, closest, 0, 0)
  })

  dispose(): void {
    this.nodes.dispose()
    this.triangles.dispose()
  }
}

/** Splits a linear buffer index into the texture's two dimensions. */
function bufferCoord(index: I): IV2 {
  const row = index.div(int(BUFFER_WIDTH)) as I
  return ivec2(index.sub(row.mul(int(BUFFER_WIDTH))), row) as IV2
}

/**
 * Wraps a flat float buffer as an RGBA32F texture.
 *
 * These are read with `textureLoad`, never `texture`, and that is not merely
 * about exactness - though it is that too: a sampler interpolating between two
 * BVH nodes would return a box that exists nowhere in the tree. It is also the
 * only way a float32 texture can be read at all here. WebGPU calls rgba32float
 * unfilterable unless the adapter offers `float32-filterable`, three declares
 * it as such, and three binds every non-depth texture with a *filtering*
 * sampler - so a float32 texture reached through `texture()` fails bind group
 * validation and takes its whole pipeline down with it, silently. `textureLoad`
 * binds no sampler, so the question never arises. Anything in this codebase
 * that needs a sampler has to be half float.
 */
function createBuffer(data: Float32Array, texelCount: number): DataTexture {
  const height = Math.max(1, Math.ceil(texelCount / BUFFER_WIDTH))
  const padded = new Float32Array(BUFFER_WIDTH * height * 4)
  padded.set(data.subarray(0, Math.min(data.length, padded.length)))

  const texture = new DataTexture(padded, BUFFER_WIDTH, height, RGBAFormat, FloatType)
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}
