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
 *
 * And it is why the rebuild is asynchronous. Picking a material rebuilds the
 * graph and creates a pipeline; doing that inline meant a frame that blocked
 * for as long as the driver took, followed by two or three black ones while
 * WebGPU skipped draws whose pipeline was not ready yet. Instead the *existing*
 * shader keeps drawing while the replacement is built off the frame and
 * compiled with `compileAsync`, and the two are swapped only once the new one
 * is ready to draw. Nothing on screen ever waits for a compile.
 *
 * The one case that cannot work that way is a rebuild caused by a resource
 * disappearing - a paint buffer disposed, a mesh map replaced. The live shader
 * samples those textures, so it cannot be left running for even one more
 * frame; `invalidateGraph({ immediate: true })` says so explicitly.
 */

import { MeshBasicNodeMaterial, NoBlending, QuadMesh, Scene } from 'three/webgpu'
import type { Renderer } from 'three/webgpu'
import { float, ivec2, mix, mrt, normalize, uv, vec3 } from 'three/tsl'
import { CHANNEL_LIST } from '../channels'
import type { LayerState, TextureSetState } from '../doc/types'
import { channelSettings } from '../doc/document'
import { getGeneratorDef } from '../procedural/generators'
import type { AnchorOutputs } from '../procedural/generators'
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
import { renderQuad } from './uvspace'
import { measure, measureAsync } from './profile'
import { yieldToBrowser } from './scheduler'

interface BuildContext {
  uv: V2
  /** Integer texel coordinate for sampler-free reads. See `unpackSlots`. */
  coord: V2
  texel: F
  maps: MeshMaps
  mapNodes: ReturnType<MeshMaps['nodes']>
  buffers: Map<string, PaintBuffer>
  /**
   * Anchor points published so far by the bottom-up walk.
   *
   * Filled as `#evalStack` passes each anchored layer, so a generator only ever
   * sees anchors from *below* it - which is both the rule Painter enforces and
   * the only order a single fused shader can evaluate in. A reference upward
   * finds nothing and contributes nothing.
   */
  anchors: Map<string, AnchorOutputs>
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

  /**
   * Async rebuild state.
   *
   * `#buildToken` is what makes a superseded build harmless: every build takes
   * a number on the way in and throws its result away if the number moved on
   * while it was compiling. Without it, a burst of edits - dragging through the
   * material browser, say - would race several builds and let an early one win.
   */
  #buildToken = 0
  #rebuilding = false
  /** Set when the live graph references something about to stop existing. */
  #rebuildImmediate = false
  /**
   * Whether a usable graph has ever been built.
   *
   * Only the very first build has nothing on screen to fall back to, so it is
   * the only one allowed to block the main thread. Everything after it can be
   * built asynchronously while the composite target keeps showing its last
   * frame.
   */
  #everBuilt = false
  /**
   * Consecutive failed asynchronous rebuilds.
   *
   * The asynchronous path is better in every way *when it works*. If it stops
   * working - a driver that rejects `createRenderPipelineAsync`, a compile that
   * throws - then retrying it forever would leave the viewport permanently
   * stale, which is worse than a stall. After a couple of failures the inline
   * path takes over and accepts the hitch.
   */
  #asyncFailures = 0
  static readonly #MAX_ASYNC_FAILURES = 2
  /** Host scene, used only to hand the quad to `compileAsync`. */
  #quadScene = new Scene()

  /**
   * Stroke fast path: everything below the layer being painted, frozen.
   *
   * A stroke recomposites the stack on every pointer sample, and the stack is
   * procedural - a base layer with a real material costs ~90ms of GPU time per
   * evaluation, so painting on top of one ran at a handful of frames a second
   * no matter how cheap the brush itself was. Nothing under the painted layer
   * can change while the pointer is down, though, so it is rendered once at
   * stroke start and read back as a texture for the rest of the stroke.
   *
   * The split is by top-level layer. `#evalStack` composites bottom-up and a
   * folder receives the same `dst` its siblings would, so resuming from a
   * snapshot of the layers below is exact, give or take the half-float
   * rounding the output target applies anyway.
   */
  #below: SlotTargets | null = null
  #belowMaterial: MeshBasicNodeMaterial | null = null
  #strokeLayerId: string | null = null
  #belowValid = false

  constructor(resolution: number) {
    this.output = new SlotTargets(resolution, 'composite')
  }

  get resolution(): number {
    return this.output.resolution
  }

  setResolution(resolution: number): void {
    if (resolution === this.output.resolution) return
    this.output.setSize(resolution)
    this.#below?.setSize(resolution)
    // Resizing reallocates the target, so its contents are no longer the last
    // good frame - there is nothing worth showing while a replacement builds,
    // which is exactly the condition that earns a blocking rebuild.
    this.#everBuilt = false
    // The attachment formats the compiled pipeline was built against are gone.
    this.invalidateGraph({ immediate: true })
  }

  /** Marks the composite stale without touching the graph. */
  invalidate(): void {
    this.#needsComposite = true
  }

  /**
   * Splits the graph below `layerId`, so painting that layer does not
   * re-evaluate what is under it. Safe to call with a layer that turns out not
   * to be splittable - the graph just stays whole.
   *
   * The split is not undone when the stroke ends. It costs a shader rebuild to
   * put in place and produces the same pixels either way, so tearing it down
   * would mean rebuilding twice per stroke for no gain; `sync()` already
   * invalidates the frozen half whenever the document changes.
   */
  splitBelow(layerId: string): void {
    if (this.#strokeLayerId === layerId) return
    this.#strokeLayerId = layerId
    this.invalidateGraph()
  }

  /**
   * Forces a shader rebuild.
   *
   * Pass `immediate` when the *reason* for the rebuild is that a texture the
   * live graph samples has been disposed or replaced. Everything else - a
   * layer added, a material swapped, a blend mode changed - can and should go
   * through the asynchronous path, because the old shader still draws
   * something valid in the meantime.
   */
  invalidateGraph(options: { immediate?: boolean } = {}): void {
    this.#needsRebuild = true
    this.#needsComposite = true
    this.#belowValid = false
    if (options.immediate) this.#rebuildImmediate = true
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
    // Any document edit can change what is under the stroke.
    this.#belowValid = false
  }

  /** Composites, if anything changed since the last call. */
  render(renderer: Renderer, set: TextureSetState, maps: MeshMaps, buffers: Map<string, PaintBuffer>): boolean {
    if (this.#needsRebuild) {
      this.#needsRebuild = false
      const immediate = this.#rebuildImmediate
      this.#rebuildImmediate = false

      // Building inline means the next draw creates the pipeline, and pipeline
      // creation for a fused stack shader is however long the driver takes -
      // hundreds of milliseconds of blocked main thread, with no yield in it.
      // So it is reserved for the two cases where there is genuinely nothing
      // valid to show in the meantime.
      if (!this.#everBuilt || this.#asyncFailures >= Compositor.#MAX_ASYNC_FAILURES) {
        // Supersede anything in flight, so a build that started before the
        // resources changed cannot overwrite this one when it lands.
        this.#buildToken++
        this.#applyBuild(measure('composite graph build (inline)', () => this.#buildGraph(set, maps, buffers)))
        // The new pipeline's first draw is skipped; autoClear would leave the
        // target black and a single composite would never recover.
        this.#rebuildDraws = 3
        this.#asyncFailures = 0
      } else {
        // An immediate invalidation means the live graph samples something that
        // is being disposed, so it must stop drawing now. That used to force an
        // inline rebuild - but the composite target still holds the last good
        // frame and the viewport goes on sampling it, so retiring the graph and
        // building the replacement off the frame shows a few stale frames
        // instead of freezing the application.
        if (immediate) this.#retire()
        if (this.#rebuilding) {
          // A build is already running against older state. Ask again next
          // frame rather than starting a second one alongside it.
          this.#needsRebuild = true
        } else {
          void this.#rebuildAsync(renderer, set, maps, buffers)
        }
      }
    }
    if (!this.#material) return false
    if (!this.#needsComposite && this.#rebuildDraws === 0) return false

    // The frozen lower stack is re-rendered while the pipeline is still
    // warming, because a skipped draw would leave the cache holding whatever
    // was in that memory.
    if (this.#belowMaterial && this.#below && (!this.#belowValid || this.#rebuildDraws > 0)) {
      measure('frozen lower-stack draw', () =>
        renderQuad(renderer, this.#quad, this.#belowMaterial!, this.#below!.rt),
      )
      this.#belowValid = true
    }

    measure('composite draw', () => renderQuad(renderer, this.#quad, this.#material!, this.output.rt))
    this.#needsComposite = false
    if (this.#rebuildDraws > 0) {
      this.#rebuildDraws--
      if (this.#rebuildDraws > 0) this.#needsComposite = true
    }
    return true
  }

  /**
   * Builds the replacement graph *without* touching anything currently live.
   *
   * Keeping this free of side effects is what makes the asynchronous path
   * possible at all: the result can be thrown away if it is superseded, and
   * the shader on screen is unaffected until `#applyBuild` swaps it in.
   */
  #buildGraph(
    set: TextureSetState,
    maps: MeshMaps,
    buffers: Map<string, PaintBuffer>,
  ): { material: MeshBasicNodeMaterial; belowMaterial: MeshBasicNodeMaterial | null } {
    let belowMaterial: MeshBasicNodeMaterial | null = null
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    const uvNode = uv()
    const coord = ivec2(uvNode.mul(set.resolution)) as unknown as V2
    const ctx: BuildContext = {
      uv: uvNode,
      coord,
      texel: float(1 / Math.max(1, set.resolution)),
      maps,
      mapNodes: maps.nodes(uvNode, coord),
      buffers,
      anchors: new Map(),
    }

    // Split the stack if a stroke is running on anything but the bottom layer.
    //
    // Unless an anchor crosses the cut. Freezing the lower half into a texture
    // throws away every node in it, and an anchor is a node - so a generator
    // above the split would silently lose the layer it references for the
    // duration of the stroke, which is exactly when you are watching it.
    let split = this.#strokeLayerId === null
      ? -1
      : set.layers.findIndex((layer) => containsLayer(layer, this.#strokeLayerId!))
    if (split > 0 && anchorsCrossSplit(set.layers, split)) split = -1
    let base = defaultBundle()
    let layers = set.layers
    if (split > 0) {
      const below = this.#ensureBelow(set.resolution)
      // Assigns the result variable - declaring a second `belowMaterial` here
      // shadowed it, so this returned null while the main graph below still
      // read the frozen cache. Nothing ever rendered into that cache, so the
      // stack composited on top of zeros: a zero normal, `normalize()`, NaN,
      // and a pitch-black model with every other channel still correct.
      belowMaterial = new MeshBasicNodeMaterial()
      belowMaterial.depthTest = false
      belowMaterial.depthWrite = false
      belowMaterial.blending = NoBlending
      const frozen = this.#evalStack(set.layers.slice(0, split), defaultBundle(), ctx)
      belowMaterial.fragmentNode = mrt(packBundle({ ...frozen, normal: normalize(frozen.normal) }))
      base = unpackSlots(below.rt.textures, uvNode, ctx.coord)
      layers = set.layers.slice(split)
    }

    const result = this.#evalStack(layers, base, ctx)
    // Normals must leave the compositor unit length: layers blend them with
    // RNM and with plain lerps, and neither preserves magnitude.
    //
    // Guarded rather than a bare `normalize`, because the cost of getting a
    // zero here is out of all proportion to the odds of it: NaN across the
    // normal channel renders the whole model black while every other channel
    // still reads correct, which is a miserable thing to debug.
    const normalLength = result.normal.length()
    const normalised: ChannelBundle = {
      ...result,
      normal: normalLength.greaterThan(float(1e-5)).select(result.normal.div(normalLength), vec3(0, 0, 1)),
    }
    material.fragmentNode = mrt(packBundle(normalised))
    return { material, belowMaterial }
  }

  /** Retires the live graph and puts a freshly built one in its place. */
  #applyBuild(built: { material: MeshBasicNodeMaterial; belowMaterial: MeshBasicNodeMaterial | null }): void {
    this.#material?.dispose()
    this.#belowMaterial?.dispose()
    this.#material = built.material
    this.#belowMaterial = built.belowMaterial
    this.#belowValid = false
    this.#needsComposite = true
    this.#everBuilt = true
  }

  /**
   * Drops the live graph without putting anything in its place.
   *
   * For when the textures it samples are about to be disposed: it must not draw
   * again, and the output target's last frame is a better thing to leave on
   * screen than a black one - or than a stalled one, which is what building the
   * replacement inline costs.
   */
  #retire(): void {
    // Supersede anything in flight: it was built against resources that are
    // going away, so its result must not land.
    this.#buildToken++
    this.#material?.dispose()
    this.#belowMaterial?.dispose()
    this.#material = null
    this.#belowMaterial = null
    this.#belowValid = false
    this.#needsComposite = true
  }

  /**
   * The normal path: build off the frame, compile off the frame, then swap.
   *
   * The compile is what actually costs - and `compileAsync` is not merely a
   * promise wrapper around the synchronous version. It generates the WGSL and
   * creates the pipeline in chunks, yielding to the event loop between them, so
   * a several-hundred-millisecond compile never becomes a several-hundred-
   * millisecond frame. The whole point of doing it here rather than letting the
   * first draw trigger it is that the first draw cannot yield.
   */
  async #rebuildAsync(
    renderer: Renderer,
    set: TextureSetState,
    maps: MeshMaps,
    buffers: Map<string, PaintBuffer>,
  ): Promise<void> {
    const token = ++this.#buildToken
    this.#rebuilding = true
    let built: { material: MeshBasicNodeMaterial; belowMaterial: MeshBasicNodeMaterial | null } | null = null
    try {
      // Let the frame that asked for this finish and present first.
      await yieldToBrowser()
      if (token !== this.#buildToken) return

      built = measure('composite graph build', () => this.#buildGraph(set, maps, buffers))
      // Checked again here: an immediate invalidation during the build means
      // the textures this graph samples may already be gone, and there is no
      // point handing them to the driver.
      if (token !== this.#buildToken) return
      await measureAsync('composite precompile', () => this.#precompile(renderer, built!.material, this.output.rt))
      if (built.belowMaterial && this.#below) {
        await measureAsync('frozen lower-stack precompile', () =>
          this.#precompile(renderer, built!.belowMaterial!, this.#below!.rt),
        )
      }
      if (token !== this.#buildToken) return

      this.#applyBuild(built)
      built = null
      this.#asyncFailures = 0
      // The pipeline is already compiled, so this draw will not be skipped -
      // but a spare costs one fullscreen pass and a missed one costs a black
      // texture set until the next edit.
      this.#rebuildDraws = 2
    } catch (cause) {
      this.#asyncFailures++
      // Retried asynchronously, not inline. Falling straight back to the
      // blocking path meant a single flaky compile turned every later edit into
      // a frozen frame; only a repeated failure is worth paying that for, and
      // `#MAX_ASYNC_FAILURES` is where that line is drawn.
      console.warn(
        `[vibe-painter] deferred composite rebuild failed (${this.#asyncFailures} in a row)`,
        cause,
      )
      this.#needsRebuild = true
      this.#needsComposite = true
    } finally {
      built?.material.dispose()
      built?.belowMaterial?.dispose()
      this.#rebuilding = false
    }
  }

  /**
   * Creates the pipeline for `material` against `target`'s attachment formats.
   *
   * The render target is bound only across `compileAsync`'s *synchronous*
   * prologue - it reads the bound target there and captures a render context -
   * and restored before the first await. Holding it bound across the await
   * would mean any frame that landed mid-compile drew the viewport into the
   * composite target instead of the canvas.
   */
  async #precompile(renderer: Renderer, material: MeshBasicNodeMaterial, target: SlotTargets['rt']): Promise<void> {
    const previous = renderer.getRenderTarget()
    this.#quadScene.add(this.#quad)
    this.#quad.material = material
    let compiled: Promise<void>
    try {
      renderer.setRenderTarget(target)
      compiled = measure('compileAsync prologue', () =>
        renderer.compileAsync(this.#quadScene, this.#quad.camera),
      )
    } finally {
      renderer.setRenderTarget(previous)
      this.#quadScene.remove(this.#quad)
    }
    await compiled
  }

  /** Bottom-up walk. `base` is what this stack composites on top of. */
  #evalStack(layers: LayerState[], base: ChannelBundle, ctx: BuildContext): ChannelBundle {
    let dst = base
    for (const layer of layers) {
      if (!layer.visible) continue
      const binding = this.#bindings.get(layer.id)
      if (!binding) continue

      const maskValue = this.#maskValue(layer, binding, ctx)
      // What the layer is masked to, without its global opacity: that is the
      // shape an anchor publishes, and multiplying opacity into it would make
      // "hide this layer" quietly rewrite every mask that references it.
      let anchorMask: F = maskValue
      let amount: F = binding.opacity.mul(maskValue)
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
          src = unpackSlots(buffer.slots.rt.textures, ctx.uv, ctx.coord)
          // Painted pixels only exist where the brush actually landed.
          const coverage = coverageOf(buffer, ctx)
          amount = amount.mul(coverage)
          // Which is also the useful thing to anchor on a paint layer: "where
          // I painted", with or without a mask on top of it.
          anchorMask = anchorMask.mul(coverage)
        }
      }

      if (layer.anchorName && src) {
        ctx.anchors.set(layer.id, { mask: anchorMask.clamp(0, 1), bundle: src })
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
        anchors: ctx.anchors,
        anchorRef: gen.anchorRef ?? null,
      })
      contribution = genBinding.levels.apply(contribution)
      if (gen.invert) contribution = contribution.oneMinus()
      value = mix(value, blendFloat(gen.blend, value, contribution), genBinding.opacity)
    }

    if (mask.paintBufferId) {
      const buffer = ctx.buffers.get(mask.paintBufferId)
      if (buffer) {
        const painted = mask.blur > 0
          ? blurredCoverage(buffer.coverage.texture, ctx.uv, binding.maskBlur.mul(ctx.texel))
          : coverageOf(buffer, ctx)
        value = blendFloat(mask.paintBlend, value, painted)
      }
    }

    value = binding.maskLevels.apply(value)
    if (mask.invert) value = value.oneMinus()
    return value.clamp(0, 1)
  }

  #ensureBelow(resolution: number): SlotTargets {
    if (this.#below && this.#below.resolution === resolution) return this.#below
    this.#below?.dispose()
    this.#below = new SlotTargets(resolution, 'compositeBelow')
    this.#belowValid = false
    return this.#below
  }

  dispose(): void {
    // Any build still in flight will find its token stale and drop its result.
    this.#buildToken++
    this.#material?.dispose()
    this.#belowMaterial?.dispose()
    this.#below?.dispose()
    this.output.dispose()
  }
}

// ---------------------------------------------------------------------------

function coverageOf(buffer: PaintBuffer, ctx: BuildContext): F {
  return blurredCoverage(buffer.coverage.texture, ctx.uv, null, ctx.coord)
}

/**
 * Whether any layer at or above `split` reads an anchor published below it.
 *
 * Cheap: this runs once per graph build, over the document, not per texel.
 */
function anchorsCrossSplit(layers: LayerState[], split: number): boolean {
  const below = new Set<string>()
  for (const layer of layers.slice(0, split)) {
    walk([layer], (node) => {
      if (node.anchorName) below.add(node.id)
    })
  }
  if (below.size === 0) return false

  let crosses = false
  walk(layers.slice(split), (node) => {
    for (const gen of node.mask?.generators ?? []) {
      if (gen.anchorRef && below.has(gen.anchorRef.layerId)) crosses = true
    }
  })
  return crosses
}

/** Whether `id` is `layer` or lives anywhere inside it. */
function containsLayer(layer: LayerState, id: string): boolean {
  if (layer.id === id) return true
  return layer.kind === 'folder' && layer.children.some((child) => containsLayer(child, id))
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
            .map(
              (g) =>
                `${g.type}:${g.enabled ? 1 : 0}:${g.blend}:${g.invert ? 1 : 0}:${
                  g.anchorRef ? `${g.anchorRef.layerId}>${g.anchorRef.source}` : '-'
                }`,
            )
            .join('|')})`
        : 'm-'

      let kindKey = layer.kind as string
      if (layer.kind === 'fill') kindKey += `:${layer.material.defId}:${layer.projection.mode}:${layer.projection.axis}`
      if (layer.kind === 'paint') kindKey += `:${layer.paintBufferId}`

      // The anchor's *name* is presentation; whether it is published is not -
      // a layer that starts publishing adds a node other masks can reach.
      parts.push(
        `${depth}|${layer.id}|${kindKey}|${layer.visible ? 1 : 0}|${layer.anchorName ? 1 : 0}|${channels}|${maskKey}`,
      )
      if (layer.kind === 'folder') encode(layer.children, depth + 1)
    }
  }
  encode(set.layers, 0)
  return parts.join(';')
}
