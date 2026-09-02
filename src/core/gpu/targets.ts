/**
 * GPU render targets for a texture set.
 *
 * All channel data lives in half-float RGBA targets packed per `channels.ts`.
 * Half float is a deliberate choice: it is one uniform format for every
 * attachment (three clones a single texture descriptor across an MRT target),
 * it keeps height and tangent-space normals out of 8-bit banding, and it lets
 * emissive go above 1.
 */

import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  RedFormat,
  RenderTarget,
} from 'three/webgpu'
import type { Texture } from 'three/webgpu'
import { SLOT_COUNT, SLOT_NAMES } from '../channels'

const COMMON = {
  depthBuffer: false,
  stencilBuffer: false,
  minFilter: LinearFilter,
  magFilter: LinearFilter,
  wrapS: ClampToEdgeWrapping,
  wrapT: ClampToEdgeWrapping,
  generateMipmaps: false,
  colorSpace: NoColorSpace,
  type: HalfFloatType,
} as const

/** The four packed channel targets, addressable as one MRT attachment set. */
export class SlotTargets {
  readonly rt: RenderTarget
  resolution: number

  constructor(resolution: number, label = 'slots') {
    this.resolution = resolution
    this.rt = new RenderTarget(resolution, resolution, {
      ...COMMON,
      format: RGBAFormat,
      count: SLOT_COUNT,
    })
    // MRT outputs bind by texture *name*, so these must match `SLOT_NAMES`.
    for (let i = 0; i < SLOT_COUNT; i++) {
      this.rt.textures[i].name = SLOT_NAMES[i]
      this.rt.textures[i].userData.label = `${label}:${SLOT_NAMES[i]}`
    }
  }

  texture(slot: number): Texture {
    return this.rt.textures[slot]
  }

  setSize(resolution: number): void {
    if (resolution === this.resolution) return
    this.resolution = resolution
    this.rt.setSize(resolution, resolution)
  }

  dispose(): void {
    this.rt.dispose()
  }
}

/** A single-channel target. Used for stroke coverage and painted masks. */
export class CoverageTarget {
  readonly rt: RenderTarget
  resolution: number

  constructor(resolution: number, label = 'coverage') {
    this.resolution = resolution
    this.rt = new RenderTarget(resolution, resolution, { ...COMMON, format: RedFormat })
    this.rt.texture.name = label
  }

  get texture(): Texture {
    return this.rt.texture
  }

  setSize(resolution: number): void {
    if (resolution === this.resolution) return
    this.resolution = resolution
    this.rt.setSize(resolution, resolution)
  }

  dispose(): void {
    this.rt.dispose()
  }
}

/**
 * Persistent painted pixels for one layer or mask.
 *
 * A *mask* buffer stores coverage only. A *material* buffer also stores the
 * channel values that were stamped, so a paint layer can carry colour,
 * roughness and height rather than only an alpha.
 */
export class PaintBuffer {
  readonly id: string
  readonly kind: 'material' | 'mask'
  readonly coverage: CoverageTarget
  readonly slots: SlotTargets | null

  constructor(id: string, kind: 'material' | 'mask', resolution: number) {
    this.id = id
    this.kind = kind
    this.coverage = new CoverageTarget(resolution, `${id}:coverage`)
    this.slots = kind === 'material' ? new SlotTargets(resolution, id) : null
  }

  get resolution(): number {
    return this.coverage.resolution
  }

  setSize(resolution: number): void {
    this.coverage.setSize(resolution)
    this.slots?.setSize(resolution)
  }

  dispose(): void {
    this.coverage.dispose()
    this.slots?.dispose()
  }
}
