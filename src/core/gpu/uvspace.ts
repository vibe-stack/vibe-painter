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
import type { BufferGeometry, Camera, Material, QuadMesh, Renderer, RenderTarget } from 'three/webgpu'
import { cameraProjectionMatrix, float, uv, vec4 } from 'three/tsl'
import type { V2, V4 } from './nodes'

/** Clip-space position that rasterises a mesh into its own UV layout. */
export function uvClipPosition(uvNode: V2 = uv()): V4 {
  // Same mapping as QuadMesh: a UV-space ortho quad, then the camera
  // projection (so WebGPU's clip convention is applied). Writing NDC by
  // hand skipped that and painted into the UV-v opposite of the click.
  const p = vec4(uvNode.x.mul(2).sub(1), float(1).sub(uvNode.y.mul(2)), 0, 1)
  return cameraProjectionMatrix.mul(p)
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

    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    // `clear` is the whole story about what happens to the target: see
    // `renderQuad` for why `autoClear` cannot be left to decide it.
    renderer.autoClear = false
    renderer.setRenderTarget(target)
    try {
      if (clear) renderer.clear(true, false, false)
      renderer.render(this.scene, this.camera)
    } finally {
      renderer.autoClear = previousAutoClear
      renderer.setRenderTarget(previousTarget)
    }
  }

  dispose(): void {
    this.scene.remove(this.mesh)
  }
}

/**
 * Draws a fullscreen quad into `target`, leaving whatever is already there.
 *
 * `QuadMesh.render()` calls `renderer.render()`, which honours `autoClear` -
 * on by default - and therefore *clears the bound render target before
 * drawing*. For a pass that overwrites every texel that is only wasted
 * bandwidth. For the brush stamp it was fatal: a stroke accumulates its dabs
 * into one buffer with a MAX blend over many draws, and each draw was wiping
 * every dab that came before it. A whole stroke collapsed into whichever
 * handful of dabs the last draw happened to contain - one dab under the
 * cursor, no matter how far you dragged.
 *
 * Every offscreen pass in the paint pipeline goes through here, so no pass can
 * quietly reintroduce that by forgetting.
 */
export function renderQuad(
  renderer: Renderer,
  quad: QuadMesh,
  material: Material,
  target: RenderTarget,
): void {
  const previousTarget = renderer.getRenderTarget()
  const previousAutoClear = renderer.autoClear
  renderer.autoClear = false
  renderer.setRenderTarget(target)
  quad.material = material
  try {
    quad.render(renderer)
  } finally {
    renderer.autoClear = previousAutoClear
    renderer.setRenderTarget(previousTarget)
  }
}

/**
 * Compiles `scene` as it would be drawn into `target`, without leaving that
 * target bound while we wait.
 *
 * The binding matters: pipelines depend on the attachment formats, and MRT
 * outputs are matched to attachments by texture name, so compiling against the
 * canvas produces a different pipeline than the one the pass will use - or no
 * pipeline at all.
 *
 * But `await`ing with a render target bound is a live grenade. The await hands
 * control back to the event loop, the animation frame fires, and the frame
 * renders the whole scene into whichever target happened to be bound - here, a
 * paint buffer. It shows up as a layer that starts life with random coverage
 * across every texel, at full opacity, non-deterministically: the "paint is
 * only half applied" that no amount of staring at the brush maths explains.
 *
 * `compileAsync` reads the bound target synchronously, before its first await,
 * so starting it and restoring the target before awaiting the promise is both
 * correct and the only version that is safe.
 */
export async function compileAgainst(
  renderer: Renderer,
  scene: Scene,
  camera: Camera,
  target: RenderTarget,
): Promise<void> {
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  let pending: Promise<unknown>
  try {
    pending = renderer.compileAsync(scene, camera)
  } finally {
    renderer.setRenderTarget(previous)
  }
  await pending
}

/** Clears a render target without drawing anything into it. */
export function clearTarget(renderer: Renderer, target: RenderTarget): void {
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.clear(true, false, false)
  renderer.setRenderTarget(previous)
}
