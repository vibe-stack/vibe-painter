/**
 * Main-thread orchestration for the ray bake: splits the texel rows across
 * workers, merges the results, then dilates and softens them.
 *
 * The post-process is not cosmetic. Dilation stops bilinear filtering from
 * pulling empty gutter into the edge of every UV island, and the blur removes
 * the residual sampling noise that any finite ray budget leaves behind - these
 * maps are low frequency by nature, so smoothing costs nothing real.
 */

import type { BufferGeometry } from 'three/webgpu'
import type { BakeSettings } from '../doc/types'
import type { BakeGeometry } from './bake'
import type { RayMapData } from '../gpu/meshmaps'

export interface BakeProgress {
  /** 0..1 across the whole bake. */
  fraction: number
  message: string
}

interface WorkerMessage {
  type: 'progress' | 'done'
  jobId: number
  fraction?: number
  rowStart?: number
  rowEnd?: number
  data?: Float32Array
}

export class RayBaker {
  #workers: Worker[] = []
  #jobId = 0
  #cancelled = false

  get workerCount(): number {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
    // Leave a core for the main thread. Ray tracing here is compute bound, so
    // it scales almost linearly with workers; the cap only avoids spawning an
    // absurd number of them on a very large machine.
    return Math.max(1, Math.min(8, cores - 1))
  }

  cancel(): void {
    this.#cancelled = true
    for (const worker of this.#workers) worker.terminate()
    this.#workers = []
  }

  async bake(
    geometry: BufferGeometry,
    settings: BakeSettings,
    onProgress?: (progress: BakeProgress) => void,
  ): Promise<RayMapData> {
    this.#cancelled = false
    const input = extractGeometry(geometry)
    const size = settings.resolution
    const count = this.workerCount
    const rowsPerWorker = Math.ceil(size / count)

    onProgress?.({ fraction: 0, message: `Tracing on ${count} worker${count === 1 ? '' : 's'}` })

    const merged = new Float32Array(size * size * 4)
    const progress = new Array<number>(count).fill(0)

    const jobs: Promise<void>[] = []
    for (let w = 0; w < count; w++) {
      const rowStart = w * rowsPerWorker
      const rowEnd = Math.min(size, rowStart + rowsPerWorker)
      if (rowStart >= rowEnd) {
        progress[w] = 1
        continue
      }
      jobs.push(
        this.#runJob(input, settings, rowStart, rowEnd, merged, (fraction) => {
          progress[w] = fraction
          const total = progress.reduce((a, b) => a + b, 0) / count
          onProgress?.({ fraction: total * 0.9, message: 'Tracing rays' })
        }),
      )
    }

    await Promise.all(jobs)
    if (this.#cancelled) throw new Error('Bake cancelled')

    onProgress?.({ fraction: 0.92, message: 'Dilating UV islands' })
    dilate(merged, size, settings.dilation)

    onProgress?.({ fraction: 0.97, message: 'Smoothing' })
    blur(merged, size)

    onProgress?.({ fraction: 1, message: 'Done' })
    return { resolution: size, data: merged }
  }

  #runJob(
    geometry: BakeGeometry,
    settings: BakeSettings,
    rowStart: number,
    rowEnd: number,
    merged: Float32Array,
    onProgress: (fraction: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      this.#workers.push(worker)
      const jobId = ++this.#jobId

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as WorkerMessage
        if (message.jobId !== jobId) return
        if (message.type === 'progress') {
          onProgress(message.fraction ?? 0)
          return
        }
        if (message.data && message.rowStart !== undefined) {
          merged.set(message.data, message.rowStart * settings.resolution * 4)
        }
        onProgress(1)
        worker.terminate()
        this.#workers = this.#workers.filter((w) => w !== worker)
        resolve()
      }
      worker.onerror = (event) => {
        worker.terminate()
        reject(new Error(`Bake worker failed: ${event.message}`))
      }

      // Each worker gets its own copy of the geometry. Cloning a few megabytes
      // beats sharing, which would need SharedArrayBuffer and the COOP/COEP
      // headers that come with it.
      worker.postMessage({
        geometry: {
          positions: geometry.positions.slice(),
          normals: geometry.normals.slice(),
          uvs: geometry.uvs.slice(),
          indices: geometry.indices.slice(),
        },
        settings,
        rowStart,
        rowEnd,
        jobId,
      })
    })
  }
}

export function extractGeometry(geometry: BufferGeometry): BakeGeometry {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const uvAttr = geometry.getAttribute('uv')
  if (!position || !normal || !uvAttr) throw new Error('Bake needs position, normal and uv attributes')

  const index = geometry.getIndex()
  const indices = index
    ? Uint32Array.from(index.array as ArrayLike<number>)
    : Uint32Array.from({ length: position.count }, (_, i) => i)

  return {
    positions: Float32Array.from(position.array as ArrayLike<number>),
    normals: Float32Array.from(normal.array as ArrayLike<number>),
    uvs: Float32Array.from(uvAttr.array as ArrayLike<number>),
    indices,
  }
}

/** Flood the nearest covered value outward, `iterations` texels at a time. */
function dilate(data: Float32Array, size: number, iterations: number): void {
  if (iterations <= 0) return
  let source: Float32Array = data
  let target: Float32Array = new Float32Array(data.length)

  for (let pass = 0; pass < iterations; pass++) {
    target.set(source)
    let changed = false
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        if (source[i + 3] > 0) continue
        let r = 0, g = 0, b = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= size) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            if (nx < 0 || nx >= size) continue
            const j = (ny * size + nx) * 4
            if (source[j + 3] <= 0) continue
            r += source[j]; g += source[j + 1]; b += source[j + 2]; n++
          }
        }
        if (n === 0) continue
        target[i] = r / n
        target[i + 1] = g / n
        target[i + 2] = b / n
        target[i + 3] = 1
        changed = true
      }
    }
    const swap = source
    source = target
    target = swap
    if (!changed) break
  }

  if (source !== data) data.set(source)
}

/** 3x3 binomial blur on the three data channels; coverage is left alone. */
function blur(data: Float32Array, size: number): void {
  const copy = new Float32Array(data.length)
  copy.set(data)
  const weights = [1, 2, 1, 2, 4, 2, 1, 2, 1]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (copy[i + 3] <= 0) continue
      let r = 0, g = 0, b = 0, total = 0
      let k = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, k++) {
          const nx = Math.min(size - 1, Math.max(0, x + dx))
          const ny = Math.min(size - 1, Math.max(0, y + dy))
          const j = (ny * size + nx) * 4
          if (copy[j + 3] <= 0) continue
          const w = weights[k]
          r += copy[j] * w; g += copy[j + 1] * w; b += copy[j + 2] * w
          total += w
        }
      }
      if (total === 0) continue
      data[i] = r / total
      data[i + 1] = g / total
      data[i + 2] = b / total
    }
  }
}
