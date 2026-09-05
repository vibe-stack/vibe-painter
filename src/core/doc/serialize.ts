/**
 * Project and smart-material serialisation.
 *
 * What gets written is the *recipe* - layers, masks, generators, parameters -
 * not flattened pixels. That is the whole point of a procedural catalogue: a
 * fully authored surface is a few kilobytes of JSON, and it re-renders at any
 * resolution on any machine.
 *
 * Painted pixels are the one genuinely raster part of the document. They are
 * stored separately as 8-bit PNG payloads (see `paint` below), because a
 * lossless float dump of a 1K paint layer is over sixteen megabytes and a
 * project file should not be.
 */

import { uid } from '../ids'
import { normaliseLayer } from './document'
import type { LayerState, ProjectState, TextureSetState } from './types'

export const FILE_VERSION = 1

export interface PaintPayload {
  bufferId: string
  kind: 'material' | 'mask'
  resolution: number
  /** Data URLs, one per slot; index 0 is always the coverage mask. */
  images: string[]
}

export interface ProjectFile {
  format: 'vibe-painter-project'
  version: number
  savedAt: string
  project: ProjectState
  paint: PaintPayload[]
}

export interface SmartMaterialFile {
  format: 'vibe-painter-smart-material'
  version: number
  name: string
  description: string
  /** The layer subtree, with every paint reference stripped. */
  layer: LayerState
}

export function serializeProject(project: ProjectState, paint: PaintPayload[] = []): ProjectFile {
  return {
    format: 'vibe-painter-project',
    version: FILE_VERSION,
    savedAt: new Date().toISOString(),
    project: structuredClone(project),
    paint,
  }
}

export function deserializeProject(input: unknown): ProjectFile {
  if (!input || typeof input !== 'object') throw new Error('Not a project file')
  const file = input as Partial<ProjectFile>
  if (file.format !== 'vibe-painter-project') throw new Error('Not a Vibe Painter project file')
  if (typeof file.version !== 'number' || file.version > FILE_VERSION) {
    throw new Error(`Project file version ${file.version} is newer than this build understands`)
  }
  if (!file.project) throw new Error('Project file has no project')
  for (const mesh of file.project.meshes ?? []) {
    if (!mesh.parts) mesh.parts = []
  }
  for (const set of file.project.textureSets ?? []) {
    for (const layer of set.layers ?? []) normaliseLayer(layer)
  }
  return {
    format: 'vibe-painter-project',
    version: file.version,
    savedAt: file.savedAt ?? new Date().toISOString(),
    project: file.project,
    paint: file.paint ?? [],
  }
}

/**
 * Packages a layer (usually a folder) as a reusable smart material.
 *
 * Paint buffers are dropped on purpose: a smart material has to work on a mesh
 * it has never seen, so anything that survives must be a *function* of the
 * geometry - generators reading the mesh maps - rather than pixels painted for
 * one particular UV layout.
 */
export function serializeSmartMaterial(layer: LayerState, name: string, description = ''): SmartMaterialFile {
  return {
    format: 'vibe-painter-smart-material',
    version: FILE_VERSION,
    name,
    description,
    layer: stripPaint(structuredClone(layer)),
  }
}

export function deserializeSmartMaterial(input: unknown): SmartMaterialFile {
  if (!input || typeof input !== 'object') throw new Error('Not a smart material file')
  const file = input as Partial<SmartMaterialFile>
  if (file.format !== 'vibe-painter-smart-material') throw new Error('Not a Vibe Painter smart material')
  if (!file.layer) throw new Error('Smart material has no layer')
  return {
    format: 'vibe-painter-smart-material',
    version: file.version ?? FILE_VERSION,
    name: file.name ?? 'Smart Material',
    description: file.description ?? '',
    layer: normaliseLayer(file.layer),
  }
}

/** Fresh ids so the same smart material can be applied repeatedly. */
export function instantiateSmartMaterial(file: SmartMaterialFile): LayerState {
  const layer = structuredClone(file.layer)
  reissue(layer)
  return layer
}

/**
 * Fresh ids, with anchor references rewritten to match.
 *
 * A smart material is very often a *group* whose upper layers read an anchor
 * published by a lower one - "grime, wherever the paint chipped". Reissuing ids
 * without remapping those references would leave the applied copy pointing at
 * layer ids that no longer exist, and the effect would silently come out empty.
 */
function reissue(layer: LayerState): void {
  const remap = new Map<string, string>()
  const assign = (node: LayerState) => {
    const next = uid('layer')
    remap.set(node.id, next)
    node.id = next
    if (node.mask) for (const gen of node.mask.generators) gen.id = uid('gen')
    if (node.kind === 'paint') node.paintBufferId = uid('paint')
    if (node.kind === 'folder') for (const child of node.children) assign(child)
  }
  const relink = (node: LayerState) => {
    if (node.mask) {
      for (const gen of node.mask.generators) {
        const target = gen.anchorRef ? remap.get(gen.anchorRef.layerId) : undefined
        if (gen.anchorRef && target) gen.anchorRef = { ...gen.anchorRef, layerId: target }
      }
    }
    if (node.kind === 'folder') for (const child of node.children) relink(child)
  }
  assign(layer)
  relink(layer)
}

function stripPaint(layer: LayerState): LayerState {
  if (layer.mask) layer.mask.paintBufferId = null
  if (layer.kind === 'folder') layer.children = layer.children.map(stripPaint)
  return layer
}

/** Collects every paint buffer id a texture set references. */
export function collectPaintBufferIds(set: TextureSetState): { id: string; kind: 'material' | 'mask' }[] {
  const out: { id: string; kind: 'material' | 'mask' }[] = []
  const walk = (layers: LayerState[]) => {
    for (const layer of layers) {
      if (layer.kind === 'paint') out.push({ id: layer.paintBufferId, kind: 'material' })
      if (layer.mask?.paintBufferId) out.push({ id: layer.mask.paintBufferId, kind: 'mask' })
      if (layer.kind === 'folder') walk(layer.children)
    }
  }
  walk(set.layers)
  return out
}
