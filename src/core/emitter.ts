/**
 * Minimal typed event emitter. The headless core never imports React, so this
 * is how the UI (or an agent) observes state changes.
 */

export type Unsubscribe = () => void

export class Emitter<Events extends Record<string, unknown>> {
  #handlers = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    let set = this.#handlers.get(event)
    if (!set) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(handler as (payload: never) => void)
    return () => {
      set!.delete(handler as (payload: never) => void)
    }
  }

  once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(event, (payload) => {
      off()
      handler(payload)
    })
    return off
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#handlers.get(event)
    if (!set) return
    // Copy so handlers may unsubscribe during dispatch.
    for (const handler of [...set]) (handler as (p: Events[K]) => void)(payload)
  }

  clear(): void {
    this.#handlers.clear()
  }
}
