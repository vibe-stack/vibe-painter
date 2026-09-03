/**
 * AO, curvature and thickness on the GPU.
 *
 * Curvature is a derivative of the world normal, rasterised into UV space
 * with the same pass the geometry maps use — so it cannot pick up chart
 * borders.
 *
 * AO and thickness are visibility. A gather in the atlas follows UV seams
 * (the cracked "AO" on the bust). Instead the mesh is rendered from a
 * Fibonacci set of directions into a depth buffer, and each surface texel
 * asks whether anything sits in front of it along that ray. That is a
 * directional shadow map, accumulated over the hemisphere.
 */

import {
  Mesh,
  MeshBasicNodeMaterial,
  Matrix4,
  NoBlending,
  NodeMaterial,
  OrthographicCamera,
  QuadMesh,
  Scene,
  Vector3,
  RenderTarget,
} from 'three/webgpu'
import type { BufferGeometry, Renderer } from 'three/webgpu'
import {
  Fn,
  If,
  dFdx,
  dFdy,
  float,
  max,
  min,
  modelNormalMatrix,
  normalize,
  normalLocal,
  positionWorld,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl'
import type { BakeSettings } from '../doc/types'
import type { BakeProgress } from '../bake/baker'
import { CHANNEL_TARGET_OPTIONS } from './targets'
import { UVSpacePass, renderQuad, uvClipPosition } from './uvspace'
import { createRayTarget } from './meshmaps'
import type { MeshMaps } from './meshmaps'

const DEPTH_MAP_SIZE = 512
const FAR_CLEAR = 1e5

export class GpuMeshMapBaker {
  #uvPass = new UVSpacePass()
  #quad = new QuadMesh()

  #depthScene = new Scene()
  #depthMesh = new Mesh()
  #depthCamera = new OrthographicCamera()
  #depthRT: RenderTarget | null = null
  #accumA: RenderTarget | null = null
  #accumB: RenderTarget | null = null

  #curvatureMaterial: NodeMaterial | null = null
  #depthMaterial: NodeMaterial | null = null
  #farClearMaterial: MeshBasicNodeMaterial | null = null
  #accumReadA: MeshBasicNodeMaterial | null = null
  #accumReadB: MeshBasicNodeMaterial | null = null
  #composeReadA: MeshBasicNodeMaterial | null = null
  #composeReadB: MeshBasicNodeMaterial | null = null
  #mapsKey = ''
  #cancelled = false

  #aoDistance = uniform(0.5)
  #rayBias = uniform(1e-3)
  #curvatureIntensity = uniform(1)
  #bboxMin = uniform(new Vector3())
  #bboxSize = uniform(new Vector3())
  #viewProj = uniform(new Matrix4())
  #camPos = uniform(new Vector3())
  #lookDir = uniform(new Vector3())
  #sampleDir = uniform(new Vector3())

  constructor() {
    this.#depthMesh.frustumCulled = false
    this.#depthScene.add(this.#depthMesh)
  }

  cancel(): void {
    this.#cancelled = true
  }

  bake(
    renderer: Renderer,
    geometry: BufferGeometry,
    maps: MeshMaps,
    settings: BakeSettings,
    onProgress?: (progress: BakeProgress) => void,
  ): void {
    if (!maps.geometryBaked) throw new Error('Geometry maps must be baked before mesh maps')
    this.#cancelled = false

    maps.ensureRayTarget(settings.resolution)
    const box = maps.bbox
    const extent = box.max.clone().sub(box.min)
    const center = box.min.clone().add(box.max).multiplyScalar(0.5)
    const radius = Math.max(1e-5, extent.length() * 0.5)

    this.#aoDistance.value = Math.max(1e-4, settings.aoDistance * radius)
    this.#rayBias.value = Math.max(1e-5, settings.rayBias * radius)
    this.#curvatureIntensity.value = settings.curvatureIntensity
    this.#bboxMin.value.copy(box.min)
    this.#bboxSize.value.set(Math.max(1e-5, extent.x), Math.max(1e-5, extent.y), Math.max(1e-5, extent.z))

    const directions = fibonacciSphere(Math.max(8, Math.min(64, Math.round(settings.aoRays))))
    const accumA = this.#ensureAccum(settings.resolution)
    const accumB = this.#ensureAccumB(settings.resolution)
    const depthRT = this.#ensureDepth()
    this.#prepareMaterials(maps, depthRT, accumA, accumB)

    onProgress?.({ fraction: 0.05, message: 'Rasterising curvature' })
    this.#bakeCurvature(renderer, geometry, accumA)

    const depthMat = this.#depthMaterialFor()
    this.#depthMesh.geometry = geometry
    this.#depthMesh.material = depthMat

    let readA = true
    const n = directions.length
    for (let i = 0; i < n; i++) {
      if (this.#cancelled) return
      const dir = directions[i]
      this.#setupDepthCamera(dir, center, radius)
      this.#renderDepth(renderer, depthRT)
      const accumMat = readA ? this.#accumReadA! : this.#accumReadB!
      const write = readA ? accumB : accumA
      renderQuad(renderer, this.#quad, accumMat, write)
      readA = !readA
      if (i % 4 === 0) {
        onProgress?.({ fraction: 0.1 + (0.75 * (i + 1)) / n, message: `Visibility ${i + 1}/${n}` })
      }
    }

    if (this.#cancelled) return
    onProgress?.({ fraction: 0.92, message: 'Composing maps' })
    const compose = readA ? this.#composeReadA! : this.#composeReadB!
    renderQuad(renderer, this.#quad, compose, maps.ray)
    maps.markRayBaked()
  }

  #bakeCurvature(renderer: Renderer, geometry: BufferGeometry, target: RenderTarget): void {
    const material = this.#curvatureMaterialFor()
    this.#uvPass.render(renderer, geometry, material, target, true)
    this.#uvPass.render(renderer, geometry, material, target, true)
  }

  #prepareMaterials(maps: MeshMaps, depthRT: RenderTarget, accumA: RenderTarget, accumB: RenderTarget): void {
    const key = `${maps.geometry.textures[0].id}:${maps.islandMask.texture.id}:${depthRT.texture.id}:${accumA.texture.id}:${accumB.texture.id}`
    if (this.#mapsKey === key && this.#accumReadA && this.#accumReadB) return
    this.#accumReadA?.dispose()
    this.#accumReadB?.dispose()
    this.#composeReadA?.dispose()
    this.#composeReadB?.dispose()
    this.#accumReadA = this.#buildAccumMaterial(maps, depthRT, accumA)
    this.#accumReadB = this.#buildAccumMaterial(maps, depthRT, accumB)
    this.#composeReadA = this.#buildComposeMaterial(maps, accumA)
    this.#composeReadB = this.#buildComposeMaterial(maps, accumB)
    this.#mapsKey = key
  }

  #curvatureMaterialFor(): NodeMaterial {
    if (this.#curvatureMaterial) return this.#curvatureMaterial
    const material = new NodeMaterial()
    material.vertexNode = uvClipPosition()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const wn = normalize(modelNormalMatrix.mul(normalLocal))
    const wp = positionWorld
    const dpx = dFdx(wp)
    const dpy = dFdy(wp)
    const dnx = dFdx(wn)
    const dny = dFdy(wn)
    const cx = dnx.dot(dpx).div(max(dpx.dot(dpx), float(1e-8)))
    const cy = dny.dot(dpy).div(max(dpy.dot(dpy), float(1e-8)))
    const raw = cx.add(cy).mul(0.5).mul(this.#curvatureIntensity)
    const curv = raw.mul(0.5).add(0.5).clamp(0, 1)
    material.fragmentNode = vec4(float(0), float(0), float(FAR_CLEAR), curv)
    this.#curvatureMaterial = material
    return material
  }

  #depthMaterialFor(): NodeMaterial {
    if (this.#depthMaterial) return this.#depthMaterial
    const material = new NodeMaterial()
    material.depthTest = true
    material.depthWrite = true
    material.blending = NoBlending
    const linear = positionWorld.sub(this.#camPos).dot(this.#lookDir)
    material.fragmentNode = vec4(linear, 0, 0, 1)
    this.#depthMaterial = material
    return material
  }

  #farClearMaterialFor(): MeshBasicNodeMaterial {
    if (this.#farClearMaterial) return this.#farClearMaterial
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    material.fragmentNode = vec4(FAR_CLEAR, 0, 0, 1)
    this.#farClearMaterial = material
    return material
  }

  #buildAccumMaterial(maps: MeshMaps, depthRT: RenderTarget, accumSrc: RenderTarget): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const uvNode = uv()
    const island = texture(maps.islandMask.texture, uvNode).x
    const P = texture(maps.geometry.textures[0], uvNode).xyz.mul(this.#bboxSize).add(this.#bboxMin)
    const N = normalize(texture(maps.geometry.textures[1], uvNode).xyz)
    const prevTex = accumSrc.texture
    const depthTex = depthRT.texture

    material.fragmentNode = Fn(() => {
      const prev = texture(prevTex, uvNode)
      const occ = prev.x.toVar('occ')
      const count = prev.y.toVar('count')
      const thick = prev.z.toVar('thick')
      const curv = prev.w.toVar('curv')

      If(island.greaterThan(float(0.5)), () => {
        const clip = this.#viewProj.mul(vec4(P, 1))
        const ndc = clip.xyz.div(clip.w)
        const suv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(0.5).add(0.5))
        const onMap = suv.x.greaterThanEqual(0).and(suv.x.lessThanEqual(1)).and(suv.y.greaterThanEqual(0)).and(suv.y.lessThanEqual(1))
        const myDepth = P.sub(this.#camPos).dot(this.#lookDir)
        const closest = texture(depthTex, suv).x
        const dist = myDepth.sub(closest)
        const occluded = onMap.and(dist.greaterThan(this.#rayBias))
        const ndot = N.dot(this.#sampleDir)

        If(ndot.greaterThan(float(0.05)), () => {
          count.addAssign(float(1))
          If(occluded.and(dist.lessThan(this.#aoDistance)), () => {
            const falloff = float(1).sub(dist.div(this.#aoDistance)).clamp(0, 1)
            occ.addAssign(falloff.mul(ndot))
          })
        })
        If(ndot.lessThan(float(-0.25)).and(occluded), () => {
          thick.assign(min(thick, max(dist, float(0))))
        })
      })

      return vec4(occ, count, thick, curv)
    })()
    return material
  }

  #buildComposeMaterial(maps: MeshMaps, accum: RenderTarget): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial()
    material.depthTest = false
    material.depthWrite = false
    material.blending = NoBlending
    const uvNode = uv()
    const island = texture(maps.islandMask.texture, uvNode).x
    const acc = texture(accum.texture, uvNode)
    const ao = float(1).sub(acc.x.div(max(acc.y, float(1))).clamp(0, 1))
    const thick = acc.z.div(max(this.#aoDistance.mul(4), float(1e-4))).clamp(0, 1)
    const inside = island.greaterThan(float(0.5))
    material.fragmentNode = vec4(
      inside.select(ao, float(1)),
      inside.select(acc.w, float(0.5)),
      inside.select(thick, float(0.5)),
      island,
    )
    return material
  }

  #setupDepthCamera(dir: Vector3, center: Vector3, radius: number): void {
    const pad = radius * 1.15
    const cam = this.#depthCamera
    cam.left = -pad
    cam.right = pad
    cam.top = pad
    cam.bottom = -pad
    cam.near = 0.001
    cam.far = pad * 2 + 0.002
    cam.position.copy(center).addScaledVector(dir, pad)
    cam.up.set(0, 1, 0)
    if (Math.abs(dir.y) > 0.9) cam.up.set(1, 0, 0)
    cam.lookAt(center)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
    this.#camPos.value.copy(cam.position)
    cam.getWorldDirection(this.#lookDir.value)
    this.#sampleDir.value.copy(dir)
    this.#viewProj.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  }

  #renderDepth(renderer: Renderer, target: RenderTarget): void {
    renderQuad(renderer, this.#quad, this.#farClearMaterialFor(), target)
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setRenderTarget(target)
    try {
      renderer.clear(false, true, false)
      renderer.render(this.#depthScene, this.#depthCamera)
      // WebGPU skips the first draw of a new pipeline; a second submit is cheap
      // next to the rest of the bake and fills an otherwise empty depth map.
      renderer.render(this.#depthScene, this.#depthCamera)
    } finally {
      renderer.autoClear = previousAutoClear
      renderer.setRenderTarget(previousTarget)
    }
  }

  #ensureDepth(): RenderTarget {
    if (this.#depthRT) return this.#depthRT
    this.#depthRT = new RenderTarget(DEPTH_MAP_SIZE, DEPTH_MAP_SIZE, {
      ...CHANNEL_TARGET_OPTIONS,
      depthBuffer: true,
    })
    this.#depthRT.texture.name = 'bakeDepth'
    return this.#depthRT
  }

  #ensureAccum(resolution: number): RenderTarget {
    if (this.#accumA && this.#accumA.width === resolution) return this.#accumA
    this.#accumA?.dispose()
    this.#accumA = createRayTarget(resolution, 'bakeAccumA')
    this.#mapsKey = ''
    return this.#accumA
  }

  #ensureAccumB(resolution: number): RenderTarget {
    if (this.#accumB && this.#accumB.width === resolution) return this.#accumB
    this.#accumB?.dispose()
    this.#accumB = createRayTarget(resolution, 'bakeAccumB')
    this.#mapsKey = ''
    return this.#accumB
  }

  dispose(): void {
    this.#curvatureMaterial?.dispose()
    this.#depthMaterial?.dispose()
    this.#farClearMaterial?.dispose()
    this.#accumReadA?.dispose()
    this.#accumReadB?.dispose()
    this.#composeReadA?.dispose()
    this.#composeReadB?.dispose()
    this.#depthRT?.dispose()
    this.#accumA?.dispose()
    this.#accumB?.dispose()
    this.#uvPass.dispose()
    this.#depthScene.remove(this.#depthMesh)
  }
}

function fibonacciSphere(count: number): Vector3[] {
  const out: Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    out.push(new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize())
  }
  return out
}
