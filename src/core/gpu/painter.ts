/**
 * Painting.
 *
 * Painting is not "drawing on the mesh". The mesh is a projection surface; the
 * pixels live in UV space. A stroke works like this:
 *
 *  1. The mesh is rasterised into its own UV layout (see `uvspace.ts`), so
 *     every fragment knows both which texel it is and where in 3D it sits.
 *  2. Each fragment asks whether it falls inside any of the brush stamps in
 *     this batch - a 3D distance test, plus a normal-facing test so the back
 *     of a thin wall is not painted through.
 *  3. Coverage accumulates with a MAX blend, so overlapping stamps inside one
 *     stroke never double-darken the way plain alpha-over would.
 *  4. The stroke is composited against a snapshot taken at stroke start, not
 *     against the previous frame. That is what makes a slow, low-flow stroke
 *     build up smoothly instead of banding at every pointer event.
 *  5. On stroke end the result is dilated past UV island borders.
 */

import {
  CustomBlending,
  MaxEquation,
  MeshBasicNodeMaterial,
  NoBlending,
  NodeMaterial,
  OneFactor,
  QuadMesh,
  Vector3,
} from 'three/webgpu'
import type { BufferGeometry, Renderer } from 'three/webgpu'
import {
  If,
  Loop,
  cross,
  dot,
  float,
  length,
  max,
  mix,
  mrt,
  normalWorld,
  positionWorld,
  smoothstep,
  tangentGeometry,
  tangentWorld,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { SLOT_COUNT, SLOT_NAMES } from '../channels'
import type { ProjectionSettings } from '../doc/types'
import { getMaterialDef } from '../procedural/material'
import { buildProjected } from '../procedural/projection'
import { ParamBag } from '../procedural/params'
import { fbm01, voronoi2 } from '../procedural/noise'
import type { MeshMaps } from './meshmaps'
import type { F, V2, V4 } from './nodes'
import { packBundle, unpackSlots } from './packing'
import { CoverageTarget, SlotTargets } from './targets'
import type { PaintBuffer } from './targets'
import { vec4ArrayUniform } from './bindings'
import { UVSpacePass, uvClipPosition, clearTarget } from './uvspace'
import type { Dilator } from './dilate'

/** Stamps evaluated per draw. Longer batches are split across draws. */
const MAX_STAMPS = 64

export const BRUSH_ALPHAS = ['round', 'square', 'speckle', 'splatter', 'streaks'] as const
export type BrushAlpha = (typeof BRUSH_ALPHAS)[number]

export interface BrushSettings {
  /** Radius in world units. */
  radius: number
  /** 0 = fully soft falloff, 1 = hard edge. */
  hardness: number
  /** Per-stamp deposition, before the stroke's own opacity. */
  flow: number
  /** Stroke opacity applied once, at commit time. */
  opacity: number
  /** Stamp spacing as a fraction of the radius. */
  spacing: number
  alpha: BrushAlpha
  /** Scale of the procedural alpha pattern, relative to the brush footprint. */
  alphaScale: number
  alphaContrast: number
  /**
   * How far a surface may face away from the stroke's own normal before it
   * stops receiving paint. 1 = only surfaces facing exactly the same way.
   */
  facing: number
  erase: boolean
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 0.08,
  hardness: 0.5,
  flow: 1,
  opacity: 1,
  spacing: 0.15,
  alpha: 'round',
  alphaScale: 1,
  alphaContrast: 0.5,
  facing: 0.15,
  erase: false,
}

/** One point of contact between the brush and the surface. */
export interface StrokeSample {
  point: [number, number, number]
  normal: [number, number, number]
  /** 0..1 pen pressure; mouse input should pass 1. */
  pressure?: number
}

export interface StrokeTarget {
  buffer: PaintBuffer
  /** A material stroke writes channel values; a mask stroke writes coverage only. */
  kind: 'material' | 'mask'
}

interface BrushMaterialSpec {
  defId: string
  params: Record<string, number | boolean | [number, number, number]>
  projection: ProjectionSettings
}

export class Painter {
  #pass = new UVSpacePass()
  #quad = new QuadMesh()

  #stroke: CoverageTarget
  #baselineSlots: SlotTargets
  #baselineCoverage: CoverageTarget

  // Stamp batch uniforms.
  #stampPos = vec4ArrayUniform(MAX_STAMPS)
  #stampNrm = vec4ArrayUniform(MAX_STAMPS)
  #stampCount = uniform(0)
  #hardness = uniform(0.5)
  #flow = uniform(1)
  #facing = uniform(0.15)
  #alphaScale = uniform(1)
  #alphaContrast = uniform(0.5)
  #alphaKind = uniform(0)

  // Commit uniforms.
  #strokeOpacity = uniform(1)
  #eraseMode = uniform(0)

  #stampMaterial: NodeMaterial | null = null
  #commitMaterials = new Map<string, MeshBasicNodeMaterial>()

  #active: {
    target: StrokeTarget
    brush: BrushSettings
    spec: BrushMaterialSpec
    params: ParamBag
    lastPoint: Vector3 | null
    /** Distance carried over between pointer events, so spacing is continuous. */
    carry: number
    pending: StrokeSample[]
    painted: boolean
  } | null = null

  constructor(resolution: number) {
    this.#stroke = new CoverageTarget(resolution, 'strokeCoverage')
    this.#baselineSlots = new SlotTargets(resolution, 'strokeBaseline')
    this.#baselineCoverage = new CoverageTarget(resolution, 'strokeBaselineCoverage')
  }

  get isStroking(): boolean {
    return this.#active !== null
  }

  setResolution(resolution: number): void {
    this.#stroke.setSize(resolution)
    this.#baselineSlots.setSize(resolution)
    this.#baselineCoverage.setSize(resolution)
  }

  /**
   * Starts a stroke. Snapshots the target so the stroke can be recomposited
   * from scratch on every batch rather than accumulated destructively.
   */
  begin(
    renderer: Renderer,
    target: StrokeTarget,
    brush: BrushSettings,
    spec: BrushMaterialSpec,
    params: ParamBag,
  ): void {
    this.end(renderer, null)

    clearTarget(renderer, this.#stroke.rt)
    renderer.copyTextureToTexture(target.buffer.coverage.texture, this.#baselineCoverage.texture)
    if (target.buffer.slots) {
      for (let i = 0; i < SLOT_COUNT; i++) {
        renderer.copyTextureToTexture(target.buffer.slots.texture(i), this.#baselineSlots.texture(i))
      }
    }

    this.#hardness.value = brush.hardness
    this.#flow.value = brush.flow
    this.#facing.value = brush.facing
    this.#alphaScale.value = brush.alphaScale
    this.#alphaContrast.value = brush.alphaContrast
    this.#alphaKind.value = BRUSH_ALPHAS.indexOf(brush.alpha)
    this.#strokeOpacity.value = brush.opacity
    this.#eraseMode.value = brush.erase ? 1 : 0

    this.#active = { target, brush, spec, params, lastPoint: null, carry: 0, pending: [], painted: false }
  }

  /**
   * Feeds a pointer sample. Stamps are interpolated along the path at the
   * brush's spacing, so stroke density does not depend on how fast the pointer
   * moved or how often the browser sampled it.
   */
  move(renderer: Renderer, geometry: BufferGeometry, maps: MeshMaps, sample: StrokeSample): void {
    const active = this.#active
    if (!active) return

    const point = new Vector3(...sample.point)
    const step = Math.max(1e-4, active.brush.spacing * active.brush.radius)

    if (!active.lastPoint) {
      active.pending.push(sample)
      active.lastPoint = point
      active.carry = 0
    } else {
      const from = active.lastPoint
      const distance = from.distanceTo(point)
      if (distance > 0) {
        let travelled = step - active.carry
        while (travelled <= distance) {
          const t = travelled / distance
          active.pending.push({
            point: [
              from.x + (point.x - from.x) * t,
              from.y + (point.y - from.y) * t,
              from.z + (point.z - from.z) * t,
            ],
            normal: sample.normal,
            pressure: sample.pressure,
          })
          travelled += step
        }
        active.carry = distance - (travelled - step)
        active.lastPoint = point
      }
    }

    if (active.pending.length === 0) return
    this.#flush(renderer, geometry, maps)
  }

  /** Ends the stroke, dilates the result, and reports whether anything changed. */
  end(renderer: Renderer, dilator: Dilator | null, dilation = 8): boolean {
    const active = this.#active
    if (!active) return false
    this.#active = null
    if (!active.painted) return false
    if (dilator) dilator.dilatePaint(renderer, active.target.buffer, dilation)
    return true
  }

  #flush(renderer: Renderer, geometry: BufferGeometry, maps: MeshMaps): void {
    const active = this.#active
    if (!active) return

    for (let offset = 0; offset < active.pending.length; offset += MAX_STAMPS) {
      const batch = active.pending.slice(offset, offset + MAX_STAMPS)
      for (let i = 0; i < batch.length; i++) {
        const s = batch[i]
        const posValue = this.#stampPos.array[i]
        const nrmValue = this.#stampNrm.array[i]
        posValue.set(s.point[0], s.point[1], s.point[2], active.brush.radius)
        const n = normaliseVector(s.normal)
        nrmValue.set(n[0], n[1], n[2], s.pressure ?? 1)
      }
      this.#stampCount.value = batch.length
      this.#pass.render(renderer, geometry, this.#stampMaterialFor(), this.#stroke.rt, false)
    }
    active.pending.length = 0
    active.painted = true
    this.#commit(renderer, maps)
  }

  #stampMaterialFor(): NodeMaterial {
    if (this.#stampMaterial) return this.#stampMaterial
    const material = new NodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.transparent = true
    // MAX rather than additive: two stamps overlapping inside one stroke should
    // give the stronger of the two, not their sum.
    material.blending = CustomBlending
    material.blendEquation = MaxEquation
    material.blendSrc = OneFactor
    material.blendDst = OneFactor

    const coverage = float(0).toVar('brushCoverage')
    Loop({ start: 0, end: MAX_STAMPS, type: 'int' }, ({ i }) => {
      If(float(i).lessThan(this.#stampCount), () => {
        const stamp = this.#stampPos.element(i)
        const aux = this.#stampNrm.element(i)
        const centre = stamp.xyz
        const radius = max(stamp.w, float(1e-5))
        const delta = positionWorld.sub(centre)
        const distance = length(delta)

        // Radial falloff. Hardness moves the inner edge of the ramp outward.
        const inner = radius.mul(this.#hardness.clamp(0, 0.99))
        const radial = smoothstep(radius, inner, distance)

        // Local frame so shaped alphas orient with the surface, not the world.
        // Rebuilt here from tangent + normal to match three's handedness rule.
        const tangent = vec3(tangentWorld)
        const bitangent = cross(vec3(normalWorld), tangent).mul(tangentGeometry.w)
        const local = vec2(dot(delta, tangent), dot(delta, bitangent)).div(radius)
        const shaped = this.#alphaShape(local, radial)

        // Reject surfaces facing away from the stroke: this is what stops a
        // brush from bleeding through to the far side of a thin object.
        const facing = smoothstep(
          this.#facing.mul(2).sub(1),
          this.#facing.mul(2).sub(1).add(0.25),
          dot(normalWorld, aux.xyz),
        )

        const value = shaped.mul(facing).mul(this.#flow).mul(aux.w)
        coverage.assign(max(coverage, value.clamp(0, 1)))
      })
    })

    material.fragmentNode = vec4(coverage, coverage, coverage, coverage)
    this.#stampMaterial = material
    return material
  }

  /** Procedural stamp alphas. No bitmap brushes anywhere in this app. */
  #alphaShape(local: V2, radial: F): F {
    const scale = max(this.#alphaScale, float(0.01))
    const contrast = this.#alphaContrast
    const kind = this.#alphaKind

    const round = radial
    const square = smoothstep(float(1), this.#hardness.clamp(0, 0.99), max(local.x.abs(), local.y.abs()))
    const speckleField = voronoi2(local.mul(scale.mul(6)), float(1)).x
    const speckle = radial.mul(smoothstep(contrast.mul(0.6), contrast.mul(0.6).add(0.25), speckleField))
    const splatterField = fbm01(vec3(local.mul(scale.mul(4)), 0), 4, 2.1, 0.55)
    const splatter = radial.mul(smoothstep(contrast, contrast.add(0.15), splatterField))
    const streakField = fbm01(vec3(local.x.mul(scale.mul(30)), local.y.mul(scale.mul(1.5)), 0), 3, 2, 0.5)
    const streaks = radial.mul(smoothstep(contrast.mul(0.8), contrast.mul(0.8).add(0.2), streakField))

    // Selected by a uniform, so switching alpha never recompiles.
    const pick = (index: number): F => float(1).sub(kind.sub(index).abs().clamp(0, 1))
    return round
      .mul(pick(0))
      .add(square.mul(pick(1)))
      .add(speckle.mul(pick(2)))
      .add(splatter.mul(pick(3)))
      .add(streaks.mul(pick(4)))
  }

  /**
   * Recomposites the whole stroke against the snapshot. Cheap (one fullscreen
   * pass) and idempotent, which is what lets flow accumulate correctly.
   */
  #commit(renderer: Renderer, maps: MeshMaps): void {
    const active = this.#active
    if (!active) return
    const material = this.#commitMaterial(active.target, active.spec, active.params, maps)

    const previous = renderer.getRenderTarget()
    this.#quad.material = material
    if (active.target.kind === 'material' && active.target.buffer.slots) {
      renderer.setRenderTarget(active.target.buffer.slots.rt)
      this.#quad.render(renderer)
    }
    renderer.setRenderTarget(active.target.buffer.coverage.rt)
    this.#quad.material = this.#coverageCommitMaterial()
    this.#quad.render(renderer)
    renderer.setRenderTarget(previous)
  }

  #commitKey(spec: BrushMaterialSpec, target: StrokeTarget): string {
    return `${target.kind}:${target.buffer.id}:${spec.defId}:${spec.projection.mode}:${spec.projection.axis}`
  }

  #commitMaterial(
    target: StrokeTarget,
    spec: BrushMaterialSpec,
    params: ParamBag,
    maps: MeshMaps,
  ): MeshBasicNodeMaterial {
    const key = this.#commitKey(spec, target)
    const cached = this.#commitMaterials.get(key)
    if (cached) return cached

    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    const uvNode = uv()
    const strokeCoverage = texture(this.#stroke.texture, uvNode).x.mul(this.#strokeOpacity).clamp(0, 1)
    const baseCoverage = texture(this.#baselineCoverage.texture, uvNode).x

    const def = getMaterialDef(spec.defId)
    const brushBundle = def
      ? buildProjected({
          def,
          params,
          mode: spec.projection.mode,
          axis: spec.projection.axis === 'x' ? 0 : spec.projection.axis === 'y' ? 1 : 2,
          nodes: {
            scale: vec2(spec.projection.scale[0], spec.projection.scale[1]),
            offset: vec2(spec.projection.offset[0], spec.projection.offset[1]),
            rotation: float(spec.projection.rotation),
            sharpness: float(spec.projection.blendSharpness),
          },
          maps: maps.nodes(uvNode),
          uv: uvNode,
          texel: float(1 / Math.max(1, this.#stroke.resolution)),
        })
      : null

    const baseBundle = unpackSlots(this.#baselineSlots.rt.textures, uvNode)
    const source = brushBundle ?? baseBundle

    // Standard "source over destination", un-premultiplied at the end so the
    // stored channel values stay meaningful where coverage is partial.
    const erase = this.#eraseMode
    const paintCoverage = strokeCoverage.mul(float(1).sub(erase))
    const outCoverage = paintCoverage.add(baseCoverage.mul(float(1).sub(paintCoverage)))
    const packedSource = packBundle(source)
    const packedBase = packBundle(baseBundle)

    const outputs: Record<string, V4> = {}
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const name = SLOT_NAMES[slot]
      const s = packedSource[name]
      const b = packedBase[name]
      const numerator = s.mul(paintCoverage).add(b.mul(baseCoverage).mul(float(1).sub(paintCoverage)))
      outputs[name] = numerator.div(max(outCoverage, float(1e-4)))
    }
    material.fragmentNode = mrt(outputs)

    this.#commitMaterials.set(key, material)
    return material
  }

  #coverageCommitMaterial(): MeshBasicNodeMaterial {
    const key = 'coverage'
    const cached = this.#commitMaterials.get(key)
    if (cached) return cached
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const uvNode = uv()
    const stroke = texture(this.#stroke.texture, uvNode).x.mul(this.#strokeOpacity).clamp(0, 1)
    const base = texture(this.#baselineCoverage.texture, uvNode).x
    const erase = this.#eraseMode
    // Erasing removes coverage; painting adds it. One expression, no branch.
    const erased = base.mul(float(1).sub(stroke))
    const painted = stroke.add(base.mul(float(1).sub(stroke)))
    const result = mix(painted, erased, erase).clamp(0, 1)
    material.fragmentNode = vec4(result, result, result, result)
    this.#commitMaterials.set(key, material)
    return material
  }

  dispose(): void {
    this.#stroke.dispose()
    this.#baselineSlots.dispose()
    this.#baselineCoverage.dispose()
    this.#stampMaterial?.dispose()
    for (const material of this.#commitMaterials.values()) material.dispose()
    this.#commitMaterials.clear()
    this.#pass.dispose()
  }
}

function normaliseVector(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 1e-6 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1]
}
