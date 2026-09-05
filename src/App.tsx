/**
 * Application shell.
 *
 * Everything here is presentation: the engine is created once and handed to
 * the panels through context. Nothing in this file knows how a layer is
 * composited or how a bake works, which is the point - the UI is a client of
 * `src/core`, replaceable without touching it.
 *
 * The right-hand column is a single scrolling stack of collapsible sections
 * rather than a tab bar. Tabs made every relationship in this app invisible:
 * a material and its projection and its mask are one object being edited, and
 * putting them behind three tabs meant checking the result of a mask change
 * required leaving the mask. Sections cost vertical space, which is why they
 * remember what you left open.
 */

import { useEffect, useRef, useState } from 'react'
import { VIEW_MODES } from './core/gpu/viewport'
import type { ViewMode } from './core/gpu/viewport'
import { isGltfFileName } from './core/mesh/gltf'
import { ApiProvider, useApi, useEngineVersion } from './ui/context'
import { Viewport } from './ui/Viewport'
import type { Tool } from './ui/Viewport'
import { ChannelSettings, LayerList, LayerToolbar } from './ui/panels/LayerPanel'
import { MaterialBrowser } from './ui/panels/MaterialBrowser'
import { SmartMaterialBrowser } from './ui/panels/SmartMaterials'
import { LayerIdentity, MaterialSection, ProjectionSection } from './ui/panels/PropertiesPanel'
import { BrushMaterialSection, BrushSection } from './ui/panels/BrushPanel'
import { BakeSection } from './ui/panels/BakePanel'
import { ExportSection } from './ui/panels/ExportPanel'
import { LightingSection, MeshSection } from './ui/panels/ScenePanel'
import { MaskSection } from './ui/panels/MaskEditor'
import { ScrollArea, Section } from './ui/widgets/controls'
import { getSession } from './ui/session'
import { isFileDrag, isMaterialDrag } from './ui/drag'
import { getMaterialDef } from './core/procedural/material'

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
  'mesh-id': 'Mesh · IDs',
}

const TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'orbit', label: 'Orbit', icon: '⤧', key: 'V' },
  { id: 'paint', label: 'Paint', icon: '✎', key: 'B' },
  { id: 'erase', label: 'Erase', icon: '⌫', key: 'E' },
]

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
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return
      }
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

  useEffect(() => {
    const onDragEnd = () => api.endMaterialDrag()
    window.addEventListener('dragend', onDragEnd)
    return () => window.removeEventListener('dragend', onDragEnd)
  }, [api])

  const status = api.status()
  const layer = api.activeLayerId ? api.getLayer(api.activeLayerId) : null
  const overlayActive = api.engine.idOverlayActive
  const overlayMaterial = api.engine.materialDragId ? getMaterialDef(api.engine.materialDragId) : null
  const meshParts = api.listMeshParts()
  const hoverPart = overlayActive
    ? meshParts.find((part) => part.index === api.engine.idHoverPartId) ?? null
    : null

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-app-void text-app-text">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-app-line bg-app-panel px-2">
        <span className="text-[12px] font-semibold tracking-tight text-app-text">Vibe Painter</span>

        <div className="ml-2 flex items-center gap-0.5 rounded-[4px] bg-app-bg p-[2px]">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={`${entry.label} (${entry.key})`}
              onClick={() => setTool(entry.id)}
              className={`flex items-center gap-1 rounded-[3px] px-2 py-[3px] text-[11px] transition-colors ${
                tool === entry.id
                  ? 'bg-app-accent text-white'
                  : 'text-app-muted hover:bg-app-raised hover:text-app-text'
              }`}
            >
              <span className="text-[10px] leading-none">{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </div>

        <div className="ml-2 flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-app-faint">View</span>
          <select
            className="cursor-pointer appearance-none rounded-[3px] border border-transparent bg-app-raised py-[3px] pl-1.5 pr-[18px] text-[11px] text-app-text outline-none transition-colors hover:border-app-line-strong focus:border-app-accent"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'><path d='M0 0h8L4 5z' fill='%23888891'/></svg>\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 6px center',
            }}
            value={viewMode}
            onChange={(event) => api.setViewMode(event.target.value as ViewMode)}
          >
            {VIEW_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {VIEW_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto flex items-center gap-3 text-[10px] text-app-faint">
          <span className="tabular-nums">{status.resolution}px</span>
          <span className="tabular-nums">{status.layers} layers</span>
          <span className="flex items-center gap-1">
            <span
              className={`h-[6px] w-[6px] rounded-full ${status.meshMapsBaked ? 'bg-app-good' : 'bg-app-warn'}`}
            />
            {status.meshMapsBaked ? 'baked' : 'not baked'}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {/* -- Left: the stack ------------------------------------------- */}
        <aside className="flex w-[248px] shrink-0 flex-col border-r border-app-line bg-app-panel">
          <ScrollArea>
            <Section id="layers" title="Layers" icon="▤" defaultOpen actions={<LayerToolbar />}>
              <LayerList />
            </Section>
            <Section id="layer-props" title="Layer" icon="◧" defaultOpen>
              <LayerIdentity />
            </Section>
            <Section id="channels" title="Channel Blending" icon="◨">
              <ChannelSettings />
            </Section>
          </ScrollArea>
        </aside>

        {/* -- Centre: the model ------------------------------------------ */}
        <section
          className="relative min-w-0 flex-1 bg-app-void"
          onDragEnter={(event) => {
            if (!isFileDrag(event)) return
            event.preventDefault()
            dropDepth.current += 1
            setDropActive(true)
          }}
          onDragOver={(event) => {
            if (isFileDrag(event) || isMaterialDrag(event)) event.preventDefault()
          }}
          onDragLeave={() => {
            dropDepth.current = Math.max(0, dropDepth.current - 1)
            if (dropDepth.current === 0) setDropActive(false)
          }}
          onDrop={(event) => {
            if (isMaterialDrag(event)) return
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
            <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-[6px] border-2 border-dashed border-app-accent bg-app-accent-dim/30">
              <p className="text-[13px] font-medium text-app-text">Drop GLB to replace the mesh</p>
            </div>
          )}
          {overlayActive && !dropActive && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 mx-auto w-fit max-w-[min(92%,420px)] rounded-[4px] border border-app-line-strong bg-app-bg/90 px-3 py-1.5 text-center shadow-lg">
              <p className="text-[11px] text-app-text">
                {hoverPart ? (
                  <>
                    Drop to apply
                    {overlayMaterial ? ` ${overlayMaterial.name}` : ''} to{' '}
                    <span className="font-medium">{hoverPart.name}</span>
                  </>
                ) : meshParts.length >= 2 ? (
                  <>
                    Drop on a coloured part
                    {overlayMaterial ? ` to assign ${overlayMaterial.name}` : ''}
                    {', or off the mesh to apply everywhere'}
                  </>
                ) : (
                  <>Drop on the mesh to add {overlayMaterial ? overlayMaterial.name : 'this material'}</>
                )}
              </p>
              {hoverPart && (
                <p className="mt-0.5 flex items-center justify-center gap-1.5 text-[10px] text-app-muted">
                  <span
                    className="inline-block h-[8px] w-[8px] rounded-[2px] border border-black/40"
                    style={{
                      background: `rgb(${Math.round(hoverPart.color[0] * 255)} ${Math.round(hoverPart.color[1] * 255)} ${Math.round(hoverPart.color[2] * 255)})`,
                    }}
                  />
                  {hoverPart.kind === 'material'
                    ? 'Source material'
                    : hoverPart.kind === 'color'
                      ? 'Colour ID'
                      : hoverPart.kind === 'face'
                        ? 'Face'
                        : 'Object'}
                  {' · '}
                  {hoverPart.triangleCount.toLocaleString()} triangles
                </p>
              )}
            </div>
          )}
          {notice && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit rounded-[4px] border border-app-warn/50 bg-app-bg/95 px-3 py-1.5 text-[11px] text-app-warn shadow-lg">
              {notice}
            </div>
          )}
          {tool !== 'orbit' && (
            <div className="pointer-events-none absolute left-3 top-3 rounded-[4px] bg-app-bg/80 px-2 py-1 text-[10px] text-app-muted">
              {tool === 'paint' ? 'Painting' : 'Erasing'} ·{' '}
              {status.paintTarget === 'mask' ? 'layer mask' : 'layer pixels'}
            </div>
          )}
        </section>

        {/* -- Right: the inspector --------------------------------------- */}
        <aside className="flex w-[284px] shrink-0 flex-col border-l border-app-line bg-app-panel">
          <ScrollArea>
            <Section
              id="material"
              title="Material"
              icon="◈"
              defaultOpen
              badge={
                layer?.kind === 'fill' ? undefined : (
                  <span className="truncate text-[9px] text-app-faint">
                    {layer?.kind === 'paint' ? 'paint layer' : layer?.kind === 'folder' ? 'group' : ''}
                  </span>
                )
              }
            >
              <MaterialSection />
            </Section>

            <Section id="projection" title="Projection" icon="⌗" defaultOpen>
              <ProjectionSection />
            </Section>

            <Section id="mask" title="Mask" icon="◐">
              <MaskSection />
            </Section>

            <Section id="brush" title="Brush" icon="✎" defaultOpen={tool !== 'orbit'}>
              <BrushSection />
            </Section>

            <Section id="brush-material" title="Brush Material" icon="◇" defaultOpen={tool !== 'orbit'}>
              <BrushMaterialSection />
            </Section>

            <Section id="smart" title="Smart Materials" icon="✧" defaultOpen>
              <SmartMaterialBrowser />
            </Section>

            <Section id="catalogue" title="Catalogue" icon="▦">
              <MaterialBrowser />
            </Section>

            <Section id="bake" title="Bake" icon="⚑">
              <BakeSection />
            </Section>

            <Section id="mesh" title="Mesh & Resolution" icon="⬡">
              <MeshSection />
            </Section>

            <Section id="lighting" title="Lighting & Display" icon="☀">
              <LightingSection />
            </Section>

            <Section id="export" title="Export" icon="⤓">
              <ExportSection />
            </Section>
          </ScrollArea>
        </aside>
      </main>
    </div>
  )
}
