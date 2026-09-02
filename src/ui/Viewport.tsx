/**
 * The 3D view.
 *
 * It does three things: give the engine a renderer, run `engine.update()` once
 * per frame before the scene draws, and translate pointer events into strokes.
 *
 * Note that picking goes through `api.raycast()` - the same headless call an
 * agent would use - rather than react-three-fiber's event system. The UI is
 * meant to be one client of the API, not a privileged one.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { ACESFilmicToneMapping, Raycaster, SRGBColorSpace, Vector2, WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { VibePainter } from '../core/api'
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
      className="h-full w-full"
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

function Stage({ api, tool, onPaintBlocked }: ViewportProps & { api: VibePainter }) {
  const { gl, camera, scene, size } = useThree()
  const controls = useRef<OrbitControls | null>(null)
  const painting = useRef(false)
  const raycaster = useMemo(() => new Raycaster(), [])
  const ndc = useMemo(() => new Vector2(), [])

  useEffect(() => {
    return () => {
      scene.remove(api.engine.root)
    }
  }, [api, scene])

  useEffect(() => {
    const instance = new OrbitControls(camera, gl.domElement)
    instance.enableDamping = true
    instance.dampingFactor = 0.08
    instance.minDistance = 0.6
    instance.maxDistance = 20
    controls.current = instance

    const bounds = api.engine.bounds()
    const radius = Math.max(0.5, bounds.radius)
    camera.position.set(radius * 1.1, radius * 0.9, radius * 2.2)
    instance.target.set(0, 0, 0)
    instance.update()

    return () => instance.dispose()
  }, [api, camera, gl])

  useEffect(() => {
    if (controls.current) controls.current.enabled = tool === 'orbit'
  }, [tool])

  // Attach inside the render loop, after the canvas has presented at least
  // once (useEffect runs too early, and Strict Mode would attach/detach
  // before a frame). Parent first so the engine can set scene.environment.
  useFrame(() => {
    if (api.engine.root.parent !== scene) {
      scene.add(api.engine.root)
      api.attachRenderer(gl as unknown as WebGPURenderer)
    }
    controls.current?.update()
    api.engine.update()
  })

  useEffect(() => {
    const element = gl.domElement as HTMLCanvasElement
    if (tool === 'orbit') return

    const hitAt = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      camera.updateMatrixWorld()
      raycaster.setFromCamera(ndc, camera)
      const { origin, direction } = raycaster.ray
      return api.raycast([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z])
    }

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const hit = hitAt(event)
      if (!hit) return
      api.setBrush({ erase: tool === 'erase' })
      const started = api.beginStroke({ point: hit.point, normal: hit.normal, pressure: event.pressure || 1 })
      if (!started) {
        onPaintBlocked('Select a paint layer, or add a paintable mask, before painting.')
        return
      }
      painting.current = true
      element.setPointerCapture(event.pointerId)
      event.preventDefault()
      event.stopPropagation()
    }

    const onMove = (event: PointerEvent) => {
      if (!painting.current) return
      const hit = hitAt(event)
      if (!hit) return
      api.strokeTo({ point: hit.point, normal: hit.normal, pressure: event.pressure || 1 })
    }

    const onUp = (event: PointerEvent) => {
      if (!painting.current) return
      painting.current = false
      api.endStroke()
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    }

    element.addEventListener('pointerdown', onDown, { capture: true })
    element.addEventListener('pointermove', onMove, { capture: true })
    element.addEventListener('pointerup', onUp, { capture: true })
    element.addEventListener('pointercancel', onUp, { capture: true })
    return () => {
      element.removeEventListener('pointerdown', onDown, { capture: true })
      element.removeEventListener('pointermove', onMove, { capture: true })
      element.removeEventListener('pointerup', onUp, { capture: true })
      element.removeEventListener('pointercancel', onUp, { capture: true })
    }
  }, [api, camera, gl, ndc, raycaster, tool, onPaintBlocked])

  useEffect(() => {
    const element = gl.domElement as HTMLCanvasElement
    element.style.cursor = tool === 'orbit' ? 'grab' : 'crosshair'
  }, [gl, tool, size])

  return null
}
