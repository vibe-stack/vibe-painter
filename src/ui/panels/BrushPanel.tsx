/**
 * Brush settings.
 *
 * The brush deposits a *material*, not a colour - one stroke can change base
 * colour, roughness and height together, which is the thing that makes 3D
 * texture painting different from painting a 2D image.
 *
 * Brush alphas are procedural too: no bitmap stamps anywhere in this app.
 */

import { useApi, useDocRevision } from '../context'
import { BRUSH_ALPHAS } from '../../core/gpu/painter'
import { getMaterialDef, listMaterialDefs } from '../../core/procedural/material'
import { Button, EmptyHint, Panel, SectionHeading, Select, Slider, Toggle } from '../widgets/controls'
import { ParamEditor } from '../widgets/ParamEditor'

export function BrushPanel() {
  const api = useApi()
  useDocRevision()
  const brush = api.getBrush()
  const material = api.engine.brushMaterial
  const def = getMaterialDef(material.defId)
  const layer = api.activeLayerId ? api.getLayer(api.activeLayerId) : null

  const target = api.engine.paintTarget
  const canPaintLayer = layer?.kind === 'paint'
  const canPaintMask = Boolean(layer?.mask?.paintBufferId)

  return (
    <Panel title="Brush">
      <SectionHeading>Target</SectionHeading>
      <div className="flex gap-1 px-3 py-1.5">
        <Button variant={target === 'layer' ? 'primary' : 'default'} onClick={() => api.setPaintTarget('layer')}>
          Layer pixels
        </Button>
        <Button variant={target === 'mask' ? 'primary' : 'default'} onClick={() => api.setPaintTarget('mask')}>
          Layer mask
        </Button>
      </div>
      {target === 'layer' && !canPaintLayer && (
        <EmptyHint>The selected layer is not a paint layer. Add one from the Layers panel to paint pixels.</EmptyHint>
      )}
      {target === 'mask' && !canPaintMask && (
        <EmptyHint>This layer has no paintable mask. Use “Make Paintable” in the mask section first.</EmptyHint>
      )}

      <SectionHeading>Shape</SectionHeading>
      <Slider label="Radius" hint="In world units, so a bigger model wants a bigger brush." value={brush.radius} min={0.005} max={1} step={0.001} onChange={(radius) => api.setBrush({ radius })} />
      <Slider label="Hardness" value={brush.hardness} min={0} max={1} onChange={(hardness) => api.setBrush({ hardness })} />
      <Slider label="Flow" hint="How much a single stamp deposits." value={brush.flow} min={0.01} max={1} onChange={(flow) => api.setBrush({ flow })} />
      <Slider label="Opacity" hint="Applied once for the whole stroke, so overlapping stamps never darken twice." value={brush.opacity} min={0.01} max={1} onChange={(opacity) => api.setBrush({ opacity })} />
      <Slider label="Spacing" hint="Stamp spacing as a fraction of the radius. Lower is smoother and slower." value={brush.spacing} min={0.02} max={1} step={0.01} onChange={(spacing) => api.setBrush({ spacing })} />
      <Slider label="Facing Limit" hint="Stops the brush bleeding onto surfaces angled away from the stroke - which is what keeps it off the far side of thin geometry." value={brush.facing} min={0} max={1} onChange={(facing) => api.setBrush({ facing })} />
      <Select
        label="Alpha"
        value={brush.alpha}
        options={BRUSH_ALPHAS.map((a) => ({ value: a, label: a }))}
        onChange={(alpha) => api.setBrush({ alpha })}
      />
      <Slider label="Alpha Scale" value={brush.alphaScale} min={0.1} max={6} step={0.01} onChange={(alphaScale) => api.setBrush({ alphaScale })} />
      <Slider label="Alpha Contrast" value={brush.alphaContrast} min={0} max={1} onChange={(alphaContrast) => api.setBrush({ alphaContrast })} />
      <Toggle label="Erase" value={brush.erase} onChange={(erase) => api.setBrush({ erase })} />

      <SectionHeading>Brush Material</SectionHeading>
      <Select
        value={material.defId}
        options={listMaterialDefs().map((m) => ({ value: m.id, label: `${m.category} · ${m.name}` }))}
        onChange={(defId) => api.setBrushMaterial(defId)}
      />
      {def && target === 'layer' && (
        <ParamEditor
          params={def.params}
          values={material.params}
          onChange={(key, value) => api.setBrushMaterial(def.id, { [key]: value })}
        />
      )}
      {target === 'mask' && (
        <EmptyHint>Painting a mask only writes coverage, so the brush material does not apply.</EmptyHint>
      )}
    </Panel>
  )
}
