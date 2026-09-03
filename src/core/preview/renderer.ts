/**
 * The offscreen sphere renderer behind the material swatches.
 *
 * It is a complete, self-contained little three.js app: its own WebGPU device,
 * its own scene, its own procedural sky. That independence is the point - it is
 * built to run inside a worker, where there is no document, no canvas element
 * and no engine, so nothing here may reach for any of them.
 *
 * Sharing the viewport's renderer instead would have been less code and a worse
 * idea. Every swatch is a fresh shader compile, and a compile on the device the
 * viewport draws with stalls the frame it lands in; that is exactly the stutter
 * this whole path exists to avoid.
 */

import { PerspectiveCamera, Scene, Mesh, SphereGeometry, ACESFilmicToneMapping, SRGBColorSpace, WebGPURenderer } from 'three/webgpu'
import type { MeshPhysicalNodeMaterial } from 'three/webgpu'
import { ENVIRONMENT_PRESETS, ProceduralEnvironment } from '../gpu/environment'
import type { EnvironmentSettings } from '../gpu/environment'
import { LightRig } from '../gpu/lighting'
import { prepareGeometry } from '../mesh/tangents'
import { getMaterialDef } from '../procedural/material'
import type { ParamValue } from '../doc/types'
import { buildPreviewMaterial } from './material'
import type { PreviewOptions } from './material'

export interface PreviewRequest {
  defId: string
  params?: Record<string, ParamValue>
  options?: PreviewOptions
}

/** Studio light, slightly warmer and brighter than the viewport default. */
const PREVIEW_ENVIRONMENT: EnvironmentSettings = {
  ...ENVIRONMENT_PRESETS.studio,
  sunElevation: 34,
  sunAzimuth: 35,
  intensity: 1.15,
}

export class PreviewRenderer {
  #renderer: WebGPURenderer
  #scene = new Scene()
  #camera: PerspectiveCamera
  #mesh: Mesh
  #environment = new ProceduralEnvironment(256)
  #lights = new LightRig()
  #canvas: OffscreenCanvas
  #encoder: OffscreenCanvas
  #material: MeshPhysicalNodeMaterial | null = null
  readonly size: number

  private constructor(canvas: OffscreenCanvas, renderer: WebGPURenderer, size: number) {
    this.#canvas = canvas
    this.#renderer = renderer
    this.size = size
    this.#encoder = new OffscreenCanvas(size, size)

    this.#camera = new PerspectiveCamera(30, 1, 0.1, 20)
    // Slightly above the equator: a swatch lit from above reads as a solid
    // object, and it puts the pole - where any projection is weakest - out of
    // the way at the top of the frame rather than dead centre.
    this.#camera.position.set(0.35, 0.75, 3.5)
    this.#camera.lookAt(0, 0, 0)

    const geometry = new SphereGeometry(1, 128, 96)
    // Tangents are a vertex attribute here for the same reason they are on the
    // painted mesh: a derivative-based frame flips handedness between backends.
    prepareGeometry(geometry)
    this.#mesh = new Mesh(geometry)
    this.#mesh.frustumCulled = false
    this.#scene.add(this.#mesh)
    this.#scene.add(this.#lights.group)

    this.#environment.apply(PREVIEW_ENVIRONMENT)
    this.#lights.apply(PREVIEW_ENVIRONMENT)
  }

  /**
   * Creates a renderer on a fresh WebGPU device. Rejects if the environment has
   * no WebGPU at all, which is the caller's cue to fall back to a flat swatch.
   */
  static async create(size = 256): Promise<PreviewRenderer> {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas is not available')
    const canvas = new OffscreenCanvas(size, size)
    const renderer = new WebGPURenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      antialias: true,
      // Transparent, so a swatch sits on whatever the card's background is
      // rather than carrying a baked-in backdrop around with it.
      alpha: true,
    })
    await renderer.init()
    renderer.setSize(size, size, false)
    renderer.setClearColor(0x000000, 0)
    // Identical to the viewport, so a swatch is a promise the app can keep.
    renderer.toneMapping = ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    renderer.outputColorSpace = SRGBColorSpace

    const instance = new PreviewRenderer(canvas, renderer, size)
    instance.#environment.build(renderer)
    instance.#scene.environment = instance.#environment.envMap
    instance.#scene.environmentIntensity = PREVIEW_ENVIRONMENT.intensity
    return instance
  }

  /**
   * Renders one material and encodes it as a PNG.
   *
   * The compile is awaited explicitly rather than left to the draw. WebGPU
   * skips a draw whose pipeline is not ready, and for a one-shot render there
   * is no next frame to recover on - the swatch would simply come out empty.
   */
  async render(request: PreviewRequest): Promise<Blob> {
    const def = getMaterialDef(request.defId)
    if (!def) throw new Error(`Unknown material "${request.defId}"`)

    this.#material?.dispose()
    this.#material = buildPreviewMaterial(def, request.params ?? {}, request.options)
    this.#mesh.material = this.#material

    await this.#renderer.compileAsync(this.#scene, this.#camera)
    await this.#renderer.renderAsync(this.#scene, this.#camera)

    // `transferToImageBitmap` is the defined way to read an OffscreenCanvas
    // whatever backend drew into it; a WebGPU swap chain has no equivalent of
    // `preserveDrawingBuffer` to read back from directly.
    const bitmap = this.#canvas.transferToImageBitmap()
    const ctx = this.#encoder.getContext('2d')
    if (!ctx) throw new Error('No 2D context for thumbnail encoding')
    ctx.clearRect(0, 0, this.size, this.size)
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return this.#encoder.convertToBlob({ type: 'image/png' })
  }

  dispose(): void {
    this.#material?.dispose()
    this.#material = null
    this.#mesh.geometry.dispose()
    this.#environment.dispose()
    this.#lights.dispose()
    this.#renderer.dispose()
  }
}
