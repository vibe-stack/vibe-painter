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
import { initialisePaintBuffer } from './gpu/clear'
import { clearTarget } from './gpu/uvspace'
import { measure } from './gpu/profile'
import { ViewportMaterials } from './gpu/viewport'
import type { ViewMode } from './gpu/viewport'
import { IdWireframe } from './gpu/idoverlay'
import { BrushCursor } from './gpu/cursor'
import { partIdAtFace, readMeshParts } from './mesh/parts'
import { ProceduralEnvironment, ENVIRONMENT_PRESETS } from './gpu/environment'
import { LightRig } from './gpu/lighting'
import type { EnvironmentSettings } from './gpu/environment'
import type { BakeProgress } from './bake/baker'
import { GpuMeshMapBaker } from './gpu/meshmapbake'
import { prepareGeometry } from './mesh/tangents'
import { ParamBag } from './procedural/params'
import { getMaterialDef, instantiateMaterial } from './procedural/material'
import type { MaterialInstance, ProjectionSettings } from './doc/types'
import { DEFAULT_PROJECTION } from './doc/types'

export interface EngineEvents {
  /**
   * Any observable state change at all - document, brush, view mode, lighting.
   * This is what the React binding watches; `documentChanged` and the rest stay
   * for consumers that care about one specific kind of change.
   */
  changed: { reason: string }
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
  faceIndex: number | null
  /** Source-mesh part under this hit, or null when the mesh is unpartitioned. */
  partId: number | null
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
  #meshMapBaker = new GpuMeshMapBaker()
  #environment = new ProceduralEnvironment()
  #lights = new LightRig()
  #cursor = new BrushCursor()
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
  #version = 0
  #heightScale = 1
  #normalScale = 1
  #needsViewportRebuild = true
  #baking = false
  #showBackground = true
  #backgroundPending = true
  #idOverlayActive = false
  #idHoverPartId: number | null = null
  #materialDragId: string | null = null
  #idWireframe = new IdWireframe()
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
    this.root.add(this.#idWireframe.object)
    this.root.add(this.#lights.group)
    this.root.add(this.#cursor.object)
    this.#cursor.setBrush(this.#brush.radius, this.#brush.hardness, this.#brush.erase)
    this.#lights.apply(this.#environmentSettings)
  }

  /**
   * Monotonic counter bumped by every observable state change.
   *
   * The core is deliberately imperative - it owns GPU resources whose lifetime
   * cannot follow a render cycle - so React needs one thing to watch. This is
   * it: `useSyncExternalStore` reads this number and the `changed` event tells
   * it when to look again. The rule for anything added later is simply that a
   * setter which alters observable state must call `#notify`, or the UI will
   * silently show stale values.
   */
  get version(): number {
    return this.#version
  }

  #notify(reason: string): void {
    this.#version++
    this.events.emit('changed', { reason })
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
    this.#idWireframe.rebuild(geometry)
    this.#idWireframe.object.matrix.copy(this.mesh.matrixWorld)

    if (this.#renderer) this.#bakeGeometry()
    this.#meshMaps.clearRayMaps()
    // The ray map texture the live graph samples has just been disposed, so
    // this rebuild cannot wait for a deferred compile.
    this.#compositor.invalidateGraph({ immediate: true })
    this.#needsViewportRebuild = true

    // The brush radius is in world units, so a default that suits one model
    // is invisible or enormous on another. Scale it to the mesh on load.
    this.#brush.radius = Math.max(0.005, this.bounds().radius * 0.1)
    this.#cursor.setBrush(this.#brush.radius, this.#brush.hardness, this.#brush.erase)

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
    for (const buffer of this.#paintBuffers.values()) {
      buffer.setSize(resolution)
      if (this.#renderer) initialisePaintBuffer(this.#renderer, buffer)
    }
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
    this.prewarmPainting()
    this.#notify(reason)
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
      this.#compositor.invalidateGraph({ immediate: true })
    }
    for (const [id, buffer] of [...this.#paintBuffers]) {
      if (!wanted.has(id)) {
        buffer.dispose()
        this.#paintBuffers.delete(id)
        this.#compositor.invalidateGraph({ immediate: true })
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
      measure('viewport material rebuild', () => {
        this.#viewport.build(this.#compositor.output, this.#meshMaps)
        this.#viewport.setMode(this.#viewMode)
      })
      this.#needsViewportRebuild = false
      this.#applyViewMode()
    }

    if (changed) this.events.emit('compositeUpdated', undefined)
  }

  setViewMode(mode: ViewMode): void {
    this.#viewMode = mode
    this.#viewport.setMode(mode)
    this.#applyViewMode()
    this.#notify('viewMode')
  }

  get viewMode(): ViewMode {
    return this.#viewMode
  }

  #applyViewMode(): void {
    const showIds = this.#idOverlayActive || this.#viewMode === 'mesh-id'
    this.#idWireframe.setVisible(showIds)
    if (showIds) {
      this.mesh.material = this.#viewport.idOverlay
      return
    }
    if (!this.#viewport.built) return
    this.mesh.material = this.#viewMode === 'shaded' ? this.#viewport.shaded : this.#viewport.debug
  }

  get idOverlayActive(): boolean {
    return this.#idOverlayActive
  }

  get idHoverPartId(): number | null {
    return this.#idHoverPartId
  }

  get materialDragId(): string | null {
    return this.#materialDragId
  }

  setIdOverlay(active: boolean, materialId: string | null = null): void {
    this.#idOverlayActive = active
    this.#materialDragId = active ? materialId : null
    if (!active) {
      this.#idHoverPartId = null
      this.#viewport.setIdHover(null)
    }
    this.#applyViewMode()
    this.#notify('idOverlay')
  }

  setIdHover(partId: number | null): void {
    if (this.#idHoverPartId === partId) return
    this.#idHoverPartId = partId
    this.#viewport.setIdHover(partId)
    this.#notify('idHover')
  }

  listMeshParts() {
    return readMeshParts(this.geometry)
  }

  get heightScale(): number {
    return this.#heightScale
  }

  setHeightScale(value: number): void {
    this.#heightScale = value
    this.#viewport.setHeightScale(value)
    this.#notify('heightScale')
  }

  get normalScale(): number {
    return this.#normalScale
  }

  setNormalScale(value: number): void {
    this.#normalScale = value
    this.#viewport.setNormalScale(value)
    this.#notify('normalScale')
  }

  // -- environment --------------------------------------------------------

  /** Whether the generated sky is drawn behind the model. */
  get showBackground(): boolean {
    return this.#showBackground
  }

  setShowBackground(value: boolean): void {
    this.#showBackground = value
    this.#applyBackground()
    this.#notify('showBackground')
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
    this.#notify('environment')
  }

  // -- baking -------------------------------------------------------------

  #bakeGeometry(options: { silent?: boolean; rebuildGraph?: boolean } = {}): void {
    const renderer = this.#renderer
    const geometry = this.geometry
    if (!renderer || !geometry) return
    measure('geometry bake', () => this.#geometryBaker.bake(renderer, geometry, this.#meshMaps))
    // Without dilation the gutter is empty, and bilinear filtering pulls it
    // into every island edge as a dark rim.
    measure('geometry dilation', () => this.#dilator.dilateGeometry(renderer, this.#meshMaps, 16))
    // Nearest-neighbour flood of part IDs into the gutter. Averaging would
    // invent IDs that match nothing; skipping it leaves a 1-texel hole on
    // every UV island border that bilinear filtering turns into a stepped seam.
    measure('id dilation', () => this.#dilator.dilateId(renderer, this.#meshMaps, 4))
    if (options.rebuildGraph === false) this.#compositor.invalidate()
    else this.#compositor.invalidateGraph()
    // The brush graphs read these maps, so they have to be rebuilt too.
    this.prewarmPainting()
    if (options.rebuildGraph !== false) this.#needsViewportRebuild = true
    if (!options.silent) this.events.emit('bakeComplete', { kind: 'geometry' })
  }

  async bakeMeshMaps(settings: Partial<BakeSettings> = {}): Promise<void> {
    const renderer = this.#renderer
    const geometry = this.geometry
    const set = this.activeTextureSet
    if (!renderer) throw new Error('Bake needs a renderer; call attachRenderer first')
    if (!geometry || !set) throw new Error('Nothing to bake: load a mesh first')
    if (this.#baking) throw new Error('A bake is already running')

    const merged: BakeSettings = { ...DEFAULT_BAKE_SETTINGS, ...(set.meshMaps?.settings ?? {}), ...settings }
    this.#baking = true
    try {
      if (!this.#meshMaps.geometryBaked) this.#bakeGeometry({ silent: true })
      // Take the ray maps out of the live graph for the duration. The bake
      // renders into them across many frames, and a viewport that goes on
      // sampling a target it is being written into is at best reading torn
      // intermediate state. Generators fall back to neutral values while this
      // runs, and the rebuild below puts the finished maps back.
      this.#meshMaps.clearRayMaps()
      this.#compositor.invalidateGraph({ immediate: true })
      await this.#meshMapBaker.bake(renderer, geometry, this.#meshMaps, merged, (progress) => {
        this.events.emit('bakeProgress', progress)
      })
      this.#dilator.dilateRay(renderer, this.#meshMaps, merged.dilation)
      this.events.emit('bakeProgress', { fraction: 1, message: 'Done' })
      set.meshMaps = {
        resolution: this.#meshMaps.resolution,
        available: ['ao', 'curvature', 'thickness'],
        settings: merged,
        bakedAt: Date.now(),
      }
      this.#compositor.invalidateGraph({ immediate: true })
      this.#needsViewportRebuild = true
      this.events.emit('bakeComplete', { kind: 'rays' })
      this.sync('bake')
    } finally {
      this.#baking = false
    }
  }

  cancelBake(): void {
    this.#meshMapBaker.cancel()
    this.#baking = false
  }

  // -- painting -----------------------------------------------------------

  get brush(): BrushSettings {
    return { ...this.#brush }
  }

  setBrush(patch: Partial<BrushSettings>): void {
    const previousAlpha = this.#brush.alpha
    this.#brush = { ...this.#brush, ...patch }
    this.#cursor.setBrush(this.#brush.radius, this.#brush.hardness, this.#brush.erase)
    // Each brush shape is its own stamp pipeline, so a new one has to be
    // compiled before the stroke that needs it rather than during it.
    if (this.#brush.alpha !== previousAlpha) this.prewarmPainting()
    this.#notify('brush')
  }

  /**
   * Moves the on-surface brush ring. Pass `null` when the pointer leaves the
   * mesh, or when a tool other than the brush is active.
   */
  setBrushCursor(hit: { point: [number, number, number]; normal: [number, number, number] } | null): void {
    if (hit) this.#cursor.setHit(hit.point, hit.normal)
    else this.#cursor.hide()
  }

  get brushMaterial(): MaterialInstance {
    return { defId: this.#brushMaterial.defId, params: { ...this.#brushMaterial.params } }
  }

  setBrushMaterial(defId: string, params: Record<string, number | boolean | [number, number, number]> = {}): void {
    if (defId !== this.#brushMaterial.defId) {
      this.#brushMaterial = instantiateMaterial(defId, params)
      this.#brushParams = new ParamBag(getMaterialDef(defId)?.params ?? [], this.#brushMaterial.params)
    } else {
      for (const [key, value] of Object.entries(params)) {
        this.#brushMaterial.params[key] = value
        this.#brushParams.set(key, value)
      }
    }
    this.prewarmPainting()
    this.#notify('brushMaterial')
  }

  get paintTarget(): PaintTargetKind {
    return this.#paintTarget
  }

  setPaintTarget(kind: PaintTargetKind): void {
    this.#paintTarget = kind
    this.prewarmPainting()
    this.#notify('paintTarget')
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

  /**
   * Compiles the paint pipelines for whatever the current target is, so the
   * first stroke is not lost to an in-flight shader compile. Safe and cheap to
   * call repeatedly - the painter remembers what it has already compiled.
   */
  prewarmPainting(): void {
    const renderer = this.#renderer
    const geometry = this.geometry
    const target = this.#resolveStrokeTarget()
    if (!renderer || !geometry || !target) return
    void this.#painter
      .prewarm(renderer, geometry, this.#meshMaps, target, {
        defId: this.#brushMaterial.defId,
        params: this.#brushMaterial.params,
        projection: this.#brushProjection,
      }, this.#brushParams, this.#brush.alpha)
      .catch((cause) => this.events.emit('error', { message: 'Could not prepare the brush', cause }))
  }

  beginStroke(sample: StrokeSample): boolean {
    const renderer = this.#renderer
    const geometry = this.geometry
    const target = this.#resolveStrokeTarget()
    if (!renderer || !geometry || !target) return false

    // Freeze everything under the layer being painted for the stroke's
    // duration, so each pointer sample does not re-evaluate the whole
    // procedural stack. See `Compositor#below`.
    if (this.activeLayer && !(globalThis as unknown as { __nosplit?: boolean }).__nosplit) this.#compositor.splitBelow(this.activeLayer.id)
    this.#painter.begin(renderer, this.#meshMaps, target, this.#brush, {
      defId: this.#brushMaterial.defId,
      params: this.#brushMaterial.params,
      projection: this.#brushProjection,
    }, this.#brushParams)
    this.#painter.move(renderer, this.#meshMaps, sample)
    this.#compositeNow()
    return true
  }

  strokeTo(sample: StrokeSample): void {
    const renderer = this.#renderer
    const geometry = this.geometry
    if (!renderer || !geometry || !this.#painter.isStroking) return
    this.#painter.move(renderer, this.#meshMaps, sample)
    this.#compositeNow()
  }

  /** TEMP DEBUG */
  async debugProbe(): Promise<unknown> {
    const renderer = this.#renderer
    const buffer = [...this.#paintBuffers.values()][0]
    if (!renderer || !buffer) return { error: 'no buffer' }
    const res = buffer.resolution
    const half = (h: number): number => {
      const sg = (h & 0x8000) ? -1 : 1
      const e = (h >> 10) & 0x1f
      const f = h & 0x3ff
      if (e === 0) return sg * Math.pow(2, -14) * (f / 1024)
      if (e === 31) return f ? NaN : sg * Infinity
      return sg * Math.pow(2, e - 15) * (1 + f / 1024)
    }
    const toF = (raw: ArrayLike<number>): Float32Array => {
      if (raw instanceof Float32Array) return raw
      const out = new Float32Array(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = half(raw[i])
      return out
    }
    const cov = toF(await renderer.readRenderTargetPixelsAsync(buffer.coverage.rt, 0, 0, res, res, 0) as unknown as ArrayLike<number>)
    const paint = toF(await renderer.readRenderTargetPixelsAsync(buffer.slots!.rt, 0, 0, res, res, 0) as unknown as ArrayLike<number>)
    const out = this.#compositor.output
    const comp = toF(await renderer.readRenderTargetPixelsAsync(out.rt, 0, 0, out.resolution, out.resolution, 0) as unknown as ArrayLike<number>)
    let maxCov = 0, argmax = 0
    for (let i = 0; i < res * res; i++) if (cov[i] > maxCov) { maxCov = cov[i]; argmax = i }
    const at = (i: number) => ({
      coverage: +cov[i].toFixed(4),
      paint: [paint[i * 4], paint[i * 4 + 1], paint[i * 4 + 2]].map((v) => +v.toFixed(4)),
      composite: [comp[i * 4], comp[i * 4 + 1], comp[i * 4 + 2]].map((v) => +v.toFixed(4)),
    })
    const bins = new Array(11).fill(0)
    for (let i = 0; i < res * res; i++) {
      const c = cov[i]
      if (c > 0.0005) bins[Math.min(10, Math.round(c * 10))]++
    }
    // 32x32 downsample of coverage, as digits, so the shape is visible in a log.
    const N = 32, cell = res / N
    const grid: string[] = []
    for (let gy = 0; gy < N; gy++) {
      let line = ''
      for (let gx = 0; gx < N; gx++) {
        let sum = 0
        for (let y = 0; y < cell; y += 4) for (let x = 0; x < cell; x += 4) {
          sum += cov[(gy * cell + y) * res + (gx * cell + x)]
        }
        const avg = sum / ((cell / 4) * (cell / 4))
        line += avg < 0.005 ? '.' : String(Math.min(9, Math.round(avg * 9)))
      }
      grid.push(line)
    }
    const out2 = this.#compositor.output
    let checksum = 0
    for (let sl = 0; sl < 4; sl++) {
      const d = toF(await renderer.readRenderTargetPixelsAsync(out2.rt, 0, 0, out2.resolution, out2.resolution, sl) as unknown as ArrayLike<number>)
      for (let i = 0; i < d.length; i += 97) checksum = (checksum + Math.round(d[i] * 4096)) % 2147483647
    }
    return { maxCov: +maxCov.toFixed(4), atMax: at(argmax), bins, grid, checksum }
  }

  /** TEMP DEBUG */
  async debugReclear(): Promise<unknown> {
    const renderer = this.#renderer
    const buffer = [...this.#paintBuffers.values()][0]
    if (!renderer || !buffer) return { error: 'no buffer' }
    clearTarget(renderer, buffer.coverage.rt)
    const res = buffer.resolution
    const raw = await renderer.readRenderTargetPixelsAsync(buffer.coverage.rt, 0, 0, res, res, 0) as unknown as ArrayLike<number>
    const half = (h: number): number => {
      const e = (h >> 10) & 0x1f, f = h & 0x3ff
      if (e === 0) return Math.pow(2, -14) * (f / 1024)
      if (e === 31) return NaN
      return Math.pow(2, e - 15) * (1 + f / 1024)
    }
    let mx = 0
    for (let i = 0; i < res * res; i++) { const v = raw instanceof Float32Array ? raw[i] : half(raw[i]); if (v > mx) mx = v }
    return { maxAfterReclear: +mx.toFixed(4) }
  }

  endStroke(): void {
    const renderer = this.#renderer
    if (!renderer) return
    const painted = this.#painter.end(renderer, this.#dilator, 4, this.#meshMaps.islandMask.texture)
    if (painted) {
      this.#compositeNow()
      this.events.emit('documentChanged', { reason: 'stroke' })
      this.#notify('stroke')
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
    this.#notify('brushProjection')
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
    const faceIndex = hit.faceIndex ?? null
    return {
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [normal.x, normal.y, normal.z],
      uv: hit.uv ? [hit.uv.x, hit.uv.y] : null,
      distance: hit.distance,
      faceIndex,
      partId: partIdAtFace(geometry, faceIndex),
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
    this.#meshMapBaker.dispose()
    this.#meshMaps.dispose()
    this.#environment.dispose()
    this.#lights.dispose()
    this.#cursor.dispose()
    this.#idWireframe.dispose()
    this.#viewport.dispose()
    for (const buffer of this.#paintBuffers.values()) buffer.dispose()
    this.#paintBuffers.clear()
    this.events.clear()
  }
}
