/**
 * The application's single engine instance.
 *
 * Created at module scope rather than inside a component. An object that owns
 * a WebGPU device, a canvas context and tens of megabytes of render targets
 * must not have its lifetime tied to a React render: `useMemo` is a cache, not
 * a guarantee, and any remount - StrictMode, a hot reload, a parent
 * re-render - would either leak a second device or tear down the live one
 * while the viewport still points at it.
 *
 * It is also published on `globalThis`, because the headless API is the point
 * of this project: everything the UI can do is callable from the console, or
 * by an automation driving the page. Start with `vibePainter.describe()`.
 */

import { VibePainter } from '../core/api'

let instance: VibePainter | null = null

export function getSession(): VibePainter {
  if (!instance) {
    instance = VibePainter.create({ name: 'Untitled', resolution: 1024, primitive: 'torus-knot' })
    ;(globalThis as unknown as { vibePainter: VibePainter }).vibePainter = instance
  }
  return instance
}
