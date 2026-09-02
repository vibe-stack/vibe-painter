/**
 * Renders any parameter schema.
 *
 * Materials and generators both declare their parameters as data, so the
 * inspector is written once and every catalogue entry - including ones added
 * later - gets a correct UI for free.
 */

import type { ParamDef } from '../../core/procedural/params'
import type { ParamValue } from '../../core/doc/types'
import { ColorInput, SectionHeading, Slider, Toggle } from './controls'

interface ParamEditorProps {
  params: readonly ParamDef[]
  values: Record<string, ParamValue>
  onChange: (key: string, value: ParamValue) => void
}

export function ParamEditor({ params, values, onChange }: ParamEditorProps) {
  const groups = new Map<string, ParamDef[]>()
  for (const def of params) {
    const group = def.group ?? 'Parameters'
    const list = groups.get(group)
    if (list) list.push(def)
    else groups.set(group, [def])
  }

  return (
    <>
      {[...groups].map(([group, defs]) => (
        <div key={group}>
          <SectionHeading>{group}</SectionHeading>
          {defs.map((def) => (
            <ParamControl key={def.key} def={def} value={values[def.key] ?? def.default} onChange={onChange} />
          ))}
        </div>
      ))}
    </>
  )
}

function ParamControl({ def, value, onChange }: { def: ParamDef; value: ParamValue; onChange: (key: string, value: ParamValue) => void }) {
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
