/**
 * The brush cursor: a ring drawn on the surface under the pointer.
 *
 * It is not decoration. The brush is a sphere in *world* space, so its
 * footprint depends on the model's scale and on how the surface curves away
 * from you - a radius that covers a whole limb on one mesh is a speck on
 * another. Showing the actual footprint is the only way to aim.
 *
 * Two rings are drawn: the outer one is the brush radius, the inner one is
 * where the hardness falloff begins, so the gradient is visible before you
 * commit to a stroke.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicNodeMaterial,
  Object3D,
  Vector3,
} from 'three/webgpu'

const SEGMENTS = 72
const FORWARD = new Vector3(0, 0, 1)

function ringGeometry(): BufferGeometry {
  const points: number[] = []
  // One extra vertex closes the loop; a LineLoop would do it, but an explicit
  // closing point keeps this a plain Line and avoids a second class.
  for (let i = 0; i <= SEGMENTS; i++) {
    const angle = (i / SEGMENTS) * Math.PI * 2
    points.push(Math.cos(angle), Math.sin(angle), 0)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
  return geometry
}

export class BrushCursor {
  readonly object = new Object3D()
  #outer: Line
  #inner: Line
  #outerMaterial = new LineBasicNodeMaterial()
  #innerMaterial = new LineBasicNodeMaterial()
  #radius = 0.1
  #hardness = 0.5
  #normal = new Vector3(0, 0, 1)

  constructor() {
    this.object.name = 'brushCursor'
    // Drawn last and unlit, so the ring stays readable against any material -
    // including a black one, which is exactly when you need it most.
    for (const material of [this.#outerMaterial, this.#innerMaterial]) {
      material.depthTest = false
      material.depthWrite = false
      material.transparent = true
      material.toneMapped = false
      material.blending = AdditiveBlending
    }
    this.#outerMaterial.color.setRGB(1, 1, 1)
    this.#innerMaterial.color.setRGB(0.35, 0.55, 0.75)

    const geometry = ringGeometry()
    this.#outer = new Line(geometry, this.#outerMaterial)
    this.#inner = new Line(geometry, this.#innerMaterial)
    for (const line of [this.#outer, this.#inner]) {
      line.frustumCulled = false
      line.renderOrder = 9999
      this.object.add(line)
    }
    this.object.visible = false
  }

  setBrush(radius: number, hardness: number, erase: boolean): void {
    this.#radius = Math.max(1e-4, radius)
    this.#hardness = Math.min(0.99, Math.max(0, hardness))
    // Erasing is destructive, so it gets its own colour rather than a mode you
    // have to remember you are in.
    if (erase) {
      this.#outerMaterial.color.setRGB(1, 0.35, 0.3)
      this.#innerMaterial.color.setRGB(0.6, 0.15, 0.12)
    } else {
      this.#outerMaterial.color.setRGB(1, 1, 1)
      this.#innerMaterial.color.setRGB(0.35, 0.55, 0.75)
    }
    this.#applyScale()
  }

  /** Places the ring on the surface, or hides it when there is no hit. */
  setHit(point: [number, number, number] | null, normal: [number, number, number] | null): void {
    if (!point || !normal) {
      this.object.visible = false
      return
    }
    this.#normal.set(normal[0], normal[1], normal[2])
    if (this.#normal.lengthSq() < 1e-12) this.#normal.set(0, 0, 1)
    this.#normal.normalize()

    this.object.position.set(point[0], point[1], point[2])
    // Lift very slightly off the surface: depth testing is off, but a coplanar
    // ring on a curved surface still reads better nudged outward.
    this.object.position.addScaledVector(this.#normal, this.#radius * 0.02)
    this.object.quaternion.setFromUnitVectors(FORWARD, this.#normal)
    this.object.visible = true
    this.object.updateMatrixWorld(true)
  }

  hide(): void {
    this.object.visible = false
  }

  #applyScale(): void {
    this.#outer.scale.setScalar(this.#radius)
    // Where the falloff starts, matching the brush's own hardness ramp.
    this.#inner.scale.setScalar(this.#radius * this.#hardness)
    this.#inner.visible = this.#hardness > 0.02
  }

  dispose(): void {
    this.#outer.geometry.dispose()
    this.#outerMaterial.dispose()
    this.#innerMaterial.dispose()
  }
}
