/**
 * Viewport light rig.
 *
 * Image-based lighting alone gives correct energy but poor *form*: a smooth
 * procedural sky produces near-constant irradiance, so a diffuse surface under
 * it reads as a flat silhouette. Three directional lights - key, fill and rim -
 * restore the shading gradients and the crisp highlight that make roughness
 * and normal detail readable while painting.
 *
 * The key tracks the procedural sun, so moving the sun moves the highlight and
 * the reflection together.
 */

import { AmbientLight, DirectionalLight, Group, HemisphereLight, Vector3 } from 'three/webgpu'
import type { EnvironmentSettings } from './environment'

export class LightRig {
  readonly group = new Group()
  #key = new DirectionalLight(0xfff4e8, 2.4)
  #fill = new DirectionalLight(0xc8d8ff, 0.55)
  #rim = new DirectionalLight(0xffffff, 0.9)
  #hemi = new HemisphereLight(0xb8c4d4, 0x2a2a2e, 0.85)
  #ambient = new AmbientLight(0xffffff, 0.35)

  constructor() {
    this.group.name = 'lightRig'
    for (const light of [this.#key, this.#fill, this.#rim]) {
      light.castShadow = false
      this.group.add(light)
      // Targets have to live in the graph: otherwise their world matrix is
      // never updated and the light direction is whatever the identity was.
      this.group.add(light.target)
    }
    this.group.add(this.#hemi)
    this.group.add(this.#ambient)
    this.#place(new Vector3(0.6, 0.7, 0.4))
  }

  /** Points the rig at the same sun the environment was generated from. */
  apply(settings: EnvironmentSettings): void {
    const elevation = (settings.sunElevation * Math.PI) / 180
    const azimuth = (settings.sunAzimuth * Math.PI) / 180
    this.#place(
      new Vector3(
        Math.cos(elevation) * Math.cos(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.sin(azimuth),
      ),
    )
    // Scale with the environment so the two never fight each other.
    const scale = Math.max(0.05, settings.intensity)
    this.#key.intensity = 2.4 * scale
    this.#fill.intensity = 0.55 * scale
    this.#rim.intensity = 0.9 * scale
    this.#hemi.intensity = 0.85 * scale
    this.#ambient.intensity = 0.35 * scale
    this.#hemi.color.setRGB(settings.skyColor[0], settings.skyColor[1], settings.skyColor[2])
    this.#hemi.groundColor.setRGB(settings.groundColor[0], settings.groundColor[1], settings.groundColor[2])
  }

  #place(sun: Vector3): void {
    const direction = sun.clone().normalize().multiplyScalar(6)
    this.#key.position.copy(direction)
    // Fill sits opposite and low, so shadowed sides keep some shape.
    this.#fill.position.set(-direction.x, Math.abs(direction.y) * 0.25, -direction.z)
    // Rim comes from behind and above, which is what separates the silhouette
    // from the background.
    this.#rim.position.set(-direction.z * 0.8, Math.abs(direction.y) * 0.9 + 2, direction.x * 0.8)
    for (const light of [this.#key, this.#fill, this.#rim]) light.target.position.set(0, 0, 0)
  }

  dispose(): void {
    for (const light of [this.#key, this.#fill, this.#rim, this.#hemi, this.#ambient]) light.dispose()
  }
}
