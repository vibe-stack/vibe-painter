/**
 * Application shell.
 *
 * Everything here is presentation: the engine is created once and handed to
 * the panels through context. Nothing in this file knows how a layer is
 * composited or how a bake works, which is the point - the UI is a client of
 * `src/core`, replaceable without touching it.
 */

import { useEffect, useRef, useState } from 'react'
import { VIEW_MODES } from './core/gpu/viewport'
import type { ViewMode } from './core/gpu/viewport'
import { isGltfFileName } from './core/mesh/gltf'
import { ApiProvider, useApi, useEngineVersion } from './ui/context'
import { Viewport } from './ui/Viewport'
import type { Tool } from './ui/Viewport'
import { LayerPanel } from './ui/panels/LayerPanel'
import { MaterialBrowser } from './ui/panels/MaterialBrowser'
import { PropertiesPanel } from './ui/panels/PropertiesPanel'
import { BrushPanel } from './ui/panels/BrushPanel'
import { BakePanel } from './ui/panels/BakePanel'
import { ExportPanel } from './ui/panels/ExportPanel'
import { ScenePanel } from './ui/panels/ScenePanel'
import { Button } from './ui/widgets/controls'
import { getSession } from './ui/session'

const RIGHT_TABS = ['Properties', 'Materials', 'Brush', 'Bake', 'Scene', 'Export'] as const
type RightTab = (typeof RIGHT_TABS)[number]

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  shaded: 'Shaded',
  baseColor: 'Base Color',
  roughness: 'Roughness',
  metallic: 'Metallic',
  normal: 'Normal',
  height: 'Height',
  ao: 'AO',
  emissive: 'Emissive',
  opacity: 'Opacity',
  'mesh-ao': 'Mesh · AO',
  'mesh-curvature': 'Mesh · Curvature',
  'mesh-thickness': 'Mesh · Thickness',
  'mesh-position': 'Mesh · Position',
  'mesh-normal': 'Mesh · World Normal',
  'uv-coverage': 'Mesh · UV Coverage',
}

export default function App() {
  // Module-scoped, so the engine survives any remount. See `ui/session.ts`.
  const api = getSession()

  return (
    <ApiProvider api={api}>
      <Workspace />
    </ApiProvider>
  )
}

function Workspace() {
  const api = useApi()
  useEngineVersion()
  const [tool, setTool] = useState<Tool>('orbit')
  const [tab, setTab] = useState<RightTab>('Properties')
  const [notice, setNotice] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const dropDepth = useRef(0)
  const viewMode = api.getViewMode()

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      if (event.key === 'b') setTool('paint')
      if (event.key === 'e') setTool('erase')
      if (event.key === 'v') setTool('orbit')
      if (event.key === 'c') {
        // Cycle the channel-solo view, the way Painter's C key does.
        const index = VIEW_MODES.indexOf(api.getViewMode())
        api.setViewMode(VIEW_MODES[(index + 1) % VIEW_MODES.length])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

  const status = api.status()

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-neutral-950 text-neutral-200">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-3 py-1.5">
        <span className="text-[13px] font-semibold tracking-tight text-neutral-100">Vibe Painter</span>
        <span className="text-[10px] text-neutral-500">fully procedural texture painting</span>

        <div className="ml-4 flex gap-1">
          <Button variant={tool === 'orbit' ? 'primary' : 'default'} title="Orbit (V)" onClick={() => setTool('orbit')}>Orbit</Button>
          <Button variant={tool === 'paint' ? 'primary' : 'default'} title="Paint (B)" onClick={() => setTool('paint')}>Paint</Button>
          <Button variant={tool === 'erase' ? 'primary' : 'default'} title="Erase (E)" onClick={() => setTool('erase')}>Erase</Button>
        </div>

        <label className="ml-4 flex items-center gap-1.5 text-[11px] text-neutral-400">
          View
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-sky-600 focus:outline-none"
            value={viewMode}
            onChange={(event) => api.setViewMode(event.target.value as ViewMode)}
          >
            {VIEW_MODES.map((mode) => (
              <option key={mode} value={mode}>{VIEW_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-3 text-[10px] text-neutral-500">
          <span>{status.resolution}px</span>
          <span>{status.layers} layers</span>
          <span className={status.meshMapsBaked ? 'text-emerald-500' : 'text-amber-500'}>
            {status.meshMapsBaked ? 'baked' : 'not baked'}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-925">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <LayerPanel />
          </div>
        </aside>

        <section
          className="relative min-w-0 flex-1 bg-neutral-900"
          onDragEnter={(event) => {
            event.preventDefault()
            dropDepth.current += 1
            setDropActive(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            dropDepth.current = Math.max(0, dropDepth.current - 1)
            if (dropDepth.current === 0) setDropActive(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            dropDepth.current = 0
            setDropActive(false)
            const file = [...event.dataTransfer.files].find((candidate) => isGltfFileName(candidate.name))
            if (!file) {
              setNotice('Drop a .glb or .gltf file to replace the scene mesh.')
              return
            }
            void api.importGltf(file).catch((cause) => {
              setNotice(cause instanceof Error ? cause.message : String(cause))
            })
          }}
        >
          <Viewport tool={tool} onPaintBlocked={setNotice} />
          {dropActive && (
            <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded border-2 border-dashed border-sky-500 bg-sky-950/50">
              <p className="text-[13px] font-medium text-sky-100">Drop GLB to replace the mesh</p>
            </div>
          )}
          {notice && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit rounded border border-amber-700 bg-amber-950/90 px-3 py-1.5 text-[11px] text-amber-200 shadow-lg">
              {notice}
            </div>
          )}
          {tool !== 'orbit' && (
            <div className="pointer-events-none absolute left-3 top-3 rounded bg-neutral-950/70 px-2 py-1 text-[10px] text-neutral-400">
              {tool === 'paint' ? 'Painting' : 'Erasing'} · {status.paintTarget === 'mask' ? 'layer mask' : 'layer pixels'}
            </div>
          )}
        </section>

        <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-925">
          <nav className="flex shrink-0 flex-wrap gap-0.5 border-b border-neutral-800 bg-neutral-900 p-1">
            {RIGHT_TABS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setTab(name)}
                className={`rounded px-2 py-1 text-[11px] transition-colors ${
                  tab === name ? 'bg-sky-600 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                }`}
              >
                {name}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === 'Properties' && <PropertiesPanel />}
            {tab === 'Materials' && <MaterialBrowser />}
            {tab === 'Brush' && <BrushPanel />}
            {tab === 'Bake' && <BakePanel />}
            {tab === 'Scene' && <ScenePanel />}
            {tab === 'Export' && <ExportPanel />}
          </div>
        </aside>
      </main>
    </div>
  )
}
