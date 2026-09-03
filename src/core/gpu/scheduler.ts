/**
 * Yielding to the browser.
 *
 * The engine does two kinds of work that must not land inside a frame: building
 * a TSL graph (pure JavaScript, a few milliseconds on a deep stack) and asking
 * WebGPU to create a pipeline (tens to hundreds). The second is genuinely
 * asynchronous and three's `compileAsync` already yields through it. The first
 * is not - it is one synchronous call tree over node objects that must live in
 * the renderer's own heap, so it cannot be moved to a worker and cannot be
 * split. What it *can* be is moved off the frame that asked for it, which is
 * what this does: the frame presents, then the build runs in the gap.
 */

interface Scheduler {
  yield?: () => Promise<void>
  postTask?: (callback: () => void, options?: { priority?: string }) => Promise<unknown>
}

/**
 * Resolves after the browser has had a chance to do its own work - paint the
 * pending frame, run input handlers - rather than on the current microtask
 * queue, which would still be inside the caller's frame.
 */
export function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as unknown as { scheduler?: Scheduler }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  if (scheduler?.postTask) {
    return scheduler.postTask(() => {}, { priority: 'user-visible' }).then(() => undefined)
  }
  // A macrotask, deliberately: a microtask would run before the frame ends.
  return new Promise((resolve) => setTimeout(resolve, 0))
}
