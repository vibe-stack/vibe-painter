/**
 * Smart materials and brush presets - the two "make it dirty now" shelves.
 *
 * Both exist for the same reason: every effect in this app was already
 * expressible, and none of it was reachable in under a dozen clicks. A smart
 * material adds a whole masked layer group; a brush preset points the brush at
 * a material and a set of numbers that behave like the substance named on it.
 *
 * Presets are recipes, not results. What lands in the stack is ordinary layers
 * with ordinary generators, so the first thing anybody does with one - open it
 * and retune it - is the thing it was built to support.
 */

import { useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { listSmartMaterials } from '../../core/presets/smart'
import type { SmartMaterialDef } from '../../core/presets/smart'
import { BRUSH_PRESETS } from '../../core/presets/brushes'
import { setSmartDragData } from '../drag'
import { EmptyHint } from '../widgets/controls'

const CATEGORY_ORDER: SmartMaterialDef['category'][] = ['Grime', 'Wear', 'Weather', 'Coating', 'Surface']

export function SmartMaterialBrowser() {
  const api = useApi()
  useEngineVersion()
  const [filter, setFilter] = useState<SmartMaterialDef['category'] | 'All'>('All')
  const baked = api.isBaked
  const defs = listSmartMaterials()
  const shown = filter === 'All' ? defs : defs.filter((def) => def.category === filter)

  return (
    <>
      <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-app-faint">
        Click to add above the selected layer. Drag onto the mesh to restrict it to one source part.
        {!baked && ' Effects marked with a dot read the mesh maps - bake for them to do anything.'}
      </p>

      <div className="flex flex-wrap gap-[3px] px-2 pb-1.5">
        {(['All', ...CATEGORY_ORDER] as const).map((category) => (
          <button
            key={category}
            type="button"
            onClick={() => setFilter(category)}
            className={`rounded-[3px] px-1.5 py-[2px] text-[10px] transition-colors ${
              filter === category
                ? 'bg-app-accent text-white'
                : 'bg-app-raised text-app-muted hover:bg-app-hover hover:text-app-text'
            }`}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1 px-2">
        {shown.map((def) => (
          <button
            key={def.id}
            type="button"
            draggable
            title={def.description}
            onDragStart={(event) => {
              if (!event.dataTransfer) return
              setSmartDragData(event.dataTransfer, def.id)
              api.beginSmartMaterialDrag(def.id)
            }}
            onDragEnd={() => api.endMaterialDrag()}
            onClick={() => api.addSmartMaterial(def.id)}
            className="group flex items-center gap-1.5 overflow-hidden rounded-[4px] border border-app-line bg-app-bg p-[3px] text-left transition-colors hover:border-app-line-strong hover:bg-app-raised"
          >
            <span
              className="h-[24px] w-[24px] shrink-0 rounded-[3px] border border-black/40"
              style={{ background: `linear-gradient(140deg, ${def.swatch[0]}, ${def.swatch[1]})` }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="min-w-0 truncate text-[11px] text-app-text">{def.name}</span>
                {def.requiresBake && !baked && (
                  <span className="h-[4px] w-[4px] shrink-0 rounded-full bg-app-warn" title="Needs baked mesh maps" />
                )}
              </span>
              <span className="block truncate text-[9px] text-app-faint">{def.category}</span>
            </span>
          </button>
        ))}
      </div>
      {shown.length === 0 && <EmptyHint>Nothing in this category.</EmptyHint>}
    </>
  )
}

/**
 * Brush presets.
 *
 * These write to the brush, never to the document, so trying one costs nothing
 * and abandoning it costs nothing. The active one is not tracked: the brush is
 * a set of numbers a preset seeds, and any slider afterwards makes "which
 * preset is this" the wrong question.
 */
export function BrushPresetRow() {
  const api = useApi()
  useEngineVersion()

  return (
    <div className="grid grid-cols-3 gap-1 px-2 pb-1 pt-0.5">
      {BRUSH_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          title={preset.description}
          onClick={() => api.applyBrushPreset(preset.id)}
          className="flex items-center gap-1 overflow-hidden rounded-[3px] border border-app-line bg-app-bg px-1 py-[3px] text-left transition-colors hover:border-app-line-strong hover:bg-app-raised"
        >
          <span
            className="h-[12px] w-[12px] shrink-0 rounded-full border border-black/40"
            style={{ background: `linear-gradient(140deg, ${preset.swatch[0]}, ${preset.swatch[1]})` }}
          />
          <span className="min-w-0 truncate text-[10px] text-app-muted">{preset.name}</span>
        </button>
      ))}
    </div>
  )
}
