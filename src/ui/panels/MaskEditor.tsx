/**
 * Mask editing: the stack of generators on a layer, plus the levels and paint
 * that shape the result.
 *
 * This is where a "smart material" actually gets made. A generator turns baked
 * geometry into a grayscale mask - curvature for edge wear, occlusion for
 * dirt, position for anything gravity-driven - so the effect follows the mesh
 * instead of being painted for one particular model.
 */

import { useApi, useDocRevision } from '../context'
import { listGeneratorDefs, getGeneratorDef } from '../../core/procedural/generators'
import type { GeneratorType, Levels } from '../../core/doc/types'
import { BLEND_MODES } from '../../core/doc/types'
import { Button, EmptyHint, SectionHeading, Select, Slider, Toggle } from '../widgets/controls'
import { ParamEditor } from '../widgets/ParamEditor'

export function MaskEditor({ layerId }: { layerId: string }) {
  const api = useApi()
  useDocRevision()
  const layer = api.getLayer(layerId)
  if (!layer) return null
  const mask = layer.mask

  if (!mask) {
    return (
      <>
        <SectionHeading>Mask</SectionHeading>
        <div className="flex flex-wrap gap-1 px-3 py-2">
          <Button onClick={() => api.addMask(layerId, { base: 1 })}>Add Mask</Button>
          <Button onClick={() => api.addMask(layerId, { base: 0, generator: 'curvature' })}>Edge Wear</Button>
          <Button onClick={() => api.addMask(layerId, { base: 0, generator: 'dirt' })}>Dirt</Button>
          <Button onClick={() => api.enableMaskPainting(layerId)}>Paintable</Button>
        </div>
        <p className="px-3 pb-2 text-[10px] leading-snug text-neutral-500">
          Generators read the baked mesh maps, so bake first for anything except plain noise.
        </p>
      </>
    )
  }

  const baked = api.isBaked

  return (
    <>
      <SectionHeading>Mask</SectionHeading>
      <div className="flex flex-wrap gap-1 px-3 py-1.5">
        <Button onClick={() => api.enableMaskPainting(layerId)} disabled={mask.paintBufferId !== null}>
          {mask.paintBufferId ? 'Paintable ✓' : 'Make Paintable'}
        </Button>
        <Button variant="danger" onClick={() => api.removeMask(layerId)}>Remove Mask</Button>
      </div>

      <Toggle label="Enabled" value={mask.enabled} onChange={(enabled) => api.setMask(layerId, { enabled })} />
      <Toggle label="Invert" value={mask.invert} onChange={(invert) => api.setMask(layerId, { invert })} />
      <Slider
        label="Base Value"
        hint="What the mask is where no generator or paint contributes. Start at 0 for wear effects, 1 for a mask you carve away."
        value={mask.base}
        min={0}
        max={1}
        onChange={(base) => api.setMask(layerId, { base })}
      />

      <LevelsEditor
        levels={mask.levels}
        onChange={(levels) => api.setMask(layerId, { levels })}
      />

      {mask.paintBufferId && (
        <>
          <Select
            label="Paint Blend"
            value={mask.paintBlend}
            options={BLEND_MODES.map((m) => ({ value: m, label: m }))}
            onChange={(paintBlend) => api.setMask(layerId, { paintBlend })}
          />
          <Slider
            label="Paint Blur"
            hint="Softens the painted component of the mask. Generators are analytic and are not blurred."
            value={mask.blur}
            min={0}
            max={16}
            step={0.5}
            onChange={(blur) => api.setMask(layerId, { blur })}
          />
        </>
      )}

      <SectionHeading>Generators</SectionHeading>
      <div className="px-3 py-1.5">
        <Select
          value={'' as GeneratorType | ''}
          options={[
            { value: '' as const, label: 'Add generator…' },
            ...listGeneratorDefs().map((def) => ({
              value: def.type,
              label: def.requiresBake && !baked ? `${def.name} (needs bake)` : def.name,
            })),
          ]}
          onChange={(type) => { if (type) api.addGenerator(layerId, type as GeneratorType) }}
        />
      </div>

      {mask.generators.length === 0 && (
        <EmptyHint>No generators yet. Curvature drives edge wear; occlusion drives dirt in cavities.</EmptyHint>
      )}

      {mask.generators.map((generator) => {
        const def = getGeneratorDef(generator.type)
        if (!def) return null
        return (
          <div key={generator.id} className="mx-2 mb-2 rounded border border-neutral-800 bg-neutral-900/40">
            <div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1">
              <input
                type="checkbox"
                className="h-3 w-3 accent-sky-500"
                checked={generator.enabled}
                onChange={(e) => api.setGenerator(layerId, generator.id, { enabled: e.target.checked })}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-200">{def.name}</span>
              <Button
                variant="danger"
                title="Remove generator"
                onClick={() => api.removeGenerator(layerId, generator.id)}
              >
                ✕
              </Button>
            </div>
            {def.requiresBake && !baked && (
              <p className="px-2 py-1 text-[10px] text-amber-500/80">
                Needs baked mesh maps. Run a bake to see this generator do anything.
              </p>
            )}
            <p className="px-2 py-1 text-[10px] leading-snug text-neutral-500">{def.description}</p>
            <Select
              label="Blend"
              value={generator.blend}
              options={BLEND_MODES.map((m) => ({ value: m, label: m }))}
              onChange={(blend) => api.setGenerator(layerId, generator.id, { blend })}
            />
            <Slider
              label="Opacity"
              value={generator.opacity}
              min={0}
              max={1}
              onChange={(opacity) => api.setGenerator(layerId, generator.id, { opacity })}
            />
            <Toggle
              label="Invert"
              value={generator.invert}
              onChange={(invert) => api.setGenerator(layerId, generator.id, { invert })}
            />
            <LevelsEditor
              levels={generator.levels}
              onChange={(levels) => api.setGenerator(layerId, generator.id, { levels })}
            />
            <ParamEditor
              params={def.params}
              values={generator.params}
              onChange={(key, value) => api.setGenerator(layerId, generator.id, { params: { [key]: value } })}
            />
          </div>
        )
      })}
    </>
  )
}

function LevelsEditor({ levels, onChange }: { levels: Levels; onChange: (levels: Partial<Levels>) => void }) {
  return (
    <>
      <SectionHeading>Levels</SectionHeading>
      <Slider label="Input Low" value={levels.inLow} min={0} max={1} onChange={(inLow) => onChange({ inLow })} />
      <Slider label="Input High" value={levels.inHigh} min={0} max={1} onChange={(inHigh) => onChange({ inHigh })} />
      <Slider label="Gamma" value={levels.gamma} min={0.1} max={5} step={0.01} onChange={(gamma) => onChange({ gamma })} />
      <Slider label="Output Low" value={levels.outLow} min={0} max={1} onChange={(outLow) => onChange({ outLow })} />
      <Slider label="Output High" value={levels.outHigh} min={0} max={1} onChange={(outHigh) => onChange({ outHigh })} />
    </>
  )
}
