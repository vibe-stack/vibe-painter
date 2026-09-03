/**
 * glTF / GLB import.
 *
 * The painter is a single-mesh, UV-space tool: one geometry, one texture set.
 * A glTF file is a scene graph. This module flattens that graph into one
 * BufferGeometry the rest of the engine can consume - world transforms baked
 * in, skins posed, instances expanded, extras stripped.
 *
 * Scale is normalised on purpose. glTF assets arrive in metres, centimetres,
 * or "whatever the DCC was using that day"; the camera, the brush radius and
 * the bake ray lengths are all in world units, so an unscaled import would
 * make the brush invisible or the camera sit inside the model. Centring and
 * fitting to the same size as the built-in primitives keeps every control
 * working without a second set of units.
 */

import { Box3, BufferAttribute, BufferGeometry, DataTexture, Matrix4, Vector3 } from 'three/webgpu'
import type { InstancedMesh, Material, Mesh, Object3D, SkinnedMesh, Texture } from 'three/webgpu'
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { deinterleaveGeometry, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { prepareGeometry } from './tangents'

export interface ImportedGltf {
  geometry: BufferGeometry
  name: string
  fileName: string
  triangleCount: number
  /** True when the file had no UVs and we generated a box atlas. */
  generatedUVs: boolean
}

/** Longest-axis length matching the built-in primitives (cube is 1.6, plane is 2). */
const FIT_SIZE = 2

/** Gap between the six box-atlas cells so dilation has somewhere to bleed. */
const ATLAS_MARGIN = 0.04

let loaderPromise: Promise<GLTFLoader> | null = null

async function getLoader(): Promise<GLTFLoader> {
  if (loaderPromise) return loaderPromise
  loaderPromise = (async () => {
    const loader = new GLTFLoader()
    const draco = new DRACOLoader()
    draco.setDecoderPath(DRACO_GLTF_CONFIG)
    loader.setDRACOLoader(draco)
    // Materials are discarded after the graph is flattened, so decoding
    // embedded images is wasted work and, in some runtimes, a crash
    // (`ImageBitmapLoader` needs a browser `self`). A 1x1 stand-in keeps
    // the parser happy without touching image codecs.
    loader.register(() => {
      const dummy = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
      dummy.needsUpdate = true
      dummy.name = 'gltf-import-placeholder'
      return {
        name: 'SkipGltfTextures',
        loadTexture: () => Promise.resolve(dummy),
      }
    })
    if (MeshoptDecoder.supported) {
      try {
        await MeshoptDecoder.ready
        loader.setMeshoptDecoder(MeshoptDecoder)
      } catch {
        // Meshopt is optional. Uncompressed and Draco files still load.
      }
    }
    return loader
  })()
  return loaderPromise
}

export async function loadGltfGeometry(source: File | Blob | ArrayBuffer, fileName = 'imported.glb'): Promise<ImportedGltf> {
  const name = source instanceof File ? source.name : fileName
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer()
  if (buffer.byteLength === 0) throw new Error(`"${name}" is empty`)

  const loader = await getLoader()
  let gltf
  try {
    gltf = await loader.parseAsync(buffer, '')
  } catch (cause) {
    throw new Error(`Could not read "${name}": ${describeGltfError(cause)}`)
  }

  const scene = gltf.scene ?? gltf.scenes[0]
  if (!scene) {
    disposeObject(gltf.scene)
    throw new Error(`"${name}" has no scene`)
  }

  scene.updateMatrixWorld(true)

  const pieces: BufferGeometry[] = []
  let generatedUVs = false
  scene.traverse((object) => {
    const extracted = extractMeshGeometries(object)
    for (const piece of extracted.geometries) pieces.push(piece)
    if (extracted.generatedUVs) generatedUVs = true
  })

  disposeObject(scene)
  for (const extra of gltf.scenes) {
    if (extra !== scene) disposeObject(extra)
  }

  if (pieces.length === 0) {
    throw new Error(`"${name}" has no triangle meshes to paint`)
  }

  const geometry = combine(pieces)
  fitToOrigin(geometry)
  prepareGeometry(geometry)

  const index = geometry.getIndex()
  const triangleCount = Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3)
  if (triangleCount === 0) throw new Error(`"${name}" has no triangles`)

  return {
    geometry,
    name: displayName(name),
    fileName: name,
    triangleCount,
    generatedUVs,
  }
}

function extractMeshGeometries(object: Object3D): { geometries: BufferGeometry[]; generatedUVs: boolean } {
  const mesh = asMesh(object)
  if (!mesh) return { geometries: [], generatedUVs: false }
  const source = mesh.geometry
  if (!source?.getAttribute('position') || source.getAttribute('position').count === 0) {
    return { geometries: [], generatedUVs: false }
  }

  const instanced = asInstancedMesh(mesh)
  if (instanced && instanced.count > 0) {
    const geometries: BufferGeometry[] = []
    let generatedUVs = false
    const local = new Matrix4()
    const world = new Matrix4()
    for (let i = 0; i < instanced.count; i++) {
      instanced.getMatrixAt(i, local)
      world.multiplyMatrices(instanced.matrixWorld, local)
      const prepared = preparePiece(mesh, world)
      geometries.push(prepared.geometry)
      if (prepared.generatedUVs) generatedUVs = true
    }
    return { geometries, generatedUVs }
  }

  const prepared = preparePiece(mesh, mesh.matrixWorld)
  return { geometries: [prepared.geometry], generatedUVs: prepared.generatedUVs }
}

function preparePiece(mesh: Mesh, world: Matrix4): { geometry: BufferGeometry; generatedUVs: boolean } {
  const geometry = mesh.geometry.clone()
  const skinned = asSkinnedMesh(mesh)
  if (skinned) bakeSkin(skinned, geometry)
  geometry.applyMatrix4(world)
  deinterleaveGeometry(geometry)
  geometry.morphAttributes = {}
  geometry.clearGroups()

  if (!geometry.getAttribute('uv')) {
    const alt = geometry.getAttribute('uv1') ?? geometry.getAttribute('uv2')
    if (alt) geometry.setAttribute('uv', alt.clone())
  }

  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name)
  }

  let generatedUVs = false
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  if (!geometry.getAttribute('uv')) {
    const unique = geometry.index ? geometry.toNonIndexed() : geometry
    generateBoxUVs(unique)
    generatedUVs = true
    if (unique !== geometry) {
      geometry.dispose()
      return { geometry: unique, generatedUVs }
    }
  }

  return { geometry, generatedUVs }
}

function bakeSkin(mesh: SkinnedMesh, geometry: BufferGeometry): void {
  if (!mesh.skeleton || !geometry.getAttribute('skinIndex') || !geometry.getAttribute('skinWeight')) return
  const previous = mesh.geometry
  mesh.geometry = geometry
  try {
    mesh.skeleton.update()
    const position = geometry.getAttribute('position')
    const vertex = new Vector3()
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i)
      mesh.applyBoneTransform(i, vertex)
      position.setXYZ(i, vertex.x, vertex.y, vertex.z)
    }
    position.needsUpdate = true
    // Bind-pose normals no longer match the posed positions.
    geometry.deleteAttribute('normal')
  } finally {
    mesh.geometry = previous
  }
}

function combine(pieces: BufferGeometry[]): BufferGeometry {
  const aligned = alignAttributes(pieces)
  const merged = mergeGeometries(aligned) as BufferGeometry | null
  for (const piece of aligned) {
    if (piece !== merged) piece.dispose()
  }
  if (!merged) throw new Error('Could not combine the meshes in this file into one geometry')
  return merged
}

/**
 * mergeGeometries requires every input to have the same attribute set and
 * either all indexed or all not. Strip extras already ran; this only has to
 * settle the index and make sure a missing normal on one piece does not
 * poison the merge.
 */
function alignAttributes(pieces: BufferGeometry[]): BufferGeometry[] {
  const anyIndexed = pieces.some((piece) => piece.getIndex() !== null)
  const allIndexed = pieces.every((piece) => piece.getIndex() !== null)
  const deindex = anyIndexed && !allIndexed
  return pieces.map((piece) => {
    let geometry = deindex && piece.getIndex() ? piece.toNonIndexed() : piece
    if (geometry !== piece) piece.dispose()
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    return geometry
  })
}

function fitToOrigin(geometry: BufferGeometry): void {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) return
  const center = box.getCenter(new Vector3())
  const size = box.getSize(new Vector3())
  const longest = Math.max(size.x, size.y, size.z)
  geometry.translate(-center.x, -center.y, -center.z)
  if (longest > 1e-8) {
    const scale = FIT_SIZE / longest
    geometry.scale(scale, scale, scale)
  }
}

/**
 * Six-direction box atlas. Overlapping within a face is expected - this is a
 * fallback so files without UVs still paint under triplanar, not a production
 * unwrap.
 */
function generateBoxUVs(geometry: BufferGeometry): void {
  const position = geometry.getAttribute('position')
  geometry.computeBoundingBox()
  const box = geometry.boundingBox ?? new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
  const size = box.getSize(new Vector3())
  const sx = Math.max(size.x, 1e-8)
  const sy = Math.max(size.y, 1e-8)
  const sz = Math.max(size.z, 1e-8)

  const uvs = new Float32Array(position.count * 2)
  const p0 = new Vector3()
  const p1 = new Vector3()
  const p2 = new Vector3()
  const e1 = new Vector3()
  const e2 = new Vector3()
  const n = new Vector3()
  const p = new Vector3()

  const triangles = Math.floor(position.count / 3)
  for (let t = 0; t < triangles; t++) {
    const i0 = t * 3
    const i1 = i0 + 1
    const i2 = i0 + 2
    p0.fromBufferAttribute(position, i0)
    p1.fromBufferAttribute(position, i1)
    p2.fromBufferAttribute(position, i2)
    n.crossVectors(e1.subVectors(p1, p0), e2.subVectors(p2, p0))
    const ax = Math.abs(n.x)
    const ay = Math.abs(n.y)
    const az = Math.abs(n.z)

    let col = 0
    let row = 0
    let uOf: (v: Vector3) => number
    let vOf: (v: Vector3) => number
    if (ax >= ay && ax >= az) {
      col = n.x >= 0 ? 0 : 1
      row = 0
      uOf = (v) => (n.x >= 0 ? v.z - box.min.z : box.max.z - v.z) / sz
      vOf = (v) => (v.y - box.min.y) / sy
    } else if (ay >= ax && ay >= az) {
      col = 2
      row = n.y >= 0 ? 0 : 1
      uOf = (v) => (v.x - box.min.x) / sx
      vOf = (v) => (n.y >= 0 ? box.max.z - v.z : v.z - box.min.z) / sz
    } else {
      col = n.z >= 0 ? 1 : 2
      row = 1
      uOf = (v) => (n.z >= 0 ? v.x - box.min.x : box.max.x - v.x) / sx
      vOf = (v) => (v.y - box.min.y) / sy
    }

    for (const i of [i0, i1, i2]) {
      p.fromBufferAttribute(position, i)
      writeAtlasUv(uvs, i, col, row, uOf(p), vOf(p))
    }
  }

  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
}

function writeAtlasUv(uvs: Float32Array, index: number, col: number, row: number, fu: number, fv: number): void {
  const cellW = 1 / 3
  const cellH = 1 / 2
  const u = (col + ATLAS_MARGIN + clamp01(fu) * (1 - ATLAS_MARGIN * 2)) * cellW
  const v = (row + ATLAS_MARGIN + clamp01(fv) * (1 - ATLAS_MARGIN * 2)) * cellH
  uvs[index * 2] = u
  uvs[index * 2 + 1] = v
}

function asMesh(object: Object3D): Mesh | null {
  return (object as Mesh).isMesh ? (object as Mesh) : null
}

function asSkinnedMesh(mesh: Mesh): SkinnedMesh | null {
  return (mesh as SkinnedMesh).isSkinnedMesh ? (mesh as SkinnedMesh) : null
}

function asInstancedMesh(mesh: Mesh): InstancedMesh | null {
  return (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh) : null
}

function disposeObject(root: Object3D | undefined): void {
  if (!root) return
  root.traverse((object) => {
    const mesh = asMesh(object)
    if (!mesh) return
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const material of materials) disposeMaterial(material)
  })
}

function disposeMaterial(material: Material): void {
  const record = material as unknown as Record<string, unknown>
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && (value as Texture).isTexture) {
      (value as Texture).dispose()
    }
  }
  material.dispose()
}

function displayName(fileName: string): string {
  const slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'))
  const base = slash >= 0 ? fileName.slice(slash + 1) : fileName
  return base.replace(/\.(glb|gltf)$/i, '') || 'Imported'
}

function describeGltfError(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') {
    return cause.message
  }
  return String(cause)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export const GLTF_ACCEPT = '.glb,.gltf,model/gltf-binary,model/gltf+json'

export function isGltfFileName(name: string): boolean {
  return /\.(glb|gltf)$/i.test(name)
}
