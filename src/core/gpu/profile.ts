/**
 * Main-thread stall reporting.
 *
 * Every expensive thing in this app is supposed to be off the frame: the
 * compositor builds its graph between two awaits and compiles with
 * `compileAsync`, the painter prewarms its pipelines before a stroke, and the
 * baker yields between passes. When something nonetheless janks, the useful
 * question is not "is it slow" but *which* of those phases actually blocked -
 * and that is not something a profiler flame chart answers quickly either,
 * because the work happens inside three and the driver.
 *
 * So each phase says how long it took, and anything over a frame and a half
 * says so out loud. The cost when nothing is slow is one `performance.now()`
 * pair per phase, a handful of times per second.
 */

/** Roughly a frame and a half at 60Hz: long enough to be visible as a hitch. */
const DEFAULT_THRESHOLD_MS = 24

interface ProfileSettings {
  /** Set false to silence reporting entirely. */
  enabled: boolean
  /** Report synchronous phases at or above this many milliseconds. */
  threshold: number
}

export const profile: ProfileSettings = {
  enabled: true,
  threshold: DEFAULT_THRESHOLD_MS,
}

/**
 * Times a synchronous phase and reports it if it blocked.
 *
 * `label` should name the phase, not the function - the point is to be able to
 * read "the composite draw blocked for 400ms" and know immediately that the
 * stall is a pipeline being created at draw time rather than a graph being
 * built.
 */
export function measure<T>(label: string, run: () => T): T {
  if (!profile.enabled) return run()
  const started = performance.now()
  try {
    return run()
  } finally {
    const elapsed = performance.now() - started
    if (elapsed >= profile.threshold) {
      console.warn(`[vibe-painter] ${label} blocked the main thread for ${elapsed.toFixed(0)}ms`)
    }
  }
}

/**
 * Times an asynchronous phase.
 *
 * Reported separately and at a much higher bar, because wall time here includes
 * every yield: a compile that takes 300ms of wall clock while the page stays at
 * 60fps is the system working, not failing. It is logged only so a slow
 * synchronous phase can be read against what preceded it.
 */
export async function measureAsync<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!profile.enabled) return run()
  const started = performance.now()
  try {
    return await run()
  } finally {
    const elapsed = performance.now() - started
    if (elapsed >= profile.threshold * 4) {
      console.info(`[vibe-painter] ${label} took ${elapsed.toFixed(0)}ms of wall clock (yielding)`)
    }
  }
}
