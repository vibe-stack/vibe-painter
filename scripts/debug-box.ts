import { readFile } from 'node:fs/promises'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { loadGltfGeometry } from '../src/core/mesh/gltf'

const buf = await readFile('/tmp/vibe-painter-gltf/Box.glb')
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const loader = new GLTFLoader()
const gltf = await loader.parseAsync(ab, '')
gltf.scene.updateMatrixWorld(true)
gltf.scene.traverse((o) => {
  console.log('object', o.type, o.name || '(unnamed)', {
    isMesh: (o as { isMesh?: boolean }).isMesh,
    attrs: (o as { geometry?: { attributes: Record<string, unknown> } }).geometry
      ? Object.keys((o as { geometry: { attributes: Record<string, unknown> } }).geometry.attributes)
      : null,
  })
})

const imported = await loadGltfGeometry(ab, 'Box.glb')
console.log('imported', { generatedUVs: imported.generatedUVs, name: imported.name, triangles: imported.triangleCount })
