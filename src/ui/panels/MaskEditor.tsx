/**
 * Mask editing: the stack of generators on a layer, plus the levels and paint
 * that shape the result.
 *
 * This is where a "smart material" actually gets made. A generator turns baked
 * geometry into a grayscale mask - curvature for edge wear, occlusion for
 * dirt, position for anything gravity-driven - so the effect follows the mesh
 * instead of being painted for one particular model.
 */

import { useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { listGeneratorDefs, getGeneratorDef } from '../../core/procedural/generators'
import type { AnchorSource, GeneratorType, Levels } from '../../core/doc/types'
import { ANCHOR_SOURCES, BLEND_MODES } from '../../core/doc/types'
import { Button, EmptyHint, IconButton, Select, Slider, Toggle } from '../widgets/controls'
import { Card, Note, ParamGroupLabel } from '../widgets/sections'
import { ParamEditor } from '../widgets/ParamEditor'

export function MaskSection() {
  const api = useApi()
  useEngineVersion()
  const layerId = api.activeLayerId
  const layer = layerId ? api.getLayer(layerId) : null
  if (!layer || !layerId) return <EmptyHint>Select a layer to give it a mask.</EmptyHint>

  const mask = layer.mask

  if (!mask) {
    return (
      <>
        <Note>
          A mask decides where this layer applies. Generators read the baked mesh maps, so bake first for anything
          except plain noise.
        </Note>
        <div className="grid grid-cols-2 gap-1 px-2 pt-1">
          <Button onClick={() => api.addMask(layerId, { base: 1 })}>Empty Mask</Button>
          <Button onClick={() => api.enableMaskPainting(layerId)}>Paintable</Button>
          <Button onClick={() => api.addMask(layerId, { base: 0, generator: 'curvature' })}>Edge Wear</Button>
          <Button onClick={() => api.addMask(layerId, { base: 0, generator: 'dirt' })}>Dirt</Button>
          <Button onClick={() => api.addMask(layerId, { base: 0, generator: 'scratches' })}>Scratches</Button>
          <Button onClick={() => api.addMask(layerId, { base: 0, generator: 'idSelect' })}>Mesh ID</Button>
          <Button
            disabled={api.listAnchors(layerId).length === 0}
            title={
              api.listAnchors(layerId).length === 0
                ? 'No anchor points below this layer yet. Turn one on from the Layer section of a layer underneath.'
                : undefined
            }
            onClick={() => api.addMask(layerId, { base: 0, generator: 'anchor' })}
          >
            Anchor
          </Button>
        </div>
      </>
    )
  }

  const baked = api.isBaked

  return (
    <>
      <div className="grid grid-cols-2 gap-1 px-2 pt-1">
        <Button onClick={() => api.enableMaskPainting(layerId)} disabled={mask.paintBufferId !== null}>
          {mask.paintBufferId ? 'Paintable ✓' : 'Make Paintable'}
        </Button>
        <Button variant="danger" onClick={() => api.removeMask(layerId)}>
          Remove Mask
        </Button>
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

      <LevelsEditor levels={mask.levels} onChange={(levels) => api.setMask(layerId, { levels })} />

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

      <ParamGroupLabel>Generators</ParamGroupLabel>
      <div className="px-2 pb-1">
        <Select
          value={'' as GeneratorType | ''}
          options={[
            { value: '' as const, label: 'Add generator…' },
            ...listGeneratorDefs().map((def) => ({
              value: def.type,
              label: def.requiresBake && !baked ? `${def.name} (needs bake)` : def.name,
            })),
          ]}
          onChange={(type) => {
            if (type) api.addGenerator(layerId, type as GeneratorType)
          }}
        />
      </div>

      {mask.generators.length === 0 && (
        <EmptyHint>No generators yet. Curvature drives edge wear; occlusion drives dirt in cavities.</EmptyHint>
      )}

      {mask.generators.map((generator) => {
        const def = getGeneratorDef(generator.type)
        if (!def) return null
        return (
          <Card
            key={generator.id}
            title={
              <label className="flex min-w-0 items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-[11px] w-[11px] shrink-0 accent-[oklch(0.62_0.17_255)]"
                  checked={generator.enabled}
                  onChange={(event) => api.setGenerator(layerId, generator.id, { enabled: event.target.checked })}
                />
                <span className="min-w-0 truncate text-[11px] text-app-text">{def.name}</span>
              </label>
            }
            actions={
              <IconButton title="Remove generator" danger onClick={() => api.removeGenerator(layerId, generator.id)}>
                ✕
              </IconButton>
            }
          >
            {def.requiresBake && !baked && <Note tone="warn">Needs baked mesh maps to do anything.</Note>}
            <Note>{def.description}</Note>
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
            {generator.type === 'idSelect' && <IdPartPicker layerId={layerId} generatorId={generator.id} value={Number(generator.params.partId ?? 0)} />}
            {generator.type === 'anchor' && (
              <AnchorPicker
                layerId={layerId}
                generatorId={generator.id}
                anchorLayerId={generator.anchorRef?.layerId ?? null}
                source={generator.anchorRef?.source ?? 'mask'}
              />
            )}
            <ParamEditor
              scope={`gen:${generator.id}`}
              params={def.params.filter((param) => !(generator.type === 'idSelect' && param.key === 'partId'))}
              values={generator.params}
              onChange={(key, value) => api.setGenerator(layerId, generator.id, { params: { [key]: value } })}
            />
          </Card>
        )
      })}
    </>
  )
}

function IdPartPicker({
  layerId,
  generatorId,
  value,
}: {
  layerId: string
  generatorId: string
  value: number
}) {
  const api = useApi()
  useEngineVersion()
  const parts = api.listMeshParts()
  if (parts.length === 0) return null
  return (
    <Select
      label="Part"
      hint="The source-mesh region this layer is restricted to."
      value={String(value)}
      options={parts.map((part) => ({ value: String(part.index), label: part.name }))}
      onChange={(next) => api.setGenerator(layerId, generatorId, { params: { partId: Number(next) } })}
    />
  )
}

const ANCHOR_SOURCE_LABELS: Record<AnchorSource, string> = {
  mask: 'Mask (where it applies)',
  height: 'Height',
  luminance: 'Base Colour Luminance',
  opacity: 'Opacity',
  roughness: 'Roughness',
  ao: 'Ambient Occlusion',
}

/**
 * Picks the anchor a generator reads, and which of its outputs.
 *
 * The list is deliberately only the anchors *below* this layer. The stack is
 * one fused shader evaluated bottom-up, so an anchor above has not been
 * computed when this mask is - offering it would be offering a value that is
 * always zero, which is a worse answer than not offering it.
 */
function AnchorPicker({
  layerId,
  generatorId,
  anchorLayerId,
  source,
}: {
  layerId: string
  generatorId: string
  anchorLayerId: string | null
  source: AnchorSource
}) {
  const api = useApi()
  useEngineVersion()
  const anchors = api.listAnchors(layerId)

  if (anchors.length === 0) {
    return (
      <Note tone="warn">
        No anchor points below this layer. Select a layer underneath, turn on “Anchor Point” in its Layer section,
        and it will appear here.
      </Note>
    )
  }

  const known = anchors.some((anchor) => anchor.layerId === anchorLayerId)

  return (
    <>
      <Select
        label="Anchor"
        hint="Which layer below this one to follow."
        value={known ? (anchorLayerId as string) : ''}
        options={[
          ...(known ? [] : [{ value: '', label: 'Pick an anchor…' }]),
          ...anchors.map((anchor) => ({ value: anchor.layerId, label: anchor.name })),
        ]}
        onChange={(next) => {
          if (next) api.setGeneratorAnchor(layerId, generatorId, { layerId: next, source })
        }}
      />
      <Select
        label="Reads"
        hint="Which of the anchored layer's outputs drives this mask."
        value={source}
        options={ANCHOR_SOURCES.map((value) => ({ value, label: ANCHOR_SOURCE_LABELS[value] }))}
        onChange={(next) => {
          if (anchorLayerId) api.setGeneratorAnchor(layerId, generatorId, { layerId: anchorLayerId, source: next })
        }}
      />
      {!known && anchorLayerId && (
        <Note tone="warn">
          This generator points at a layer that is no longer below it, so it contributes nothing. Pick another anchor.
        </Note>
      )}
    </>
  )
}

/**
 * Levels, collapsed by default.
 *
 * Five sliders appear on the mask *and* on every generator in the stack, and
 * expanded they bury the controls people actually reach for. They matter, but
 * they are a second pass.
 */
function LevelsEditor({ levels, onChange }: { levels: Levels; onChange: (levels: Partial<Levels>) => void }) {
  const [open, setOpen] = useState(false)
  const touched =
    levels.inLow !== 0 || levels.inHigh !== 1 || levels.gamma !== 1 || levels.outLow !== 0 || levels.outHigh !== 1

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
          Levels
        </span>
        {/* A dot, so a collapsed section still says it is doing something. */}
        {touched && !open && <span className="h-[4px] w-[4px] rounded-full bg-app-accent" />}
      </button>
      {open && (
        <>
          <Slider label="Input Low" value={levels.inLow} min={0} max={1} onChange={(inLow) => onChange({ inLow })} />
          <Slider label="Input High" value={levels.inHigh} min={0} max={1} onChange={(inHigh) => onChange({ inHigh })} />
          <Slider label="Gamma" value={levels.gamma} min={0.1} max={5} step={0.01} onChange={(gamma) => onChange({ gamma })} />
          <Slider label="Output Low" value={levels.outLow} min={0} max={1} onChange={(outLow) => onChange({ outLow })} />
          <Slider label="Output High" value={levels.outHigh} min={0} max={1} onChange={(outHigh) => onChange({ outHigh })} />
        </>
      )}
    </div>
  )
}
