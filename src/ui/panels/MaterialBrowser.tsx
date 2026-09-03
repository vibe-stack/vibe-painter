/**
 * The material catalogue.
 *
 * Every entry here is a shader, not an asset. There is no download, no texture
 * memory and no resolution: picking one rewrites the active fill layer's graph
 * and the next composite shows it.
 *
 * The swatches are rendered spheres, not screenshots - the same material graph
 * the compositor will run, drawn under the same lighting the viewport uses. The
 * rendering happens in a worker on its own GPU device and is cached to disk, so
 * browsing the catalogue never costs the viewport a frame. Cards ask for their
 * swatch only when they scroll into view; whatever is left over warms up in the
 * background once the visible ones are done.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useApi, useEngineVersion } from '../context'
import { listCategories, listMaterialDefs } from '../../core/procedural/material'
import type { ProceduralMaterialDef } from '../../core/procedural/material'
import { PRIORITY_VISIBLE, swatchColours, thumbnails } from '../../core/preview/thumbnails'
import { Button, EmptyHint, Panel } from '../widgets/controls'

function useThumbnails(): number {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => thumbnails.subscribe(onChange), []),
    () => thumbnails.version,
  )
}

export function MaterialBrowser() {
  const api = useApi()
  useEngineVersion()
  useThumbnails()
  const [category, setCategory] = useState<string>('All')
  const [query, setQuery] = useState('')

  const categories = useMemo(() => ['All', ...listCategories()], [])
  const materials = useMemo(() => {
    const term = query.trim().toLowerCase()
    return listMaterialDefs().filter(
      (def) =>
        (category === 'All' || def.category === category) &&
        (term === '' ||
          def.name.toLowerCase().includes(term) ||
          def.category.toLowerCase().includes(term) ||
          def.description.toLowerCase().includes(term)),
    )
  }, [category, query])

  // Warm the rest of the catalogue behind the visible cards, once, so that
  // switching category or searching lands on swatches that are already there.
  useEffect(() => {
    const idle = setTimeout(() => thumbnails.warmAll(), 1200)
    return () => clearTimeout(idle)
  }, [])

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

      <div className="grid grid-cols-2 gap-2 px-2 pb-3">
        {materials.map((def) => (
          <MaterialCard
            key={def.id}
            def={def}
            active={activeMaterialId === def.id}
            onPick={() => apply(def.id)}
          />
        ))}
      </div>

      {!thumbnails.supported && materials.length > 0 && (
        <p className="px-2 pb-2 text-[10px] leading-snug text-neutral-600">
          Rendered previews need WebGPU in a worker, which this browser does not provide. The swatches
          below are the materials&apos; own colours.
        </p>
      )}
    </Panel>
  )
}

function MaterialCard({
  def,
  active,
  onPick,
}: {
  def: ProceduralMaterialDef
  active: boolean
  onPick: () => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const url = thumbnails.url(def.id)
  const status = thumbnails.status(def.id)

  /**
   * Ask for the swatch when the card is actually on screen. With the whole
   * catalogue mounted at once this is the difference between the panel opening
   * instantly and it queueing thirty renders nobody asked to see.
   */
  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      thumbnails.request(def.id, PRIORITY_VISIBLE)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          thumbnails.request(def.id, PRIORITY_VISIBLE)
          observer.disconnect()
        }
      },
      { rootMargin: '160px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [def.id])

  const colours = useMemo(() => swatchColours(def), [def])
  const placeholder =
    colours.length > 1
      ? `radial-gradient(circle at 34% 28%, ${colours[0]}, ${colours[colours.length - 1]} 78%)`
      : `radial-gradient(circle at 34% 28%, ${colours[0]}, #14141a 82%)`

  return (
    <button
      ref={ref}
      type="button"
      onClick={onPick}
      title={`${def.name} — ${def.description}`}
      className={`group flex flex-col overflow-hidden rounded border text-left transition-colors ${
        active
          ? 'border-sky-500 bg-sky-950/40 ring-1 ring-sky-500/40'
          : 'border-neutral-800 bg-neutral-900/50 hover:border-neutral-600 hover:bg-neutral-800/60'
      }`}
    >
      <span
        className="relative block aspect-square w-full bg-neutral-950"
        style={{
          // A checker-free neutral ground: the swatch itself is transparent
          // around the sphere, so the card decides what sits behind it.
          backgroundImage:
            'radial-gradient(circle at 50% 40%, rgb(46 46 52), rgb(18 18 22) 70%)',
        }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span
            className={`absolute inset-[14%] rounded-full ${status === 'pending' ? 'animate-pulse' : ''}`}
            style={{ backgroundImage: placeholder }}
          />
        )}
      </span>

      <span className="flex items-baseline justify-between gap-1 px-1.5 py-1">
        <span className="truncate text-[11px] text-neutral-200 group-hover:text-neutral-50">{def.name}</span>
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-neutral-600">
          {def.category}
        </span>
      </span>
    </button>
  )
}
