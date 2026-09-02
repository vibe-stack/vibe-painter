/**
 * React binding for the headless core.
 *
 * The core is an imperative object graph: it owns a GPU device and render
 * targets, so its state cannot live in React. The bridge is deliberately as
 * small as it can be - one version counter on the engine, read through
 * `useSyncExternalStore`.
 *
 * That matters for correctness, not just tidiness. An earlier version of this
 * file re-rendered only on `documentChanged`, so every setter that was not a
 * document edit - brush size, view mode, lighting - mutated the engine without
 * React ever hearing about it, and the corresponding controls sat frozen at
 * their old values. With a single counter that every mutator bumps, a control
 * cannot go stale unless someone adds a setter that forgets to call `#notify`.
 */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
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
 * Subscribes the calling component to every engine change. Returns the current
 * version, which is only useful as a dependency - read the values you need
 * straight off the api.
 */
export function useEngineVersion(): number {
  const api = useApi()
  const subscribe = useCallback(
    (onChange: () => void) => api.engine.events.on('changed', onChange),
    [api],
  )
  return useSyncExternalStore(subscribe, () => api.engine.version)
}

/** Re-renders when the composite finishes, for previews that read the output. */
export function useCompositeRevision(): number {
  const api = useApi()
  const subscribe = useCallback(
    (onChange: () => void) => api.engine.events.on('compositeUpdated', onChange),
    [api],
  )
  // The composite has no version of its own; the engine's is monotonic and
  // changes at least as often, which is all the store contract requires.
  return useSyncExternalStore(subscribe, () => api.engine.version)
}
