/**
 * Pure operations over the document tree. Every mutation the API exposes is
 * implemented here so the data model stays testable without a GPU.
 */

import type { Channel } from '../channels'
import { CHANNELS } from '../channels'
import { uid } from '../ids'
import type {
  AnchorRef,
  BlendMode,
  FillLayerState,
  FolderLayerState,
  GeneratorState,
  GeneratorType,
  LayerState,
  Levels,
  MaskState,
  MaterialInstance,
  MeshPart,
  MeshState,
  PaintLayerState,
  ProjectState,
  TextureSetState,
} from './types'
import { DEFAULT_LEVELS, DEFAULT_PROJECTION } from './types'

export interface LayerLocation {
  layer: LayerState
  /** Array the layer lives in (the root stack or a folder's children). */
  siblings: LayerState[]
  index: number
  parent: FolderLayerState | null
}

export function createProject(name = 'Untitled'): ProjectState {
  return {
    version: 1,
    name,
    meshes: [],
    textureSets: [],
    activeTextureSetId: null,
    activeLayerId: null,
  }
}

export function createTextureSet(meshId: string, name = 'Texture Set', resolution = 1024): TextureSetState {
  return {
    id: uid('ts'),
    name,
    resolution,
    channels: [...CHANNELS] as Channel[],
    layers: [],
    meshMaps: null,
    meshId,
  }
}

export function createMesh(
  source: MeshState['source'],
  name: string,
  triangleCount: number,
  hasUVs: boolean,
  parts: MeshPart[] = [],
): MeshState {
  return { id: uid('mesh'), name, source, triangleCount, hasUVs, parts }
}

export function createFillLayer(material: MaterialInstance, name = 'Fill'): FillLayerState {
  return {
    id: uid('layer'),
    kind: 'fill',
    name,
    visible: true,
    opacity: 1,
    channels: {},
    mask: null,
    anchorName: null,
    material,
    projection: { ...DEFAULT_PROJECTION, scale: [...DEFAULT_PROJECTION.scale], offset: [...DEFAULT_PROJECTION.offset] },
  }
}

export function createPaintLayer(name = 'Paint'): PaintLayerState {
  return {
    id: uid('layer'),
    kind: 'paint',
    name,
    visible: true,
    opacity: 1,
    channels: {},
    mask: null,
    anchorName: null,
    paintBufferId: uid('paint'),
  }
}

export function createFolder(name = 'Folder', children: LayerState[] = []): FolderLayerState {
  return {
    id: uid('layer'),
    kind: 'folder',
    name,
    visible: true,
    opacity: 1,
    channels: {},
    mask: null,
    anchorName: null,
    collapsed: false,
    children,
  }
}

export function createMask(base = 0): MaskState {
  return {
    enabled: true,
    invert: false,
    base,
    generators: [],
    paintBufferId: null,
    paintBlend: 'add',
    levels: { ...DEFAULT_LEVELS },
    blur: 0,
  }
}

export function createGenerator(
  type: GeneratorType,
  params: Record<string, number | boolean | [number, number, number]> = {},
  anchorRef: AnchorRef | null = null,
): GeneratorState {
  return {
    id: uid('gen'),
    type,
    name: type,
    enabled: true,
    opacity: 1,
    blend: 'normal',
    params,
    levels: { ...DEFAULT_LEVELS },
    invert: false,
    anchorRef,
  }
}

/** Depth-first walk, bottom layer first, folders before their children. */
export function walkLayers(
  layers: LayerState[],
  visit: (layer: LayerState, parent: FolderLayerState | null, depth: number) => void,
  parent: FolderLayerState | null = null,
  depth = 0,
): void {
  for (const layer of layers) {
    visit(layer, parent, depth)
    if (layer.kind === 'folder') walkLayers(layer.children, visit, layer, depth + 1)
  }
}

export function findLayer(layers: LayerState[], id: string, parent: FolderLayerState | null = null): LayerLocation | null {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    if (layer.id === id) return { layer, siblings: layers, index: i, parent }
    if (layer.kind === 'folder') {
      const found = findLayer(layer.children, id, layer)
      if (found) return found
    }
  }
  return null
}

export function collectLayers(layers: LayerState[]): LayerState[] {
  const out: LayerState[] = []
  walkLayers(layers, (l) => out.push(l))
  return out
}

/** True when `ancestorId` is `layer` itself or one of its folder ancestors. */
export function isDescendantOf(layers: LayerState[], layerId: string, ancestorId: string): boolean {
  if (layerId === ancestorId) return true
  const loc = findLayer(layers, ancestorId)
  if (!loc || loc.layer.kind !== 'folder') return false
  return findLayer(loc.layer.children, layerId) !== null
}

export function insertLayer(set: TextureSetState, layer: LayerState, parentId: string | null, index?: number): void {
  const siblings = resolveSiblings(set, parentId)
  const at = index === undefined ? siblings.length : clampIndex(index, siblings.length)
  siblings.splice(at, 0, layer)
}

export function removeLayer(set: TextureSetState, id: string): LayerState | null {
  const loc = findLayer(set.layers, id)
  if (!loc) return null
  loc.siblings.splice(loc.index, 1)
  return loc.layer
}

/**
 * Moves a layer to a new position. Refuses to move a folder into itself, which
 * would detach the subtree from the document.
 */
export function moveLayer(set: TextureSetState, id: string, parentId: string | null, index: number): boolean {
  if (parentId !== null && isDescendantOf(set.layers, parentId, id)) return false
  const loc = findLayer(set.layers, id)
  if (!loc) return false

  const target = resolveSiblings(set, parentId)
  // Removing first shifts indices when moving down inside the same array.
  const sameArray = target === loc.siblings
  loc.siblings.splice(loc.index, 1)
  let at = clampIndex(index, target.length)
  if (sameArray && loc.index < at) at = clampIndex(at, target.length)
  target.splice(at, 0, loc.layer)
  return true
}

function resolveSiblings(set: TextureSetState, parentId: string | null): LayerState[] {
  if (parentId === null) return set.layers
  const loc = findLayer(set.layers, parentId)
  if (!loc || loc.layer.kind !== 'folder') {
    throw new Error(`Layer "${parentId}" is not a folder`)
  }
  return loc.layer.children
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length))
}

/** Deep clone that re-issues every id, so the copy is independent. */
export function duplicateLayer(layer: LayerState): LayerState {
  const clone = structuredClone(layer) as LayerState
  reissueIds(clone)
  clone.name = `${layer.name} copy`
  return clone
}

function reissueIds(layer: LayerState): void {
  const previousId = layer.id
  layer.id = uid('layer')
  // Two layers publishing the same anchor name is a coin toss for anyone
  // reading the picker, and the copy is a different layer producing different
  // pixels. The reference itself is kept: a duplicated generator that read
  // somebody else's anchor should go on reading it.
  if (layer.anchorName) layer.anchorName = `${layer.anchorName} copy`
  remapAnchorRefs(layer, previousId, layer.id)
  if (layer.mask) {
    for (const gen of layer.mask.generators) gen.id = uid('gen')
    // A duplicated paint buffer needs its own id; the engine copies the pixels.
    if (layer.mask.paintBufferId) layer.mask.paintBufferId = uid('paint')
  }
  if (layer.kind === 'paint') layer.paintBufferId = uid('paint')
  if (layer.kind === 'folder') for (const child of layer.children) reissueIds(child)
}

/**
 * Rewrites anchor references inside a subtree that pointed at `from` to `to`.
 *
 * A duplicated *folder* is the case that needs it: its children may reference
 * each other, and those references have to follow the copy rather than keep
 * pointing into the original group.
 */
function remapAnchorRefs(layer: LayerState, from: string, to: string): void {
  const visit = (node: LayerState) => {
    if (node.mask) {
      for (const gen of node.mask.generators) {
        if (gen.anchorRef?.layerId === from) gen.anchorRef = { ...gen.anchorRef, layerId: to }
      }
    }
    if (node.kind === 'folder') for (const child of node.children) visit(child)
  }
  visit(layer)
}

/**
 * The stack flattened into the order the compositor evaluates it in.
 *
 * Not the same as `walkLayers`. A folder composites its children first and only
 * then blends the group as a unit, so its children are evaluated *before* it -
 * post-order for folders, and bottom-up within every array. Anchor visibility
 * is exactly this order, so anything that answers "can this layer see that
 * anchor" has to ask here rather than guess from the tree shape.
 */
export function evaluationOrder(layers: LayerState[]): LayerState[] {
  const out: LayerState[] = []
  for (const layer of layers) {
    if (layer.kind === 'folder') out.push(...evaluationOrder(layer.children))
    out.push(layer)
  }
  return out
}

/** Every anchor point published in a stack, in evaluation order. */
export function collectAnchors(layers: LayerState[]): { layerId: string; name: string }[] {
  return evaluationOrder(layers)
    .filter((layer) => Boolean(layer.anchorName))
    .map((layer) => ({ layerId: layer.id, name: layer.anchorName as string }))
}

/**
 * The anchors `layerId` may reference: those published by layers the
 * compositor has already evaluated by the time it reaches this one.
 *
 * An unknown layer gets the whole list, which is what a caller asking "what
 * anchors exist at all" wants.
 */
export function anchorsVisibleTo(layers: LayerState[], layerId: string): { layerId: string; name: string }[] {
  const out: { layerId: string; name: string }[] = []
  for (const layer of evaluationOrder(layers)) {
    if (layer.id === layerId) break
    if (layer.anchorName) out.push({ layerId: layer.id, name: layer.anchorName })
  }
  return out
}

/**
 * Fills in fields added after a project file was written.
 *
 * Anything the document gains has to survive loading a file that predates it,
 * and the alternative - declaring the field optional - pushes the same check
 * into every reader instead of doing it once, here.
 */
export function normaliseLayer(layer: LayerState): LayerState {
  if (layer.anchorName === undefined) layer.anchorName = null
  if (layer.mask) {
    for (const gen of layer.mask.generators) {
      if (gen.anchorRef === undefined) gen.anchorRef = null
    }
  }
  if (layer.kind === 'folder') for (const child of layer.children) normaliseLayer(child)
  return layer
}

export function getTextureSet(project: ProjectState, id: string | null): TextureSetState | null {
  if (!id) return null
  return project.textureSets.find((s) => s.id === id) ?? null
}

export function applyLevels(v: number, levels: Levels): number {
  const span = levels.inHigh - levels.inLow
  const t = span === 0 ? 0 : (v - levels.inLow) / span
  const clamped = Math.max(0, Math.min(1, t))
  const gamma = levels.gamma <= 0 ? 1 : levels.gamma
  const shaped = Math.pow(clamped, 1 / gamma)
  return levels.outLow + shaped * (levels.outHigh - levels.outLow)
}

export function channelSettings(layer: LayerState, channel: Channel): { enabled: boolean; opacity: number; blend: BlendMode } {
  const override = layer.channels[channel]
  return {
    enabled: override?.enabled ?? true,
    opacity: override?.opacity ?? 1,
    blend: override?.blend ?? 'normal',
  }
}
