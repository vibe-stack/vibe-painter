/**
 * The headless API.
 *
 * This is the whole application, minus pixels on screen. Every capability the
 * UI has is reachable from here as a plain method with plain arguments, and
 * `describe()` returns a machine-readable schema of everything that can be
 * set - materials and their parameters, generators, blend modes, channels,
 * export presets. An agent can therefore discover what this app can do and
 * drive it without reading a line of the UI.
 *
 * Two rules hold everywhere below:
 *  - Methods mutate the document and then call `engine.sync()`. Nothing else
 *    needs to be coordinated.
 *  - Anything that needs a GPU says so, and fails with a clear message rather
 *    than silently doing nothing.
 */

import type { BufferGeometry, Renderer } from 'three/webgpu'
import { Engine } from './engine'
import type { EngineEvents, PaintTargetKind, SurfaceHit } from './engine'
import type { Unsubscribe } from './emitter'
import { CHANNELS, CHANNEL_INFO } from './channels'
import type { Channel } from './channels'
import type {
  BakeSettings,
  BlendMode,
  ChannelSettings,
  FillLayerState,
  FolderLayerState,
  GeneratorState,
  GeneratorType,
  LayerState,
  Levels,
  MaskState,
  ParamValue,
  ProjectState,
  ProjectionSettings,
} from './doc/types'
import { BLEND_MODES, DEFAULT_BAKE_SETTINGS, DEFAULT_LEVELS, GENERATOR_TYPES, PROJECTIONS } from './doc/types'
import {
  createFillLayer,
  createFolder,
  createGenerator,
  createMask,
  createMesh,
  createPaintLayer,
  createProject,
  createTextureSet,
  duplicateLayer,
  findLayer,
  insertLayer,
  moveLayer,
  removeLayer,
} from './doc/document'
import { uid } from './ids'
import {
  collectPaintBufferIds,
  deserializeProject,
  deserializeSmartMaterial,
  instantiateSmartMaterial,
  serializeProject,
  serializeSmartMaterial,
} from './doc/serialize'
import type { ProjectFile, SmartMaterialFile } from './doc/serialize'
import { PRIMITIVES, buildPrimitive } from './mesh/primitives'
import { loadGltfGeometry } from './mesh/gltf'
import type { ImportedGltf } from './mesh/gltf'
import { BUILT_IN_MATERIALS, DEFAULT_MATERIAL_ID } from './procedural/catalogue'
import { describeCatalogue, getMaterialDef, instantiateMaterial, listMaterialDefs } from './procedural/material'
import { defaultGeneratorParams, describeGenerators, getGeneratorDef, listGeneratorDefs } from './procedural/generators'
import { BRUSH_ALPHAS } from './gpu/painter'
import type { BrushSettings, StrokeSample } from './gpu/painter'
import { VIEW_MODES } from './gpu/viewport'
import type { ViewMode } from './gpu/viewport'
import { ENVIRONMENT_PRESETS } from './gpu/environment'
import type { EnvironmentSettings } from './gpu/environment'
import { EXPORT_PRESETS, exportMaps, getExportPreset } from './gpu/exporter'
import type { ExportedMap } from './gpu/exporter'
import type { BakeProgress } from './bake/baker'

// Importing the catalogue module is what registers the built-in materials.
void BUILT_IN_MATERIALS

export interface CreateOptions {
  name?: string
  resolution?: number
  /** Built-in primitive to start with. Pass `null` to start with no mesh. */
  primitive?: string | null
}

export interface LayerSummary {
  id: string
  name: string
  kind: LayerState['kind']
  visible: boolean
  opacity: number
  depth: number
  parentId: string | null
  hasMask: boolean
  materialId: string | null
  generatorCount: number
}

export class VibePainter {
  readonly engine: Engine

  private constructor(engine: Engine) {
    this.engine = engine
  }

  /**
   * Builds a project with one texture set, one mesh and a base fill layer.
   * Works without a GPU; call `attachRenderer` to enable rendering, painting,
   * geometry baking and export.
   */
  static create(options: CreateOptions = {}): VibePainter {
    const resolution = options.resolution ?? 1024
    const project = createProject(options.name ?? 'Untitled')
    const engine = new Engine(project, resolution)
    const api = new VibePainter(engine)

    const primitive = options.primitive === undefined ? 'torus-knot' : options.primitive
    if (primitive) {
      api.setMesh(primitive)
    } else {
      const mesh = createMesh({ kind: 'primitive', preset: 'none' }, 'Empty', 0, false)
      project.meshes.push(mesh)
      const set = createTextureSet(mesh.id, 'Texture Set', resolution)
      project.textureSets.push(set)
      project.activeTextureSetId = set.id
    }

    api.addFillLayer({ materialId: DEFAULT_MATERIAL_ID, name: 'Base' })
    engine.sync('created')
    return api
  }

  // -- lifecycle ----------------------------------------------------------

  attachRenderer(renderer: Renderer): void {
    this.engine.attachRenderer(renderer)
  }

  on<K extends keyof EngineEvents>(event: K, handler: (payload: EngineEvents[K]) => void): Unsubscribe {
    return this.engine.events.on(event, handler)
  }

  dispose(): void {
    this.engine.dispose()
  }

  get project(): ProjectState {
    return this.engine.project
  }

  // -- discovery ----------------------------------------------------------

  /**
   * Everything this build can do, as data. Intended to be handed straight to
   * an agent as the tool schema for the app.
   */
  describe() {
    return {
      channels: CHANNELS.map((id) => ({
        id,
        label: CHANNEL_INFO[id].label,
        components: CHANNEL_INFO[id].components,
        kind: CHANNEL_INFO[id].kind,
        default: CHANNEL_INFO[id].defaultValue,
      })),
      blendModes: [...BLEND_MODES],
      projections: [...PROJECTIONS],
      layerKinds: ['fill', 'paint', 'folder'],
      materials: describeCatalogue(),
      generators: describeGenerators(),
      brushAlphas: [...BRUSH_ALPHAS],
      viewModes: [...VIEW_MODES],
      primitives: PRIMITIVES.map((p) => ({ id: p.id, name: p.name, description: p.description })),
      meshImport: {
        formats: ['.glb', '.gltf'],
        method: 'importGltf',
        notes: 'Replaces the current mesh. Scene graphs are flattened, centred and scaled to match the built-in primitives. Materials, animations and cameras are ignored.',
      },
      environmentPresets: Object.keys(ENVIRONMENT_PRESETS),
      exportPresets: EXPORT_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        maps: p.maps.map((m) => ({ suffix: m.suffix, label: m.label })),
      })),
      bakeDefaults: DEFAULT_BAKE_SETTINGS,
    }
  }

  // -- mesh ---------------------------------------------------------------

  listPrimitives() {
    return PRIMITIVES.map((p) => ({ id: p.id, name: p.name, description: p.description }))
  }

  setMesh(primitiveId: string): void {
    const geometry = buildPrimitive(primitiveId)
    this.#installMesh(geometry, primitiveId, { kind: 'primitive', preset: primitiveId })
  }

  /**
   * Replaces the painted mesh with the contents of a glTF / GLB file.
   *
   * Every triangle mesh in the file is merged into one geometry; skins are
   * posed, instances are expanded, and the result is centred and scaled so
   * the camera and brush still make sense. Materials and animations are
   * ignored - this is a painter, not a scene viewer.
   */
  async importGltf(source: File | Blob | ArrayBuffer, fileName?: string): Promise<ImportedGltf> {
    const imported = await loadGltfGeometry(source, fileName)
    this.#installMesh(imported.geometry, imported.name, { kind: 'imported', fileName: imported.fileName })
    return imported
  }

  /** Uses an externally loaded geometry. It must have UVs. */
  loadGeometry(geometry: BufferGeometry, name = 'Imported'): void {
    this.#installMesh(geometry, name, { kind: 'imported', fileName: name })
  }

  #installMesh(geometry: BufferGeometry, name: string, source: { kind: 'primitive'; preset: string } | { kind: 'imported'; fileName: string }): void {
    this.engine.setGeometry(geometry)
    const index = geometry.getIndex()
    const triangles = Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3)
    const mesh = createMesh(source, name, triangles, true)

    const project = this.engine.project
    project.meshes = [mesh]
    const existing = this.engine.activeTextureSet
    if (existing) {
      existing.meshId = mesh.id
      // Mesh maps describe the old geometry and are now meaningless.
      existing.meshMaps = null
    } else {
      const set = createTextureSet(mesh.id, 'Texture Set', this.engine.resolution)
      project.textureSets.push(set)
      project.activeTextureSetId = set.id
    }
    this.engine.sync('mesh')
  }

  // -- texture set --------------------------------------------------------

  getResolution(): number {
    return this.engine.resolution
  }

  setResolution(resolution: number): void {
    const clamped = Math.max(64, Math.min(4096, roundToPowerOfTwo(resolution)))
    this.engine.setResolution(clamped)
  }

  // -- layers -------------------------------------------------------------

  listLayers(): LayerSummary[] {
    const set = this.engine.activeTextureSet
    if (!set) return []
    const out: LayerSummary[] = []
    const walk = (layers: LayerState[], depth: number, parentId: string | null) => {
      // Reported top-first, which is how a layer panel reads; index 0 in the
      // document is the *bottom* of the stack.
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i]
        out.push({
          id: layer.id,
          name: layer.name,
          kind: layer.kind,
          visible: layer.visible,
          opacity: layer.opacity,
          depth,
          parentId,
          hasMask: layer.mask !== null,
          materialId: layer.kind === 'fill' ? layer.material.defId : null,
          generatorCount: layer.mask?.generators.length ?? 0,
        })
        if (layer.kind === 'folder') walk(layer.children, depth + 1, layer.id)
      }
    }
    walk(set.layers, 0, null)
    return out
  }

  getLayer(id: string): LayerState | null {
    const set = this.engine.activeTextureSet
    if (!set) return null
    return findLayer(set.layers, id)?.layer ?? null
  }

  addFillLayer(options: { materialId?: string; name?: string; parentId?: string | null; index?: number; params?: Record<string, ParamValue> } = {}): string {
    const set = this.#requireSet()
    const defId = options.materialId ?? DEFAULT_MATERIAL_ID
    if (!getMaterialDef(defId)) throw new Error(`Unknown material "${defId}"`)
    const def = getMaterialDef(defId)!
    const layer = createFillLayer(instantiateMaterial(defId, options.params ?? {}), options.name ?? def.name)
    insertLayer(set, layer, options.parentId ?? null, options.index)
    this.engine.project.activeLayerId = layer.id
    this.engine.sync('addFillLayer')
    return layer.id
  }

  addPaintLayer(options: { name?: string; parentId?: string | null; index?: number } = {}): string {
    const set = this.#requireSet()
    const layer = createPaintLayer(options.name ?? 'Paint')
    insertLayer(set, layer, options.parentId ?? null, options.index)
    this.engine.project.activeLayerId = layer.id
    this.engine.setPaintTarget('layer')
    this.engine.sync('addPaintLayer')
    return layer.id
  }

  addFolder(options: { name?: string; parentId?: string | null; index?: number } = {}): string {
    const set = this.#requireSet()
    const layer = createFolder(options.name ?? 'Folder')
    insertLayer(set, layer, options.parentId ?? null, options.index)
    this.engine.project.activeLayerId = layer.id
    this.engine.sync('addFolder')
    return layer.id
  }

  removeLayer(id: string): boolean {
    const set = this.#requireSet()
    const removed = removeLayer(set, id)
    if (!removed) return false
    if (this.engine.project.activeLayerId === id) {
      this.engine.project.activeLayerId = set.layers.at(-1)?.id ?? null
    }
    this.engine.sync('removeLayer')
    return true
  }

  duplicateLayer(id: string): string | null {
    const set = this.#requireSet()
    const location = findLayer(set.layers, id)
    if (!location) return null
    const copy = duplicateLayer(location.layer)
    location.siblings.splice(location.index + 1, 0, copy)
    this.engine.project.activeLayerId = copy.id
    this.engine.sync('duplicateLayer')
    return copy.id
  }

  /** `index` counts from the bottom of the target stack, as the document does. */
  moveLayer(id: string, parentId: string | null, index: number): boolean {
    const set = this.#requireSet()
    const ok = moveLayer(set, id, parentId, index)
    if (ok) this.engine.sync('moveLayer')
    return ok
  }

  selectLayer(id: string | null): void {
    this.engine.project.activeLayerId = id
    this.engine.events.emit('documentChanged', { reason: 'selectLayer' })
  }

  get activeLayerId(): string | null {
    return this.engine.project.activeLayerId
  }

  setLayerProps(id: string, patch: { name?: string; visible?: boolean; opacity?: number; collapsed?: boolean }): boolean {
    const layer = this.getLayer(id)
    if (!layer) return false
    if (patch.name !== undefined) layer.name = patch.name
    if (patch.visible !== undefined) layer.visible = patch.visible
    if (patch.opacity !== undefined) layer.opacity = clamp01(patch.opacity)
    if (patch.collapsed !== undefined && layer.kind === 'folder') layer.collapsed = patch.collapsed
    this.engine.sync('setLayerProps')
    return true
  }

  setChannelSettings(id: string, channel: Channel, patch: Partial<ChannelSettings>): boolean {
    const layer = this.getLayer(id)
    if (!layer) return false
    const current = layer.channels[channel] ?? { enabled: true, opacity: 1, blend: 'normal' as BlendMode }
    layer.channels[channel] = {
      enabled: patch.enabled ?? current.enabled,
      opacity: patch.opacity !== undefined ? clamp01(patch.opacity) : current.opacity,
      blend: patch.blend ?? current.blend,
    }
    this.engine.sync('setChannelSettings')
    return true
  }

  // -- materials ----------------------------------------------------------

  listMaterials() {
    return listMaterialDefs().map((def) => ({
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
    }))
  }

  getMaterialSchema(defId: string) {
    const def = getMaterialDef(defId)
    return def ? { id: def.id, name: def.name, category: def.category, description: def.description, params: def.params } : null
  }

  setLayerMaterial(layerId: string, defId: string, params: Record<string, ParamValue> = {}): boolean {
    const layer = this.getLayer(layerId)
    if (!layer || layer.kind !== 'fill') return false
    if (!getMaterialDef(defId)) throw new Error(`Unknown material "${defId}"`)
    layer.material = instantiateMaterial(defId, params)
    this.engine.sync('setLayerMaterial')
    return true
  }

  setMaterialParam(layerId: string, key: string, value: ParamValue): boolean {
    const layer = this.getLayer(layerId)
    if (!layer || layer.kind !== 'fill') return false
    const def = getMaterialDef(layer.material.defId)
    if (!def || !def.params.some((p) => p.key === key)) return false
    layer.material.params[key] = value
    this.engine.sync('setMaterialParam')
    return true
  }

  setProjection(layerId: string, patch: Partial<ProjectionSettings>): boolean {
    const layer = this.getLayer(layerId)
    if (!layer || layer.kind !== 'fill') return false
    layer.projection = { ...layer.projection, ...patch }
    this.engine.sync('setProjection')
    return true
  }

  // -- masks --------------------------------------------------------------

  addMask(layerId: string, options: { base?: number; generator?: GeneratorType } = {}): boolean {
    const layer = this.getLayer(layerId)
    if (!layer) return false
    layer.mask = createMask(options.base ?? (options.generator ? 0 : 1))
    if (options.generator) {
      layer.mask.generators.push(createGenerator(options.generator, defaultGeneratorParams(options.generator)))
    }
    this.engine.sync('addMask')
    return true
  }

  removeMask(layerId: string): boolean {
    const layer = this.getLayer(layerId)
    if (!layer?.mask) return false
    layer.mask = null
    this.engine.sync('removeMask')
    return true
  }

  setMask(layerId: string, patch: Partial<Pick<MaskState, 'enabled' | 'invert' | 'base' | 'paintBlend' | 'blur'>> & { levels?: Partial<Levels> }): boolean {
    const layer = this.getLayer(layerId)
    if (!layer?.mask) return false
    const mask = layer.mask
    if (patch.enabled !== undefined) mask.enabled = patch.enabled
    if (patch.invert !== undefined) mask.invert = patch.invert
    if (patch.base !== undefined) mask.base = clamp01(patch.base)
    if (patch.paintBlend !== undefined) mask.paintBlend = patch.paintBlend
    if (patch.blur !== undefined) mask.blur = Math.max(0, patch.blur)
    if (patch.levels) mask.levels = { ...mask.levels, ...patch.levels }
    this.engine.sync('setMask')
    return true
  }

  /** Allocates a paint buffer on a mask, so the mask can be hand-painted. */
  enableMaskPainting(layerId: string): boolean {
    const layer = this.getLayer(layerId)
    if (!layer) return false
    if (!layer.mask) layer.mask = createMask(0)
    if (!layer.mask.paintBufferId) layer.mask.paintBufferId = uid('paint')
    this.engine.sync('enableMaskPainting')
    return true
  }

  listGeneratorTypes() {
    return listGeneratorDefs().map((def) => ({
      type: def.type,
      name: def.name,
      description: def.description,
      requiresBake: def.requiresBake,
    }))
  }

  addGenerator(layerId: string, type: GeneratorType, params: Record<string, ParamValue> = {}): string | null {
    const layer = this.getLayer(layerId)
    if (!layer) return null
    if (!getGeneratorDef(type)) throw new Error(`Unknown generator "${type}"`)
    if (!layer.mask) layer.mask = createMask(0)
    const generator = createGenerator(type, { ...defaultGeneratorParams(type), ...params })
    layer.mask.generators.push(generator)
    this.engine.sync('addGenerator')
    return generator.id
  }

  removeGenerator(layerId: string, generatorId: string): boolean {
    const layer = this.getLayer(layerId)
    if (!layer?.mask) return false
    const index = layer.mask.generators.findIndex((g) => g.id === generatorId)
    if (index < 0) return false
    layer.mask.generators.splice(index, 1)
    this.engine.sync('removeGenerator')
    return true
  }

  setGenerator(
    layerId: string,
    generatorId: string,
    patch: Partial<Pick<GeneratorState, 'name' | 'enabled' | 'opacity' | 'blend' | 'invert'>> & {
      params?: Record<string, ParamValue>
      levels?: Partial<Levels>
    },
  ): boolean {
    const layer = this.getLayer(layerId)
    const generator = layer?.mask?.generators.find((g) => g.id === generatorId)
    if (!generator) return false
    if (patch.name !== undefined) generator.name = patch.name
    if (patch.enabled !== undefined) generator.enabled = patch.enabled
    if (patch.opacity !== undefined) generator.opacity = clamp01(patch.opacity)
    if (patch.blend !== undefined) generator.blend = patch.blend
    if (patch.invert !== undefined) generator.invert = patch.invert
    if (patch.params) Object.assign(generator.params, patch.params)
    if (patch.levels) generator.levels = { ...generator.levels, ...patch.levels }
    this.engine.sync('setGenerator')
    return true
  }

  // -- painting -----------------------------------------------------------

  getBrush(): BrushSettings {
    return this.engine.brush
  }

  setBrush(patch: Partial<BrushSettings>): void {
    this.engine.setBrush(patch)
  }

  setBrushMaterial(defId: string, params: Record<string, ParamValue> = {}): void {
    if (!getMaterialDef(defId)) throw new Error(`Unknown material "${defId}"`)
    this.engine.setBrushMaterial(defId, params)
  }

  setPaintTarget(kind: PaintTargetKind): void {
    this.engine.setPaintTarget(kind)
  }

  beginStroke(sample: StrokeSample): boolean {
    return this.engine.beginStroke(sample)
  }

  strokeTo(sample: StrokeSample): void {
    this.engine.strokeTo(sample)
  }

  endStroke(): void {
    this.engine.endStroke()
  }

  /** Convenience for scripted painting: one call for a whole stroke. */
  paintStroke(samples: StrokeSample[]): boolean {
    if (samples.length === 0) return false
    if (!this.beginStroke(samples[0])) return false
    for (let i = 1; i < samples.length; i++) this.strokeTo(samples[i])
    this.endStroke()
    return true
  }

  raycast(origin: [number, number, number], direction: [number, number, number]): SurfaceHit | null {
    return this.engine.raycast(origin, direction)
  }

  // -- baking -------------------------------------------------------------

  async bake(settings: Partial<BakeSettings> = {}, onProgress?: (progress: BakeProgress) => void): Promise<void> {
    const off = onProgress ? this.engine.events.on('bakeProgress', onProgress) : null
    try {
      await this.engine.bakeMeshMaps(settings)
    } finally {
      off?.()
    }
  }

  cancelBake(): void {
    this.engine.cancelBake()
  }

  get isBaked(): boolean {
    return this.engine.meshMaps.rayBaked
  }

  // -- view ---------------------------------------------------------------

  setViewMode(mode: ViewMode): void {
    this.engine.setViewMode(mode)
  }

  getViewMode(): ViewMode {
    return this.engine.viewMode
  }

  setEnvironment(preset: string | Partial<EnvironmentSettings>): void {
    if (typeof preset === 'string') {
      const found = ENVIRONMENT_PRESETS[preset]
      if (!found) throw new Error(`Unknown environment preset "${preset}"`)
      this.engine.setEnvironment(found)
    } else {
      this.engine.setEnvironment(preset)
    }
  }

  // -- io -----------------------------------------------------------------

  save(): ProjectFile {
    return serializeProject(this.engine.project)
  }

  /**
   * Replaces the document. Painted pixels are not part of the JSON, so paint
   * buffers come back empty - the layer structure that referenced them is
   * fully restored.
   */
  load(file: unknown): void {
    const parsed = deserializeProject(file)
    this.engine.project = parsed.project
    const set = this.engine.activeTextureSet
    if (set) {
      // Rebuilding at the file's resolution keeps every buffer consistent.
      this.engine.setResolution(set.resolution)
    }
    this.engine.sync('load')
  }

  saveSmartMaterial(layerId: string, name: string, description = ''): SmartMaterialFile | null {
    const layer = this.getLayer(layerId)
    if (!layer) return null
    return serializeSmartMaterial(layer, name, description)
  }

  applySmartMaterial(file: unknown, parentId: string | null = null, index?: number): string {
    const set = this.#requireSet()
    const parsed = deserializeSmartMaterial(file)
    const layer = instantiateSmartMaterial(parsed)
    insertLayer(set, layer, parentId, index)
    this.engine.project.activeLayerId = layer.id
    this.engine.sync('applySmartMaterial')
    return layer.id
  }

  listExportPresets() {
    return EXPORT_PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description }))
  }

  async exportMaps(presetId: string, baseName = 'texture'): Promise<ExportedMap[]> {
    const renderer = this.engine.renderer
    if (!renderer) throw new Error('Export needs a renderer; call attachRenderer first')
    const preset = getExportPreset(presetId)
    if (!preset) throw new Error(`Unknown export preset "${presetId}"`)
    // Make sure the composite reflects the current document before reading it.
    this.engine.update()
    return exportMaps(renderer, this.engine.compositor.output, preset, baseName)
  }

  /** A quick health summary - handy as an agent's "what state am I in" call. */
  status() {
    const set = this.engine.activeTextureSet
    const paint = set ? collectPaintBufferIds(set) : []
    return {
      project: this.engine.project.name,
      resolution: this.engine.resolution,
      hasRenderer: this.engine.renderer !== null,
      meshName: this.engine.project.meshes[0]?.name ?? null,
      meshSource: this.engine.project.meshes[0]?.source ?? null,
      meshTriangles: this.engine.project.meshes[0]?.triangleCount ?? 0,
      layers: this.engine.layerCount(),
      activeLayerId: this.engine.project.activeLayerId,
      geometryBaked: this.engine.meshMaps.geometryBaked,
      meshMapsBaked: this.engine.meshMaps.rayBaked,
      paintBuffers: paint.length,
      viewMode: this.engine.viewMode,
      paintTarget: this.engine.paintTarget,
      isBaking: this.engine.isBaking,
    }
  }

  #requireSet() {
    const set = this.engine.activeTextureSet
    if (!set) throw new Error('No active texture set')
    return set
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function roundToPowerOfTwo(value: number): number {
  return 2 ** Math.round(Math.log2(Math.max(1, value)))
}

export type {
  BakeProgress,
  BrushSettings,
  Channel,
  EnvironmentSettings,
  ExportedMap,
  FillLayerState,
  FolderLayerState,
  GeneratorType,
  ImportedGltf,
  LayerState,
  PaintTargetKind,
  ProjectFile,
  SmartMaterialFile,
  StrokeSample,
  SurfaceHit,
  ViewMode,
}
export { GENERATOR_TYPES, BLEND_MODES, PROJECTIONS, VIEW_MODES, DEFAULT_LEVELS }
