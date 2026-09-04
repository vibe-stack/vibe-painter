/**
 * Closes a popover when a pointer lands outside it, or on Escape.
 *
 * Its own file because `controls.tsx` is a component module and React Fast
 * Refresh only works on modules that export components alone.
 */

import { useCallback, useEffect } from 'react'
import type { RefObject } from 'react'

export function useDismiss(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  const handler = useCallback(
    (event: PointerEvent) => {
      const element = ref.current
      if (element && !element.contains(event.target as Node)) onOutside()
    },
    [ref, onOutside],
  )

  useEffect(() => {
    if (!active) return
    // Capture phase: a click that also closes a menu must not first activate a
    // control underneath the menu.
    document.addEventListener('pointerdown', handler, true)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOutside()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', handler, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, handler, onOutside])
}
