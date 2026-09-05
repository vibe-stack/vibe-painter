/**
 * The 3D view.
 *
 * It does three things: give the engine a renderer, run `engine.update()` once
 * per frame before the scene draws, and translate pointer events into strokes.
 *
 * Pointer input is *coalesced to one sample per frame* rather than handled per
 * event. Each sample costs a mesh raycast plus a stamp pass and a commit pass,
 * and a pointer can fire well above the display rate - handling every event
 * put the GPU several frames behind the cursor, which felt like the brush was
 * ignoring input. The painter interpolates stamps along the path between
 * samples, so stroke density is unaffected by dropping the extra events.
 *
 * Picking goes through `api.raycast()` - the same headless call an agent would
 * use - rather than react-three-fiber's event system. The UI is meant to be one
 * client of the API, not a privileged one.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ACESFilmicToneMapping, Raycaster, SRGBColorSpace, Vector2, WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { VibePainter } from '../core/api'
import type { SurfaceHit } from '../core/engine'
import { useApi } from './context'
import { isMaterialDrag, materialIdFromDrop } from './drag'

export type Tool = 'orbit' | 'paint' | 'erase'

interface ViewportProps {
  tool: Tool
  onPaintBlocked: (reason: string) => void
}

/**
 * Raises the per-stage texture limits to whatever the adapter actually offers.
 *
 * WebGPU's *default* limit is 16 sampled textures per shader stage, and it is a
 * default, not a capability - this machine's adapter allows 48. The compositor
 * is one shader over the whole layer stack, and every paint layer in it costs
 * five textures (four channel slots plus its coverage mask). So the third paint
 * layer pushed the fragment stage to 17, pipeline creation failed with a
 * validation error, and the layer simply did nothing: no crash, no missing
 * pixels, just a layer that quietly refused to exist.
 *
 * Requesting only the two limits that bind, and only as much as the adapter
 * reports, keeps this honest - asking for more than the hardware has would fail
 * the device request outright.
 */
async function textureLimits(): Promise<Record<string, number> | undefined> {
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) return undefined
    return {
      maxSampledTexturesPerShaderStage: adapter.limits.maxSampledTexturesPerShaderStage,
      maxSamplersPerShaderStage: adapter.limits.maxSamplersPerShaderStage,
    }
  } catch {
    // No adapter to ask, or a backend without WebGPU limits at all (the WebGL
    // fallback). The defaults still render; they just cap the layer count.
    return undefined
  }
}

export function Viewport(props: ViewportProps) {
  const api = useApi()
  return (
    <Canvas
      // An explicit absolute box rather than `h-full w-full`. react-three-fiber
      // measures its container with a ResizeObserver and does not mount its
      // children until it reports a non-zero size; with a percentage height the
      // first measurement can come back as 0 and never be revisited, leaving a
      // 300x150 default canvas and no scene at all.
      style={{ position: 'absolute', inset: 0 }}
      dpr={[1, 2]}
      camera={{ position: [0, 1.2, 3.4], fov: 42, near: 0.05, far: 100 }}
      gl={async (defaults) => {
        const renderer = new WebGPURenderer({
          canvas: defaults.canvas as HTMLCanvasElement,
          antialias: true,
          alpha: false,
          requiredLimits: await textureLimits(),
        })
        await renderer.init()
        renderer.toneMapping = ACESFilmicToneMapping
        renderer.toneMappingExposure = 1
        renderer.outputColorSpace = SRGBColorSpace
        return renderer
      }}
    >
      <Stage api={api} {...props} />
    </Canvas>
  )
}

interface PendingSample {
  x: number
  y: number
  pressure: number
}

function Stage({ api, tool, onPaintBlocked }: ViewportProps & { api: VibePainter }) {
  const { gl, camera, scene } = useThree()
  const controls = useRef<OrbitControls | null>(null)
  const painting = useRef(false)
  const pending = useRef<PendingSample | null>(null)
  const raycaster = useMemo(() => new Raycaster(), [])
  const ndc = useMemo(() => new Vector2(), [])

  useEffect(() => {
    // Parent first: the engine reads `root.parent` to install the environment
    // background, and there is nothing to install onto before it is in a scene.
    const g = globalThis as unknown as Record<string, unknown>
    g.__stageMounts = ((g.__stageMounts as number) ?? 0) + 1
    g.__stageGl = (gl as unknown as { isWebGPURenderer?: boolean })?.isWebGPURenderer ?? 'none'
    scene.add(api.engine.root)
    api.attachRenderer(gl as unknown as WebGPURenderer)
    g.__stageAttached = ((g.__stageAttached as number) ?? 0) + 1
    return () => {
      scene.remove(api.engine.root)
    }
  }, [api, gl, scene])

  useEffect(() => {
    const instance = new OrbitControls(camera, gl.domElement)
    instance.enableDamping = true
    instance.dampingFactor = 0.08
    instance.minDistance = 0.6
    instance.maxDistance = 20
    controls.current = instance

    const frame = () => {
      const radius = Math.max(0.5, api.engine.bounds().radius)
      camera.position.set(radius * 1.1, radius * 0.9, radius * 2.2)
      instance.target.set(0, 0, 0)
      instance.minDistance = Math.max(0.05, radius * 0.08)
      instance.maxDistance = Math.max(20, radius * 10)
      instance.update()
    }
    frame()
    const off = api.on('meshChanged', frame)

    return () => {
      off()
      instance.dispose()
    }
  }, [api, camera, gl])

  const hitAt = useCallback(
    (clientX: number, clientY: number): SurfaceHit | null => {
      const rect = (gl.domElement as HTMLCanvasElement).getBoundingClientRect()
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const { origin, direction } = raycaster.ray
      return api.raycast([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z])
    },
    [api, camera, gl, ndc, raycaster],
  )

  // Priority 0 keeps react-three-fiber's own render; our callback simply runs
  // before it, which is exactly when the composite needs to be up to date.
  useFrame(() => {
    controls.current?.update()

    // A single raycast per frame drives both the ring and the stroke, so the
    // two can never disagree about where the brush is.
    const sample = pending.current
    if (sample) {
      pending.current = null
      const hit = hitAt(sample.x, sample.y)
      api.engine.setBrushCursor(hit)
      if (painting.current && hit) {
        api.strokeTo({ point: hit.point, normal: hit.normal, pressure: sample.pressure })
      }
    }

    api.engine.update()
  })

  useEffect(() => {
    const element = gl.domElement as HTMLCanvasElement
    if (tool === 'orbit') {
      api.engine.setBrushCursor(null)
      return
    }
    api.setBrush({ erase: tool === 'erase' })
    // Compile the paint pipelines the moment a brush tool is picked, so the
    // first stroke is not swallowed by an in-flight shader compile.
    api.engine.prewarmPainting()

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const hit = hitAt(event.clientX, event.clientY)
      if (!hit) return
      const started = api.beginStroke({ point: hit.point, normal: hit.normal, pressure: event.pressure || 1 })
      if (!started) {
        onPaintBlocked('Select a paint layer, or make the layer mask paintable, before painting.')
        return
      }
      painting.current = true
      pending.current = null
      if (controls.current) controls.current.enabled = false
      element.setPointerCapture(event.pointerId)
      event.preventDefault()
    }

    const onMove = (event: PointerEvent) => {
      // The newest position always wins; the frame loop consumes it. It is
      // recorded whether or not a stroke is in progress, because the brush ring
      // has to follow the pointer before you press too.
      pending.current = { x: event.clientX, y: event.clientY, pressure: event.pressure || 1 }
    }

    const onLeave = () => {
      pending.current = null
      api.engine.setBrushCursor(null)
    }

    const finish = (event: PointerEvent) => {
      if (!painting.current) return
      painting.current = false
      const sample = pending.current
      pending.current = null
      if (sample) {
        const hit = hitAt(sample.x, sample.y)
        if (hit) api.strokeTo({ point: hit.point, normal: hit.normal, pressure: sample.pressure })
      }
      api.endStroke()
      if (controls.current) controls.current.enabled = true
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    }

    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', finish)
    element.addEventListener('pointercancel', finish)
    element.addEventListener('pointerleave', onLeave)
    // The ring shows the footprint, so the OS cursor only gets in the way.
    element.style.cursor = 'none'
    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', finish)
      element.removeEventListener('pointercancel', finish)
      element.removeEventListener('pointerleave', onLeave)
      element.style.cursor = 'grab'
      api.engine.setBrushCursor(null)
      if (controls.current) controls.current.enabled = true
    }
  }, [api, gl, hitAt, tool, onPaintBlocked])

  useEffect(() => {
    const element = gl.domElement as HTMLCanvasElement

    const onDragOver = (event: DragEvent) => {
      if (!isMaterialDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      const hit = hitAt(event.clientX, event.clientY)
      const parts = api.listMeshParts()
      const partId = hit?.partId ?? null
      api.setMaterialDragHover(parts.length >= 2 ? partId : null)
    }

    const onDragLeave = (event: DragEvent) => {
      if (!isMaterialDrag(event)) return
      api.setMaterialDragHover(null)
    }

    const onDrop = (event: DragEvent) => {
      const defId = materialIdFromDrop(event)
      if (!defId) return
      event.preventDefault()
      event.stopPropagation()
      const hit = hitAt(event.clientX, event.clientY)
      const parts = api.listMeshParts()
      const partId = parts.length >= 2 ? (hit?.partId ?? null) : null
      api.dropMaterial(defId, partId)
      api.endMaterialDrag()
    }

    element.addEventListener('dragover', onDragOver)
    element.addEventListener('dragleave', onDragLeave)
    element.addEventListener('drop', onDrop)
    return () => {
      element.removeEventListener('dragover', onDragOver)
      element.removeEventListener('dragleave', onDragLeave)
      element.removeEventListener('drop', onDrop)
    }
  }, [api, gl, hitAt])

  return null
}
