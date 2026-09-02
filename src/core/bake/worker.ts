/**
 * Bake worker entry point. Keeps the ray tracing off the main thread so the
 * viewport stays interactive and the progress bar actually moves.
 */

import type { BakeRequest } from './bake'
import { bakeRows } from './bake'

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void
}

const ctx = self as unknown as WorkerScope

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as BakeRequest & { jobId: number }
  const result = bakeRows(request, (fraction) => {
    ctx.postMessage({ type: 'progress', jobId: request.jobId, fraction })
  })
  ctx.postMessage(
    { type: 'done', jobId: request.jobId, rowStart: result.rowStart, rowEnd: result.rowEnd, data: result.data },
    [result.data.buffer],
  )
})
