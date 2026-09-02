/**
 * The material catalogue.
 *
 * Every entry here is a shader, not an asset. There is no download, no texture
 * memory and no resolution: picking one rewrites the active fill layer's graph
 * and the next composite shows it.
 */

import { useMemo, useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { listCategories, listMaterialDefs } from '../../core/procedural/material'
import { Button, EmptyHint, Panel } from '../widgets/controls'

export function MaterialBrowser() {
  const api = useApi()
  useEngineVersion()
  const [category, setCategory] = useState<string>('All')
  const [query, setQuery] = useState('')

  const categories = useMemo(() => ['All', ...listCategories()], [])
  const materials = useMemo(() => {
    const term = query.trim().toLowerCase()
    return listMaterialDefs().filter(
      (def) =>
        (category === 'All' || def.category === category) &&
        (term === '' || def.name.toLowerCase().includes(term) || def.description.toLowerCase().includes(term)),
    )
  }, [category, query])

  const layer = api.activeLayerId ? api.getLayer(api.activeLayerId) : null
  const activeMaterialId = layer?.kind === 'fill' ? layer.material.defId : null

  const apply = (defId: string) => {
    if (layer?.kind === 'fill' && api.activeLayerId) {
      api.setLayerMaterial(api.activeLayerId, defId)
    } else {
      // Nothing suitable selected: adding a layer is what the user meant.
      api.addFillLayer({ materialId: defId })
    }
  }

  return (
    <Panel title="Procedural Materials">
      <div className="space-y-2 p-2">
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none"
          placeholder="Search materials"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {categories.map((name) => (
            <Button
              key={name}
              variant={category === name ? 'primary' : 'default'}
              onClick={() => setCategory(name)}
            >
              {name}
            </Button>
          ))}
        </div>
      </div>

      {materials.length === 0 && <EmptyHint>No material matches that search.</EmptyHint>}

      <ul className="px-2 pb-2">
        {materials.map((def) => (
          <li key={def.id}>
            <button
              type="button"
              onClick={() => apply(def.id)}
              className={`mb-1 w-full rounded border px-2 py-1.5 text-left transition-colors ${
                activeMaterialId === def.id
                  ? 'border-sky-600 bg-sky-950/50'
                  : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-600 hover:bg-neutral-800/60'
              }`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[12px] text-neutral-200">{def.name}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-600">{def.category}</span>
              </span>
              <span className="mt-0.5 block text-[10px] leading-snug text-neutral-500">{def.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
