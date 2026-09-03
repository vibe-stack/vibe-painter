/**
 * Headless smoke test for GLB import. Run with: npx vite-node scripts/test-gltf-import.ts
 */
import { readFile } from 'node:fs/promises'
import { BufferGeometry, Mesh, MeshStandardMaterial, Scene } from 'three/webgpu'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { loadGltfGeometry } from '../src/core/mesh/gltf'
import { buildPrimitive } from '../src/core/mesh/primitives'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function inspect(geometry: BufferGeometry, label: string) {
  const index = geometry.getIndex()
  const triangles = Math.floor((index ? index.count : geometry.getAttribute('position').count) / 3)
  const box = geometry.boundingBox
  const size = box ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z] : null
  console.log(label, {
    triangles,
    hasUv: Boolean(geometry.getAttribute('uv')),
    hasNormal: Boolean(geometry.getAttribute('normal')),
    hasTangent: Boolean(geometry.getAttribute('tangent')),
    size,
  })
  assert(triangles > 0, `${label}: no triangles`)
  assert(geometry.getAttribute('uv'), `${label}: missing uv`)
  assert(geometry.getAttribute('normal'), `${label}: missing normal`)
  assert(geometry.getAttribute('tangent'), `${label}: missing tangent`)
  assert(size, `${label}: missing bounds`)
  const longest = Math.max(...size)
  assert(Math.abs(longest - 2) < 0.05, `${label}: expected longest axis ~2, got ${longest}`)
}

async function exportGlb(geometry: BufferGeometry): Promise<ArrayBuffer> {
  const scene = new Scene()
  scene.add(new Mesh(geometry, new MeshStandardMaterial()))
  const exporter = new GLTFExporter()
  const result = await exporter.parseAsync(scene, { binary: true })
  if (result instanceof ArrayBuffer) return result
  throw new Error('Exporter did not return a GLB ArrayBuffer')
}

async function loadFile(path: string, name: string) {
  const buf = await readFile(path)
  return loadGltfGeometry(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name)
}

const unwrapped = await loadFile('/tmp/vibe-painter-gltf/Box.glb', 'Box.glb')
inspect(unwrapped.geometry, 'Box.glb (no UVs in file)')
assert(unwrapped.generatedUVs, 'Box.glb has no TEXCOORD_0, so a box atlas should be generated')

const textured = await loadFile('/tmp/vibe-painter-gltf/BoxTextured.glb', 'BoxTextured.glb')
inspect(textured.geometry, 'BoxTextured.glb')
assert(!textured.generatedUVs, 'BoxTextured.glb should keep its authored UVs')

const duck = await loadFile('/tmp/vibe-painter-gltf/Duck.glb', 'Duck.glb')
inspect(duck.geometry, 'Duck.glb')
assert(!duck.generatedUVs, 'Duck.glb should keep its authored UVs')

const knot = await loadGltfGeometry(await exportGlb(buildPrimitive('torus-knot')), 'knot.glb')
inspect(knot.geometry, 'exported torus-knot')

const noUv = new BufferGeometry()
const src = buildPrimitive('sphere')
noUv.setAttribute('position', src.getAttribute('position').clone())
noUv.setIndex(src.getIndex()!.clone())
const generated = await loadGltfGeometry(await exportGlb(noUv), 'no-uv.glb')
inspect(generated.geometry, 'generated-uv sphere')
assert(generated.generatedUVs, 'sphere without UVs should generate a box atlas')

console.log('ok')
