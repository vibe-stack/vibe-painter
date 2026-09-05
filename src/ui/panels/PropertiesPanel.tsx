/**
 * The selected layer: what it is made of and how that lands on the surface.
 *
 * Split into separate section bodies rather than one panel, because the shell
 * stacks them as independent collapsible sections - material and projection are
 * edited at different moments and it is worth being able to close one.
 */

import { useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { getMaterialDef } from '../../core/procedural/material'
import { PROJECTIONS } from '../../core/doc/types'
import { EmptyHint, NumberField, Row, Segmented, Slider, TextInput, Toggle } from '../widgets/controls'
import { MaterialField } from '../widgets/MaterialPicker'
import { ParamEditor } from '../widgets/ParamEditor'

/** Name, opacity and the anchor point - what every layer kind has. */
export function LayerIdentity() {
  const api = useApi()
  useEngineVersion()
  const layerId = api.activeLayerId
  const layer = layerId ? api.getLayer(layerId) : null
  if (!layer || !layerId) return <EmptyHint>Select a layer to edit it.</EmptyHint>

  const anchored = Boolean(layer.anchorName)

  return (
    <>
      <TextInput label="Name" value={layer.name} onChange={(name) => api.setLayerProps(layerId, { name })} />
      <Slider
        label="Opacity"
        value={layer.opacity}
        min={0}
        max={1}
        onChange={(opacity) => api.setLayerProps(layerId, { opacity })}
      />
      <Toggle
        label="Anchor Point"
        hint="Publishes what this layer produced so layers above it can drive their masks from it - and keep following it as you edit. Free: the stack is one shader, so an anchor is a value it already computed."
        value={anchored}
        onChange={(on) => api.setLayerAnchor(layerId, on ? layer.name || 'Anchor' : null)}
      />
      {anchored && (
        <TextInput
          label="Anchor Name"
          value={layer.anchorName ?? ''}
          placeholder="Anchor"
          hint="How this anchor is listed in the mask panel above."
          // Clearing the field would otherwise unpublish the anchor and pull
          // this input out from under the caret. The toggle above is how you
          // turn it off.
          onChange={(anchorName) => api.setLayerAnchor(layerId, anchorName.trim() ? anchorName : 'Anchor')}
        />
      )}
    </>
  )
}

export function MaterialSection() {
  const api = useApi()
  useEngineVersion()
  const layerId = api.activeLayerId
  const layer = layerId ? api.getLayer(layerId) : null

  if (!layer || !layerId) return <EmptyHint>Select a layer to edit it.</EmptyHint>

  if (layer.kind === 'paint') {
    return (
      <EmptyHint>
        A paint layer stores the pixels you stamp onto it. Pick a brush material in the Brush section, choose the
        Paint tool, and draw on the model.
      </EmptyHint>
    )
  }

  if (layer.kind === 'folder') {
    return (
      <EmptyHint>
        A group composites its children against everything below it, then blends the whole result through the
        group&apos;s own opacity and mask. That is what makes a mask on a folder affect every layer inside it at once.
      </EmptyHint>
    )
  }

  const def = getMaterialDef(layer.material.defId)

  return (
    <>
      <MaterialField
        defId={layer.material.defId}
        onPick={(defId) => api.setLayerMaterial(layerId, defId)}
        hint="Every material is a shader evaluated live. Switching one rebuilds the layer stack's graph."
      />
      {!def ? (
        <EmptyHint>Material “{layer.material.defId}” is not registered in this build.</EmptyHint>
      ) : (
        <>
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-app-faint">{def.description}</p>
          <ParamEditor
            scope={`layer:${layerId}`}
            params={def.params}
            values={layer.material.params}
            onChange={(key, value) => api.setMaterialParam(layerId, key, value)}
          />
        </>
      )}
    </>
  )
}

export function ProjectionSection() {
  const api = useApi()
  useEngineVersion()
  const layerId = api.activeLayerId
  const layer = layerId ? api.getLayer(layerId) : null

  if (!layer || !layerId || layer.kind !== 'fill') {
    return <EmptyHint>Projection applies to fill layers, which evaluate a material across the surface.</EmptyHint>
  }

  const projection = layer.projection

  return (
    <>
      <Row
        label="Mode"
        hint="UV follows the mesh layout. Triplanar ignores UVs entirely and never stretches, at three times the shader cost."
      >
        <div className="grid grid-cols-3 gap-[3px]">
          {PROJECTIONS.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => api.setProjection(layerId, { mode })}
              className={`truncate rounded-[3px] px-1 py-[3px] text-[10px] capitalize transition-colors ${
                projection.mode === mode
                  ? 'bg-app-accent text-white'
                  : 'bg-app-raised text-app-muted hover:bg-app-hover hover:text-app-text'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </Row>

      <TilingControls
        scale={projection.scale}
        onChange={(scale) => api.setProjection(layerId, { scale })}
      />

      <Row label="Offset">
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            value={projection.offset[0]}
            min={-2}
            max={2}
            step={0.01}
            onChange={(value) => api.setProjection(layerId, { offset: [value, projection.offset[1]] })}
          />
          <NumberField
            value={projection.offset[1]}
            min={-2}
            max={2}
            step={0.01}
            onChange={(value) => api.setProjection(layerId, { offset: [projection.offset[0], value] })}
          />
        </div>
      </Row>

      <Slider
        label="Rotation"
        value={projection.rotation}
        min={-Math.PI}
        max={Math.PI}
        step={0.001}
        onChange={(rotation) => api.setProjection(layerId, { rotation })}
      />

      {projection.mode === 'triplanar' && (
        <Slider
          label="Blend Sharp."
          hint="How narrow the transition between the three planes is."
          value={projection.blendSharpness}
          min={1}
          max={24}
          step={0.1}
          onChange={(blendSharpness) => api.setProjection(layerId, { blendSharpness })}
        />
      )}

      {(projection.mode === 'planar' || projection.mode === 'cylindrical') && (
        <Segmented
          label="Axis"
          value={projection.axis}
          options={[
            { value: 'x' as const, label: 'X' },
            { value: 'y' as const, label: 'Y' },
            { value: 'z' as const, label: 'Z' },
          ]}
          onChange={(axis) => api.setProjection(layerId, { axis })}
        />
      )}
    </>
  )
}

const TILING_MIN = 0.2
const TILING_MAX = 64

function TilingControls({
  scale,
  onChange,
}: {
  scale: [number, number]
  onChange: (scale: [number, number]) => void
}) {
  const [separate, setSeparate] = useState(false)
  const split = separate || Math.abs(scale[0] - scale[1]) > 1e-3

  return (
    <>
      <div className="flex items-center justify-end px-2">
        <button
          type="button"
          title={split ? 'Lock X and Y together' : 'Edit X and Y separately'}
          onClick={() => {
            if (split) {
              const mean = (scale[0] + scale[1]) / 2
              onChange([mean, mean])
              setSeparate(false)
            } else {
              setSeparate(true)
            }
          }}
          className={`rounded-[3px] px-1.5 py-[1px] text-[9px] tabular-nums transition-colors ${
            split ? 'text-app-faint hover:text-app-muted' : 'bg-app-raised text-app-muted'
          }`}
        >
          {split ? 'X ≠ Y' : 'X = Y'}
        </button>
      </div>
      {split ? (
        <>
          <Slider
            label="Tiling X"
            hint="Higher tiling makes the pattern finer. This is the control that sharpens a blurry catalogue material."
            value={scale[0]}
            min={TILING_MIN}
            max={TILING_MAX}
            step={0.01}
            curve="log"
            onChange={(value) => onChange([value, scale[1]])}
          />
          <Slider
            label="Tiling Y"
            value={scale[1]}
            min={TILING_MIN}
            max={TILING_MAX}
            step={0.01}
            curve="log"
            onChange={(value) => onChange([scale[0], value])}
          />
        </>
      ) : (
        <Slider
          label="Tiling"
          hint="How many times the material repeats across the model. Higher = finer, sharper detail. Lower = larger features."
          value={scale[0]}
          min={TILING_MIN}
          max={TILING_MAX}
          step={0.01}
          curve="log"
          onChange={(value) => onChange([value, value])}
        />
      )}
    </>
  )
}
