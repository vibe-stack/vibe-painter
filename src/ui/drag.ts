/**
 * Catalogue material drags.
 *
 * HTML5 DnD is used so a swatch can land on the viewport *or* on a mesh-part
 * row in the scene panel. A custom MIME keeps file drops (GLB import) from
 * being mistaken for a material; `text/plain` is a Safari fallback.
 */

import type { DragEvent as ReactDragEvent } from 'react'

export const MATERIAL_MIME = 'application/x-vibe-material'
const MATERIAL_TEXT_PREFIX = 'vibe-material:'

/**
 * Smart materials drag on their own MIME rather than sharing the material one.
 *
 * They land in the same places and produce a layer either way, but a preset id
 * and a catalogue id are different namespaces - "dust" is a plausible member of
 * both - and a drop handler that guessed which it had would sooner or later
 * guess wrong.
 */
export const SMART_MIME = 'application/x-vibe-smart-material'
const SMART_TEXT_PREFIX = 'vibe-smart:'

type DragLike = DragEvent | ReactDragEvent

export function setMaterialDragData(data: DataTransfer, defId: string): void {
  data.setData(MATERIAL_MIME, defId)
  data.setData('text/plain', `${MATERIAL_TEXT_PREFIX}${defId}`)
  data.effectAllowed = 'copy'
}

export function setSmartDragData(data: DataTransfer, presetId: string): void {
  data.setData(SMART_MIME, presetId)
  data.setData('text/plain', `${SMART_TEXT_PREFIX}${presetId}`)
  data.effectAllowed = 'copy'
}

export function isMaterialDrag(event: DragLike): boolean {
  const types = [...(event.dataTransfer?.types ?? [])]
  if (types.includes(MATERIAL_MIME) || types.includes(SMART_MIME)) return true
  if (types.includes('Files')) return false
  return types.includes('text/plain')
}

export function isSmartDrag(event: DragLike): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(SMART_MIME)
}

export function isFileDrag(event: DragLike): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes('Files')
}

export function materialIdFromDrop(event: DragLike): string | null {
  const data = event.dataTransfer
  if (!data) return null
  const custom = data.getData(MATERIAL_MIME)
  if (custom) return custom
  const text = data.getData('text/plain')
  if (text.startsWith(MATERIAL_TEXT_PREFIX)) return text.slice(MATERIAL_TEXT_PREFIX.length)
  return null
}

export function smartIdFromDrop(event: DragLike): string | null {
  const data = event.dataTransfer
  if (!data) return null
  const custom = data.getData(SMART_MIME)
  if (custom) return custom
  const text = data.getData('text/plain')
  if (text.startsWith(SMART_TEXT_PREFIX)) return text.slice(SMART_TEXT_PREFIX.length)
  return null
}
