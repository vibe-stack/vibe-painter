/**
 * The engine: owns every GPU resource and drives the pipeline.
 *
 * It is deliberately free of UI. It takes a renderer, a document, and calls;
 * it produces render targets and a mesh you can drop into any scene. The React
 * layer in `src/ui` is one consumer; a script, a test, or an agent driving
 * `api.ts` is another, and neither is privileged.
 *
 * Frame flow is: document mutated -> `sync()` reconciles bindings and decides
 * whether the compositor graph must be rebuilt -> `update()` re-composites if
 * anything is dirty -> the host renders its scene, whose material samples the
 * composited targets.
 */

import { Box3, Mesh, Object3D, Raycaster, Vector3 } from 'three/webgpu'
import type { BufferGeometry, Renderer, Scene } from 'three/webgpu'
import { Emitter } from './emitter'
import type { BakeSettings, LayerState, ProjectState, TextureSetState } from './doc/types'
import { DEFAULT_BAKE_SETTINGS } from './doc/types'
import { collectLayers, findLayer, getTextureSet } from './doc/document'
import { collectPaintBufferIds } from './doc/serialize'
import { Compositor } from './gpu/compositor'
import { Dilator } from './gpu/dilate'
import { GeometryBaker } from './gpu/geometrybake'
import { MeshMaps } from './gpu/meshmaps'
import { Painter } from './gpu/painter'
import type { BrushSettings, StrokeSample, StrokeTarget } from './gpu/painter'
import { DEFAULT_BRUSH } from './gpu/painter'
import { PaintBuffer } from './gpu/targets'
import { clearTarget } from './gpu/uvspace'
import { ViewportMaterials } from './gpu/viewport'
import type { ViewMode } from './gpu/viewport'
import { ProceduralEnvironment, ENVIRONMENT_PRESETS } from './gpu/environment'
import { LightRig } from './gpu/lighting'
import type { EnvironmentSettings } from './gpu/environment'
import { RayBaker } from './bake/baker'
import type { BakeProgress } from './bake/baker'
import { prepareGeometry } from './mesh/tangents'
import { ParamBag } from './procedural/params'
import { getMaterialDef, instantiateMaterial } from './procedural/material'
import type { MaterialInstance, ProjectionSettings } from './doc/types'
import { DEFAULT_PROJECTION } from './doc/types'

export interface EngineEvents {
  documentChanged: { reason: string }
  compositeUpdated: void
  bakeProgress: BakeProgress
  bakeComplete: { kind: 'geometry' | 'rays' }
  meshChanged: { triangles: number }
  error: { message: string; cause?: unknown }
}

export type PaintTargetKind = 'layer' | 'mask'

export interface SurfaceHit {
  point: [number, number, number]
  normal: [number, number, number]
  uv: [number, number] | null
  distance: number
}

export class Engine {
  readonly events = new Emitter<EngineEvents>()
  readonly root = new Object3D()
  readonly mesh = new Mesh()

  project: ProjectState

  #renderer: Renderer | null = null
  #compositor: Compositor
  #painter: Painter
  #meshMaps: MeshMaps
  #dilator = new Dilator()
  #geometryBaker = new GeometryBaker()
  #rayBaker = new RayBaker()
  #environment = new ProceduralEnvironment()
  #lights = new LightRig()
  #viewport = new ViewportMaterials()
  #paintBuffers = new Map<string, PaintBuffer>()
  #raycaster = new Raycaster()

  #brush: BrushSettings = { ...DEFAULT_BRUSH }
  #brushMaterial: MaterialInstance
  #brushParams: ParamBag
  #brushProjection: ProjectionSettings = { ...DEFAULT_PROJECTION }
  #paintTarget: PaintTargetKind = 'layer'
  #viewMode: ViewMode = 'shaded'
  #environmentSettings: EnvironmentSettings = { ...ENVIRONMENT_PRESETS.studio }
  #resolution: number
  #needsViewportRebuild = true
  #baking = false
  #showBackground = true
  #backgroundPending = true
  /**
   * WebGPU compiles pipelines asynchronously and *skips* the first draw of a
   * new shader. Env, geometry bake and the composite are one-shot, so a cold
   * start would leave every target at clear-color (black) forever. Retry with
   * the same compiled materials — rebuilding the graph each frame would skip
   * every draw again.
   */
  static readonly #WARMUP_FRAMES = 4
  #gpuWarmup = 0
  #disposed = false

  constructor(project: ProjectState, resolution = 1024) {
    this.project = project
    this.#resolution = resolution
    this.#compositor = new Compositor(resolution)
    this.#painter = new Painter(resolution)
    this.#meshMaps = new MeshMaps(resolution)
    this.#brushMaterial = instantiateMaterial('plain', { color: [0.8, 0.2, 0.2] })
    this.#brushParams = new ParamBag(getMaterialDef('plain')?.params ?? [], this.#brushMaterial.params)

    this.mesh.frustumCulled = false
    this.root.add(this.mesh)
    this.root.add(this.#lights.group)
    this.#lights.apply(this.#environmentSettings)
  }

  // -- lifecycle ----------------------------------------------------------

  get renderer(): Renderer | null {
    return this.#renderer
  }

  get resolution(): number {
    return this.#resolution
  }

  get meshMaps(): MeshMaps {
    return this.#meshMaps
  }

  get compositor(): Compositor {
    return this.#compositor
  }

  get environment(): ProceduralEnvironment {
    return this.#environment
  }

  get isBaking(): boolean {
    return this.#baking
  }

  attachRenderer(renderer: Renderer): void {
    const alreadyWarm = this.#renderer === renderer && this.#environment.built && this.#gpuWarmup === 0
    this.#renderer = renderer
    this.#environment.apply(this.#environmentSettings)
    this.#lights.apply(this.#environmentSettings)
    this.#applyBackground()
    if (alreadyWarm) return
    this.#needsViewportRebuild = true
    this.#gpuWarmup = Engine.#WARMUP_FRAMES
    this.sync('renderer attached')
  }

  /** Replaces the painted mesh. Rebakes the geometry maps immediately. */
  setGeometry(geometry: BufferGeometry): void {
    prepareGeometry(geometry)
    const previous = this.mesh.geometry
    this.mesh.geometry = geometry
    if (previous && previous !== geometry) previous.dispose()

    // The mesh sits at the origin with an identity transform; the camera moves
    // instead. That keeps world space equal to object space everywhere, which
    // the bakers and the painter both rely on.
    this.mesh.position.set(0, 0, 0)
    this.mesh.quaternion.identity()
    this.mesh.scale.set(1, 1, 1)
    this.mesh.updateMatrixWorld(true)

    if (this.#renderer) this.#bakeGeometry()
    this.#meshMaps.clearRayMaps()
    this.#compositor.invalidateGraph()
    this.#needsViewportRebuild = true

    const index = geometry.getIndex()
    const triangles = (index ? index.count : geometry.getAttribute('position').count) / 3
    this.events.emit('meshChanged', { triangles })
  }

  get geometry(): BufferGeometry | null {
    return this.mesh.geometry?.getAttribute('position') ? this.mesh.geometry : null
  }

  setResolution(resolution: number): void {
    if (resolution === this.#resolution) return
    this.#resolution = resolution
    this.#compositor.setResolution(resolution)
    this.#painter.setResolution(resolution)
    this.#meshMaps.setSize(resolution)
    for (const buffer of this.#paintBuffers.values()) buffer.setSize(resolution)
    const set = this.activeTextureSet
    if (set) set.resolution = resolution
    if (this.#renderer) this.#bakeGeometry()
    this.#needsViewportRebuild = true
    this.sync('resolution changed')
  }

  // -- document -----------------------------------------------------------

  get activeTextureSet(): TextureSetState | null {
    return getTextureSet(this.project, this.project.activeTextureSetId)
  }

  get activeLayer(): LayerState | null {
    const set = this.activeTextureSet
    if (!set || !this.project.activeLayerId) return null
    return findLayer(set.layers, this.project.activeLayerId)?.layer ?? null
  }

  /** Call after any document mutation. Cheap; safe to over-call. */
  sync(reason = 'document'): void {
    const set = this.activeTextureSet
    if (!set) return
    this.#syncPaintBuffers(set)
    this.#compositor.sync(set)
    this.events.emit('documentChanged', { reason })
  }

  #syncPaintBuffers(set: TextureSetState): void {
    const referenced = collectPaintBufferIds(set)
    const wanted = new Map(referenced.map((r) => [r.id, r.kind]))

    for (const [id, kind] of wanted) {
      const existing = this.#paintBuffers.get(id)
      if (existing && existing.kind === kind) continue
      existing?.dispose()
      const buffer = new PaintBuffer(id, kind, this.#resolution)
      this.#paintBuffers.set(id, buffer)
      if (this.#renderer) {
        clearTarget(this.#renderer, buffer.coverage.rt)
        if (buffer.slots) clearTarget(this.#renderer, buffer.slots.rt)
      }
      // A brand-new buffer starts empty, and the compositor must sample the
      // new texture object rather than the disposed one.
      this.#compositor.invalidateGraph()
    }
    for (const [id, buffer] of [...this.#paintBuffers]) {
      if (!wanted.has(id)) {
        buffer.dispose()
        this.#paintBuffers.delete(id)
        this.#compositor.invalidateGraph()
      }
    }
  }

  get paintBuffers(): ReadonlyMap<string, PaintBuffer> {
    return this.#paintBuffers
  }

  // -- per frame ----------------------------------------------------------

  /** Runs the compositor if needed and keeps the viewport material current. */
  update(): void {
    const renderer = this.#renderer
    const set = this.activeTextureSet
    if (!renderer || !set) return

    if (this.#gpuWarmup > 0) {
      const first = this.#gpuWarmup === Engine.#WARMUP_FRAMES
      this.#environment.build(renderer)
      this.#applyBackground()
      if (this.geometry) this.#bakeGeometry({ silent: !first, rebuildGraph: first })
      // Re-draw with the *same* compiled shaders. invalidateGraph() would
      // dispose the material every frame, so every retry would be another
      // skipped first draw and the targets would stay black forever.
      if (!first) this.#compositor.invalidate()
      this.#gpuWarmup--
    } else if (this.#backgroundPending) {
      this.#applyBackground()
    }

    const changed = this.#compositor.render(renderer, set, this.#meshMaps, this.#paintBuffers)

    if (this.#needsViewportRebuild) {
      this.#viewport.build(this.#compositor.output, this.#meshMaps)
      this.#viewport.setMode(this.#viewMode)
      this.#needsViewportRebuild = false
      this.#applyViewMode()
    }

    if (changed) this.events.emit('compositeUpdated', undefined)
  }

  setViewMode(mode: ViewMode): void {
    this.#viewMode = mode
    this.#viewport.setMode(mode)
    this.#applyViewMode()
  }

  get viewMode(): ViewMode {
    return this.#viewMode
  }

  #applyViewMode(): void {
    if (!this.#viewport.built) return
    this.mesh.material = this.#viewMode === 'shaded' ? this.#viewport.shaded : this.#viewport.debug
  }

  setHeightScale(value: number): void {
    this.#viewport.setHeightScale(value)
  }

  setNormalScale(value: number): void {
    this.#viewport.setNormalScale(value)
  }

  // -- environment --------------------------------------------------------

  /** Whether the generated sky is drawn behind the model. */
  get showBackground(): boolean {
    return this.#showBackground
  }

  setShowBackground(value: boolean): void {
    this.#showBackground = value
    this.#applyBackground()
  }

  /**
   * Applied lazily: the engine is given a renderer before its root is parented
   * into a scene, so there is nothing to set the background on at that point.
   */
  #applyBackground(): void {
    const scene = this.root.parent as Scene | null
    if (!scene?.isScene) {
      this.#backgroundPending = true
      return
    }
    this.#backgroundPending = false
    scene.background = this.#showBackground && this.#environment.built ? this.#environment.texture : null
    // IBL is a scene property, not a background one: the sky can be hidden
    // without turning the model black.
    scene.environment = this.#environment.built ? this.#environment.envMap : null
    scene.environmentIntensity = this.#environmentSettings.intensity
  }

  get environmentSettings(): EnvironmentSettings {
    return { ...this.#environmentSettings }
  }

  setEnvironment(settings: Partial<EnvironmentSettings>): void {
    this.#environmentSettings = { ...this.#environmentSettings, ...settings }
    this.#environment.apply(this.#environmentSettings)
    this.#lights.apply(this.#environmentSettings)
    if (this.#renderer) {
      this.#environment.build(this.#renderer)
      // PMREM output is bound by reference, so the material graph only needs a
      // rebuild the first time an environment appears.
      if (!this.#viewport.built) this.#needsViewportRebuild = true
      this.#applyBackground()
    }
  }

  // -- baking -------------------------------------------------------------

  #bakeGeometry(options: { silent?: boolean; rebuildGraph?: boolean } = {}): void {
    const renderer = this.#renderer
    const geometry = this.geometry
    if (!renderer || !geometry) return
    this.#geometryBaker.bake(renderer, geometry, this.#meshMaps)
    // Without dilation the gutter is empty, and bilinear filtering pulls it
    // into every island edge as a dark rim.
    this.#dilator.dilateGeometry(renderer, this.#meshMaps, 16)
    if (options.rebuildGraph === false) this.#compositor.invalidate()
    else this.#compositor.invalidateGraph()
    if (options.rebuildGraph !== false) this.#needsViewportRebuild = true
    if (!options.silent) this.events.emit('bakeComplete', { kind: 'geometry' })
  }

  async bakeMeshMaps(settings: Partial<BakeSettings> = {}): Promise<void> {
    const geometry = this.geometry
    const set = this.activeTextureSet
    if (!geometry || !set) throw new Error('Nothing to bake: load a mesh first')
    if (this.#baking) throw new Error('A bake is already running')

    const merged: BakeSettings = { ...DEFAULT_BAKE_SETTINGS, ...(set.meshMaps?.settings ?? {}), ...settings }
    this.#baking = true
    try {
      const maps = await this.#rayBaker.bake(geometry, merged, (progress) => {
        this.events.emit('bakeProgress', progress)
      })
      this.#meshMaps.setRayMaps(maps)
      set.meshMaps = {
        resolution: merged.resolution,
        available: ['ao', 'curvature', 'thickness'],
        settings: merged,
        bakedAt: Date.now(),
      }
      // A new DataTexture means the graphs referencing the old one are stale.
      this.#compositor.invalidateGraph()
      this.#needsViewportRebuild = true
      this.events.emit('bakeComplete', { kind: 'rays' })
      this.sync('bake')
    } finally {
      this.#baking = false
    }
  }

  cancelBake(): void {
    this.#rayBaker.cancel()
    this.#baking = false
  }

  // -- painting -----------------------------------------------------------

  get brush(): BrushSettings {
    return { ...this.#brush }
  }

  setBrush(patch: Partial<BrushSettings>): void {
    this.#brush = { ...this.#brush, ...patch }
  }

  get brushMaterial(): MaterialInstance {
    return { defId: this.#brushMaterial.defId, params: { ...this.#brushMaterial.params } }
  }

  setBrushMaterial(defId: string, params: Record<string, number | boolean | [number, number, number]> = {}): void {
    if (defId !== this.#brushMaterial.defId) {
      this.#brushMaterial = instantiateMaterial(defId, params)
      this.#brushParams = new ParamBag(getMaterialDef(defId)?.params ?? [], this.#brushMaterial.params)
      return
    }
    for (const [key, value] of Object.entries(params)) {
      this.#brushMaterial.params[key] = value
      this.#brushParams.set(key, value)
    }
  }

  get paintTarget(): PaintTargetKind {
    return this.#paintTarget
  }

  setPaintTarget(kind: PaintTargetKind): void {
    this.#paintTarget = kind
  }

  get isStroking(): boolean {
    return this.#painter.isStroking
  }

  /**
   * Resolves what a stroke should write into, creating the buffer if the
   * document implies one but has not allocated it yet.
   */
  #resolveStrokeTarget(): StrokeTarget | null {
    const layer = this.activeLayer
    if (!layer) return null

    if (this.#paintTarget === 'mask') {
      if (!layer.mask) return null
      if (!layer.mask.paintBufferId) return null
      const buffer = this.#paintBuffers.get(layer.mask.paintBufferId)
      return buffer ? { buffer, kind: 'mask' } : null
    }

    if (layer.kind !== 'paint') return null
    const buffer = this.#paintBuffers.get(layer.paintBufferId)
    return buffer ? { buffer, kind: 'material' } : null
  }

  beginStroke(sample: StrokeSample): boolean {
    const renderer = this.#renderer
    const geometry = this.geometry
    const target = this.#resolveStrokeTarget()
    if (!renderer || !geometry || !target) return false

    this.#painter.begin(renderer, target, this.#brush, {
      defId: this.#brushMaterial.defId,
      params: this.#brushMaterial.params,
      projection: this.#brushProjection,
    }, this.#brushParams)
    this.#painter.move(renderer, geometry, this.#meshMaps, sample)
    this.#compositeNow()
    return true
  }

  strokeTo(sample: StrokeSample): void {
    const renderer = this.#renderer
    const geometry = this.geometry
    if (!renderer || !geometry || !this.#painter.isStroking) return
    this.#painter.move(renderer, geometry, this.#meshMaps, sample)
    this.#compositeNow()
  }

  endStroke(): void {
    const renderer = this.#renderer
    if (!renderer) return
    const painted = this.#painter.end(renderer, this.#dilator, 8)
    if (painted) {
      this.#compositeNow()
      this.events.emit('documentChanged', { reason: 'stroke' })
    }
  }

  /** Flatten the stack immediately so a stroke is visible without waiting for the next frame. */
  #compositeNow(): void {
    const renderer = this.#renderer
    const set = this.activeTextureSet
    if (!renderer || !set) return
    this.#compositor.invalidate()
    this.#compositor.render(renderer, set, this.#meshMaps, this.#paintBuffers)
  }

  get brushProjection(): ProjectionSettings {
    return { ...this.#brushProjection }
  }

  setBrushProjection(patch: Partial<ProjectionSettings>): void {
    this.#brushProjection = { ...this.#brushProjection, ...patch }
  }

  // -- picking ------------------------------------------------------------

  /**
   * Raycasts the painted mesh. Provided so the API can be driven without any
   * particular UI framework's pointer events.
   */
  raycast(origin: [number, number, number], direction: [number, number, number]): SurfaceHit | null {
    const geometry = this.geometry
    if (!geometry) return null
    this.mesh.updateMatrixWorld(true)
    this.#raycaster.set(new Vector3(...origin), new Vector3(...direction).normalize())
    const hits = this.#raycaster.intersectObject(this.mesh, false)
    const hit = hits[0]
    if (!hit) return null
    const normal = new Vector3()
    if (hit.normal) {
      // `hit.normal` is interpolated in object space.
      normal.copy(hit.normal).transformDirection(this.mesh.matrixWorld).normalize()
    } else if (hit.face) {
      normal.copy(hit.face.normal).transformDirection(this.mesh.matrixWorld).normalize()
    } else {
      normal.set(0, 0, 1)
    }
    return {
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [normal.x, normal.y, normal.z],
      uv: hit.uv ? [hit.uv.x, hit.uv.y] : null,
      distance: hit.distance,
    }
  }

  /** Bounding box of the current mesh, for framing the camera. */
  bounds(): { min: [number, number, number]; max: [number, number, number]; radius: number } {
    const box = new Box3()
    const geometry = this.geometry
    if (geometry) {
      if (!geometry.boundingBox) geometry.computeBoundingBox()
      box.copy(geometry.boundingBox!)
    } else {
      box.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
    }
    const size = new Vector3()
    box.getSize(size)
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      radius: size.length() * 0.5,
    }
  }

  layerCount(): number {
    const set = this.activeTextureSet
    return set ? collectLayers(set.layers).length : 0
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#compositor.dispose()
    this.#painter.dispose()
    this.#dilator.dispose()
    this.#geometryBaker.dispose()
    this.#meshMaps.dispose()
    this.#environment.dispose()
    this.#lights.dispose()
    this.#viewport.dispose()
    for (const buffer of this.#paintBuffers.values()) buffer.dispose()
    this.#paintBuffers.clear()
    this.#rayBaker.cancel()
    this.events.clear()
  }
}
