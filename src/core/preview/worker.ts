/**
 * Thumbnail worker.
 *
 * Everything expensive about a material swatch - building the TSL graph,
 * generating WGSL, creating the pipeline, drawing the sphere - happens in here,
 * on a device this worker owns. The main thread receives a finished PNG and
 * nothing else, so no amount of swatch rendering can drop a viewport frame.
 *
 * Jobs are handled strictly one at a time. Racing them would not make the GPU
 * finish sooner and would multiply the peak memory of the compile.
 */

import '../procedural/catalogue'
import { PreviewRenderer } from './renderer'
import type { WorkerRequest, WorkerResponse } from './protocol'

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void
}

const ctx = self as unknown as WorkerScope

let renderer: PreviewRenderer | null = null
let startup: Promise<PreviewRenderer> | null = null
/** Serialises the job queue without needing a queue: each job awaits the last. */
let chain: Promise<unknown> = Promise.resolve()

function ensureRenderer(size: number): Promise<PreviewRenderer> {
  if (!startup) {
    startup = PreviewRenderer.create(size).then((created) => {
      renderer = created
      return created
    })
  }
  return startup
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as WorkerRequest

  if (request.type === 'init') {
    chain = chain.then(async () => {
      try {
        await ensureRenderer(request.size)
        ctx.postMessage({ type: 'ready' })
      } catch (cause) {
        ctx.postMessage({ type: 'unavailable', message: describe(cause) })
      }
    })
    return
  }

  if (request.type !== 'render') return
  const job = request.job
  chain = chain.then(async () => {
    try {
      const active = renderer ?? (await ensureRenderer(256))
      const blob = await active.render({ defId: job.defId, params: job.params, options: job.options })
      ctx.postMessage({ type: 'done', jobId: job.jobId, blob })
    } catch (cause) {
      ctx.postMessage({ type: 'failed', jobId: job.jobId, message: describe(cause) })
    }
  })
})

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
