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

export type Tool = 'orbit' | 'paint' | 'erase'

interface ViewportProps {
  tool: Tool
  onPaintBlocked: (reason: string) => void
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

    const radius = Math.max(0.5, api.engine.bounds().radius)
    camera.position.set(radius * 1.1, radius * 0.9, radius * 2.2)
    instance.target.set(0, 0, 0)
    instance.update()

    return () => instance.dispose()
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

  return null
}
