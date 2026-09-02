/**
 * React binding for the headless core.
 *
 * The UI holds exactly one reference into the engine - the `VibePainter`
 * facade - and re-renders off its events. No component reaches past the API,
 * which is what keeps the core usable without React at all.
 */

import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VibePainter } from '../core/api'

const ApiContext = createContext<VibePainter | null>(null)

export function ApiProvider({ api, children }: { api: VibePainter; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApi(): VibePainter {
  const api = useContext(ApiContext)
  if (!api) throw new Error('useApi must be used inside <ApiProvider>')
  return api
}

/**
 * Bumps whenever the document changes. Panels read it to re-render; it is a
 * revision counter rather than a state mirror, because the engine already owns
 * the document and duplicating it into React state would just create two
 * sources of truth.
 */
export function useDocRevision(): number {
  const api = useApi()
  const [revision, setRevision] = useState(0)
  useEffect(() => api.on('documentChanged', () => setRevision((r) => r + 1)), [api])
  return revision
}

/** Re-renders when the composite finishes, for previews that read the output. */
export function useCompositeRevision(): number {
  const api = useApi()
  const [revision, setRevision] = useState(0)
  useEffect(() => api.on('compositeUpdated', () => setRevision((r) => r + 1)), [api])
  return revision
}
