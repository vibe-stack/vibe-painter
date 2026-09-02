import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// R3F imports `three` (the WebGL build). The engine imports `three/webgpu`.
// Vite prebundles those as two copies, so DirectionalLight from the rig is a
// different class than the one the WebGPU renderer registered — lights are
// silently skipped and every MeshPhysicalNodeMaterial renders black. HMR
// loads sources as a single graph, which is why a hot reload looked fine
// and a refresh did not. Alias the bare specifier only; `three/tsl` and
// `three/addons` must keep resolving to their own entry points.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
    dedupe: ['three'],
  },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
  },
  build: {
    target: 'esnext',
  },
})
