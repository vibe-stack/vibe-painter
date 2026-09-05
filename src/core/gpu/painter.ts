/**
 * Painting.
 *
 * Painting is not "drawing on the mesh". The mesh is a projection surface; the
 * pixels live in UV space. A stroke works like this:
 *
 *  1. The geometry bake has already put a world position, normal and tangent
 *     frame in every texel (see `meshmaps.ts`), so a fullscreen pass over the
 *     texture knows where in 3D each of its texels sits.
 *  2. Each fragment asks whether it falls inside any of the brush stamps in
 *     this batch - a 3D distance test, plus a normal-facing test so the back
 *     of a thin wall is not painted through.
 *  3. Coverage accumulates with a MAX blend, so overlapping stamps inside one
 *     stroke never double-darken the way plain alpha-over would.
 *  4. The stroke is composited against a snapshot taken at stroke start, not
 *     against the previous frame. That is what makes a slow, low-flow stroke
 *     build up smoothly instead of banding at every pointer event.
 *  5. On stroke end the result is dilated past UV island borders.
 *
 * Every pass here reads and writes at the same uv, with no flips anywhere -
 * see `sampling.ts` for why that is the only convention that can be right.
 */

import {
  CustomBlending,
  MaxEquation,
  MeshBasicNodeMaterial,
  NoBlending,
  OneFactor,
  QuadMesh,
  Scene,
  Vector2,
  Vector3,
} from 'three/webgpu'
import type { BufferGeometry, Renderer, Texture } from 'three/webgpu'
import {
  Fn,
  If,
  Loop,
  dFdx,
  dFdy,
  dot,
  int,
  float,
  length,
  max,
  min,
  mix,
  mrt,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { SLOT_COUNT, SLOT_NAMES } from '../channels'
import type { ProjectionSettings } from '../doc/types'
import { getMaterialDef } from '../procedural/material'
import { buildProjected } from '../procedural/projection'
import { ParamBag } from '../procedural/params'
import { fbm01, voronoi2 } from '../procedural/noise'
import type { MeshMaps } from './meshmaps'
import type { F, V2, V4 } from './nodes'
import { packBundle, unpackSlots } from './packing'
import { CoverageTarget, SlotTargets } from './targets'
import type { PaintBuffer } from './targets'
import { vec4ArrayUniform } from './bindings'
import { measure, measureAsync } from './profile'
import { clearTarget, compileAgainst, renderQuad } from './uvspace'
import { Blitter } from './blit'
import type { Dilator } from './dilate'

/** Stamps evaluated per draw. Longer batches are split across draws. */
const MAX_STAMPS = 64

/**
 * Ceiling on the stamps one pointer segment may lay down.
 *
 * Spacing is a fraction of the radius, so a fine brush dragged fast asks for an
 * unbounded number of stamps: at a radius of 0.002 with 5% spacing, a pointer
 * that moved half a unit between frames wants five thousand of them, which is
 * eighty draws in a single frame. The stroke then runs further behind the
 * cursor with every frame and fine painting becomes unusable exactly where it
 * matters. Past this count the segment's spacing is widened to fit; the visible
 * result is a slightly sparser dash on a very fast flick, which is what every
 * other painting application does too.
 */
const MAX_STAMPS_PER_SEGMENT = 256

export const BRUSH_ALPHAS = ['round', 'square', 'speckle', 'splatter', 'streaks'] as const
export type BrushAlpha = (typeof BRUSH_ALPHAS)[number]

export interface BrushSettings {
  /** Radius in world units. */
  radius: number
  /** 0 = fully soft falloff, 1 = hard edge. */
  hardness: number
  /** Per-stamp deposition, before the stroke's own opacity. */
  flow: number
  /** Stroke opacity applied once, at commit time. */
  opacity: number
  /** Stamp spacing as a fraction of the radius. */
  spacing: number
  /** How much pen pressure scales the stamp radius. 0 = fixed size. */
  pressureSize: number
  /** How much pen pressure scales per-stamp deposition. */
  pressureFlow: number
  alpha: BrushAlpha
  /** Scale of the procedural alpha pattern, relative to the brush footprint. */
  alphaScale: number
  alphaContrast: number
  /**
   * How far a surface may face away from the stroke's own normal before it
   * stops receiving paint. 1 = only surfaces facing exactly the same way.
   */
  facing: number
  erase: boolean
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 0.08,
  // Hard by default. The falloff is antialiased against the texel size now
  // (see `#stampMaterialFor`), so a hard edge reads as a clean edge rather
  // than a staircase - and a soft default is what made every stroke look
  // airbrushed no matter how small the brush was.
  hardness: 0.85,
  flow: 1,
  opacity: 1,
  spacing: 0.08,
  pressureSize: 1,
  pressureFlow: 0.5,
  alpha: 'round',
  alphaScale: 1,
  alphaContrast: 0.5,
  facing: 0.5,
  erase: false,
}

/** One point of contact between the brush and the surface. */
export interface StrokeSample {
  point: [number, number, number]
  normal: [number, number, number]
  /** 0..1 pen pressure; mouse input should pass 1. */
  pressure?: number
}

export interface StrokeTarget {
  buffer: PaintBuffer
  /** A material stroke writes channel values; a mask stroke writes coverage only. */
  kind: 'material' | 'mask'
}

interface BrushMaterialSpec {
  defId: string
  params: Record<string, number | boolean | [number, number, number]>
  projection: ProjectionSettings
}

export class Painter {
  #quad = new QuadMesh()

  #stroke: CoverageTarget
  #baselineSlots: SlotTargets
  #baselineCoverage: CoverageTarget

  // Stamp batch uniforms.
  #stampPos = vec4ArrayUniform(MAX_STAMPS)
  #stampNrm = vec4ArrayUniform(MAX_STAMPS)
  #stampCount = uniform(0, 'int')
  #hardness = uniform(0.5)
  #flow = uniform(1)
  #facing = uniform(0.15)
  #alphaScale = uniform(1)
  #alphaContrast = uniform(0.5)

  // Commit uniforms.
  #strokeOpacity = uniform(1)
  #eraseMode = uniform(0)

  /**
   * The brush material, evaluated once and held as pixels for the stroke.
   *
   * This is the difference between painting at 60fps and painting at 4. The
   * commit pass runs once per pointer sample, and it used to *evaluate the
   * brush's procedural material* every time - a full triplanar rock or brick
   * graph, over every texel of a 1024x1024 target, a hundred times per stroke.
   * Nothing about that evaluation changes while the pointer is down: the
   * parameters are fixed, the projection is fixed, the mesh maps are fixed, and
   * the material is a pure function of UV. It was the same picture, recomputed
   * from scratch, for every dab.
   *
   * So it is computed once at stroke start and read back as a texture. The
   * commit pass becomes four texture reads and a lerp, which is the same work
   * a plain colour brush was already doing - the cost of a brush no longer has
   * anything to do with how expensive its material is.
   *
   * The second win is that the commit *shader* no longer contains the material
   * at all. One commit pipeline now serves every material in the catalogue, so
   * switching brush material costs no recompile.
   */
  #brushSource: SlotTargets | null = null
  #brushSourceMaterials = new Map<string, MeshBasicNodeMaterial>()
  /**
   * Brush source pipelines already compiled, keyed by `#sourceKey`.
   *
   * Separate from `#warmed`, which is keyed by the whole stroke setup - target
   * buffer, geometry and alpha included. A stroke only needs to know whether
   * *this material's* pass is ready, and asking the wider set that question
   * always answered no.
   */
  #warmedSources = new Set<string>()
  /**
   * Projection as uniforms rather than constants folded into the graph, so
   * dragging a tiling slider re-renders the source instead of recompiling it.
   */
  #projScale = uniform(new Vector2(1, 1))
  #projOffset = uniform(new Vector2(0, 0))
  #projRotation = uniform(0)
  #projSharpness = uniform(4)

  /**
   * One stamp pipeline per brush alpha, not one pipeline with the alpha on a
   * uniform. Selecting between the five shapes with uniform weights meant
   * every stamp evaluated *all* of them - a voronoi lattice plus three fbm
   * stacks - for every texel of a 1024x1024 target, even for a plain round
   * brush that needs none of it. That was ~1.3ms of GPU time per stamp, and a
   * single dragged stroke lays down a hundred stamps. Recompiling when
   * somebody picks a different brush shape is the cheaper trade by orders of
   * magnitude.
   */
  #stampMaterials = new Map<BrushAlpha, MeshBasicNodeMaterial>()
  /**
   * Identity of the mesh maps the cached materials were built against.
   *
   * The graphs bind specific texture objects, and `MeshMaps.nodes()` hands back
   * neutral constants until the geometry bake has run. A material built during
   * that window keeps a world position of (0,0,0) forever, so every brush test
   * fails and nothing is ever painted - silently. Rebuilding when the maps
   * change is what keeps the cache honest.
   */
  #mapsKey = ''
  #commitMaterials = new Map<string, MeshBasicNodeMaterial>()
  /** Pipelines already compiled, keyed by brush source key plus geometry. */
  #warmed = new Set<string>()
  /**
   * Warm-ups run one at a time, chained onto this.
   *
   * Every one of them borrows `#quad` to hand a material to `compileAsync`,
   * and `sync()` asks for a warm-up on every document edit - so without a queue
   * a burst of edits would run several at once, each reassigning the quad's
   * material out from under the others' awaits.
   */
  #warmQueue: Promise<void> = Promise.resolve()
  #warming = new Set<string>()
  /** Resolution the lazy targets are (or will be) allocated at. */
  #resolution: number
  /** Host scene used only to hand the commit quad to `compileAsync`. */
  #quadScene = new Scene()
  #blitter = new Blitter()

  #active: {
    target: StrokeTarget
    brush: BrushSettings
    spec: BrushMaterialSpec
    params: ParamBag
    lastPoint: Vector3 | null
    /** Distance carried over between pointer events, so spacing is continuous. */
    carry: number
    pending: StrokeSample[]
    painted: boolean
    /**
     * How many more times to re-render the brush source.
     *
     * Normally one draw at stroke start is enough. But WebGPU skips the first
     * draw of a pipeline it has not finished compiling, and a skipped draw here
     * would leave the source holding whatever was in that memory - the whole
     * stroke would paint garbage, silently. When the pipeline was not prewarmed
     * we simply draw it again on the next few samples, which costs a handful of
     * evaluations instead of one per sample.
     */
    sourceDraws: number
  } | null = null

  constructor(resolution: number) {
    this.#stroke = new CoverageTarget(resolution, 'strokeCoverage')
    this.#baselineSlots = new SlotTargets(resolution, 'strokeBaseline')
    this.#baselineCoverage = new CoverageTarget(resolution, 'strokeBaselineCoverage')
    this.#resolution = resolution
  }

  /**
   * The brush-source target, allocated on first use.
   *
   * Four RGBA16F attachments is 128MB at 2K, and a session that only ever
   * paints masks never reads a single texel of it.
   */
  #sourceTarget(): SlotTargets {
    if (!this.#brushSource) this.#brushSource = new SlotTargets(this.#resolution, 'brushSource')
    return this.#brushSource
  }

  get isStroking(): boolean {
    return this.#active !== null
  }

  setResolution(resolution: number): void {
    this.#stroke.setSize(resolution)
    this.#baselineSlots.setSize(resolution)
    this.#baselineCoverage.setSize(resolution)
    this.#resolution = resolution
    this.#brushSource?.setSize(resolution)
  }

  /**
   * Starts a stroke. Snapshots the target so the stroke can be recomposited
   * from scratch on every batch rather than accumulated destructively.
   */
  begin(
    renderer: Renderer,
    maps: MeshMaps,
    target: StrokeTarget,
    brush: BrushSettings,
    spec: BrushMaterialSpec,
    params: ParamBag,
  ): void {
    this.end(renderer, null)

    clearTarget(renderer, this.#stroke.rt)
    // Snapshot the layer as it stands. Every commit during this stroke
    // recomposites from here rather than from the previous commit, which is
    // what stops a slow stroke from building up darker than a fast one.
    this.#blitter.blit(renderer, [target.buffer.coverage.texture], this.#baselineCoverage.rt, ['coverage'])
    if (target.buffer.slots) {
      this.#blitter.blit(
        renderer,
        Array.from({ length: SLOT_COUNT }, (_, i) => target.buffer.slots!.texture(i)),
        this.#baselineSlots.rt,
        SLOT_NAMES,
      )
    }

    this.#hardness.value = brush.hardness
    this.#flow.value = brush.flow
    this.#facing.value = brush.facing
    this.#alphaScale.value = brush.alphaScale
    this.#alphaContrast.value = brush.alphaContrast
    this.#strokeOpacity.value = brush.opacity
    this.#eraseMode.value = brush.erase ? 1 : 0
    this.#applyProjection(spec.projection)

    const sourceKey = this.#sourceKey(spec)
    this.#active = {
      target,
      brush,
      spec,
      params,
      lastPoint: null,
      carry: 0,
      pending: [],
      painted: false,
      sourceDraws: this.#warmedSources.has(sourceKey) ? 1 : 3,
    }

    // Freeze the brush material into pixels for the life of the stroke.
    if (target.kind === 'material') this.#renderBrushSource(renderer, spec, params, maps)
  }

  /** Uploads the projection controls the brush source graph reads. */
  #applyProjection(projection: ProjectionSettings): void {
    this.#projScale.value.set(projection.scale[0], projection.scale[1])
    this.#projOffset.value.set(projection.offset[0], projection.offset[1])
    this.#projRotation.value = projection.rotation
    this.#projSharpness.value = projection.blendSharpness
  }

  /** Evaluates the brush material across UV space into `#brushSource`. */
  #renderBrushSource(
    renderer: Renderer,
    spec: BrushMaterialSpec,
    params: ParamBag,
    maps: MeshMaps,
  ): void {
    const material = this.#brushSourceMaterial(spec, params, maps)
    if (!material) return
    measure('brush source draw', () => renderQuad(renderer, this.#quad, material, this.#sourceTarget().rt))
  }

  /**
   * The graph that evaluates the brush material. Structural inputs only - the
   * material id and projection mode - so the cache survives every slider.
   */
  #brushSourceMaterial(
    spec: BrushMaterialSpec,
    params: ParamBag,
    maps: MeshMaps,
  ): MeshBasicNodeMaterial | null {
    this.#syncMapsKey(maps)
    const key = this.#sourceKey(spec)
    const cached = this.#brushSourceMaterials.get(key)
    if (cached) return cached

    const def = getMaterialDef(spec.defId)
    if (!def) return null

    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    const uvNode = uv()
    const bundle = buildProjected({
      def,
      params,
      mode: spec.projection.mode,
      axis: spec.projection.axis === 'x' ? 0 : spec.projection.axis === 'y' ? 1 : 2,
      nodes: {
        scale: this.#projScale as unknown as V2,
        offset: this.#projOffset as unknown as V2,
        rotation: this.#projRotation as unknown as F,
        sharpness: this.#projSharpness as unknown as F,
      },
      maps: maps.nodes(uvNode),
      uv: uvNode,
    })
    material.fragmentNode = mrt(packBundle(bundle))

    this.#brushSourceMaterials.set(key, material)
    return material
  }

  #sourceKey(spec: BrushMaterialSpec): string {
    return `${spec.defId}:${spec.projection.mode}:${spec.projection.axis}`
  }

  /**
   * Compiles the stamp and commit pipelines before any stroke needs them.
   *
   * WebGPU builds pipelines asynchronously and three *skips* a draw whose
   * pipeline is not ready yet. A stroke is a synchronous burst of draws, so
   * building these lazily on first use meant the entire first stroke - often
   * several - was silently discarded. That is the "I have to scrub over it a
   * dozen times before anything appears" symptom, and no amount of extra
   * drawing fixes it because every attempt races the same compile.
   *
   * Compiling is done with the real render targets bound, because the pipeline
   * depends on the attachment formats: warming against the canvas would
   * compile a different pipeline than the one the stroke actually uses.
   */
  async prewarm(
    renderer: Renderer,
    geometry: BufferGeometry,
    maps: MeshMaps,
    target: StrokeTarget,
    spec: BrushMaterialSpec,
    params: ParamBag,
    alpha: BrushAlpha,
  ): Promise<void> {
    this.#syncMapsKey(maps)
    // Nothing to compile against until the geometry maps exist; the engine
    // calls this again once they do.
    if (!maps.geometryBaked) return
    const sourceKey = this.#sourceKey(spec)
    const key = `${sourceKey}|${target.kind}|${target.buffer.id}|${geometry.id}|${alpha}`
    if (this.#warmed.has(key) || this.#warming.has(key)) return
    this.#warming.add(key)

    const run = this.#warmQueue.then(() =>
      measureAsync('brush prewarm', () => this.#warm(renderer, maps, target, spec, params, alpha, key)),
    )
    // The queue must survive a failed warm-up, or every later one is skipped.
    this.#warmQueue = run.catch(() => {})
    return run
  }

  async #warm(
    renderer: Renderer,
    maps: MeshMaps,
    target: StrokeTarget,
    spec: BrushMaterialSpec,
    params: ParamBag,
    alpha: BrushAlpha,
    key: string,
  ): Promise<void> {
    try {
      this.#quadScene.add(this.#quad)
      this.#quad.material = this.#stampMaterialFor(maps, alpha)
      await compileAgainst(renderer, this.#quadScene, this.#quad.camera, this.#stroke.rt)

      if (target.buffer.slots) {
        // The expensive one: this is the graph that holds the whole procedural
        // material. Compiling it here is what keeps it off the stroke.
        const source = this.#brushSourceMaterial(spec, params, maps)
        if (source) {
          this.#quad.material = source
          await compileAgainst(renderer, this.#quadScene, this.#quad.camera, this.#sourceTarget().rt)
          this.#warmedSources.add(this.#sourceKey(spec))
        }

        this.#quad.material = this.#commitMaterial(target)
        await compileAgainst(renderer, this.#quadScene, this.#quad.camera, target.buffer.slots.rt)
      }

      this.#quad.material = this.#coverageCommitMaterial()
      await compileAgainst(renderer, this.#quadScene, this.#quad.camera, target.buffer.coverage.rt)

      // The baseline snapshot is a pass like any other and can be skipped while
      // its pipeline compiles - which would silently lose the existing paint.
      await this.#blitter.prewarm(renderer, [target.buffer.coverage.texture], this.#baselineCoverage.rt, ['coverage'])
      if (target.buffer.slots) {
        await this.#blitter.prewarm(
          renderer,
          Array.from({ length: SLOT_COUNT }, (_, i) => target.buffer.slots!.texture(i)),
          this.#baselineSlots.rt,
          SLOT_NAMES,
        )
      }
      // Recorded only on success. A failed or superseded warm-up must not
      // convince the next stroke that its pipelines are ready.
      this.#warmed.add(key)
    } finally {
      this.#warming.delete(key)
      this.#quadScene.remove(this.#quad)
    }
  }

  /**
   * Feeds a pointer sample. Stamps are interpolated along the path at the
   * brush's spacing, so stroke density does not depend on how fast the pointer
   * moved or how often the browser sampled it.
   */
  move(renderer: Renderer, maps: MeshMaps, sample: StrokeSample): void {
    const active = this.#active
    if (!active) return

    const point = new Vector3(...sample.point)
    const spacing = Math.max(1e-5, active.brush.spacing * active.brush.radius)

    if (!active.lastPoint) {
      active.pending.push(sample)
      active.lastPoint = point
      active.carry = 0
    } else {
      const from = active.lastPoint
      const distance = from.distanceTo(point)
      if (distance > 0) {
        // Widen the spacing rather than emit thousands of stamps for one flick.
        const step = Math.max(spacing, distance / MAX_STAMPS_PER_SEGMENT)
        // The carry was measured against the *previous* segment's step, which
        // may have been wider; it cannot push the first stamp behind the start.
        let travelled = step - Math.min(active.carry, step)
        while (travelled <= distance) {
          const t = travelled / distance
          active.pending.push({
            point: [
              from.x + (point.x - from.x) * t,
              from.y + (point.y - from.y) * t,
              from.z + (point.z - from.z) * t,
            ],
            normal: sample.normal,
            pressure: sample.pressure,
          })
          travelled += step
        }
        active.carry = distance - (travelled - step)
        active.lastPoint = point
      }
    }

    if (active.pending.length === 0) return
    this.#flush(renderer, maps)
  }

  /** Ends the stroke, dilates the result, and reports whether anything changed. */
  end(renderer: Renderer, dilator: Dilator | null, dilation = 4, islandMask: Texture | null = null): boolean {
    const active = this.#active
    if (!active) return false
    this.#active = null
    if (!active.painted) return false
    if (dilator) dilator.dilatePaint(renderer, active.target.buffer, dilation, islandMask)
    return true
  }

  #flush(renderer: Renderer, maps: MeshMaps): void {
    const active = this.#active
    if (!active) return

    for (let offset = 0; offset < active.pending.length; offset += MAX_STAMPS) {
      const batch = active.pending.slice(offset, offset + MAX_STAMPS)
      for (let i = 0; i < batch.length; i++) {
        const s = batch[i]
        const posValue = this.#stampPos.array[i]
        const nrmValue = this.#stampNrm.array[i]
        // Pressure drives size and flow independently, each with its own
        // amount, so a tablet can taper a stroke without also fading it out.
        const pressure = clamp01(s.pressure ?? 1)
        const sized = active.brush.radius * lerp(1, pressure, active.brush.pressureSize)
        posValue.set(s.point[0], s.point[1], s.point[2], Math.max(1e-5, sized))
        const n = normaliseVector(s.normal)
        nrmValue.set(n[0], n[1], n[2], lerp(1, pressure, active.brush.pressureFlow))
      }
      this.#stampCount.value = batch.length
      measure('brush stamp draw', () =>
        renderQuad(renderer, this.#quad, this.#stampMaterialFor(maps, active.brush.alpha), this.#stroke.rt),
      )
    }
    active.pending.length = 0
    active.painted = true
    this.#commit(renderer, maps)
  }

  /**
   * The stamp pass.
   *
   * This used to rasterise the mesh into UV space to get a world position per
   * texel. It does not need to: the geometry bake already stores exactly that,
   * verified against the mesh, in `geomPosition`. Reading it turns the stamp
   * into a plain fullscreen pass - no vertex stage, no varyings, no dependence
   * on how a `vertexNode`-overridden material interpolates - and the texel a
   * fragment writes is by construction the texel whose position it tested.
   *
   * It is also faster: one quad instead of every triangle of the mesh, per
   * stamp batch.
   */
  #stampMaterialFor(maps: MeshMaps, alpha: BrushAlpha): MeshBasicNodeMaterial {
    this.#syncMapsKey(maps)
    const cached = this.#stampMaterials.get(alpha)
    if (cached) return cached
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.transparent = true
    // MAX rather than additive: two stamps overlapping inside one stroke should
    // give the stronger of the two, not their sum.
    material.blending = CustomBlending
    material.blendEquation = MaxEquation
    material.blendSrc = OneFactor
    material.blendDst = OneFactor

    const uvNode = uv()
    const surface = maps.nodes(uvNode)

    // How much world space one texel spans, here.
    //
    // This pass runs one fragment per texel, so a screen-space derivative of
    // the surface position *is* the world size of a texel - and that is the
    // width below which a falloff cannot be resolved. Clamping the ramp to it
    // is what lets hardness go to 1 and give a clean edge instead of a
    // staircase: the last texel of the stamp gets a partial value.
    //
    // Measured on the coarse position rather than the precise one, which is
    // discontinuous at island borders by construction (it falls back to coarse
    // in the gutter) and would report an enormous derivative there. Built out
    // here rather than inside the `Fn`, alongside every other derivative in
    // this codebase: WGSL requires them in uniform control flow.
    const texelWorld = max(length(dFdx(surface.worldPosition)), length(dFdy(surface.worldPosition)))

    const coverageFn = Fn(() => {
      // Sample the mesh maps once, into locals, *before* any control flow.
      // WGSL requires texture sampling to happen in uniform control flow, and
      // these are loop-invariant anyway - reading them inside the `If` is both
      // undefined behaviour and pure waste.
      //
      // The *precise* position, not the coarse one. This pass is 1:1 over the
      // texture set, which is the condition that reconstruction needs, and the
      // coarse map quantises position to about a texel at 2K - which is to say
      // the brush could not resolve anything finer than a texel no matter how
      // small it was set. See `MeshMaps.nodes()`.
      const surfacePosition = surface.worldPositionPrecise.toVar('brushSurfacePos')
      const surfaceNormal = surface.normal.toVar('brushSurfaceNormal')
      const surfaceTangent = surface.tangent.toVar('brushSurfaceTangent')
      const surfaceBitangent = surface.bitangent.toVar('brushSurfaceBitangent')
      const surfaceCoverage = surface.coverage.toVar('brushSurfaceCoverage')

      const coverage = float(0).toVar('brushCoverage')
      // The loop runs to the batch's actual stamp count, not to `MAX_STAMPS`
      // with a test inside. Same result, without paying for the empty slots.
      Loop({ start: int(0), end: this.#stampCount, type: 'int' }, ({ i }) => {
        const stamp = this.#stampPos.element(i)
        const aux = this.#stampNrm.element(i)
        const centre = stamp.xyz
        const radius = max(stamp.w, float(1e-5))
        const delta = surfacePosition.sub(centre)
        const distance = length(delta)

        // Radial falloff. Hardness narrows the ramp; the texel width sets the
        // floor, so the hardest brush still lands antialiased rather than
        // aliased. Forward edges only: WGSL leaves smoothstep indeterminate
        // when low >= high, which silently broke the whole brush falloff.
        const softness = max(
          max(
            radius.mul(this.#hardness.oneMinus().clamp(0, 1)),
            min(texelWorld.mul(0.8), radius.mul(0.5)),
          ),
          // A degenerate derivative (a fully collapsed chart) would otherwise
          // leave low == high, which WGSL leaves indeterminate.
          radius.mul(1e-3),
        )
        const inner = radius.sub(softness).max(float(0))
        const radial = smoothstep(inner, radius, distance).oneMinus()

        // Almost every texel is outside almost every stamp, so reject on the
        // cheap radial test before evaluating a shaped alpha's noise.
        If(radial.greaterThan(float(0)), () => {
          // Local frame so shaped alphas orient with the surface, not the world.
          const local = vec2(dot(delta, surfaceTangent), dot(delta, surfaceBitangent)).div(radius)
          const shaped = this.#alphaShape(local, radial, alpha)

          // Reject surfaces facing away from the stroke: this is what stops a
          // brush from bleeding through to the far side of a thin object.
          const facing = smoothstep(
            this.#facing.mul(2).sub(1),
            this.#facing.mul(2).sub(1).add(0.25),
            dot(surfaceNormal, aux.xyz),
          )

          const value = shaped.mul(facing).mul(this.#flow).mul(aux.w)
          coverage.assign(max(coverage, value.clamp(0, 1)))
        })
      })
      // Texels outside every UV island have no real surface behind them.
      return coverage.mul(surfaceCoverage.clamp(0, 1))
    })

    const coverage = coverageFn()
    material.fragmentNode = vec4(coverage, coverage, coverage, coverage)
    this.#stampMaterials.set(alpha, material)
    return material
  }

  /**
   * Procedural stamp alphas. No bitmap brushes anywhere in this app.
   *
   * `alpha` is a plain string, not a node: only the shape actually selected is
   * built into the graph. See `#stampMaterials`.
   */
  #alphaShape(local: V2, radial: F, alpha: BrushAlpha): F {
    const scale = max(this.#alphaScale, float(0.01))
    const contrast = this.#alphaContrast

    switch (alpha) {
      case 'square':
        return smoothstep(this.#hardness.clamp(0, 0.99), float(1), max(local.x.abs(), local.y.abs())).oneMinus()
      case 'speckle': {
        const field = voronoi2(local.mul(scale.mul(6)), float(1)).x
        return radial.mul(smoothstep(contrast.mul(0.6), contrast.mul(0.6).add(0.25), field))
      }
      case 'splatter': {
        const field = fbm01(vec3(local.mul(scale.mul(4)), 0), 4, 2.1, 0.55)
        return radial.mul(smoothstep(contrast, contrast.add(0.15), field))
      }
      case 'streaks': {
        const field = fbm01(vec3(local.x.mul(scale.mul(30)), local.y.mul(scale.mul(1.5)), 0), 3, 2, 0.5)
        return radial.mul(smoothstep(contrast.mul(0.8), contrast.mul(0.8).add(0.2), field))
      }
      default:
        return radial
    }
  }

  /**
   * Recomposites the whole stroke against the snapshot. Cheap (one fullscreen
   * pass) and idempotent, which is what lets flow accumulate correctly.
   */
  #commit(renderer: Renderer, maps: MeshMaps): void {
    const active = this.#active
    if (!active) return

    if (active.target.kind === 'material' && active.target.buffer.slots) {
      // Re-draw the source only while we are unsure the first draw landed.
      if (active.sourceDraws > 1) {
        active.sourceDraws--
        this.#renderBrushSource(renderer, active.spec, active.params, maps)
      }
      measure('brush commit draw', () =>
        renderQuad(renderer, this.#quad, this.#commitMaterial(active.target), active.target.buffer.slots!.rt),
      )
    }
    measure('brush coverage draw', () =>
      renderQuad(renderer, this.#quad, this.#coverageCommitMaterial(), active.target.buffer.coverage.rt),
    )
  }

  /** Drops every cached graph if the mesh maps it was built against changed. */
  #syncMapsKey(maps: MeshMaps): void {
    const key = `${maps.geometryBaked ? 1 : 0}:${maps.rayBaked ? 1 : 0}:${maps.geometry.textures.map((t) => t.id).join(',')}`
    if (key === this.#mapsKey) return
    this.#mapsKey = key
    for (const material of this.#stampMaterials.values()) material.dispose()
    this.#stampMaterials.clear()
    for (const material of this.#brushSourceMaterials.values()) material.dispose()
    this.#brushSourceMaterials.clear()
    // The commit graph reads only render targets, so it survives a map change.
    this.#warmed.clear()
    this.#warmedSources.clear()
  }

  /**
   * Composites the stroke into the layer.
   *
   * There is exactly one of these. It reads the brush material as a texture
   * rather than evaluating it, so nothing about this graph depends on which
   * material the brush carries or how it is projected - picking a different
   * material mid-session costs no recompile, and the pass costs the same
   * whether the brush is a flat colour or a triplanar rock.
   */
  #commitMaterial(target: StrokeTarget): MeshBasicNodeMaterial {
    const key = `commit:${target.kind}`
    const cached = this.#commitMaterials.get(key)
    if (cached) return cached

    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    const uvNode = uv()
    const strokeCoverage = texture(this.#stroke.texture, uvNode).x.mul(this.#strokeOpacity).clamp(0, 1)
    const baseCoverage = texture(this.#baselineCoverage.texture, uvNode).x

    const baseBundle = unpackSlots(this.#baselineSlots.rt.textures, uvNode)
    const source = unpackSlots(this.#sourceTarget().rt.textures, uvNode)

    // Standard "source over destination", un-premultiplied at the end so the
    // stored channel values stay meaningful where coverage is partial.
    const erase = this.#eraseMode
    const paintCoverage = strokeCoverage.mul(float(1).sub(erase))
    const outCoverage = paintCoverage.add(baseCoverage.mul(float(1).sub(paintCoverage)))
    const packedSource = packBundle(source)
    const packedBase = packBundle(baseBundle)

    const outputs: Record<string, V4> = {}
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const name = SLOT_NAMES[slot]
      const s = packedSource[name]
      const b = packedBase[name]
      const numerator = s.mul(paintCoverage).add(b.mul(baseCoverage).mul(float(1).sub(paintCoverage)))
      outputs[name] = numerator.div(max(outCoverage, float(1e-4)))
    }
    material.fragmentNode = mrt(outputs)

    this.#commitMaterials.set(key, material)
    return material
  }

  #coverageCommitMaterial(): MeshBasicNodeMaterial {
    const key = 'coverage'
    const cached = this.#commitMaterials.get(key)
    if (cached) return cached
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const uvNode = uv()
    const stroke = texture(this.#stroke.texture, uvNode).x.mul(this.#strokeOpacity).clamp(0, 1)
    const base = texture(this.#baselineCoverage.texture, uvNode).x
    const erase = this.#eraseMode
    // Erasing removes coverage; painting adds it. One expression, no branch.
    const erased = base.mul(float(1).sub(stroke))
    const painted = stroke.add(base.mul(float(1).sub(stroke)))
    const result = mix(painted, erased, erase).clamp(0, 1)
    material.fragmentNode = vec4(result, result, result, result)
    this.#commitMaterials.set(key, material)
    return material
  }

  dispose(): void {
    this.#blitter.dispose()
    this.#stroke.dispose()
    this.#baselineSlots.dispose()
    this.#baselineCoverage.dispose()
    this.#brushSource?.dispose()
    for (const material of this.#stampMaterials.values()) material.dispose()
    this.#stampMaterials.clear()
    for (const material of this.#commitMaterials.values()) material.dispose()
    this.#commitMaterials.clear()
    for (const material of this.#brushSourceMaterials.values()) material.dispose()
    this.#brushSourceMaterials.clear()
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, amount))
}

function normaliseVector(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 1e-6 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1]
}
