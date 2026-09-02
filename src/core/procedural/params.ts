/**
 * Parameter schemas and their GPU binding.
 *
 * Every catalogue material declares its parameters as data. That serves three
 * purposes: the UI builds its inspector from the schema, the document
 * serialises just the values, and an agent driving the headless API can
 * discover what is tweakable without reading any shader code.
 *
 * Values bind to *uniforms*, never to constants baked into the graph. Dragging
 * a slider therefore updates a buffer and re-composites; it never triggers a
 * shader recompile.
 */

import { Color } from 'three/webgpu'
import { float, uniform, vec3 } from 'three/tsl'
import type { ParamValue } from '../doc/types'
import type { F, V3 } from '../gpu/nodes'

export type ParamType = 'float' | 'int' | 'bool' | 'color'

export interface ParamDef {
  key: string
  label: string
  type: ParamType
  default: ParamValue
  /** Slider bounds for numeric params. */
  min?: number
  max?: number
  step?: number
  /** Groups params into inspector sections. */
  group?: string
  /** Shown as help text; also what an agent reads to understand the knob. */
  description?: string
}

export function defaultValues(defs: readonly ParamDef[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const def of defs) out[def.key] = Array.isArray(def.default) ? [...def.default] : def.default
  return out
}

/** Clamps and coerces an incoming value to what the schema declares. */
export function coerceParam(def: ParamDef, value: ParamValue): ParamValue {
  switch (def.type) {
    case 'bool':
      return Boolean(value)
    case 'int':
    case 'float': {
      const n = typeof value === 'number' ? value : 0
      const min = def.min ?? -Infinity
      const max = def.max ?? Infinity
      const clamped = Math.min(max, Math.max(min, n))
      return def.type === 'int' ? Math.round(clamped) : clamped
    }
    case 'color': {
      if (!Array.isArray(value)) return [0, 0, 0]
      return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])]
    }
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

type UniformHandle = { value: unknown; name: string }

/**
 * Live uniform bindings for one material (or generator) instance.
 *
 * Colour params are authored in sRGB - that is what a colour picker gives you -
 * and converted to linear on upload, so shader maths happens in linear space.
 */
export class ParamBag {
  readonly defs: readonly ParamDef[]
  #byKey = new Map<string, ParamDef>()
  #values: Record<string, ParamValue> = {}
  #uniforms = new Map<string, UniformHandle>()
  #scratch = new Color()

  constructor(defs: readonly ParamDef[], values: Record<string, ParamValue> = {}) {
    this.defs = defs
    for (const def of defs) this.#byKey.set(def.key, def)
    this.#values = { ...defaultValues(defs) }
    for (const [key, value] of Object.entries(values)) this.set(key, value)
  }

  has(key: string): boolean {
    return this.#byKey.has(key)
  }

  get(key: string): ParamValue {
    return this.#values[key]
  }

  values(): Record<string, ParamValue> {
    const out: Record<string, ParamValue> = {}
    for (const [k, v] of Object.entries(this.#values)) out[k] = Array.isArray(v) ? [...v] : v
    return out
  }

  /** Updates a value in place; the bound uniform picks it up on the next draw. */
  set(key: string, value: ParamValue): boolean {
    const def = this.#byKey.get(key)
    if (!def) return false
    const coerced = coerceParam(def, value)
    this.#values[key] = coerced
    const handle = this.#uniforms.get(key)
    if (handle) handle.value = this.#uniformValue(def, coerced)
    return true
  }

  /** Scalar node for a float / int / bool param. */
  float(key: string): F {
    const def = this.#byKey.get(key)
    if (!def) return float(0)
    if (def.type === 'color') return float(0)
    return this.#handle(def) as unknown as F
  }

  /** Linear-space colour node for a colour param. */
  color(key: string): V3 {
    const def = this.#byKey.get(key)
    if (!def || def.type !== 'color') return vec3(0, 0, 0)
    return this.#handle(def) as unknown as V3
  }

  #handle(def: ParamDef): UniformHandle {
    let handle = this.#uniforms.get(def.key)
    if (!handle) {
      const initial = this.#uniformValue(def, this.#values[def.key])
      // `uniform()` is overloaded per value type; the bag is deliberately
      // type-erased here and re-typed by `float()` / `color()`.
      handle = (typeof initial === 'number'
        ? uniform(initial)
        : uniform(initial)) as unknown as UniformHandle
      handle.name = def.key
      this.#uniforms.set(def.key, handle)
    }
    return handle
  }

  #uniformValue(def: ParamDef, value: ParamValue): number | Color {
    if (def.type === 'color') {
      const [r, g, b] = value as [number, number, number]
      // setRGB with an explicit source space converts into three's working
      // (linear) space, so the shader never sees an sRGB-encoded number.
      return this.#scratch.clone().setRGB(r, g, b, 'srgb')
    }
    if (def.type === 'bool') return value ? 1 : 0
    return value as number
  }
}
