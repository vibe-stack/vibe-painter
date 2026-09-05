/**
 * Picking a material.
 *
 * There is one list of materials in this app and it is this component. The
 * catalogue panel renders it inline; the brush and the fill-layer inspector
 * render it inside a popover. That matters beyond tidiness - a material is
 * chosen by *look*, and the brush selector used to be a `<select>` of fifty
 * strings, which is a list of names for a thing nobody identifies by name.
 *
 * Swatches come from `thumbnails`, which renders them in a worker on its own
 * GPU device and caches them to disk. Cards ask for theirs only when they
 * scroll into view; the rest warm up behind the visible ones.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { listCategories, listMaterialDefs } from '../../core/procedural/material'
import type { ProceduralMaterialDef } from '../../core/procedural/material'
import { PRIORITY_VISIBLE, swatchColours, thumbnails } from '../../core/preview/thumbnails'
import { useApi } from '../context'
import { setMaterialDragData } from '../drag'
import { Row } from './controls'
import { useDismiss } from './useDismiss'
import { useThumbnails } from './useThumbnails'

/** Kicks off a background warm-up of the whole catalogue, once per session. */
function useCatalogueWarmup(): void {
  useEffect(() => {
    const idle = setTimeout(() => thumbnails.warmAll(), 1200)
    return () => clearTimeout(idle)
  }, [])
}

export interface MaterialGridProps {
  activeId: string | null
  onPick: (defId: string) => void
  /** Card edge length in pixels. The popover uses a smaller grid than the panel. */
  size?: 'sm' | 'md'
  autoFocusSearch?: boolean
}

/**
 * The catalogue itself: a filter bar and a grid of swatches, grouped by
 * category so a 50-material list stays navigable.
 */
export function MaterialGrid({ activeId, onPick, size = 'md', autoFocusSearch = false }: MaterialGridProps) {
  useThumbnails()
  useCatalogueWarmup()
  const [category, setCategory] = useState<string>('All')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus()
  }, [autoFocusSearch])

  const categories = useMemo(() => ['All', ...listCategories()], [])

  const matches = useMemo(() => {
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

  /**
   * Grouped when showing everything, flat when filtered.
   *
   * A category heading over a single result is noise, and a search has already
   * told you what you were looking for - the grouping only earns its space when
   * you are browsing.
   */
  const groups = useMemo(() => {
    if (category !== 'All' || query.trim() !== '') return [{ name: null, defs: matches }]
    const byCategory = new Map<string, ProceduralMaterialDef[]>()
    for (const def of matches) {
      const list = byCategory.get(def.category)
      if (list) list.push(def)
      else byCategory.set(def.category, [def])
    }
    return [...byCategory]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, defs]) => ({ name, defs }))
  }, [matches, category, query])

  const columns = size === 'sm' ? 'grid-cols-3' : 'grid-cols-2'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 p-2">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-1.5 flex items-center text-[10px] text-app-faint">
            ⌕
          </span>
          <input
            ref={searchRef}
            className="w-full rounded-[3px] border border-transparent bg-app-raised py-[4px] pl-5 pr-1.5 text-[11px] text-app-text outline-none transition-colors placeholder:text-app-faint hover:border-app-line-strong focus:border-app-accent focus:bg-app-bg"
            placeholder="Search materials"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCategory(name)}
              className={`rounded-full px-2 py-[2px] text-[10px] transition-colors ${
                category === name
                  ? 'bg-app-accent text-white'
                  : 'bg-app-raised text-app-muted hover:bg-app-hover hover:text-app-text'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {matches.length === 0 && (
          <p className="px-1 py-3 text-[11px] text-app-dim">No material matches that search.</p>
        )}
        {groups.map((group) => (
          <div key={group.name ?? '_'}>
            {group.name && (
              <div className="sticky top-0 z-10 -mx-2 bg-app-panel px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.09em] text-app-faint">
                {group.name}
              </div>
            )}
            <div className={`grid ${columns} gap-1.5 pb-1`}>
              {group.defs.map((def) => (
                <MaterialCard
                  key={def.id}
                  def={def}
                  active={activeId === def.id}
                  compact={size === 'sm'}
                  onPick={() => onPick(def.id)}
                />
              ))}
            </div>
          </div>
        ))}

        {!thumbnails.supported && matches.length > 0 && (
          <p className="px-1 pb-1 pt-2 text-[10px] leading-snug text-app-faint">
            Rendered previews need WebGPU in a worker, which this browser does not provide. The swatches above
            are the materials&apos; own colours.
          </p>
        )}
      </div>
    </div>
  )
}

function MaterialCard({
  def,
  active,
  compact,
  onPick,
}: {
  def: ProceduralMaterialDef
  active: boolean
  compact: boolean
  onPick: () => void
}) {
  const api = useApi()
  const ref = useRef<HTMLButtonElement | null>(null)
  const dragged = useRef(false)
  const url = thumbnails.url(def.id)
  const status = thumbnails.status(def.id)

  // Ask for the swatch only once the card is actually on screen. With the whole
  // catalogue mounted this is the difference between the panel opening
  // instantly and it queueing fifty renders nobody asked to see.
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
      : `radial-gradient(circle at 34% 28%, ${colours[0]}, #16161a 82%)`

  return (
    <button
      ref={ref}
      type="button"
      draggable
      onClick={() => {
        if (dragged.current) {
          dragged.current = false
          return
        }
        onPick()
      }}
      onDragStart={(event) => {
        dragged.current = true
        setMaterialDragData(event.dataTransfer, def.id)
        api.beginMaterialDrag(def.id)
      }}
      onDragEnd={() => api.endMaterialDrag()}
      title={`${def.name} — ${def.description}. Drag onto the mesh to assign to a part.`}
      className={`group relative flex flex-col overflow-hidden rounded-[4px] border text-left transition-colors ${
        active
          ? 'border-app-accent bg-app-accent-dim/30'
          : 'border-app-line bg-app-bg hover:border-app-line-strong hover:bg-app-raised'
      }`}
    >
      <span
        className="relative block aspect-square w-full"
        style={{ backgroundImage: 'radial-gradient(circle at 50% 40%, oklch(0.28 0.005 285), oklch(0.16 0.004 285) 72%)' }}
      >
        {url ? (
          <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
        ) : (
          <span
            className={`absolute inset-[14%] rounded-full ${status === 'pending' ? 'animate-pulse' : ''}`}
            style={{ backgroundImage: placeholder }}
          />
        )}
      </span>
      <span className="block truncate px-1.5 py-1 text-[10px] text-app-muted group-hover:text-app-text">
        {compact ? def.name : def.name}
      </span>
      {active && (
        <span className="pointer-events-none absolute inset-0 rounded-[3px] ring-1 ring-inset ring-app-accent" />
      )}
    </button>
  )
}

/**
 * A row that shows the current material and opens the grid to change it.
 *
 * The trigger carries the swatch, not just the name, so the inspector tells you
 * what the layer looks like without a trip to the catalogue.
 */
export function MaterialField({
  label = 'Material',
  defId,
  onPick,
  hint,
}: {
  label?: string
  defId: string
  onPick: (defId: string) => void
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement | null>(null)
  useThumbnails()
  const close = useCallback(() => setOpen(false), [])
  useDismiss(container, close, open)

  const def = useMemo(() => listMaterialDefs().find((entry) => entry.id === defId) ?? null, [defId])
  const url = thumbnails.url(defId)
  const colours = useMemo(() => (def ? swatchColours(def) : ['#333']), [def])

  useEffect(() => {
    thumbnails.request(defId, PRIORITY_VISIBLE)
  }, [defId])

  return (
    <Row label={label} hint={hint}>
      <div className="relative" ref={container}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={`flex w-full items-center gap-1.5 rounded-[3px] border bg-app-raised py-[3px] pl-[3px] pr-1.5 text-left transition-colors ${
            open ? 'border-app-accent' : 'border-transparent hover:border-app-line-strong'
          }`}
        >
          <span
            className="h-[18px] w-[18px] shrink-0 overflow-hidden rounded-[2px] border border-app-line"
            style={{
              backgroundImage: url ? `url(${url})` : `radial-gradient(circle at 34% 28%, ${colours[0]}, #16161a 82%)`,
              backgroundSize: 'cover',
            }}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-app-text">{def?.name ?? defId}</span>
          <span className="shrink-0 text-[9px] text-app-faint">{def?.category}</span>
          <span className="shrink-0 text-[8px] text-app-faint">▼</span>
        </button>

        {open && (
          <Popover>
            <MaterialGrid
              activeId={defId}
              size="sm"
              autoFocusSearch
              onPick={(next) => {
                onPick(next)
                setOpen(false)
              }}
            />
          </Popover>
        )}
      </div>
    </Row>
  )
}

/**
 * The picker's floating panel.
 *
 * Anchored to the right edge of the trigger and pulled left by its own width,
 * because these rows live in a sidebar with no room to the right. It is taller
 * than it is wide on purpose: the grid is the content, and the search bar has
 * to stay reachable without scrolling.
 */
function Popover({ children }: { children: ReactNode }) {
  return (
    <div
      className="absolute right-0 top-[calc(100%+4px)] z-50 flex h-[340px] w-[272px] flex-col overflow-hidden rounded-[5px] border border-app-line-strong bg-app-panel shadow-2xl shadow-black/60"
      // Stops a click inside the popover reaching the dismiss handler as an
      // "outside" event when it lands on a child that unmounts on click.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}
