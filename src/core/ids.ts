/**
 * Stable id generation. Kept dependency-free so the core can run in a worker
 * or in Node without a DOM.
 */

let counter = 0

export function uid(prefix = 'id'): string {
  counter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${counter.toString(36)}_${rand}`
}

/** Resets the monotonic part of the counter. Only used by tests. */
export function resetUid(): void {
  counter = 0
}
