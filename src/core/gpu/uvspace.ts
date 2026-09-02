/**
 * Rendering *into* UV space.
 *
 * The core trick behind both baking and painting: draw the mesh with a vertex
 * stage that outputs its UV coordinate as the clip position instead of the
 * camera projection. Every triangle then lands on the texel it owns, and the
 * fragment stage still receives interpolated world position, normal and
 * tangent as varyings - so it can ask 3D questions while writing 2D pixels.
 *
 * The Y term matches three's own fullscreen-quad convention (clip.y = +1 is
 * uv.y = 0), which three normalises across its WebGPU and WebGL backends. Get
 * it wrong and every bake comes out vertically mirrored.
 */

import { OrthographicCamera, Scene, Mesh, DoubleSide } from 'three/webgpu'
import type { BufferGeometry, Material, Renderer, RenderTarget } from 'three/webgpu'
import { float, uv, vec4 } from 'three/tsl'
import type { V2, V4 } from './nodes'

/** Clip-space position that rasterises a mesh into its own UV layout. */
export function uvClipPosition(uvNode: V2 = uv()): V4 {
  return vec4(uvNode.x.mul(2).sub(1), float(1).sub(uvNode.y.mul(2)), 0, 1)
}

/**
 * Reusable scene for UV-space passes. Holds its own Mesh so the viewport's
 * mesh is never re-parented or given a different material mid-frame.
 */
export class UVSpacePass {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  readonly mesh: Mesh

  constructor() {
    this.mesh = new Mesh()
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.scene.add(this.mesh)
  }

  /**
   * Renders `geometry` with `material` into `target`.
   *
   * `clear` is separate from the draw because painting accumulates many stamps
   * into the same target across a stroke.
   */
  render(
    renderer: Renderer,
    geometry: BufferGeometry,
    material: Material,
    target: RenderTarget,
    clear: boolean,
  ): void {
    this.mesh.geometry = geometry
    this.mesh.material = material
    material.side = DoubleSide

    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    if (clear) renderer.clear(true, false, false)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(previous)
  }

  dispose(): void {
    this.scene.remove(this.mesh)
  }
}

/** Clears a render target without drawing anything into it. */
export function clearTarget(renderer: Renderer, target: RenderTarget): void {
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.clear(true, false, false)
  renderer.setRenderTarget(previous)
}
