/**
 * The layer stack.
 *
 * Displayed top-first, which is how the result reads: the top row is what you
 * see last. The document stores the opposite order (index 0 is the bottom),
 * and that flip is confined to this file and `api.listLayers()`.
 *
 * Each row carries the layer's own swatch. In a stack of six fill layers the
 * names are all "Brick Wall" and "Rust" and the thing you are actually looking
 * for is the one that looks a certain way.
 */

import { useEffect } from 'react'
import { useApi, useEngineVersion } from '../context'
import type { LayerSummary } from '../../core/api'
import { IconButton, Select } from '../widgets/controls'
import { BLEND_MODES } from '../../core/doc/types'
import { CHANNEL_LIST } from '../../core/channels'
import { getMaterialDef } from '../../core/procedural/material'
import { PRIORITY_VISIBLE, swatchColours, thumbnails } from '../../core/preview/thumbnails'
import { useThumbnails } from '../widgets/useThumbnails'

export function LayerList() {
  const api = useApi()
  useEngineVersion()
  // Rows carry material swatches, which arrive from the preview worker long
  // after the document last changed.
  useThumbnails()
  const layers = api.listLayers()
  const activeId = api.activeLayerId

  return (
    <ul className="py-0.5">
      {layers.map((layer) => (
        <LayerRow key={layer.id} layer={layer} active={layer.id === activeId} />
      ))}
      {layers.length === 0 && (
        <li className="px-2 py-3 text-[11px] text-app-dim">No layers. Add a fill layer to start.</li>
      )}
    </ul>
  )
}

export function LayerToolbar() {
  const api = useApi()
  return (
    <>
      <IconButton title="Add fill layer" onClick={() => api.addFillLayer({})}>
        ▣
      </IconButton>
      <IconButton title="Add paint layer" onClick={() => api.addPaintLayer({})}>
        ✎
      </IconButton>
      <IconButton title="Add group" onClick={() => api.addFolder({})}>
        ▤
      </IconButton>
    </>
  )
}

function LayerRow({ layer, active }: { layer: LayerSummary; active: boolean }) {
  const api = useApi()
  const def = layer.materialId ? getMaterialDef(layer.materialId) : null
  const url = layer.materialId ? thumbnails.url(layer.materialId) : null

  useEffect(() => {
    if (layer.materialId) thumbnails.request(layer.materialId, PRIORITY_VISIBLE)
  }, [layer.materialId])

  const colours = def ? swatchColours(def) : ['#2a2a30']

  return (
    <li>
      <div
        className={`group flex items-center gap-1.5 py-[3px] pr-1 text-[11px] transition-colors ${
          active ? 'bg-app-accent-dim/45 text-app-text' : 'text-app-muted hover:bg-app-raised'
        }`}
        style={{ paddingLeft: 4 + layer.depth * 12 }}
      >
        <button
          type="button"
          title={layer.visible ? 'Hide layer' : 'Show layer'}
          className={`w-3.5 shrink-0 text-center text-[9px] transition-colors ${
            layer.visible ? 'text-app-muted hover:text-app-text' : 'text-app-faint hover:text-app-dim'
          }`}
          onClick={() => api.setLayerProps(layer.id, { visible: !layer.visible })}
        >
          {layer.visible ? '●' : '○'}
        </button>

        <span
          className="h-[22px] w-[22px] shrink-0 overflow-hidden rounded-[3px] border border-app-line"
          style={{
            backgroundImage: url
              ? `url(${url})`
              : layer.kind === 'folder'
                ? 'linear-gradient(135deg, oklch(0.28 0.005 285), oklch(0.2 0.004 285))'
                : `radial-gradient(circle at 34% 28%, ${colours[0]}, #16161a 82%)`,
            backgroundSize: 'cover',
          }}
        />

        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => api.selectLayer(layer.id)}>
          <span className={`block truncate ${active ? 'text-app-text' : ''}`}>{layer.name}</span>
          <span className="block truncate text-[9px] text-app-faint">
            {def?.name ?? (layer.kind === 'paint' ? 'Painted pixels' : layer.kind === 'folder' ? 'Group' : '—')}
            {layer.hasMask ? ` · mask${layer.generatorCount ? ` (${layer.generatorCount})` : ''}` : ''}
          </span>
        </button>

        {/* An anchored layer is one other layers depend on, which is worth
            seeing from the stack rather than only from the inspector. */}
        {layer.anchorName && (
          <span
            className="shrink-0 text-[9px] text-app-accent"
            title={`Publishes the anchor point “${layer.anchorName}”`}
          >
            ⚓
          </span>
        )}

        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <IconButton title="Move up" onClick={() => shift(api, layer, 1)}>
            ↑
          </IconButton>
          <IconButton title="Move down" onClick={() => shift(api, layer, -1)}>
            ↓
          </IconButton>
          <IconButton title="Duplicate" onClick={() => api.duplicateLayer(layer.id)}>
            ⧉
          </IconButton>
          <IconButton title="Delete" danger onClick={() => api.removeLayer(layer.id)}>
            ✕
          </IconButton>
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
    ? ((api.getLayer(layer.parentId) as { children?: { id: string }[] } | null)?.children ?? [])
    : set.layers
  const index = siblings.findIndex((l) => l.id === layer.id)
  if (index < 0) return
  const target = index + delta
  if (target < 0 || target >= siblings.length) return
  api.moveLayer(layer.id, layer.parentId, target)
}

/**
 * Per-channel blending.
 *
 * A layer does not have to write every channel. Turning off base colour but
 * leaving roughness on is how a "polish" layer works, and it is the control
 * that makes the stack more than a pile of textures.
 */
export function ChannelSettings() {
  const api = useApi()
  useEngineVersion()
  const layerId = api.activeLayerId
  const layer = layerId ? api.getLayer(layerId) : null
  if (!layer || !layerId) return null

  return (
    <div>
      {CHANNEL_LIST.map((info) => {
        const settings = layer.channels[info.id] ?? { enabled: true, opacity: 1, blend: 'normal' as const }
        return (
          <div key={info.id} className="flex items-center gap-1.5 px-2 py-[3px]">
            <input
              type="checkbox"
              className="h-[11px] w-[11px] shrink-0 accent-[oklch(0.62_0.17_255)]"
              checked={settings.enabled}
              title={`Write ${info.label}`}
              onChange={(event) => api.setChannelSettings(layerId, info.id, { enabled: event.target.checked })}
            />
            <span
              className={`w-[62px] shrink-0 truncate text-[10px] ${settings.enabled ? 'text-app-dim' : 'text-app-faint line-through'}`}
            >
              {info.label}
            </span>
            <div className="min-w-0 flex-1">
              <Select
                value={settings.blend}
                options={BLEND_MODES.map((m) => ({ value: m, label: m }))}
                onChange={(blend) => api.setChannelSettings(layerId, info.id, { blend })}
              />
            </div>
            <input
              type="range"
              className="track h-[11px] w-[42px] shrink-0 cursor-pointer"
              min={0}
              max={1}
              step={0.01}
              value={settings.opacity}
              title={`${info.label} opacity`}
              onChange={(event) =>
                api.setChannelSettings(layerId, info.id, { opacity: Number.parseFloat(event.target.value) })
              }
            />
          </div>
        )
      })}
    </div>
  )
}
