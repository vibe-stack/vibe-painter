import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

/**
 * Deliberately not wrapped in <StrictMode>.
 *
 * StrictMode mounts, unmounts and remounts every component in development to
 * surface effect bugs. That is the right default for ordinary UI, but this app
 * owns a WebGPU device, render targets and a canvas context - things that are
 * expensive to build, cannot be attached twice to one canvas, and are torn
 * down by the simulated unmount. The result is a dead renderer in dev and a
 * working one in a production build, which is the worst possible way to find
 * out. The engine's own lifetime is managed explicitly instead.
 */
createRoot(document.getElementById('root')!).render(<App />)
