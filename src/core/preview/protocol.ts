/**
 * The message contract between the thumbnail service and its worker.
 *
 * Kept in its own module so neither side imports the other: the worker pulls in
 * three.js and the whole catalogue, and the main thread must be able to talk
 * about jobs without any of that being in its bundle graph.
 */

import type { ParamValue } from '../doc/types'
import type { PreviewOptions } from './material'

export interface RenderJob {
  jobId: number
  defId: string
  params?: Record<string, ParamValue>
  options?: PreviewOptions
}

export type WorkerRequest = { type: 'render'; job: RenderJob } | { type: 'init'; size: number }

export type WorkerResponse =
  | { type: 'ready' }
  /** The worker could not get a WebGPU device at all. Nothing will render. */
  | { type: 'unavailable'; message: string }
  | { type: 'done'; jobId: number; blob: Blob }
  | { type: 'failed'; jobId: number; message: string }
