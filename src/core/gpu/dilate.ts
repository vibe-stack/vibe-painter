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

import { float, ivec2, max, mix, mrt, step, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { MeshBasicNodeMaterial, NearestFilter, NoBlending, RGBAFormat, RedFormat, RenderTarget, Vector2 } from 'three/webgpu'
import type { Renderer, Texture } from 'three/webgpu'
import { QuadMesh } from 'three/webgpu'
import type { F, V2, V4 } from './nodes'
import { GEOMETRY_MAP_NAMES, ID_MAP_NAME, RAY_MAP_NAME, createRayTarget } from './meshmaps'
import type { MeshMaps } from './meshmaps'
import { SLOT_COUNT, SLOT_NAMES } from '../channels'
import type { PaintBuffer } from '../gpu/targets'
import { CHANNEL_TARGET_OPTIONS, SlotTargets } from '../gpu/targets'
import { Blitter } from './blit'
import { renderQuad } from './uvspace'

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
  /**
   * Optional UV island mask. When given, only texels *outside* an island may
   * be filled.
   *
   * This is the difference between padding and smearing. Without it the pass
   * treats "has paint" as "is valid" and floods paint outward in every
   * direction - across island borders onto entirely different faces, and over
   * unpainted surface inside the same island, growing a little further with
   * every stroke. Gutter texels are the only ones that should ever be invented.
   */
  islandMask: Texture | null = null,
): { outputs: V4[]; coverage: V4 } {
  const uvNode = uv()
  const sampleCoverage = (at: V2): F =>
    coverageSwizzle === 'w' ? texture(coverage, at).w : texture(coverage, at).x

  // Built as a plain expression tree rather than with mutable `toVar`/
  // `addAssign`: TSL only allows assignments inside an `Fn()` stack, and with
  // eight fixed taps there is nothing to gain from a loop variable.
  let weight: F = float(0)
  const accum: V4[] = sources.map(() => vec4(0, 0, 0, 0))

  for (const [dx, dy] of NEIGHBOURS) {
    const sampleUv = uvNode.add(texelSize.mul(vec2(dx, dy)))
    // Weight by coverage so empty neighbours contribute nothing - no branching,
    // and diagonal neighbours fall out of the same expression.
    const w = sampleCoverage(sampleUv).clamp(0, 1)
    weight = weight.add(w)
    sources.forEach((tex, i) => {
      accum[i] = accum[i].add(texture(tex, sampleUv).mul(w))
    })
  }

  const own = sampleCoverage(uvNode)
  const keep = step(float(0.001), own)
  // Only gutter texels are fillable when a mask is supplied.
  const fillable = islandMask
    ? step(texture(islandMask, uvNode).x, float(0.5))
    : float(1)
  // A texel is padded only if it holds nothing, sits outside every island, and
  // has something to copy from. Anything else must come through untouched:
  // this pass invents gutter, it does not get a say about real texels.
  const pad = step(float(1e-5), weight).mul(fillable).mul(keep.oneMinus())
  const padded = pad.greaterThan(float(0.5))

  const outputs = sources.map((tex, i) => {
    const averaged = accum[i].div(max(weight, float(1e-5)))
    const original = texture(tex, uvNode)
    // A branch, not a `mix`. Blending would fold `averaged` into every texel
    // with a weight of zero, and `0 * NaN` is NaN - one bad neighbour would
    // then poison a texel this pass is supposed to leave alone.
    return padded.select(averaged, original) as V4
  })

  // Padding claims a texel outright; everywhere else the coverage that is
  // already there is the answer. Rounding it to 0/1 with a `step` threw away
  // every soft brush edge in the texture and left hard, aliased borders.
  const grown = padded.select(float(1), own) as F
  return { outputs, coverage: vec4(grown, grown, grown, grown) }
}

/**
 * One dilation step for an ID map: copy a neighbour's ID, never blend.
 *
 * Averaging IDs produces values that match no part, which is exactly the
 * stair-stepped halo along every UV island. Alpha is the "this texel was
 * rasterised" flag (part 0 is a real ID, so the index itself cannot be the
 * coverage signal).
 */
function dilateIdNode(source: Texture, texelSize: V2): V4 {
  // Texel fetches, not `texture()`. three's WebGPU path binds a filtering
  // sampler for every texture() node regardless of magFilter, so a bilinear
  // ID read invents values like 1.5 that match no part - and 16 iterations of
  // that is a 16-texel white halo around every UV island.
  const res = float(1).div(texelSize.x.max(1e-8))
  // Same coord convention as the compositor (`ivec2(uv * resolution)`), so a
  // dilated ID lands on the texel the mask will actually fetch.
  const coord = ivec2(uv().mul(res))
  const loadAt = (dx: number, dy: number) => texture(source).load(coord.add(ivec2(dx, dy)))
  const own = loadAt(0, 0)
  let best: V4 = own as unknown as V4
  let bestAlpha: F = own.w
  for (const [dx, dy] of NEIGHBOURS) {
    const sample = loadAt(dx, dy)
    const better = step(bestAlpha.add(1e-4), sample.w)
    best = mix(best, sample, better) as V4
    bestAlpha = mix(bestAlpha, sample.w, better) as F
  }
  const keep = step(float(0.5), own.w)
  const filled = mix(best, own, keep) as V4
  const written = step(float(0.5), filled.w)
  return vec4(filled.x, filled.y, filled.z, written)
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
  #rayMaterial: MeshBasicNodeMaterial | null = null
  #rayScratch: RenderTarget | null = null
  #compositeMaterial: MeshBasicNodeMaterial | null = null
  #idMaterialFwd: MeshBasicNodeMaterial | null = null
  #idMaterialBack: MeshBasicNodeMaterial | null = null
  #idScratch: RenderTarget | null = null
  #sourceKey = ''
  #blitter = new Blitter()

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
      renderQuad(renderer, this.#quad, this.#geometryMaterial, scratch)
      // Blit rather than copyTextureToTexture: this has to land on exactly the
      // texels the dilation shader read, and a render pass shares its UV
      // convention with every other pass by construction.
      this.#blitter.blit(renderer, scratch.textures, maps.geometry, GEOMETRY_MAP_NAMES)
    }
  }

  /**
   * Floods each source-mesh part ID into the UV gutter by copying, not
   * averaging. Without this the compositor mask is 0 on every island border
   * (standard rasterisation misses pixel centres) and bilinear filtering of
   * the composite shows it as a stepped halo.
   */
  dilateId(renderer: Renderer, maps: MeshMaps, iterations: number): void {
    if (iterations <= 0) return
    const res = maps.resolution
    this.#texelSize.value.set(1 / res, 1 / res)
    const scratch = this.#ensureIdScratch(res)
    const fwd = this.#ensureIdMaterial(maps.idMap.texture, 'fwd')
    const back = this.#ensureIdMaterial(scratch.texture, 'back')
    // First write is drawn twice: WebGPU skips the first draw of a new
    // pipeline, and a skipped write into scratch followed by a blit would
    // wipe the rasterised ID map.
    renderQuad(renderer, this.#quad, fwd, scratch)
    renderQuad(renderer, this.#quad, fwd, scratch)
    renderQuad(renderer, this.#quad, back, maps.idMap)
    for (let i = 1; i < iterations; i++) {
      renderQuad(renderer, this.#quad, fwd, scratch)
      renderQuad(renderer, this.#quad, back, maps.idMap)
    }
  }

  #ensureIdMaterial(source: Texture, tag: string): MeshBasicNodeMaterial {
    const existing = tag === 'fwd' ? this.#idMaterialFwd : this.#idMaterialBack
    const key = `${tag}:${source.id}`
    if (existing && existing.userData.key === key) return existing
    existing?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    material.fragmentNode = dilateIdNode(source, this.#texelSize)
    material.userData.key = key
    if (tag === 'fwd') this.#idMaterialFwd = material
    else this.#idMaterialBack = material
    return material
  }

  /**
   * Grows AO / curvature / thickness into the UV gutter.
   *
   * No island mask here, unlike paint. The mask lives at the texture set's
   * resolution while the mesh maps bake at their own - tracing is quadratic in
   * that, so they are usually smaller - and a mask sampled at the wrong scale
   * answers "is this texel surface?" a texel out at every chart border. That
   * gate would then refuse to pad exactly the texels that most need it, leaving
   * an undilated rim tracing every island. The ray map carries its own coverage
   * in alpha, written by the same raster that produced its values, so it is
   * both authoritative and at the right resolution by construction.
   */
  dilateRay(renderer: Renderer, maps: MeshMaps, iterations: number): void {
    if (iterations <= 0 || !maps.rayBaked) return
    const res = maps.ray.width
    this.#texelSize.value.set(1 / res, 1 / res)
    const scratch = this.#ensureRayScratch(res)
    const key = `ray:${maps.ray.texture.id}`
    if (!this.#rayMaterial || this.#sourceKey !== key) {
      this.#rayMaterial?.dispose()
      const material = new MeshBasicNodeMaterial()
      material.depthTest = false
      material.depthWrite = false
      material.blending = NoBlending
      const { outputs } = dilateNode([maps.ray.texture], maps.ray.texture, 'w', this.#texelSize)
      material.fragmentNode = outputs[0]
      this.#rayMaterial = material
      this.#sourceKey = key
    }
    for (let i = 0; i < iterations; i++) {
      renderQuad(renderer, this.#quad, this.#rayMaterial, scratch)
      this.#blitter.blit(renderer, [scratch.texture], maps.ray, [RAY_MAP_NAME])
    }
  }

  /**
   * Pads the composited maps into the UV gutter.
   *
   * The compositor writes a fullscreen UV pass; mesh vertices on an island
   * border bilinear-sample the texel *outside* the triangle. Without this,
   * every UV chart edge — part seams, unique-unwrap cuts, painted islands —
   * shows up as a stepped halo, independent of ID masks.
   */
  dilateComposite(renderer: Renderer, slots: SlotTargets, islandMask: Texture, iterations: number): void {
    if (iterations <= 0) return
    const res = slots.resolution
    this.#texelSize.value.set(1 / res, 1 / res)
    const scratch = this.#ensureSlotScratch(res)
    const material = this.#ensureCompositeMaterial(slots, islandMask)
    renderQuad(renderer, this.#quad, material, scratch.rt)
    renderQuad(renderer, this.#quad, material, scratch.rt)
    this.#blitter.blit(renderer, scratch.rt.textures, slots.rt, SLOT_NAMES)
    for (let i = 1; i < iterations; i++) {
      renderQuad(renderer, this.#quad, material, scratch.rt)
      this.#blitter.blit(renderer, scratch.rt.textures, slots.rt, SLOT_NAMES)
    }
  }

  /** Same, for a painted layer's channel slots and its coverage mask. */
  dilatePaint(renderer: Renderer, buffer: PaintBuffer, iterations: number, islandMask: Texture | null = null): void {
    if (iterations <= 0) return
    const res = buffer.resolution
    this.#texelSize.value.set(1 / res, 1 / res)

    if (buffer.slots) {
      const scratch = this.#ensureSlotScratch(res)
      const material = this.#ensureSlotMaterial(buffer, islandMask)
      const coverageScratch = this.#ensureCoverageScratch(res)
      const coverageMaterial = this.#ensureCoverageMaterial(buffer, islandMask)
      for (let i = 0; i < iterations; i++) {
        renderQuad(renderer, this.#quad, material, scratch.rt)
        renderQuad(renderer, this.#quad, coverageMaterial, coverageScratch)
        this.#blitter.blit(renderer, scratch.rt.textures, buffer.slots.rt, SLOT_NAMES)
        this.#blitter.blit(renderer, [coverageScratch.texture], buffer.coverage.rt, ['coverage'])
      }
    } else {
      const coverageScratch = this.#ensureCoverageScratch(res)
      const coverageMaterial = this.#ensureCoverageMaterial(buffer, islandMask)
      for (let i = 0; i < iterations; i++) {
        renderQuad(renderer, this.#quad, coverageMaterial, coverageScratch)
        this.#blitter.blit(renderer, [coverageScratch.texture], buffer.coverage.rt, ['coverage'])
      }
    }
  }

  #ensureGeometryScratch(res: number): RenderTarget {
    if (this.#geometryScratch && this.#geometryScratch.width === res) return this.#geometryScratch
    this.#geometryScratch?.dispose()
    // Must match the geometry maps exactly: a texture-to-texture copy is only
    // valid between identical formats.
    const rt = new RenderTarget(res, res, {
      ...CHANNEL_TARGET_OPTIONS,
      format: RGBAFormat,
      count: GEOMETRY_MAP_NAMES.length,
    })
    GEOMETRY_MAP_NAMES.forEach((n, i) => {
      rt.textures[i].name = n
    })
    this.#geometryScratch = rt
    return rt
  }

  #ensureRayScratch(res: number): RenderTarget {
    if (this.#rayScratch && this.#rayScratch.width === res) return this.#rayScratch
    this.#rayScratch?.dispose()
    this.#rayScratch = createRayTarget(res, 'dilateRay')
    return this.#rayScratch
  }

  #ensureSlotScratch(res: number): SlotTargets {
    if (this.#slotScratch && this.#slotScratch.resolution === res) return this.#slotScratch
    this.#slotScratch?.dispose()
    this.#slotScratch = new SlotTargets(res, 'dilate')
    return this.#slotScratch
  }

  #ensureIdScratch(res: number): RenderTarget {
    if (this.#idScratch && this.#idScratch.width === res) return this.#idScratch
    this.#idScratch?.dispose()
    const rt = new RenderTarget(res, res, {
      ...CHANNEL_TARGET_OPTIONS,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    })
    rt.texture.name = ID_MAP_NAME
    this.#idScratch = rt
    return rt
  }

  #ensureCoverageScratch(res: number): RenderTarget {
    if (this.#coverageScratch && this.#coverageScratch.width === res) return this.#coverageScratch
    this.#coverageScratch?.dispose()
    this.#coverageScratch = new RenderTarget(res, res, { ...CHANNEL_TARGET_OPTIONS, format: RedFormat })
    this.#coverageScratch.texture.name = 'dilateCoverage'
    return this.#coverageScratch
  }

  #ensureCompositeMaterial(slots: SlotTargets, islandMask: Texture): MeshBasicNodeMaterial {
    const key = `comp:${slots.texture(0).id}:${islandMask.id}`
    if (this.#compositeMaterial && this.#compositeMaterial.userData.key === key) return this.#compositeMaterial
    this.#compositeMaterial?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const textures = Array.from({ length: SLOT_COUNT }, (_, i) => slots.texture(i))
    // Island mask is both "what is a valid source" and "only fill the gutter".
    const { outputs } = dilateNode(textures, islandMask, 'x', this.#texelSize, islandMask)
    material.fragmentNode = mrt(Object.fromEntries(SLOT_NAMES.map((n, i) => [n, outputs[i]])))
    material.userData.key = key
    this.#compositeMaterial = material
    return material
  }

  #ensureSlotMaterial(buffer: PaintBuffer, islandMask: Texture | null): MeshBasicNodeMaterial {
    const slots = buffer.slots!
    const key = `slots:${slots.texture(0).id}:${islandMask?.id ?? 'none'}`
    if (this.#slotMaterial && this.#slotMaterial.userData.key === key) return this.#slotMaterial
    this.#slotMaterial?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const textures = Array.from({ length: SLOT_COUNT }, (_, i) => slots.texture(i))
    const { outputs } = dilateNode(textures, buffer.coverage.texture, 'x', this.#texelSize, islandMask)
    material.fragmentNode = mrt(Object.fromEntries(SLOT_NAMES.map((n, i) => [n, outputs[i]])))
    material.userData.key = key
    this.#slotMaterial = material
    return material
  }

  #ensureCoverageMaterial(buffer: PaintBuffer, islandMask: Texture | null): MeshBasicNodeMaterial {
    const key = `cov:${buffer.coverage.texture.id}:${islandMask?.id ?? 'none'}`
    if (this.#coverageMaterial && this.#coverageMaterial.userData.key === key) return this.#coverageMaterial
    this.#coverageMaterial?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const { coverage } = dilateNode([buffer.coverage.texture], buffer.coverage.texture, 'x', this.#texelSize, islandMask)
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
    this.#rayMaterial?.dispose()
    this.#rayScratch?.dispose()
    this.#compositeMaterial?.dispose()
    this.#idMaterialFwd?.dispose()
    this.#idMaterialBack?.dispose()
    this.#idScratch?.dispose()
    this.#blitter.dispose()
  }
}
