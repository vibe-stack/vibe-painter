/**
 * Renders any parameter schema.
 *
 * Materials and generators both declare their parameters as data, so the
 * inspector is written once and every catalogue entry - including ones added
 * later - gets a correct UI for free.
 *
 * Groups are collapsible past the first one. A material like brickwork has
 * twenty parameters across four groups, and a flat list of twenty sliders is
 * the thing that makes a good material feel unusable; the first group is the
 * one people actually reach for, so it opens and the rest wait to be asked.
 */

import { useState } from 'react'
import type { ParamDef } from '../../core/procedural/params'
import type { ParamValue } from '../../core/doc/types'
import { ColorInput, Slider, Toggle } from './controls'

interface ParamEditorProps {
  params: readonly ParamDef[]
  values: Record<string, ParamValue>
  onChange: (key: string, value: ParamValue) => void
  /** Namespaces the remembered open/closed state, so two editors never clash. */
  scope?: string
}

export function ParamEditor({ params, values, onChange, scope = 'params' }: ParamEditorProps) {
  const groups = new Map<string, ParamDef[]>()
  for (const def of params) {
    const group = def.group ?? 'Parameters'
    const list = groups.get(group)
    if (list) list.push(def)
    else groups.set(group, [def])
  }

  return (
    <>
      {[...groups].map(([group, defs], index) => (
        <ParamGroup key={`${scope}:${group}`} title={group} defaultOpen={index === 0}>
          {defs.map((def) => (
            <ParamControl key={def.key} def={def} value={values[def.key] ?? def.default} onChange={onChange} />
          ))}
        </ParamGroup>
      ))}
    </>
  )
}

function ParamGroup({
  title,
  defaultOpen,
  children,
}: {
  title: string
  defaultOpen: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-1 px-2 pb-1 pt-2.5 text-left"
      >
        <span
          className={`text-app-faint transition-transform group-hover:text-app-dim ${open ? 'rotate-90' : ''}`}
          style={{ fontSize: 7, lineHeight: 1 }}
        >
          ▶
        </span>
        <span className="text-[9px] font-semibold uppercase tracking-[0.09em] text-app-faint group-hover:text-app-dim">
          {title}
        </span>
      </button>
      {open && children}
    </div>
  )
}

function ParamControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef
  value: ParamValue
  onChange: (key: string, value: ParamValue) => void
}) {
  switch (def.type) {
    case 'color':
      return (
        <ColorInput
          label={def.label}
          hint={def.description}
          value={Array.isArray(value) ? value : [0, 0, 0]}
          onChange={(next) => onChange(def.key, next)}
        />
      )
    case 'bool':
      return (
        <Toggle
          label={def.label}
          hint={def.description}
          value={Boolean(value)}
          onChange={(next) => onChange(def.key, next)}
        />
      )
    default:
      return (
        <Slider
          label={def.label}
          hint={def.description}
          value={typeof value === 'number' ? value : 0}
          min={def.min ?? 0}
          max={def.max ?? 1}
          step={def.type === 'int' ? 1 : def.step ?? 0.001}
          onChange={(next) => onChange(def.key, def.type === 'int' ? Math.round(next) : next)}
        />
      )
  }
}
