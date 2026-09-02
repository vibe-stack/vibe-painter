/**
 * Inspector for the selected layer: its material, how that material is
 * projected onto the surface, and its mask stack.
 */

import { useApi, useDocRevision } from '../context'
import { getMaterialDef } from '../../core/procedural/material'
import { PROJECTIONS } from '../../core/doc/types'
import { EmptyHint, Field, Panel, SectionHeading, Select, Slider } from '../widgets/controls'
import { ParamEditor } from '../widgets/ParamEditor'
import { MaskEditor } from './MaskEditor'

export function PropertiesPanel() {
  const api = useApi()
  useDocRevision()
  const layerId = api.activeLayerId
  const layer = layerId ? api.getLayer(layerId) : null

  if (!layer || !layerId) {
    return (
      <Panel title="Properties">
        <EmptyHint>Select a layer to edit it.</EmptyHint>
      </Panel>
    )
  }

  return (
    <Panel title={`Properties — ${layer.name}`}>
      <Field label="Name">
        <input
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-sky-600 focus:outline-none"
          value={layer.name}
          onChange={(e) => api.setLayerProps(layerId, { name: e.target.value })}
        />
      </Field>

      {layer.kind === 'fill' && <FillProperties layerId={layerId} />}
      {layer.kind === 'paint' && (
        <EmptyHint>
          A paint layer stores the pixels you stamp onto it. Pick a brush material in the Brush panel, choose the Paint
          tool, and draw on the model.
        </EmptyHint>
      )}
      {layer.kind === 'folder' && (
        <EmptyHint>
          A group composites its children against everything below it, then blends the whole result through the group's
          own opacity and mask. That is what makes a mask on a folder affect every layer inside it at once.
        </EmptyHint>
      )}

      <MaskEditor layerId={layerId} />
    </Panel>
  )
}

function FillProperties({ layerId }: { layerId: string }) {
  const api = useApi()
  const layer = api.getLayer(layerId)
  if (!layer || layer.kind !== 'fill') return null
  const def = getMaterialDef(layer.material.defId)
  if (!def) return <EmptyHint>Material “{layer.material.defId}” is not registered in this build.</EmptyHint>

  const projection = layer.projection

  return (
    <>
      <SectionHeading>Projection</SectionHeading>
      <Select
        label="Mode"
        value={projection.mode}
        hint="UV follows the mesh layout. Triplanar ignores UVs entirely and never stretches, at three times the shader cost."
        options={PROJECTIONS.map((p) => ({ value: p, label: p }))}
        onChange={(mode) => api.setProjection(layerId, { mode })}
      />
      <Slider
        label="Tiling U"
        value={projection.scale[0]}
        min={0.05}
        max={40}
        step={0.01}
        onChange={(value) => api.setProjection(layerId, { scale: [value, projection.scale[1]] })}
      />
      <Slider
        label="Tiling V"
        value={projection.scale[1]}
        min={0.05}
        max={40}
        step={0.01}
        onChange={(value) => api.setProjection(layerId, { scale: [projection.scale[0], value] })}
      />
      <Slider
        label="Rotation"
        value={projection.rotation}
        min={-Math.PI}
        max={Math.PI}
        step={0.001}
        onChange={(rotation) => api.setProjection(layerId, { rotation })}
      />
      <Slider
        label="Offset U"
        value={projection.offset[0]}
        min={-2}
        max={2}
        step={0.001}
        onChange={(value) => api.setProjection(layerId, { offset: [value, projection.offset[1]] })}
      />
      <Slider
        label="Offset V"
        value={projection.offset[1]}
        min={-2}
        max={2}
        step={0.001}
        onChange={(value) => api.setProjection(layerId, { offset: [projection.offset[0], value] })}
      />
      {projection.mode === 'triplanar' && (
        <Slider
          label="Blend Sharpness"
          hint="How narrow the transition between the three planes is."
          value={projection.blendSharpness}
          min={1}
          max={24}
          step={0.1}
          onChange={(blendSharpness) => api.setProjection(layerId, { blendSharpness })}
        />
      )}
      {(projection.mode === 'planar' || projection.mode === 'cylindrical') && (
        <Select
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

      <div className="mt-1 px-3 py-1 text-[10px] leading-snug text-neutral-500">{def.description}</div>
      <ParamEditor
        params={def.params}
        values={layer.material.params}
        onChange={(key, value) => api.setMaterialParam(layerId, key, value)}
      />
    </>
  )
}
