/**
 * Initialising paint buffers.
 *
 * A freshly allocated texture is all zeros, and zero is not neutral: a zero
 * normal is degenerate, zero opacity is invisible, zero roughness is a mirror.
 * The compositor multiplies a paint layer by its coverage so unpainted texels
 * *should* not matter - but they still flow through the blend maths, and one
 * bad value is enough to poison the result. So every new buffer is filled with
 * the documented channel defaults instead.
 */

import { MeshBasicNodeMaterial, NoBlending, QuadMesh } from 'three/webgpu'
import type { Renderer } from 'three/webgpu'
import { mrt } from 'three/tsl'
import { defaultBundle } from './nodes'
import { packBundle } from './packing'
import type { PaintBuffer } from './targets'
import { clearTarget } from './uvspace'

let quad: QuadMesh | null = null
let material: MeshBasicNodeMaterial | null = null

function neutralMaterial(): MeshBasicNodeMaterial {
  if (material) return material
  const created = new MeshBasicNodeMaterial()
  created.depthTest = false
  created.depthWrite = false
  created.blending = NoBlending
  created.fragmentNode = mrt(packBundle(defaultBundle()))
  material = created
  return created
}

export function initialisePaintBuffer(renderer: Renderer, buffer: PaintBuffer): void {
  // Coverage genuinely does start at zero: nothing has been painted yet.
  clearTarget(renderer, buffer.coverage.rt)
  if (!buffer.slots) return

  if (!quad) quad = new QuadMesh()
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(buffer.slots.rt)
  quad.material = neutralMaterial()
  quad.render(renderer)
  renderer.setRenderTarget(previous)
}
