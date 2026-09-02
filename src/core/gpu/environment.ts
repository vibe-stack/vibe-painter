/**
 * Procedural image-based lighting.
 *
 * The catalogue rule - no external textures - applies to the lighting too. A
 * sky is generated analytically into an equirectangular target, converted to a
 * cube map, and pre-filtered by three's PMREM so rough metals get a properly
 * blurred reflection.
 *
 * This matters more than it looks: a metal lit only by punctual lights renders
 * almost black, because its diffuse term is zero and there is nothing for it to
 * reflect. IBL is what makes the metal materials in the catalogue readable.
 */

import { CubeRenderTarget, HalfFloatType, LinearFilter, MeshBasicNodeMaterial, NoBlending, PMREMGenerator, QuadMesh, RenderTarget, Vector3, EquirectangularReflectionMapping, NoColorSpace } from 'three/webgpu'
import type { Renderer, Texture } from 'three/webgpu'
import { exp, float, max, mix, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl'
import { fbm01 } from '../procedural/noise'

export interface EnvironmentSettings {
  /** Sun elevation in degrees above the horizon. */
  sunElevation: number
  /** Sun azimuth in degrees. */
  sunAzimuth: number
  sunIntensity: number
  sunSize: number
  skyColor: [number, number, number]
  horizonColor: [number, number, number]
  groundColor: [number, number, number]
  /** Overall multiplier, before tone mapping. */
  intensity: number
  /** Broken cloud cover, which softens the key and breaks up flat reflections. */
  clouds: number
}

export const ENVIRONMENT_PRESETS: Record<string, EnvironmentSettings> = {
  studio: {
    sunElevation: 38, sunAzimuth: 40, sunIntensity: 20, sunSize: 0.05,
    skyColor: [0.42, 0.5, 0.62], horizonColor: [0.78, 0.78, 0.8], groundColor: [0.16, 0.16, 0.18],
    intensity: 1.0, clouds: 0,
  },
  sunset: {
    sunElevation: 6, sunAzimuth: 250, sunIntensity: 14, sunSize: 0.05,
    skyColor: [0.16, 0.25, 0.48], horizonColor: [0.95, 0.45, 0.18], groundColor: [0.1, 0.07, 0.06],
    intensity: 1.1, clouds: 0.35,
  },
  overcast: {
    sunElevation: 60, sunAzimuth: 60, sunIntensity: 1.2, sunSize: 0.5,
    skyColor: [0.62, 0.65, 0.7], horizonColor: [0.7, 0.71, 0.73], groundColor: [0.3, 0.3, 0.31],
    intensity: 0.9, clouds: 0.8,
  },
  night: {
    sunElevation: 25, sunAzimuth: 310, sunIntensity: 2.5, sunSize: 0.04,
    skyColor: [0.03, 0.05, 0.11], horizonColor: [0.08, 0.1, 0.16], groundColor: [0.02, 0.02, 0.03],
    intensity: 1.4, clouds: 0.2,
  },
}

export class ProceduralEnvironment {
  #equirect: RenderTarget
  #cube: CubeRenderTarget
  #pmrem: PMREMGenerator | null = null
  #envTarget: RenderTarget | null = null
  #quad = new QuadMesh()
  #material: MeshBasicNodeMaterial

  #sunDirection = uniform(new Vector3(0, 1, 0))
  #sunIntensity = uniform(6)
  #sunSize = uniform(0.09)
  #skyColor = uniform(new Vector3(0.62, 0.66, 0.72))
  #horizonColor = uniform(new Vector3(0.78, 0.78, 0.8))
  #groundColor = uniform(new Vector3(0.22, 0.22, 0.24))
  #intensity = uniform(1)
  #clouds = uniform(0)
  #built = false

  constructor(size = 512) {
    this.#equirect = new RenderTarget(size, size / 2, {
      type: HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      colorSpace: NoColorSpace,
    })
    this.#equirect.texture.mapping = EquirectangularReflectionMapping
    this.#equirect.texture.name = 'proceduralSky'
    this.#cube = new CubeRenderTarget(256, { type: HalfFloatType })
    this.#material = this.#buildMaterial()
  }

  /** Cube map, used as the scene background. */
  get texture(): Texture {
    return this.#cube.texture
  }

  /**
   * Pre-filtered environment for PBR. Generating this up front (rather than
   * lazily inside the material graph) is what keeps metals and diffuse
   * surfaces from rendering black: `pmremTexture()` on a cube render-target
   * is not always ready the first time the viewport shader compiles.
   */
  get envMap(): Texture | null {
    return this.#envTarget?.texture ?? null
  }

  get equirectTexture(): Texture {
    return this.#equirect.texture
  }

  get built(): boolean {
    return this.#built
  }

  apply(settings: EnvironmentSettings): void {
    const elevation = (settings.sunElevation * Math.PI) / 180
    const azimuth = (settings.sunAzimuth * Math.PI) / 180
    this.#sunDirection.value.set(
      Math.cos(elevation) * Math.cos(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.sin(azimuth),
    )
    this.#sunIntensity.value = settings.sunIntensity
    this.#sunSize.value = Math.max(0.005, settings.sunSize)
    this.#skyColor.value.set(...settings.skyColor)
    this.#horizonColor.value.set(...settings.horizonColor)
    this.#groundColor.value.set(...settings.groundColor)
    this.#intensity.value = settings.intensity
    this.#clouds.value = settings.clouds
  }

  /** Regenerates the sky, cube background, and pre-filtered IBL map. */
  build(renderer: Renderer): void {
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.#equirect)
    this.#quad.material = this.#material
    this.#quad.render(renderer)
    renderer.setRenderTarget(previous)
    this.#cube.fromEquirectangularTexture(renderer, this.#equirect.texture)
    if (!this.#pmrem) this.#pmrem = new PMREMGenerator(renderer)
    this.#envTarget = this.#pmrem.fromEquirectangular(this.#equirect.texture, this.#envTarget)
    this.#built = true
  }

  #buildMaterial(): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending

    // Invert three's equirect mapping so the generated texture lines up with
    // how it will be sampled back.
    const coord = uv()
    const phi = coord.x.sub(0.5).mul(Math.PI * 2)
    const theta = coord.y.sub(0.5).mul(Math.PI)
    const cosTheta = theta.cos()
    const dir = vec3(phi.cos().negate().mul(cosTheta), theta.sin(), phi.sin().mul(cosTheta))

    const up = dir.y
    const skyGradient = mix(this.#horizonColor, this.#skyColor, smoothstep(float(0), float(0.55), up))
    const ground = mix(this.#groundColor, this.#horizonColor, smoothstep(float(-0.35), float(0), up))
    let colour = mix(ground, skyGradient, smoothstep(float(-0.02), float(0.02), up))

    // Broken cloud cover: fbm over the direction, confined to the upper hemisphere.
    const cloudField = fbm01(dir.mul(2.5), 5, 2.2, 0.5)
    const cloudMask = smoothstep(float(0.5), float(0.72), cloudField)
      .mul(smoothstep(float(0), float(0.25), up))
      .mul(this.#clouds)
    colour = mix(colour, vec3(0.86, 0.88, 0.92), cloudMask)

    // Sun: a soft disk plus a wide exponential glow, which is what gives a
    // rough metal its broad highlight rather than a hard dot.
    const cosAngle = dir.dot(this.#sunDirection).clamp(-1, 1)
    const disk = smoothstep(float(1).sub(this.#sunSize), float(1).sub(this.#sunSize.mul(0.35)), cosAngle)
    const glow = exp(cosAngle.oneMinus().mul(-14)).mul(0.35)
    const sun = disk.add(glow).mul(this.#sunIntensity).mul(this.#clouds.oneMinus().mul(0.7).add(0.3))

    const result = colour.add(vec3(1, 0.96, 0.9).mul(sun)).mul(this.#intensity)
    material.fragmentNode = vec4(max(result, vec3(0, 0, 0)), 1)
    return material
  }

  dispose(): void {
    this.#equirect.dispose()
    this.#cube.dispose()
    this.#envTarget?.dispose()
    this.#envTarget = null
    this.#pmrem?.dispose()
    this.#pmrem = null
    this.#material.dispose()
  }
}
