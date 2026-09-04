/**
 * Re-renders the caller whenever a material swatch finishes rendering.
 *
 * The thumbnail service is not part of the engine, so `useEngineVersion` never
 * hears about it. Anything drawing a swatch needs this as well, or the picture
 * arrives and the component that asked for it never finds out - the swatch sits
 * on its placeholder gradient until something unrelated forces a render.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { thumbnails } from '../../core/preview/thumbnails'

export function useThumbnails(): number {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => thumbnails.subscribe(onChange), []),
    () => thumbnails.version,
  )
}
