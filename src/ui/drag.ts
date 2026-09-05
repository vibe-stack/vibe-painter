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

type DragLike = DragEvent | ReactDragEvent

export function setMaterialDragData(data: DataTransfer, defId: string): void {
  data.setData(MATERIAL_MIME, defId)
  data.setData('text/plain', `${MATERIAL_TEXT_PREFIX}${defId}`)
  data.effectAllowed = 'copy'
}

export function isMaterialDrag(event: DragLike): boolean {
  const types = [...(event.dataTransfer?.types ?? [])]
  if (types.includes(MATERIAL_MIME)) return true
  if (types.includes('Files')) return false
  return types.includes('text/plain')
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
