/**
 * UV island dilation ("padding").
 *
 * A texel just outside a UV island holds nothing, but bilinear filtering in
 * the viewport - and mipmapping in any engine you export to - will happily
 * sample it, which shows up as dark seams along every island border. The fix
 * is to flood the nearest island value outward a few texels.
 *
 * Implemented as an iterative ping-pong: each pass grows the filled region by
 * one texel, using the coverage channel to decide what is real. Coverage grows
 * with the fill, so the next iteration can push out from what the last one
 * wrote.
 */

import { float, max, mix, step, texture, uniform, vec2, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, NoBlending, RenderTarget, Vector2 } from 'three/webgpu'
import type { Renderer, Texture } from 'three/webgpu'
import { QuadMesh } from 'three/webgpu'
import { mrt, uv } from 'three/tsl'
import type { F, V2, V4 } from './nodes'
import { GEOMETRY_MAP_NAMES } from './meshmaps'
import type { MeshMaps } from './meshmaps'
import { SLOT_COUNT, SLOT_NAMES } from '../channels'
import type { PaintBuffer } from '../gpu/targets'
import { SlotTargets } from '../gpu/targets'

const NEIGHBOURS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
]

/**
 * One dilation step for a set of textures that share a coverage channel.
 *
 * `coverageOf` says where the "is this texel real" signal lives, because the
 * geometry maps carry it in the alpha of their position map while paint
 * buffers keep it in a dedicated single-channel target.
 */
function dilateNode(
  sources: Texture[],
  coverage: Texture,
  coverageSwizzle: 'w' | 'x',
  texelSize: V2,
): { outputs: V4[]; coverage: V4 } {
  const uvNode = uv()
  const sampleCoverage = (at: V2): F =>
    coverageSwizzle === 'w' ? texture(coverage, at).w : texture(coverage, at).x

  const accum = sources.map(() => vec4(0, 0, 0, 0).toVar())
  const weight = float(0).toVar('dilateWeight')

  for (const [dx, dy] of NEIGHBOURS) {
    const sampleUv = uvNode.add(texelSize.mul(vec2(dx, dy)))
    // Weight by coverage so empty neighbours contribute nothing - no branching,
    // and diagonal neighbours fall out of the same expression.
    const w = sampleCoverage(sampleUv).clamp(0, 1)
    weight.addAssign(w)
    sources.forEach((tex, i) => {
      accum[i].addAssign(texture(tex, sampleUv).mul(w))
    })
  }

  const keep = step(float(0.001), sampleCoverage(uvNode))
  const hasNeighbours = step(float(1e-5), weight)

  const outputs = sources.map((tex, i) => {
    const averaged = accum[i].div(max(weight, float(1e-5))).mul(hasNeighbours)
    const original = texture(tex, uvNode)
    return mix(averaged, original, keep) as V4
  })

  const grown = max(keep, hasNeighbours)
  return { outputs, coverage: vec4(grown, grown, grown, grown) }
}

export class Dilator {
  #quad = new QuadMesh()
  #texelSize = uniform(new Vector2(1 / 1024, 1 / 1024))
  #geometryMaterial: MeshBasicNodeMaterial | null = null
  #geometryScratch: RenderTarget | null = null
  #slotMaterial: MeshBasicNodeMaterial | null = null
  #slotScratch: SlotTargets | null = null
  #coverageMaterial: MeshBasicNodeMaterial | null = null
  #coverageScratch: RenderTarget | null = null
  #sourceKey = ''

  /** Grows the geometry maps outward so filtering never reads empty gutter. */
  dilateGeometry(renderer: Renderer, maps: MeshMaps, iterations: number): void {
    if (iterations <= 0) return
    const res = maps.resolution
    this.#texelSize.value.set(1 / res, 1 / res)

    const scratch = this.#ensureGeometryScratch(res)
    const key = `geom:${maps.geometry.textures.map((t) => t.id).join(',')}`
    if (!this.#geometryMaterial || this.#sourceKey !== key) {
      this.#geometryMaterial?.dispose()
      const material = new MeshBasicNodeMaterial()
      material.depthTest = false
      material.depthWrite = false
      material.blending = NoBlending
      const { outputs } = dilateNode(maps.geometry.textures, maps.geometry.textures[0], 'w', this.#texelSize)
      material.fragmentNode = mrt(Object.fromEntries(GEOMETRY_MAP_NAMES.map((n, i) => [n, outputs[i]])))
      this.#geometryMaterial = material
      this.#sourceKey = key
    }

    for (let i = 0; i < iterations; i++) {
      this.#renderQuad(renderer, this.#geometryMaterial, scratch)
      for (let t = 0; t < maps.geometry.textures.length; t++) {
        renderer.copyTextureToTexture(scratch.textures[t], maps.geometry.textures[t])
      }
    }
  }

  /** Same, for a painted layer's channel slots and its coverage mask. */
  dilatePaint(renderer: Renderer, buffer: PaintBuffer, iterations: number): void {
    if (iterations <= 0) return
    const res = buffer.resolution
    this.#texelSize.value.set(1 / res, 1 / res)

    if (buffer.slots) {
      const scratch = this.#ensureSlotScratch(res)
      const material = this.#ensureSlotMaterial(buffer)
      const coverageScratch = this.#ensureCoverageScratch(res)
      const coverageMaterial = this.#ensureCoverageMaterial(buffer)
      for (let i = 0; i < iterations; i++) {
        this.#renderQuad(renderer, material, scratch.rt)
        this.#renderQuad(renderer, coverageMaterial, coverageScratch)
        for (let s = 0; s < SLOT_COUNT; s++) {
          renderer.copyTextureToTexture(scratch.texture(s), buffer.slots.texture(s))
        }
        renderer.copyTextureToTexture(coverageScratch.texture, buffer.coverage.texture)
      }
    } else {
      const coverageScratch = this.#ensureCoverageScratch(res)
      const coverageMaterial = this.#ensureCoverageMaterial(buffer)
      for (let i = 0; i < iterations; i++) {
        this.#renderQuad(renderer, coverageMaterial, coverageScratch)
        renderer.copyTextureToTexture(coverageScratch.texture, buffer.coverage.texture)
      }
    }
  }

  #renderQuad(renderer: Renderer, material: MeshBasicNodeMaterial, target: RenderTarget): void {
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    this.#quad.material = material
    this.#quad.render(renderer)
    renderer.setRenderTarget(previous)
  }

  #ensureGeometryScratch(res: number): RenderTarget {
    if (this.#geometryScratch && this.#geometryScratch.width === res) return this.#geometryScratch
    this.#geometryScratch?.dispose()
    const rt = new RenderTarget(res, res, {
      count: GEOMETRY_MAP_NAMES.length,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    })
    GEOMETRY_MAP_NAMES.forEach((n, i) => {
      rt.textures[i].name = n
    })
    this.#geometryScratch = rt
    return rt
  }

  #ensureSlotScratch(res: number): SlotTargets {
    if (this.#slotScratch && this.#slotScratch.resolution === res) return this.#slotScratch
    this.#slotScratch?.dispose()
    this.#slotScratch = new SlotTargets(res, 'dilate')
    return this.#slotScratch
  }

  #ensureCoverageScratch(res: number): RenderTarget {
    if (this.#coverageScratch && this.#coverageScratch.width === res) return this.#coverageScratch
    this.#coverageScratch?.dispose()
    this.#coverageScratch = new RenderTarget(res, res, { depthBuffer: false, stencilBuffer: false, generateMipmaps: false })
    this.#coverageScratch.texture.name = 'dilateCoverage'
    return this.#coverageScratch
  }

  #ensureSlotMaterial(buffer: PaintBuffer): MeshBasicNodeMaterial {
    const slots = buffer.slots!
    const key = `slots:${slots.texture(0).id}`
    if (this.#slotMaterial && this.#slotMaterial.userData.key === key) return this.#slotMaterial
    this.#slotMaterial?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const textures = Array.from({ length: SLOT_COUNT }, (_, i) => slots.texture(i))
    const { outputs } = dilateNode(textures, buffer.coverage.texture, 'x', this.#texelSize)
    material.fragmentNode = mrt(Object.fromEntries(SLOT_NAMES.map((n, i) => [n, outputs[i]])))
    material.userData.key = key
    this.#slotMaterial = material
    return material
  }

  #ensureCoverageMaterial(buffer: PaintBuffer): MeshBasicNodeMaterial {
    const key = `cov:${buffer.coverage.texture.id}`
    if (this.#coverageMaterial && this.#coverageMaterial.userData.key === key) return this.#coverageMaterial
    this.#coverageMaterial?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const { coverage } = dilateNode([buffer.coverage.texture], buffer.coverage.texture, 'x', this.#texelSize)
    material.fragmentNode = coverage
    material.userData.key = key
    this.#coverageMaterial = material
    return material
  }

  dispose(): void {
    this.#geometryMaterial?.dispose()
    this.#geometryScratch?.dispose()
    this.#slotMaterial?.dispose()
    this.#slotScratch?.dispose()
    this.#coverageMaterial?.dispose()
    this.#coverageScratch?.dispose()
  }
}
