/**
 * Uniform bindings for the layer stack.
 *
 * The split between "uniform" and "structural" is the single most important
 * performance decision in the compositor. Anything continuous - opacity,
 * levels, tiling, every material parameter - lives here as a uniform, so
 * dragging a slider costs one buffer write and one composite pass. Anything
 * that changes the *shape* of the graph - layer order, blend modes, which
 * generators exist - forces a shader rebuild, and is therefore deliberately
 * limited to discrete actions.
 */

import { Vector2, Vector4 } from 'three/webgpu'
import { uniform, uniformArray } from 'three/tsl'
import type { Channel } from '../channels'
import { CHANNELS } from '../channels'
import type { GeneratorState, LayerState, Levels } from '../doc/types'
import { levels as applyLevels } from '../procedural/noise'
import { ParamBag } from '../procedural/params'
import { getMaterialDef } from '../procedural/material'
import { getGeneratorDef } from '../procedural/generators'
import type { F, V2, V4 } from './nodes'
import type { Node } from 'three/webgpu'

export type ScalarUniform = F & { value: number }
export type Vec2Uniform = V2 & { value: Vector2 }

export function scalarUniform(initial: number): ScalarUniform {
  return uniform(initial) as unknown as ScalarUniform
}

export function vec2Uniform(x: number, y: number): Vec2Uniform {
  return uniform(new Vector2(x, y)) as unknown as Vec2Uniform
}

/** A fixed-length vec4 array uniform, written in place from the CPU. */
export interface Vec4ArrayUniform {
  array: Vector4[]
  element(index: Node<'int'>): V4
}

export function vec4ArrayUniform(length: number): Vec4ArrayUniform {
  const values = Array.from({ length }, () => new Vector4())
  return uniformArray(values, 'vec4') as unknown as Vec4ArrayUniform
}

export class LevelBindings {
  inLow = scalarUniform(0)
  inHigh = scalarUniform(1)
  gamma = scalarUniform(1)
  outLow = scalarUniform(0)
  outHigh = scalarUniform(1)

  sync(l: Levels): void {
    this.inLow.value = l.inLow
    this.inHigh.value = l.inHigh
    this.gamma.value = l.gamma
    this.outLow.value = l.outLow
    this.outHigh.value = l.outHigh
  }

  apply(value: F): F {
    return applyLevels(value, this.inLow, this.inHigh, this.gamma, this.outLow, this.outHigh)
  }
}

export class GeneratorBindings {
  readonly type: string
  opacity = scalarUniform(1)
  levels = new LevelBindings()
  params: ParamBag

  constructor(state: GeneratorState) {
    this.type = state.type
    const def = getGeneratorDef(state.type)
    this.params = new ParamBag(def?.params ?? [], state.params)
  }

  sync(state: GeneratorState): void {
    this.opacity.value = state.opacity
    this.levels.sync(state.levels)
    for (const [key, value] of Object.entries(state.params)) this.params.set(key, value)
  }
}

export class LayerBindings {
  readonly id: string
  opacity = scalarUniform(1)
  channelOpacity: Record<Channel, ScalarUniform>
  projScale = vec2Uniform(1, 1)
  projOffset = vec2Uniform(0, 0)
  projRotation = scalarUniform(0)
  projSharpness = scalarUniform(4)
  maskBase = scalarUniform(0)
  maskBlur = scalarUniform(0)
  maskLevels = new LevelBindings()
  materialDefId = ''
  materialParams = new ParamBag([], {})
  generators = new Map<string, GeneratorBindings>()

  constructor(id: string) {
    this.id = id
    this.channelOpacity = Object.fromEntries(
      CHANNELS.map((c) => [c, scalarUniform(1)]),
    ) as Record<Channel, ScalarUniform>
  }

  sync(layer: LayerState): void {
    this.opacity.value = layer.opacity
    for (const channel of CHANNELS) {
      this.channelOpacity[channel].value = layer.channels[channel]?.opacity ?? 1
    }

    if (layer.kind === 'fill') {
      const p = layer.projection
      this.projScale.value.set(p.scale[0], p.scale[1])
      this.projOffset.value.set(p.offset[0], p.offset[1])
      this.projRotation.value = p.rotation
      this.projSharpness.value = p.blendSharpness

      // A different material means a different parameter schema, so the bag is
      // rebuilt rather than patched.
      if (this.materialDefId !== layer.material.defId) {
        this.materialDefId = layer.material.defId
        const def = getMaterialDef(layer.material.defId)
        this.materialParams = new ParamBag(def?.params ?? [], layer.material.params)
      } else {
        for (const [key, value] of Object.entries(layer.material.params)) {
          this.materialParams.set(key, value)
        }
      }
    }

    if (layer.mask) {
      this.maskBase.value = layer.mask.base
      this.maskBlur.value = layer.mask.blur
      this.maskLevels.sync(layer.mask.levels)
      const seen = new Set<string>()
      for (const gen of layer.mask.generators) {
        seen.add(gen.id)
        let binding = this.generators.get(gen.id)
        if (!binding || binding.type !== gen.type) {
          binding = new GeneratorBindings(gen)
          this.generators.set(gen.id, binding)
        }
        binding.sync(gen)
      }
      for (const id of [...this.generators.keys()]) if (!seen.has(id)) this.generators.delete(id)
    } else {
      this.generators.clear()
    }
  }
}
