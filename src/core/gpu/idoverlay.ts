/**
 * Hard-edge wireframe drawn on top of the ID overlay.
 *
 * The fill pass colours each source-mesh part; this is the "wireframe" half of
 * Painter's drop target, so you can still read the form when every region is a
 * flat colour. EdgesGeometry with a modest angle threshold keeps coplanar
 * subdivision (a cube face, a cylinder wall) from turning into a triangle soup.
 */

import { EdgesGeometry, LineBasicNodeMaterial, LineSegments } from 'three/webgpu'
import type { BufferGeometry } from 'three/webgpu'

const EDGE_ANGLE = 25

export class IdWireframe {
  readonly object = new LineSegments()
  #material = new LineBasicNodeMaterial()
  #geometry: BufferGeometry | null = null

  constructor() {
    this.#material.color.setRGB(0.04, 0.04, 0.05)
    this.object.material = this.#material
    this.object.frustumCulled = false
    this.object.renderOrder = 2
    this.object.visible = false
    this.object.matrixAutoUpdate = false
  }

  rebuild(source: BufferGeometry | null): void {
    this.#geometry?.dispose()
    this.#geometry = null
    if (!source?.getAttribute('position')) {
      this.object.geometry = new EdgesGeometry()
      return
    }
    const edges = new EdgesGeometry(source, EDGE_ANGLE)
    this.#geometry = edges
    this.object.geometry = edges
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible
  }

  dispose(): void {
    this.#geometry?.dispose()
    this.#geometry = null
    this.#material.dispose()
  }
}
