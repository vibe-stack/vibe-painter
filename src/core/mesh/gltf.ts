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

import { BufferAttribute, BufferGeometry, DataTexture, Matrix4, Vector3 } from 'three/webgpu'
import type { InstancedMesh, Material, Mesh, Object3D, SkinnedMesh, Texture } from 'three/webgpu'
import { DRACO_GLTF_CONFIG, DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { attributeToFloat32, compactGeometryAttributes } from './attributes'
import type { MeshPart, MeshPiece } from './parts'
import { assignPartIds, attachMeshParts } from './parts'
import { prepareGeometry } from './tangents'
import { uniqueUnwrap, uvsOverlap } from './unwrap'

export interface ImportedGltf {
  geometry: BufferGeometry
  name: string
  fileName: string
  triangleCount: number
  /** True when we generated or replaced UVs so the baker has a unique atlas. */
  generatedUVs: boolean
  /** Source-mesh partitions (materials, objects, colour IDs) a fill can target. */
  parts: MeshPart[]
}

/** Longest-axis length matching the built-in primitives (cube is 1.6, plane is 2). */
const FIT_SIZE = 2

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

  const pieces: MeshPiece[] = []
  let generatedUVs = false
  scene.traverse((object) => {
    const extracted = extractMeshPieces(object)
    for (const piece of extracted.pieces) pieces.push(piece)
    if (extracted.generatedUVs) generatedUVs = true
  })

  disposeObject(scene)
  for (const extra of gltf.scenes) {
    if (extra !== scene) disposeObject(extra)
  }

  if (pieces.length === 0) {
    throw new Error(`"${name}" has no triangle meshes to paint`)
  }

  const assignment = assignPartIds(pieces)
  packUvLayouts(pieces.map((piece) => piece.geometry))
  let geometry = combine(pieces.map((piece) => piece.geometry))
  // A unique atlas is mandatory for the ray baker: overlapping charts let the
  // last triangle win, which is the "face AO stamped onto the skull" failure.
  // Keep an authored unwrap only when it already is unique.
  if (generatedUVs || uvsOverlap(geometry)) {
    const unwrapped = uniqueUnwrap(geometry)
    if (unwrapped !== geometry) geometry.dispose()
    geometry = unwrapped
    generatedUVs = true
  }
  fitToOrigin(geometry)
  prepareGeometry(geometry)
  attachMeshParts(geometry, assignment.parts)

  const index = geometry.getIndex()
  const triangleCount = Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3)
  if (triangleCount === 0) throw new Error(`"${name}" has no triangles`)

  return {
    geometry,
    name: displayName(name),
    fileName: name,
    triangleCount,
    generatedUVs,
    parts: assignment.parts,
  }
}

function extractMeshPieces(object: Object3D): { pieces: MeshPiece[]; generatedUVs: boolean } {
  const mesh = asMesh(object)
  if (!mesh) return { pieces: [], generatedUVs: false }
  const source = mesh.geometry
  if (!source?.getAttribute('position') || source.getAttribute('position').count === 0) {
    return { pieces: [], generatedUVs: false }
  }

  const instanced = asInstancedMesh(mesh)
  if (instanced && instanced.count > 0) {
    const pieces: MeshPiece[] = []
    let generatedUVs = false
    const local = new Matrix4()
    const world = new Matrix4()
    for (let i = 0; i < instanced.count; i++) {
      instanced.getMatrixAt(i, local)
      world.multiplyMatrices(instanced.matrixWorld, local)
      const extracted = preparePieces(mesh, world)
      for (const piece of extracted.pieces) pieces.push(piece)
      if (extracted.generatedUVs) generatedUVs = true
    }
    return { pieces, generatedUVs }
  }

  return preparePieces(mesh, mesh.matrixWorld)
}

/**
 * One mesh becomes one piece per source material. Groups on a multi-material
 * mesh are sliced so each slot keeps its name; a single-material mesh is one
 * piece. Vertex colours stay until `assignPartIds` decides whether they are
 * the ID source.
 */
function preparePieces(mesh: Mesh, world: Matrix4): { pieces: MeshPiece[]; generatedUVs: boolean } {
  const geometry = mesh.geometry.clone()
  // Float-expand *before* skinning and matrix bake. Writing a denormalised
  // position back into a normalised integer attribute would quantise it again
  // and smear the mesh.
  compactGeometryAttributes(geometry, ['position', 'normal', 'uv', 'uv1', 'uv2', 'skinWeight', 'color'])
  const skinned = asSkinnedMesh(mesh)
  if (skinned) bakeSkin(skinned, geometry)
  geometry.applyMatrix4(world)
  geometry.morphAttributes = {}

  if (!geometry.getAttribute('uv')) {
    const alt = geometry.getAttribute('uv1') ?? geometry.getAttribute('uv2')
    if (alt) geometry.setAttribute('uv', alt.clone())
  }

  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
      geometry.deleteAttribute(name)
    }
  }

  let generatedUVs = false
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  if (!geometry.getAttribute('uv')) {
    // Placeholder so mergeGeometries sees the same attributes on every piece.
    // The real unwrap runs on the combined mesh.
    const count = geometry.getAttribute('position').count
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2))
    generatedUVs = true
  }

  const expanded = geometry.getIndex() ? geometry.toNonIndexed() : geometry
  if (expanded !== geometry) geometry.dispose()

  const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
  const objectName = mesh.name || mesh.parent?.name || 'Mesh'
  const vertexCount = expanded.getAttribute('position').count
  const groups = expanded.groups.length > 0
    ? expanded.groups
    : [{ start: 0, count: vertexCount, materialIndex: 0 }]

  const pieces: MeshPiece[] = []
  for (const group of groups) {
    const slice = sliceVertexRange(expanded, group.start, group.count)
    if (!slice) continue
    const materialIndex = group.materialIndex ?? 0
    const material = materials[materialIndex] ?? materials[0]
    const materialName = (material?.name && material.name.trim()) || `Material ${materialIndex + 1}`
    pieces.push({
      geometry: slice,
      materialKey: material?.uuid ?? `mat-${materialIndex}`,
      materialName,
      objectName,
    })
  }
  expanded.dispose()
  return { pieces, generatedUVs }
}

function sliceVertexRange(geometry: BufferGeometry, start: number, count: number): BufferGeometry | null {
  const position = geometry.getAttribute('position')
  if (!position || count < 3) return null
  const end = Math.min(position.count, Math.max(0, start) + count)
  const from = Math.max(0, start)
  const length = end - from
  if (length < 3) return null

  const out = new BufferGeometry()
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.getAttribute(name)
    const packed = attributeToFloat32(attr as Parameters<typeof attributeToFloat32>[0], attr.itemSize)
    const sliced = packed.subarray(from * attr.itemSize, end * attr.itemSize)
    out.setAttribute(name, new BufferAttribute(new Float32Array(sliced), attr.itemSize))
  }
  return out
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

/**
 * Each glTF primitive usually has its own 0..1 unwrap. Merging them as-is
 * stacks every island on top of every other, so the ray baker's last triangle
 * wins and AO/curvature/thickness land on the wrong surface. Pack the pieces
 * into a unique atlas when their UV rectangles overlap or sit outside 0..1.
 *
 * A single primitive that already lives in 0..1 is left alone, so a proper
 * unique unwrap is not disturbed.
 */
function packUvLayouts(pieces: BufferGeometry[]): void {
  if (pieces.length === 0) return
  const bounds = pieces.map(uvBounds)
  const needsPack = pieces.length > 1
    ? bounds.some((a, i) => bounds.some((b, j) => i < j && uvRectsOverlap(a, b)))
      || bounds.some((b) => b.minU < -0.001 || b.minV < -0.001 || b.maxU > 1.001 || b.maxV > 1.001)
    : bounds[0].minU < -0.001 || bounds[0].minV < -0.001 || bounds[0].maxU > 1.001 || bounds[0].maxV > 1.001

  if (!needsPack) return

  const pad = 0.04
  const boxes = bounds.map((b, i) => ({
    i,
    w: Math.max(1e-4, b.maxU - b.minU) + pad,
    h: Math.max(1e-4, b.maxV - b.minV) + pad,
    x: 0,
    y: 0,
  }))
  const packed = packRects(boxes)
  const margin = 0.02
  const innerW = Math.max(packed.w, 1e-8)
  const innerH = Math.max(packed.h, 1e-8)

  for (const box of boxes) {
    const src = bounds[box.i]
    remapUVs(pieces[box.i], src, {
      minU: margin + (box.x / innerW) * (1 - margin * 2),
      minV: margin + (box.y / innerH) * (1 - margin * 2),
      maxU: margin + ((box.x + box.w) / innerW) * (1 - margin * 2),
      maxV: margin + ((box.y + box.h) / innerH) * (1 - margin * 2),
    })
  }
}

function uvBounds(geometry: BufferGeometry): { minU: number; minV: number; maxU: number; maxV: number } {
  const uv = geometry.getAttribute('uv')
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i)
    const v = uv.getY(i)
    if (u < minU) minU = u
    if (v < minV) minV = v
    if (u > maxU) maxU = u
    if (v > maxV) maxV = v
  }
  if (!Number.isFinite(minU)) return { minU: 0, minV: 0, maxU: 1, maxV: 1 }
  return { minU, minV, maxU, maxV }
}

function uvRectsOverlap(
  a: { minU: number; minV: number; maxU: number; maxV: number },
  b: { minU: number; minV: number; maxU: number; maxV: number },
): boolean {
  const eps = 1e-4
  return a.minU < b.maxU - eps && b.minU < a.maxU - eps && a.minV < b.maxV - eps && b.minV < a.maxV - eps
}

function packRects(boxes: { w: number; h: number; x: number; y: number }[]): { w: number; h: number } {
  const sorted = [...boxes].sort((a, b) => b.h - a.h)
  const area = sorted.reduce((sum, box) => sum + box.w * box.h, 0)
  const targetW = Math.max(Math.sqrt(area), ...sorted.map((box) => box.w))
  let x = 0
  let y = 0
  let rowH = 0
  let width = 0
  let height = 0
  for (const box of sorted) {
    if (x > 0 && x + box.w > targetW) {
      x = 0
      y += rowH
      rowH = 0
    }
    box.x = x
    box.y = y
    x += box.w
    rowH = Math.max(rowH, box.h)
    width = Math.max(width, x)
    height = Math.max(height, y + box.h)
  }
  return { w: width, h: height }
}

function remapUVs(
  geometry: BufferGeometry,
  from: { minU: number; minV: number; maxU: number; maxV: number },
  to: { minU: number; minV: number; maxU: number; maxV: number },
): void {
  const uv = geometry.getAttribute('uv')
  const srcW = Math.max(1e-8, from.maxU - from.minU)
  const srcH = Math.max(1e-8, from.maxV - from.minV)
  const dstW = to.maxU - to.minU
  const dstH = to.maxV - to.minV
  for (let i = 0; i < uv.count; i++) {
    const u = to.minU + ((uv.getX(i) - from.minU) / srcW) * dstW
    const v = to.minV + ((uv.getY(i) - from.minV) / srcH) * dstH
    uv.setXY(i, u, v)
  }
  uv.needsUpdate = true
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

export const GLTF_ACCEPT = '.glb,.gltf,model/gltf-binary,model/gltf+json'

export function isGltfFileName(name: string): boolean {
  return /\.(glb|gltf)$/i.test(name)
}
