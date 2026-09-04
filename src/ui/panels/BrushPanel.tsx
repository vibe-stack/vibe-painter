/**
 * Brush settings.
 *
 * The brush deposits a *material*, not a colour - one stroke can change base
 * colour, roughness and height together, which is the thing that makes 3D
 * texture painting different from painting a 2D image. So the material picker
 * here is the same swatch grid the catalogue uses; picking a brush by name off
 * a dropdown was asking people to identify fifty shaders by their labels.
 *
 * Brush alphas are procedural too: no bitmap stamps anywhere in this app.
 */

import { useApi, useEngineVersion } from '../context'
import { BRUSH_ALPHAS } from '../../core/gpu/painter'
import { getMaterialDef } from '../../core/procedural/material'
import { EmptyHint, Row, Segmented, Slider, Toggle } from '../widgets/controls'
import { MaterialField } from '../widgets/MaterialPicker'
import { ParamEditor } from '../widgets/ParamEditor'

export function BrushSection() {
  const api = useApi()
  useEngineVersion()
  const brush = api.getBrush()
  const layer = api.activeLayerId ? api.getLayer(api.activeLayerId) : null

  const target = api.engine.paintTarget
  const canPaintLayer = layer?.kind === 'paint'
  const canPaintMask = Boolean(layer?.mask?.paintBufferId)

  return (
    <>
      <Segmented
        label="Target"
        value={target}
        options={[
          { value: 'layer' as const, label: 'Pixels' },
          { value: 'mask' as const, label: 'Mask' },
        ]}
        onChange={(kind) => api.setPaintTarget(kind)}
      />
      {target === 'layer' && !canPaintLayer && (
        <EmptyHint>The selected layer is not a paint layer. Add one from the Layers panel to paint pixels.</EmptyHint>
      )}
      {target === 'mask' && !canPaintMask && (
        <EmptyHint>This layer has no paintable mask. Use “Make Paintable” in the Mask section first.</EmptyHint>
      )}

      <Slider
        label="Radius"
        hint="In world units, so a bigger model wants a bigger brush."
        value={brush.radius}
        min={0.005}
        max={1}
        step={0.001}
        onChange={(radius) => api.setBrush({ radius })}
      />
      <Slider label="Hardness" value={brush.hardness} min={0} max={1} onChange={(hardness) => api.setBrush({ hardness })} />
      <Slider
        label="Flow"
        hint="How much a single stamp deposits."
        value={brush.flow}
        min={0.01}
        max={1}
        onChange={(flow) => api.setBrush({ flow })}
      />
      <Slider
        label="Opacity"
        hint="Applied once for the whole stroke, so overlapping stamps never darken twice."
        value={brush.opacity}
        min={0.01}
        max={1}
        onChange={(opacity) => api.setBrush({ opacity })}
      />
      <Slider
        label="Spacing"
        hint="Stamp spacing as a fraction of the radius. Lower is smoother and slower."
        value={brush.spacing}
        min={0.02}
        max={1}
        step={0.01}
        onChange={(spacing) => api.setBrush({ spacing })}
      />
      <Slider
        label="Facing Limit"
        hint="Stops the brush bleeding onto surfaces angled away from the stroke - which is what keeps it off the far side of thin geometry."
        value={brush.facing}
        min={0}
        max={1}
        onChange={(facing) => api.setBrush({ facing })}
      />

      <Row label="Alpha" hint="Each shape is its own compiled pipeline, so switching one costs a short recompile.">
        <div className="grid grid-cols-3 gap-[3px]">
          {BRUSH_ALPHAS.map((alpha) => (
            <button
              key={alpha}
              type="button"
              onClick={() => api.setBrush({ alpha })}
              className={`truncate rounded-[3px] px-1 py-[3px] text-[10px] capitalize transition-colors ${
                brush.alpha === alpha
                  ? 'bg-app-accent text-white'
                  : 'bg-app-raised text-app-muted hover:bg-app-hover hover:text-app-text'
              }`}
            >
              {alpha}
            </button>
          ))}
        </div>
      </Row>
      {brush.alpha !== 'round' && brush.alpha !== 'square' && (
        <>
          <Slider
            label="Alpha Scale"
            value={brush.alphaScale}
            min={0.1}
            max={6}
            step={0.01}
            onChange={(alphaScale) => api.setBrush({ alphaScale })}
          />
          <Slider
            label="Alpha Contrast"
            value={brush.alphaContrast}
            min={0}
            max={1}
            onChange={(alphaContrast) => api.setBrush({ alphaContrast })}
          />
        </>
      )}
      <Toggle label="Erase" value={brush.erase} onChange={(erase) => api.setBrush({ erase })} />
    </>
  )
}

export function BrushMaterialSection() {
  const api = useApi()
  useEngineVersion()
  const material = api.engine.brushMaterial
  const def = getMaterialDef(material.defId)
  const target = api.engine.paintTarget

  if (target === 'mask') {
    return <EmptyHint>Painting a mask only writes coverage, so the brush material does not apply.</EmptyHint>
  }

  return (
    <>
      <MaterialField
        defId={material.defId}
        onPick={(defId) => api.setBrushMaterial(defId)}
        hint="Evaluated once at stroke start and held as pixels, so an expensive material costs the same to paint with as a flat colour."
      />
      {def && (
        <>
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-app-faint">{def.description}</p>
          <ParamEditor
            scope="brush"
            params={def.params}
            values={material.params}
            onChange={(key, value) => api.setBrushMaterial(def.id, { [key]: value })}
          />
        </>
      )}
    </>
  )
}
