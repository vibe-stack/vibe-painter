/**
 * The layer stack.
 *
 * Displayed top-first, which is how the result reads: the top row is what you
 * see last. The document stores the opposite order (index 0 is the bottom),
 * and that flip is confined to this file and `api.listLayers()`.
 */

import { useState } from 'react'
import { useApi, useDocRevision } from '../context'
import type { LayerSummary } from '../../core/api'
import { Button, Panel, Select, Slider } from '../widgets/controls'
import { BLEND_MODES } from '../../core/doc/types'
import { CHANNEL_LIST } from '../../core/channels'
import { getMaterialDef } from '../../core/procedural/material'

export function LayerPanel() {
  const api = useApi()
  useDocRevision()
  const layers = api.listLayers()
  const activeId = api.activeLayerId
  const [showChannels, setShowChannels] = useState(false)

  return (
    <Panel
      title="Layers"
      actions={
        <div className="flex gap-1">
          <Button variant="ghost" title="Add fill layer" onClick={() => api.addFillLayer({})}>+ Fill</Button>
          <Button variant="ghost" title="Add paint layer" onClick={() => api.addPaintLayer({})}>+ Paint</Button>
          <Button variant="ghost" title="Add folder" onClick={() => api.addFolder({})}>+ Group</Button>
        </div>
      }
    >
      <ul className="py-1">
        {layers.map((layer) => (
          <LayerRow key={layer.id} layer={layer} active={layer.id === activeId} />
        ))}
      </ul>

      {activeId && (
        <div className="border-t border-neutral-800 pt-1">
          <Slider
            label="Layer Opacity"
            value={api.getLayer(activeId)?.opacity ?? 1}
            min={0}
            max={1}
            onChange={(value) => api.setLayerProps(activeId, { opacity: value })}
          />
          <button
            type="button"
            className="w-full px-3 py-1 text-left text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
            onClick={() => setShowChannels((v) => !v)}
          >
            {showChannels ? '▾' : '▸'} Per-channel blending
          </button>
          {showChannels && <ChannelSettings layerId={activeId} />}
        </div>
      )}
    </Panel>
  )
}

function LayerRow({ layer, active }: { layer: LayerSummary; active: boolean }) {
  const api = useApi()
  const materialName = layer.materialId ? getMaterialDef(layer.materialId)?.name : null

  return (
    <li>
      <div
        className={`group flex items-center gap-1.5 py-1 pr-2 text-[11px] ${active ? 'bg-sky-950/60 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800/60'}`}
        style={{ paddingLeft: 8 + layer.depth * 14 }}
      >
        <button
          type="button"
          title={layer.visible ? 'Hide layer' : 'Show layer'}
          className={`w-4 shrink-0 text-center ${layer.visible ? 'text-neutral-300' : 'text-neutral-600'}`}
          onClick={() => api.setLayerProps(layer.id, { visible: !layer.visible })}
        >
          {layer.visible ? '●' : '○'}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => api.selectLayer(layer.id)}>
          <span className="block truncate">
            {layer.kind === 'folder' ? '📁 ' : layer.kind === 'paint' ? '🖌 ' : ''}
            {layer.name}
          </span>
          <span className="block truncate text-[10px] text-neutral-500">
            {materialName ?? (layer.kind === 'paint' ? 'Painted pixels' : 'Group')}
            {layer.hasMask ? ` · mask (${layer.generatorCount})` : ''}
          </span>
        </button>
        <div className="hidden shrink-0 gap-0.5 group-hover:flex">
          <Button variant="ghost" title="Move up" onClick={() => shift(api, layer, 1)}>↑</Button>
          <Button variant="ghost" title="Move down" onClick={() => shift(api, layer, -1)}>↓</Button>
          <Button variant="ghost" title="Duplicate" onClick={() => api.duplicateLayer(layer.id)}>⧉</Button>
          <Button variant="danger" title="Delete" onClick={() => api.removeLayer(layer.id)}>✕</Button>
        </div>
      </div>
    </li>
  )
}

/** `delta` is in visual terms: +1 means "further up the panel". */
function shift(api: ReturnType<typeof useApi>, layer: LayerSummary, delta: number): void {
  const set = api.engine.activeTextureSet
  if (!set) return
  const siblings = layer.parentId
    ? (api.getLayer(layer.parentId) as { children?: { id: string }[] } | null)?.children ?? []
    : set.layers
  const index = siblings.findIndex((l) => l.id === layer.id)
  if (index < 0) return
  const target = index + delta
  if (target < 0 || target >= siblings.length) return
  api.moveLayer(layer.id, layer.parentId, target)
}

function ChannelSettings({ layerId }: { layerId: string }) {
  const api = useApi()
  const layer = api.getLayer(layerId)
  if (!layer) return null

  return (
    <div className="pb-2">
      {CHANNEL_LIST.map((info) => {
        const settings = layer.channels[info.id] ?? { enabled: true, opacity: 1, blend: 'normal' as const }
        return (
          <div key={info.id} className="flex items-center gap-2 px-3 py-1">
            <input
              type="checkbox"
              className="h-3 w-3 shrink-0 accent-sky-500"
              checked={settings.enabled}
              title={`Write ${info.label}`}
              onChange={(e) => api.setChannelSettings(layerId, info.id, { enabled: e.target.checked })}
            />
            <span className="w-20 shrink-0 truncate text-[10px] text-neutral-400">{info.label}</span>
            <div className="min-w-0 flex-1">
              <Select
                value={settings.blend}
                options={BLEND_MODES.map((m) => ({ value: m, label: m }))}
                onChange={(blend) => api.setChannelSettings(layerId, info.id, { blend })}
              />
            </div>
            <input
              type="range"
              className="h-1 w-12 shrink-0 cursor-pointer appearance-none rounded bg-neutral-700 accent-sky-500"
              min={0}
              max={1}
              step={0.01}
              value={settings.opacity}
              title={`${info.label} opacity`}
              onChange={(e) => api.setChannelSettings(layerId, info.id, { opacity: Number.parseFloat(e.target.value) })}
            />
          </div>
        )
      })}
    </div>
  )
}
