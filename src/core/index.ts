/**
 * Public entry point for the headless core.
 *
 * Nothing under `src/core` imports React or touches the DOM outside of the
 * places that genuinely need it (worker creation and PNG encoding). The UI in
 * `src/ui` is a consumer of this module, not a peer of it.
 */

export { VibePainter } from './api'
export type { CreateOptions, LayerSummary } from './api'
export { Engine } from './engine'
export type { EngineEvents, PaintTargetKind, SurfaceHit } from './engine'

export * from './channels'
export * from './doc/types'
export * from './doc/document'
export * from './doc/serialize'

export { PRIMITIVES, buildPrimitive, getPrimitive } from './mesh/primitives'
export { loadGltfGeometry, isGltfFileName, GLTF_ACCEPT } from './mesh/gltf'
export type { ImportedGltf } from './mesh/gltf'
export { prepareGeometry, computeTangents } from './mesh/tangents'

export { BUILT_IN_MATERIALS, DEFAULT_MATERIAL_ID } from './procedural/catalogue'
export {
  describeCatalogue,
  getMaterialDef,
  instantiateMaterial,
  listCategories,
  listMaterialDefs,
  registerMaterial,
} from './procedural/material'
export type { MatContext, MeshMapNodes, ProceduralMaterialDef } from './procedural/material'
export type { ParamDef, ParamType } from './procedural/params'
export { describeGenerators, getGeneratorDef, listGeneratorDefs } from './procedural/generators'
export type { GeneratorDef } from './procedural/generators'
export * as noise from './procedural/noise'

export { DEFAULT_BRUSH, BRUSH_ALPHAS } from './gpu/painter'
export type { BrushAlpha, BrushSettings, StrokeSample } from './gpu/painter'
export { VIEW_MODES } from './gpu/viewport'
export type { ViewMode } from './gpu/viewport'
export { ENVIRONMENT_PRESETS } from './gpu/environment'
export type { EnvironmentSettings } from './gpu/environment'
export { EXPORT_PRESETS, exportMaps, getExportPreset } from './gpu/exporter'
export type { ExportPreset, ExportedMap } from './gpu/exporter'
export type { BakeProgress } from './bake/baker'
