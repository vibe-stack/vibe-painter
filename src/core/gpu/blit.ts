/**
 * Explicit texture-to-texture copies, done as render passes.
 *
 * `renderer.copyTextureToTexture` looks like the obvious tool here, but it is
 * the one operation in the paint path that does not go through the normal
 * render pipeline, and it carries backend-specific assumptions about row order
 * and format compatibility. A fullscreen blit uses exactly the same path as the
 * compositor and the brush commit, so it cannot disagree with them about which
 * texel is which - and when the whole design depends on several passes sharing
 * one UV convention, "cannot disagree" is worth more than the cycles saved.
 */

import { MeshBasicNodeMaterial, NoBlending, QuadMesh, Scene } from 'three/webgpu'
import type { Renderer, RenderTarget, Texture } from 'three/webgpu'
import { mrt, texture, uv, vec4 } from 'three/tsl'
import { renderQuad } from './uvspace'

export class Blitter {
  #quad = new QuadMesh()
  #scene = new Scene()
  #materials = new Map<string, MeshBasicNodeMaterial>()

  /**
   * Copies `sources` into `destination`, matching them up by index.
   *
   * `names` are the MRT attachment names of the destination, which must be the
   * names its textures carry - that is how three routes a fragment output to an
   * attachment.
   */
  blit(renderer: Renderer, sources: readonly Texture[], destination: RenderTarget, names: readonly string[]): void {
    if (sources.length === 0) return
    renderQuad(renderer, this.#quad, this.#materialFor(sources, names), destination)
  }

  /**
   * A blit is a straight read: the source is sampled at the very uv the
   * destination fragment is being written at, with no flip on either side.
   * See `sampling.ts` - that is the one UV convention every pass here shares,
   * and a copy that quietly mirrored its input would corrupt the stroke
   * baseline on every press.
   */
  #materialFor(sources: readonly Texture[], names: readonly string[]): MeshBasicNodeMaterial {
    const key = sources.map((t) => t.id).join(',') + '|' + names.join(',')
    const cached = this.#materials.get(key)
    if (cached) return cached

    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const uvNode = uv()
    material.fragmentNode =
      sources.length === 1
        ? vec4(texture(sources[0], uvNode))
        : mrt(Object.fromEntries(sources.map((tex, i) => [names[i], vec4(texture(tex, uvNode))])))
    this.#materials.set(key, material)
    return material
  }

  /**
   * Precompiles a blit's pipeline so the first use is not silently skipped.
   *
   * The destination stays bound across `compileAsync`, because MRT outputs are
   * matched to attachments by texture name: compile against the canvas instead
   * and every output is dropped, producing an empty output struct and a WGSL
   * error rather than a working pipeline. The quad has to be *in* the scene
   * being compiled, too - compiling an empty scene succeeds and warms nothing.
   */
  async prewarm(renderer: Renderer, sources: readonly Texture[], destination: RenderTarget, names: readonly string[]): Promise<void> {
    if (sources.length === 0) return
    const previous = renderer.getRenderTarget()
    this.#quad.material = this.#materialFor(sources, names)
    this.#scene.add(this.#quad)
    renderer.setRenderTarget(destination)
    try {
      await renderer.compileAsync(this.#scene, this.#quad.camera)
    } finally {
      this.#scene.remove(this.#quad)
      renderer.setRenderTarget(previous)
    }
    this.blit(renderer, sources, destination, names)
  }

  dispose(): void {
    for (const material of this.#materials.values()) material.dispose()
    this.#materials.clear()
  }
}
