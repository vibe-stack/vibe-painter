/**
 * The compositor: flattens the layer stack into the packed channel targets.
 *
 * Substance Painter evaluates its stack bottom-up with a cached flatten per
 * layer, so editing a top layer never re-runs the ones below. We do something
 * different on purpose: the whole stack is *fused into one shader* and drawn in
 * a single MRT pass.
 *
 * Why fuse rather than cache per layer? At the scale a browser session actually
 * works at - one texture set, 1-2K, tens of layers - a single fullscreen pass
 * costs well under a millisecond, while per-layer caching would need one render
 * target pair per layer and a ping-pong for every one of them. Painter's design
 * pays off at 4K/8K with UDIMs and fifty layers, which is exactly where a web
 * app is not. The stack walk below is still bottom-up and still per layer, so
 * inserting cache breaks later is a local change.
 *
 * The cost of fusing is that structural edits recompile a shader. That is why
 * `bindings.ts` pushes everything continuous into uniforms.
 */

import { MeshBasicNodeMaterial, NoBlending, QuadMesh } from 'three/webgpu'
import type { Renderer } from 'three/webgpu'
import { float, mix, mrt, normalize, uv, vec3 } from 'three/tsl'
import { CHANNEL_LIST } from '../channels'
import type { LayerState, TextureSetState } from '../doc/types'
import { channelSettings } from '../doc/document'
import { getGeneratorDef } from '../procedural/generators'
import { getMaterialDef } from '../procedural/material'
import { buildProjected } from '../procedural/projection'
import type { ProjectionNodes } from '../procedural/projection'
import { blendFloat, combineChannel } from './blend'
import type { LayerBindings } from './bindings'
import { LayerBindings as Bindings } from './bindings'
import type { MeshMaps } from './meshmaps'
import type { ChannelBundle, F, V2, V3 } from './nodes'
import { defaultBundle } from './nodes'
import { packBundle, unpackSlots } from './packing'
import type { PaintBuffer } from './targets'
import { SlotTargets } from './targets'
import { blurredCoverage } from './sampling'

interface BuildContext {
  uv: V2
  texel: F
  maps: MeshMaps
  mapNodes: ReturnType<MeshMaps['nodes']>
  buffers: Map<string, PaintBuffer>
}

export class Compositor {
  readonly output: SlotTargets
  #quad = new QuadMesh()
  #material: MeshBasicNodeMaterial | null = null
  #bindings = new Map<string, LayerBindings>()
  #structureKey = ''
  #needsRebuild = true
  #needsComposite = true
  /** Extra draws after a shader rebuild. WebGPU skips the first draw of a new pipeline. */
  #rebuildDraws = 0

  constructor(resolution: number) {
    this.output = new SlotTargets(resolution, 'composite')
  }

  get resolution(): number {
    return this.output.resolution
  }

  setResolution(resolution: number): void {
    if (resolution === this.output.resolution) return
    this.output.setSize(resolution)
    this.#needsRebuild = true
    this.#needsComposite = true
  }

  /** Marks the composite stale without touching the graph. */
  invalidate(): void {
    this.#needsComposite = true
  }

  /** Forces a shader rebuild, e.g. after mesh maps are (re)bound. */
  invalidateGraph(): void {
    this.#needsRebuild = true
    this.#needsComposite = true
  }

  get dirty(): boolean {
    return this.#needsComposite
  }

  /**
   * Reconciles uniform bindings with the document and decides whether the
   * change was structural.
   */
  sync(set: TextureSetState): void {
    const seen = new Set<string>()
    walk(set.layers, (layer) => {
      seen.add(layer.id)
      let binding = this.#bindings.get(layer.id)
      if (!binding) {
        binding = new Bindings(layer.id)
        this.#bindings.set(layer.id, binding)
      }
      binding.sync(layer)
    })
    for (const id of [...this.#bindings.keys()]) if (!seen.has(id)) this.#bindings.delete(id)

    const key = structureKey(set)
    if (key !== this.#structureKey) {
      this.#structureKey = key
      this.#needsRebuild = true
    }
    this.#needsComposite = true
  }

  /** Composites, if anything changed since the last call. */
  render(renderer: Renderer, set: TextureSetState, maps: MeshMaps, buffers: Map<string, PaintBuffer>): boolean {
    if (this.#needsRebuild || !this.#material) {
      this.#rebuild(set, maps, buffers)
      this.#needsRebuild = false
      // The new pipeline's first draw is skipped; autoClear would leave the
      // target black and a single composite would never recover.
      this.#rebuildDraws = 3
    }
    if (!this.#needsComposite && this.#rebuildDraws === 0) return false

    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.output.rt)
    this.#quad.material = this.#material!
    this.#quad.render(renderer)
    renderer.setRenderTarget(previous)
    this.#needsComposite = false
    if (this.#rebuildDraws > 0) {
      this.#rebuildDraws--
      if (this.#rebuildDraws > 0) this.#needsComposite = true
    }
    return true
  }

  #rebuild(set: TextureSetState, maps: MeshMaps, buffers: Map<string, PaintBuffer>): void {
    this.#material?.dispose()
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    const uvNode = uv()
    const ctx: BuildContext = {
      uv: uvNode,
      texel: float(1 / Math.max(1, set.resolution)),
      maps,
      mapNodes: maps.nodes(uvNode),
      buffers,
    }

    const result = this.#evalStack(set.layers, defaultBundle(), ctx)
    // Normals must leave the compositor unit length: layers blend them with
    // RNM and with plain lerps, and neither preserves magnitude.
    const normalised: ChannelBundle = { ...result, normal: normalize(result.normal) }
    material.fragmentNode = mrt(packBundle(normalised))
    this.#material = material
  }

  /** Bottom-up walk. `base` is what this stack composites on top of. */
  #evalStack(layers: LayerState[], base: ChannelBundle, ctx: BuildContext): ChannelBundle {
    let dst = base
    for (const layer of layers) {
      if (!layer.visible) continue
      const binding = this.#bindings.get(layer.id)
      if (!binding) continue

      let amount: F = binding.opacity.mul(this.#maskValue(layer, binding, ctx))
      let src: ChannelBundle | null = null

      if (layer.kind === 'folder') {
        // Pass-through grouping: children composite against what is already
        // below, then the whole group is masked in as a unit. That keeps blend
        // modes inside the folder meaningful, which an isolated group loses.
        src = this.#evalStack(layer.children, dst, ctx)
      } else if (layer.kind === 'fill') {
        const def = getMaterialDef(layer.material.defId)
        if (def) {
          const nodes: ProjectionNodes = {
            scale: binding.projScale,
            offset: binding.projOffset,
            rotation: binding.projRotation,
            sharpness: binding.projSharpness,
          }
          src = buildProjected({
            def,
            params: binding.materialParams,
            mode: layer.projection.mode,
            axis: axisIndex(layer.projection.axis),
            nodes,
            maps: ctx.mapNodes,
            uv: ctx.uv,
          })
        }
      } else {
        const buffer = ctx.buffers.get(layer.paintBufferId)
        if (buffer?.slots) {
          src = unpackSlots(buffer.slots.rt.textures, ctx.uv, true)
          // Painted pixels only exist where the brush actually landed.
          amount = amount.mul(coverageOf(buffer, ctx))
        }
      }

      if (src) dst = combineBundles(dst, src, amount, layer, binding)
    }
    return dst
  }

  #maskValue(layer: LayerState, binding: LayerBindings, ctx: BuildContext): F {
    const mask = layer.mask
    if (!mask || !mask.enabled) return float(1)

    let value: F = binding.maskBase
    for (const gen of mask.generators) {
      if (!gen.enabled) continue
      const def = getGeneratorDef(gen.type)
      const genBinding = binding.generators.get(gen.id)
      if (!def || !genBinding) continue
      let contribution = def.build({
        uv: ctx.uv,
        texel: ctx.texel,
        params: genBinding.params,
        meshMaps: ctx.mapNodes,
      })
      contribution = genBinding.levels.apply(contribution)
      if (gen.invert) contribution = contribution.oneMinus()
      value = mix(value, blendFloat(gen.blend, value, contribution), genBinding.opacity)
    }

    if (mask.paintBufferId) {
      const buffer = ctx.buffers.get(mask.paintBufferId)
      if (buffer) {
        const painted = mask.blur > 0
          ? blurredCoverage(buffer.coverage.texture, ctx.uv, binding.maskBlur.mul(ctx.texel), true)
          : coverageOf(buffer, ctx)
        value = blendFloat(mask.paintBlend, value, painted)
      }
    }

    value = binding.maskLevels.apply(value)
    if (mask.invert) value = value.oneMinus()
    return value.clamp(0, 1)
  }

  dispose(): void {
    this.#material?.dispose()
    this.output.dispose()
  }
}

// ---------------------------------------------------------------------------

function coverageOf(buffer: PaintBuffer, ctx: BuildContext): F {
  return blurredCoverage(buffer.coverage.texture, ctx.uv, null, true)
}

function axisIndex(axis: 'x' | 'y' | 'z'): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2
}

/**
 * Blends one layer's bundle into the accumulated result, channel by channel.
 * Per-channel blend modes and opacities are the reason a single stroke can
 * make something rougher *and* darker *and* raised, all with different curves.
 */
function combineBundles(
  dst: ChannelBundle,
  src: ChannelBundle,
  amount: F,
  layer: LayerState,
  binding: LayerBindings,
): ChannelBundle {
  const out: ChannelBundle = { ...dst }
  for (const info of CHANNEL_LIST) {
    const settings = channelSettings(layer, info.id)
    if (!settings.enabled) continue
    const channelAmount = amount.mul(binding.channelOpacity[info.id])
    const isNormal = info.id === 'normal'

    if (info.components === 3) {
      out[info.id] = combineChannel(
        settings.blend,
        dst[info.id] as V3,
        src[info.id] as V3,
        channelAmount,
        isNormal,
      ) as never
    } else {
      const blended = combineChannel(
        settings.blend,
        vec3(dst[info.id] as F),
        vec3(src[info.id] as F),
        channelAmount,
        false,
      )
      out[info.id] = blended.x as never
    }
  }
  return out
}

function walk(layers: LayerState[], visit: (layer: LayerState) => void): void {
  for (const layer of layers) {
    visit(layer)
    if (layer.kind === 'folder') walk(layer.children, visit)
  }
}

/**
 * A fingerprint of everything that changes the *shape* of the graph. If this
 * string is unchanged, a document edit is guaranteed to be uniform-only.
 */
function structureKey(set: TextureSetState): string {
  const parts: string[] = [`res:${set.resolution}`]
  const encode = (layers: LayerState[], depth: number) => {
    for (const layer of layers) {
      const channels = CHANNEL_LIST.map((info) => {
        const s = channelSettings(layer, info.id)
        return `${info.id}:${s.enabled ? 1 : 0}:${s.blend}`
      }).join(',')

      const mask = layer.mask
      const maskKey = mask
        ? `m(${mask.enabled ? 1 : 0},${mask.invert ? 1 : 0},${mask.paintBufferId ?? '-'},${mask.paintBlend},${mask.blur > 0 ? 1 : 0},${mask.generators
            .map((g) => `${g.type}:${g.enabled ? 1 : 0}:${g.blend}:${g.invert ? 1 : 0}`)
            .join('|')})`
        : 'm-'

      let kindKey = layer.kind as string
      if (layer.kind === 'fill') kindKey += `:${layer.material.defId}:${layer.projection.mode}:${layer.projection.axis}`
      if (layer.kind === 'paint') kindKey += `:${layer.paintBufferId}`

      parts.push(`${depth}|${layer.id}|${kindKey}|${layer.visible ? 1 : 0}|${channels}|${maskKey}`)
      if (layer.kind === 'folder') encode(layer.children, depth + 1)
    }
  }
  encode(set.layers, 0)
  return parts.join(';')
}
