/**
 * AO, curvature and thickness.
 *
 * Every pass here rasterises the *mesh* into UV space. That is the whole design
 * and it is what fixes the jagged lines that used to trace every UV chart in
 * all three maps at once.
 *
 * The old passes were fullscreen quads that read the baked geometry maps and
 * gated on the island mask - two separate answers to "is this texel surface?",
 * reached by two different paths, which is one answer too many. Wherever they
 * disagreed by a texel the compose pass wrote nothing, and the texel kept the
 * value it had been cleared to: AO 1, thickness 1, curvature 0. That is exactly
 * the signature those seams had - white in AO, white in thickness, hard concave
 * in curvature - and no amount of tuning the visibility maths could have
 * touched it, because it was never a visibility bug.
 *
 * Rasterising the mesh removes the second answer. A texel is written if and
 * only if the mesh covers it, by the same rasteriser that defines the island in
 * the first place, and the fragment carries its own position and normal as
 * full-precision varyings instead of reading them back out of a half-float map.
 *
 * What the passes compute:
 *
 *  - **AO and thickness** trace real rays against a BVH (`raytrace.ts`). The
 *    previous version gathered from 512-1024px depth maps rendered from a
 *    sphere of directions, which cannot resolve an occluder smaller than its
 *    own texel - an eyelid crease baked to nothing - and which is a stack of
 *    hard directional shadows rather than an integrated hemisphere, hence the
 *    patchwork. Cosine-weighted stratified rays give the smooth result the
 *    technique was reaching for.
 *  - **Curvature** is measured on the mesh's connectivity (`mesh/curvature.ts`)
 *    and arrives as a vertex attribute, so this file only interpolates it.
 *
 * The ray budget is split across several draws with a yield between them: one
 * draw covering a 2k atlas at 128 rays a texel is long enough for a browser to
 * decide the GPU has hung.
 *
 * Those draws accumulate through *blending* rather than by reading back the
 * previous pass's target. A ping-pong makes every pass a read of the texture
 * the pass before it just rendered into, and that hazard is the one thing here
 * with no cheap way to verify from the outside - it showed up as speckle in AO
 * and tile-shaped blocks in thickness. Blending keeps the sum entirely inside
 * the attachment, where the ordering is the API's problem rather than ours, and
 * it costs one render target instead of two.
 */

import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoBlending,
  NodeMaterial,
  OneFactor,
  QuadMesh,
  RGBAFormat,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import type { BufferGeometry, Renderer } from 'three/webgpu'
import {
  Fn,
  If,
  Loop,
  abs,
  attribute,
  cos,
  cross,
  float,
  fract,
  int,
  max,
  modelNormalMatrix,
  normalLocal,
  normalize,
  positionWorld,
  sin,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { BakeSettings } from '../doc/types'
import type { BakeProgress } from '../bake/baker'
import { CHANNEL_TARGET_OPTIONS } from './targets'
import { UVSpacePass, compileAgainst, renderQuad, uvClipPosition } from './uvspace'
import { CURVATURE_ATTRIBUTE, ensureVertexCurvature } from '../mesh/curvature'
import { Bvh } from '../bake/bvh'
import { BvhTextures } from './raytrace'
import { attributeToFloat32 } from '../mesh/attributes'
import type { MeshMaps } from './meshmaps'
import type { F, V2, V3, V4 } from './nodes'

/**
 * Fragment-rays a single draw may issue.
 *
 * Tracing is not cheap per ray - a walk visits tens of nodes and each visit is
 * a texture fetch - so the size of one draw has to be bounded by the *product*
 * of resolution and rays, not by a fixed ray count. A 2k atlas at eight rays a
 * texel is on the order of a billion loop iterations in one draw, which is well
 * past what a browser will wait for: the GPU work is killed part way, and on a
 * tile-based GPU that surfaces as rectangular blocks of whatever was in that
 * memory rather than as an error.
 */
const PASS_BUDGET = 1_500_000

/** Thickness is far lower frequency than AO, so it does not need the budget. */
const MAX_THICKNESS_RAYS = 32

/**
 * Mesh maps are low frequency - they feed masks, not detail - and the bake cost
 * is quadratic in this, so the default is well below a typical texture set. The
 * result is dilated and sampled bilinearly, so it upscales cleanly.
 */
function bakeResolution(setting: number, textureSet: number): number {
  return Math.max(64, Math.min(textureSet, Math.round(setting)))
}

export class GpuMeshMapBaker {
  #uvPass = new UVSpacePass()
  #quad = new QuadMesh()
  /** Host scene, used only to hand the quad to `compileAsync`. */
  #quadScene = new Scene()

  #accum: RenderTarget | null = null

  #bvh: BvhTextures | null = null
  #bvhKey = ''

  #traceMaterial: NodeMaterial | null = null
  #composeMaterial: NodeMaterial | null = null
  #zeroMaterial: MeshBasicNodeMaterial | null = null
  #materialKey = ''
  #cancelled = false

  #uniforms = createBakeUniforms()

  cancel(): void {
    this.#cancelled = true
  }

  async bake(
    renderer: Renderer,
    geometry: BufferGeometry,
    maps: MeshMaps,
    settings: BakeSettings,
    onProgress?: (progress: BakeProgress) => void,
  ): Promise<void> {
    this.#cancelled = false

    const resolution = bakeResolution(settings.resolution, maps.resolution)
    maps.ensureRayTarget(resolution)

    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const radius = Math.max(1e-5, box.max.clone().sub(box.min).length() * 0.5)

    const raysPerPass = Math.max(1, Math.min(16, Math.round(PASS_BUDGET / (resolution * resolution))))
    const aoRays = Math.max(raysPerPass, Math.min(512, Math.round(settings.aoRays)))
    const passes = Math.ceil(aoRays / raysPerPass)
    const thicknessRays = Math.min(MAX_THICKNESS_RAYS, passes * raysPerPass)

    onProgress?.({ fraction: 0.02, message: 'Measuring curvature' })
    ensureVertexCurvature(geometry, settings.curvatureRadius)
    if (this.#cancelled) return

    onProgress?.({ fraction: 0.05, message: 'Building ray acceleration structure' })
    const bvh = this.#ensureBvh(geometry)
    if (this.#cancelled) return

    const accum = this.#ensureAccum(resolution)
    // Before the values are written: a rebuild replaces the uniform *nodes*, so
    // anything set on the old ones would go nowhere.
    this.#prepareMaterials(bvh, accum)

    const u = this.#uniforms
    u.aoDistance.value = Math.max(1e-4, settings.aoDistance * radius)
    u.thicknessDistance.value = Math.max(1e-4, settings.thicknessDistance * radius * 2)
    // Tracing the real surface needs only enough offset to clear float error on
    // the originating triangle - orders of magnitude below the depth-map bias
    // this replaces, which is why fine creases survive now.
    u.originBias.value = Math.max(settings.rayBias * radius, 1e-6)
    u.curvatureIntensity.value = settings.curvatureIntensity
    u.aoRayTotal.value = passes * raysPerPass
    u.thicknessRayTotal.value = thicknessRays
    u.raysPerPass.value = raysPerPass
    u.raysPerPassScale.value = raysPerPass

    try {
      onProgress?.({ fraction: 0.08, message: 'Preparing pipelines' })
      await this.#prewarm(renderer, geometry, maps, accum)
      if (this.#cancelled) return

      // Both targets start empty. The destination matters as much as the
      // accumulator: its alpha is what tells the dilation pass which texels are
      // real, so a texel the mesh never covers has to read as empty for the
      // dilation to flood over it.
      renderQuad(renderer, this.#quad, this.#zeroMaterialFor(), accum)
      renderQuad(renderer, this.#quad, this.#zeroMaterialFor(), maps.ray)

      for (let pass = 0; pass < passes; pass++) {
        if (this.#cancelled) return
        this.#uniforms.passIndex.value = pass
        this.#uvPass.render(renderer, geometry, this.#traceMaterial!, accum, false)
        onProgress?.({
          fraction: 0.12 + (0.8 * (pass + 1)) / passes,
          message: `Tracing ${(pass + 1) * raysPerPass}/${passes * raysPerPass} rays`,
        })
        // Hand the frame back so the page stays alive and the progress bar
        // actually moves; a bake of a dense mesh is seconds of GPU time.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      if (this.#cancelled) return
      onProgress?.({ fraction: 0.95, message: 'Composing maps' })
      this.#uvPass.render(renderer, geometry, this.#composeMaterial!, maps.ray, false)
      maps.markRayBaked()
    } finally {
      if (this.#cancelled) this.#releaseScratch()
    }
  }

  // -- passes ---------------------------------------------------------------

  /**
   * One batch of rays, added to the running total by the blender.
   *
   * `One`/`One` with `AddEquation` is the whole accumulation: the pass emits
   * only what its own rays found and the attachment keeps the sum. Half float
   * holds it comfortably - the increments are around 1 and the total is at most
   * the ray count, so the ratio never approaches the ten bits of mantissa.
   */
  #buildTraceMaterial(bvh: BvhTextures): NodeMaterial {
    const u = this.#uniforms
    // A traversal of its own. Sharing one across materials is what silently
    // killed every re-bake; `BvhTextures.createTracer` has the full story.
    const trace = bvh.createTracer()
    const material = new NodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.blending = CustomBlending
    material.blendEquation = AddEquation
    material.blendSrc = OneFactor
    material.blendDst = OneFactor

    // Transformed by hand rather than via `normalWorld`, which three flips for
    // back-facing fragments. In a UV-space pass "back-facing" means "wound
    // clockwise in the atlas", which says nothing about the surface - it would
    // invert the hemisphere on whichever islands happen to be mirrored.
    const N = normalize(modelNormalMatrix.mul(normalLocal)) as V3
    const P = positionWorld as V3

    material.fragmentNode = Fn(() => {
      const aoSum = float(0).toVar('aoSum')
      const thickSum = float(0).toVar('thickSum')

      const frame = orthonormalFrame(N)
      const rotation = hash(uv() as V2)
      const outwardOrigin = P.add(N.mul(u.originBias))
      const inwardOrigin = P.sub(N.mul(u.originBias))

      Loop({ start: int(0), end: u.raysPerPass, type: 'int', condition: '<' }, ({ i }) => {
        const index = float(i).add(u.passIndex.mul(u.raysPerPassScale))

        // Cosine weighted and stratified. The elevation is a stratum of the ray
        // budget so no two rays crowd the same ring, and the azimuth advances
        // by the golden angle from a per-texel offset - so neighbouring texels
        // sample different azimuths and the residual noise has no structure to
        // line up along.
        const u1 = index.add(0.5).div(u.aoRayTotal)
        const u2 = fract(index.mul(float(0.6180339887)).add(rotation))
        const local = cosineHemisphere(u1 as F, u2 as F)
        const inPlane = frame.tangent.mul(local.x).add(frame.bitangent.mul(local.y))

        const aoDir = inPlane.add(N.mul(local.z)) as V3
        const aoHit = trace(outwardOrigin, aoDir, u.originBias as F, u.aoDistance as F)
        // Attenuate by distance: a wall a hair away occludes far more than one
        // at the edge of the search radius, and a binary test bands visibly
        // wherever a surface crosses the cutoff.
        aoSum.addAssign(aoHit.x.mul(float(1).sub(aoHit.y.div(u.aoDistance)).clamp(0, 1)))

        If(index.lessThan(u.thicknessRayTotal), () => {
          // Thickness gets its own stratification rather than reusing the AO
          // ray's direction. It runs on a smaller budget, and the strata are
          // ordered - so taking the first N of the AO sequence would take the
          // first N *elevations*, every one of them hugging the normal. That
          // measures the depth straight down through the surface, not the mean
          // over the hemisphere, and a fin would read as solid as a sphere.
          const t1 = index.add(0.5).div(u.thicknessRayTotal)
          const t2 = fract(index.mul(float(0.6180339887)).add(rotation).add(float(0.5)))
          const inwardLocal = cosineHemisphere(t1 as F, t2 as F)
          // Mirrored through the surface: straight into the mesh, where the
          // first hit is the far wall. A miss means the ray left the model
          // without finding anything within the search distance, which is as
          // solid as this measurement can report.
          const inward = frame.tangent.mul(inwardLocal.x)
            .add(frame.bitangent.mul(inwardLocal.y))
            .sub(N.mul(inwardLocal.z)) as V3
          const hit = trace(inwardOrigin, inward, u.originBias as F, u.thicknessDistance as F)
          const depth = hit.x.greaterThan(float(0)).select(hit.y, u.thicknessDistance)
          thickSum.addAssign(depth.div(u.thicknessDistance).clamp(0, 1))
        })
      })

      return vec4(aoSum, thickSum, 0, 0)
    })()
    return material
  }

  /**
   * Turns the sums into the maps, and stamps coverage.
   *
   * Also a mesh raster rather than a fullscreen quad, so the alpha it writes
   * marks exactly the texels the mesh covers - the single source of truth the
   * dilation pass then floods outward from.
   */
  #buildComposeMaterial(source: RenderTarget): NodeMaterial {
    const u = this.#uniforms
    const material = new NodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    const accumulated = texture(source.texture, uv())
    const ao = float(1).sub(accumulated.x.div(max(u.aoRayTotal, float(1)))).clamp(0, 1)
    // Mean ray depth into the mesh, already normalised by the search distance:
    // 0 where rays exit immediately, 1 where nothing was found within reach.
    const thickness = accumulated.y.div(max(u.thicknessRayTotal, float(1))).clamp(0, 1)

    const raw = attribute(CURVATURE_ATTRIBUTE, 'float') as unknown as F
    const curvature = raw.mul(u.curvatureIntensity).clamp(-1, 1).mul(0.5).add(0.5)

    material.fragmentNode = vec4(ao, curvature, thickness, 1)
    return material
  }

  #zeroMaterialFor(): MeshBasicNodeMaterial {
    if (this.#zeroMaterial) return this.#zeroMaterial
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    material.fragmentNode = vec4(0, 0, 0, 0) as V4
    this.#zeroMaterial = material
    return material
  }

  // -- resources ------------------------------------------------------------

  /**
   * Builds the BVH, keyed on the geometry so a re-bake of the same mesh reuses
   * it. On a dense mesh the build is the one part of this that runs on the CPU.
   */
  #ensureBvh(geometry: BufferGeometry): BvhTextures {
    const position = geometry.getAttribute('position')
    if (!position) throw new Error('Baking needs a position attribute')
    const key = `${geometry.uuid}:${position.count}:${geometry.getIndex()?.count ?? -1}`
    if (this.#bvh && this.#bvhKey === key) return this.#bvh

    const index = geometry.getIndex()
    // Read through the accessors rather than `.array`: glTF positions are
    // routinely interleaved, and a BVH built over the raw buffer would trace a
    // different mesh than the one being rasterised.
    const positions = attributeToFloat32(position, 3)
    const indices = index
      ? Uint32Array.from(index.array as ArrayLike<number>)
      : Uint32Array.from({ length: position.count }, (_, i) => i)

    this.#bvh?.dispose()
    this.#bvh = new BvhTextures(new Bvh({ positions, indices }).packForGpu())
    this.#bvhKey = key
    this.#materialKey = ''
    return this.#bvh
  }

  #prepareMaterials(bvh: BvhTextures, accum: RenderTarget): void {
    const key = `${this.#bvhKey}:${accum.texture.id}`
    if (this.#materialKey === key && this.#traceMaterial) return
    this.#disposePassMaterials()
    // Fresh nodes for a fresh pair of materials, for the same reason the
    // traversal is rebuilt: a `uniform()` keeps the name the first material to
    // generate it handed out, and the next material lays its groups out
    // differently.
    this.#uniforms = createBakeUniforms()
    this.#traceMaterial = this.#buildTraceMaterial(bvh)
    this.#composeMaterial = this.#buildComposeMaterial(accum)
    this.#materialKey = key
  }

  /**
   * Compiles every pipeline against the target it will be used on.
   *
   * three's WebGPU backend builds pipelines lazily and silently skips the draw
   * that triggers the build. With a ping-pong accumulator that is not a missing
   * first frame but a permanently empty buffer on one side of the swap.
   */
  async #prewarm(
    renderer: Renderer,
    geometry: BufferGeometry,
    maps: MeshMaps,
    accum: RenderTarget,
  ): Promise<void> {
    await this.#compileMesh(renderer, geometry, this.#traceMaterial!, accum)
    await this.#compileMesh(renderer, geometry, this.#composeMaterial!, maps.ray)
    await this.#compileQuad(renderer, this.#zeroMaterialFor(), accum)
    await this.#compileQuad(renderer, this.#zeroMaterialFor(), maps.ray)
  }

  async #compileMesh(
    renderer: Renderer,
    geometry: BufferGeometry,
    material: NodeMaterial,
    target: RenderTarget,
  ): Promise<void> {
    // `UVSpacePass.render` forces double-sided and the pipeline is keyed on it,
    // so the compile has to see the value the draw will.
    material.side = DoubleSide
    this.#uvPass.mesh.geometry = geometry
    this.#uvPass.mesh.material = material
    await compileAgainst(renderer, this.#uvPass.scene, this.#uvPass.camera, target)
  }

  async #compileQuad(renderer: Renderer, material: MeshBasicNodeMaterial, target: RenderTarget): Promise<void> {
    this.#quad.material = material
    this.#quadScene.add(this.#quad)
    try {
      await compileAgainst(renderer, this.#quadScene, this.#quad.camera, target)
    } finally {
      this.#quadScene.remove(this.#quad)
    }
  }

  /**
   * Half float, because the accumulation is done by the blender and WebGPU only
   * blends 32-bit float attachments behind an optional feature. Nearest
   * filtered because the compose pass reads it at a raster fragment's uv rather
   * than at a texel centre, and a linear tap would pull in three neighbours.
   */
  #ensureAccum(resolution: number): RenderTarget {
    if (this.#accum && this.#accum.width === resolution) return this.#accum
    this.#accum?.dispose()
    this.#accum = new RenderTarget(resolution, resolution, {
      ...CHANNEL_TARGET_OPTIONS,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    })
    this.#accum.texture.name = 'bakeAccum'
    this.#materialKey = ''
    return this.#accum
  }

  /**
   * Frees the accumulator and the pass materials.
   *
   * *Not* called between successful bakes, though the idle VRAM is real - ~33MB
   * at 2k for a pass the user runs by hand. Releasing it made every bake build
   * a new accumulator, and a new accumulator meant new pass materials, and
   * rebuilding those is precisely the operation that emits a stale WGSL
   * function against the wrong uniform layout. Keeping them means the second
   * bake runs the pipeline the first one proved works. The rebuild path is safe
   * now too - see `#prepareMaterials` - but not exercising it on every bake is
   * worth more than the megabytes.
   */
  #releaseScratch(): void {
    this.#accum?.dispose()
    this.#accum = null
    this.#disposePassMaterials()
    this.#materialKey = ''
  }

  #disposePassMaterials(): void {
    this.#traceMaterial?.dispose()
    this.#composeMaterial?.dispose()
    this.#traceMaterial = null
    this.#composeMaterial = null
  }

  dispose(): void {
    this.#releaseScratch()
    this.#zeroMaterial?.dispose()
    this.#zeroMaterial = null
    this.#bvh?.dispose()
    this.#bvh = null
    this.#bvhKey = ''
    this.#uvPass.dispose()
  }
}

/**
 * Every uniform the two pass materials read.
 *
 * A factory rather than fields on the baker, so a material rebuild gets nodes
 * that have never been generated into a shader before. See
 * `BvhTextures.createTracer` for what reusing one costs.
 */
function createBakeUniforms() {
  return {
    aoDistance: uniform(0.5),
    thicknessDistance: uniform(1),
    originBias: uniform(1e-4),
    curvatureIntensity: uniform(1),
    aoRayTotal: uniform(64),
    thicknessRayTotal: uniform(32),
    passIndex: uniform(0),
    raysPerPass: uniform(0, 'int'),
    raysPerPassScale: uniform(0),
  }
}

// -- sampling ---------------------------------------------------------------

interface Frame {
  tangent: V3
  bitangent: V3
}

/**
 * Any orthonormal basis around `n`.
 *
 * The helper axis is whichever of z and x the normal is least aligned with, so
 * the cross product never approaches zero - at a pole of a lat/long unwrap the
 * naive choice collapses the frame and every ray leaves along the same line.
 */
function orthonormalFrame(n: V3): Frame {
  const helper = abs(n.z).lessThan(float(0.99)).select(vec3(0, 0, 1), vec3(1, 0, 0)) as V3
  const tangent = normalize(cross(helper, n)) as V3
  return { tangent, bitangent: cross(n, tangent) as V3 }
}

/**
 * A cosine-weighted direction in the +z hemisphere, from two uniforms.
 *
 * Cosine weighted rather than uniform so the mean of the hit tests *is* the
 * occlusion integral - no per-ray `dot(n, l)` factor and no weight sum to
 * divide by afterwards. That symmetry is what the old code got wrong when it
 * divided a cosine-weighted numerator by a plain ray count, which capped AO at
 * roughly mid grey however buried the texel was.
 */
function cosineHemisphere(u1: F, u2: F): V3 {
  const r = sqrt(u1)
  const phi = u2.mul(float(Math.PI * 2))
  return vec3(r.mul(cos(phi)), r.mul(sin(phi)), sqrt(max(float(0), float(1).sub(u1)))) as V3
}

/** Per-texel decorrelation offset. Cheap, and only ever used to rotate a set. */
function hash(at: V2): F {
  return fract(sin(at.dot(vec2(12.9898, 78.233))).mul(float(43758.5453))) as F
}
