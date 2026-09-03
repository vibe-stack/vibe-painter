/**
 * Material swatches: request them, get a picture back.
 *
 * Two caches sit in front of the renderer, and both matter:
 *
 *  - In memory, so scrolling the browser never re-renders anything.
 *  - In IndexedDB, keyed by a signature derived from the material definition
 *    itself. That is what makes the swatches feel pre-baked: the first visit to
 *    a machine pays for the renders once, in the background, and every visit
 *    after that reads finished PNGs off disk. Because the key is derived from
 *    the definition rather than hand-maintained, editing a material's shader or
 *    its defaults invalidates exactly that material's swatch and nothing else.
 *
 * The worker is created on demand and shut down once the queue has been quiet
 * for a while, because keeping it alive means keeping a second WebGPU device
 * and its whole pipeline cache resident for the sake of pictures nobody is
 * looking at any more.
 */

import type { Unsubscribe } from '../emitter'
import type { ParamValue } from '../doc/types'
import { defaultValues } from '../procedural/params'
import { getMaterialDef, listMaterialDefs } from '../procedural/material'
import type { ProceduralMaterialDef } from '../procedural/material'
import type { RenderJob, WorkerResponse } from './protocol'

/**
 * Bump when the *renderer* changes in a way that alters every swatch - the
 * lighting, the camera, the projection. Per-material changes are picked up by
 * the signature below without touching this.
 */
const PREVIEW_REVISION = 1

const DB_NAME = 'vibe-painter-previews'
const DB_VERSION = 1
const STORE = 'thumbnails'
const THUMBNAIL_SIZE = 256
/** How long the worker (and its GPU device) survives an empty queue. */
const IDLE_SHUTDOWN_MS = 20_000

export type ThumbnailStatus = 'missing' | 'pending' | 'ready' | 'failed' | 'unsupported'

/** Visible cards jump the queue; everything else warms up behind them. */
export const PRIORITY_VISIBLE = 0
export const PRIORITY_WARM = 1

interface Entry {
  url: string | null
  status: ThumbnailStatus
}

/**
 * A material's cache key: its id, its parameter defaults, and the renderer
 * revision. Anything that would change the picture changes the key.
 */
function signatureFor(def: ProceduralMaterialDef): string {
  const shape = JSON.stringify({
    id: def.id,
    revision: PREVIEW_REVISION,
    size: THUMBNAIL_SIZE,
    params: defaultValues(def.params),
  })
  // FNV-1a: short, stable across sessions, and not a security boundary.
  let hash = 0x811c9dc5
  for (let i = 0; i < shape.length; i++) {
    hash ^= shape.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${def.id}.${hash.toString(36)}`
}

class ThumbnailService {
  #entries = new Map<string, Entry>()
  #queue: { defId: string; priority: number }[] = []
  #inFlight: string | null = null
  #worker: Worker | null = null
  #workerReady = false
  #supported = true
  #jobId = 0
  #version = 0
  #listeners = new Set<() => void>()
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  #db: Promise<IDBDatabase | null> | null = null

  /** Monotonic counter for `useSyncExternalStore`. */
  get version(): number {
    return this.#version
  }

  /** False once the environment has told us it cannot render swatches at all. */
  get supported(): boolean {
    return this.#supported
  }

  subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  status(defId: string): ThumbnailStatus {
    if (!this.#supported) return 'unsupported'
    return this.#entries.get(defId)?.status ?? 'missing'
  }

  /** The object URL for a finished swatch, or null while it is not ready. */
  url(defId: string): string | null {
    return this.#entries.get(defId)?.url ?? null
  }

  /**
   * Asks for a swatch. Safe and cheap to call on every render: an entry that is
   * ready, pending or already queued is left alone, and a queued entry that is
   * asked for again at a higher priority is simply promoted.
   */
  request(defId: string, priority = PRIORITY_VISIBLE): void {
    if (!this.#supported) return
    const existing = this.#entries.get(defId)
    if (existing && existing.status !== 'missing' && existing.status !== 'failed') {
      const queued = this.#queue.find((item) => item.defId === defId)
      if (queued && priority < queued.priority) queued.priority = priority
      return
    }
    if (!getMaterialDef(defId)) return

    this.#set(defId, { url: null, status: 'pending' })
    this.#queue.push({ defId, priority })
    void this.#pump()
  }

  /** Queues every registered material behind whatever is already waiting. */
  warmAll(): void {
    for (const def of listMaterialDefs()) this.request(def.id, PRIORITY_WARM)
  }

  #set(defId: string, entry: Entry): void {
    const previous = this.#entries.get(defId)
    if (previous?.url && previous.url !== entry.url) URL.revokeObjectURL(previous.url)
    this.#entries.set(defId, entry)
    this.#notify()
  }

  #notify(): void {
    this.#version++
    for (const listener of [...this.#listeners]) listener()
  }

  /**
   * Drives the queue: cache lookup first, worker only on a miss.
   *
   * One job at a time. The worker serialises anyway, and letting the queue run
   * ahead would only mean holding more decoded blobs than anyone can look at.
   */
  async #pump(): Promise<void> {
    if (this.#inFlight || this.#queue.length === 0 || !this.#supported) return

    this.#queue.sort((a, b) => a.priority - b.priority)
    const next = this.#queue.shift()!
    const def = getMaterialDef(next.defId)
    if (!def) return void this.#finish(next.defId, null)

    this.#inFlight = next.defId
    this.#cancelIdleShutdown()

    const key = signatureFor(def)
    const cached = await this.#readCache(key)
    if (cached) {
      this.#finish(next.defId, cached)
      return
    }

    const worker = this.#ensureWorker()
    if (!worker) {
      this.#finish(next.defId, null)
      return
    }

    const job: RenderJob = { jobId: ++this.#jobId, defId: def.id, params: defaultValues(def.params) }
    const settled = await this.#runJob(worker, job)
    if (settled) void this.#writeCache(key, settled)
    this.#finish(next.defId, settled)
  }

  #runJob(worker: Worker, job: RenderJob): Promise<Blob | null> {
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const message = event.data as WorkerResponse
        if (message.type === 'unavailable') {
          worker.removeEventListener('message', onMessage)
          this.#markUnsupported(message.message)
          resolve(null)
          return
        }
        if (message.type === 'done' && message.jobId === job.jobId) {
          worker.removeEventListener('message', onMessage)
          resolve(message.blob)
          return
        }
        if (message.type === 'failed' && message.jobId === job.jobId) {
          worker.removeEventListener('message', onMessage)
          console.warn(`[vibe-painter] preview for "${job.defId}" failed: ${message.message}`)
          resolve(null)
        }
      }
      worker.addEventListener('message', onMessage)
      worker.postMessage({ type: 'render', job })
    })
  }

  #finish(defId: string, blob: Blob | null): void {
    this.#inFlight = null
    this.#set(defId, blob ? { url: URL.createObjectURL(blob), status: 'ready' } : { url: null, status: 'failed' })
    if (this.#queue.length > 0) void this.#pump()
    else this.#scheduleIdleShutdown()
  }

  #ensureWorker(): Worker | null {
    if (this.#worker) return this.#worker
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      this.#markUnsupported('This browser cannot render offscreen previews')
      return null
    }
    try {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('error', (event) => {
        this.#markUnsupported(event.message || 'The preview worker crashed')
      })
      worker.postMessage({ type: 'init', size: THUMBNAIL_SIZE })
      this.#worker = worker
      this.#workerReady = true
      return worker
    } catch (cause) {
      this.#markUnsupported(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }

  #markUnsupported(message: string): void {
    if (!this.#supported) return
    console.warn(`[vibe-painter] material previews unavailable: ${message}`)
    this.#supported = false
    this.#workerReady = false
    this.#queue.length = 0
    this.#inFlight = null
    this.#worker?.terminate()
    this.#worker = null
    this.#notify()
  }

  #scheduleIdleShutdown(): void {
    if (!this.#workerReady || this.#idleTimer) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      if (this.#queue.length > 0 || this.#inFlight) return
      this.#worker?.terminate()
      this.#worker = null
      this.#workerReady = false
    }, IDLE_SHUTDOWN_MS)
  }

  #cancelIdleShutdown(): void {
    if (!this.#idleTimer) return
    clearTimeout(this.#idleTimer)
    this.#idleTimer = null
  }

  // -- persistent cache ---------------------------------------------------

  #openDb(): Promise<IDBDatabase | null> {
    if (this.#db) return this.#db
    this.#db = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null)
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION)
      } catch {
        return resolve(null)
      }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      request.onsuccess = () => resolve(request.result)
      // A private window, a blocked origin, a quota refusal - all mean the same
      // thing here: render every time instead of never rendering at all.
      request.onerror = () => resolve(null)
    })
    return this.#db
  }

  async #readCache(key: string): Promise<Blob | null> {
    const db = await this.#openDb()
    if (!db) return null
    return new Promise((resolve) => {
      try {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        request.onsuccess = () => {
          const value = request.result
          resolve(value instanceof Blob ? value : null)
        }
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }

  async #writeCache(key: string, blob: Blob): Promise<void> {
    const db = await this.#openDb()
    if (!db) return
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key)
    } catch {
      // A full or read-only store costs a re-render next session, nothing more.
    }
  }
}

/**
 * One service for the page. Swatches are global to the catalogue rather than to
 * a document, so there is nothing per-project to key them on.
 */
export const thumbnails = new ThumbnailService()

/**
 * Colours to fall back to when no swatch exists yet - a loading card, or a
 * browser with no WebGPU in workers.
 *
 * Read straight off the material's own colour parameters, so the placeholder is
 * always in the right family and the grid never flashes grey.
 */
export function swatchColours(def: ProceduralMaterialDef): string[] {
  const colours: string[] = []
  for (const param of def.params) {
    if (param.type !== 'color') continue
    const [r, g, b] = param.default as [number, number, number]
    colours.push(`rgb(${to8(r)} ${to8(g)} ${to8(b)})`)
    if (colours.length === 3) break
  }
  if (colours.length === 0) colours.push('rgb(90 90 96)')
  return colours
}

function to8(value: number): number {
  // The parameters are sRGB already, which is what CSS wants.
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
}

export type { ParamValue }
