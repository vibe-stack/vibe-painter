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
import { ParamGroupLabel } from '../widgets/sections'
import { MaterialField } from '../widgets/MaterialPicker'
import { ParamEditor } from '../widgets/ParamEditor'
import { BrushPresetRow } from './SmartMaterials'

export function BrushSection() {
  const api = useApi()
  useEngineVersion()
  const brush = api.getBrush()
  const layer = api.activeLayerId ? api.getLayer(api.activeLayerId) : null

  const target = api.engine.paintTarget
  const canPaintLayer = layer?.kind === 'paint'
  const canPaintMask = Boolean(layer?.mask?.paintBufferId)

  // The brush is a sphere in world space, so its useful range is a property of
  // the model rather than a constant. The floor is deliberately far below one
  // texel: the position map is precise enough to resolve it now, and a brush
  // that cannot go finer than a texel is a brush that cannot do detail at all.
  const modelRadius = Math.max(0.05, api.engine.bounds().radius)
  const minRadius = modelRadius * 0.001
  const maxRadius = modelRadius * 1.5
  const resolution = api.getResolution()
  // A rough figure, and honest about it: UV density varies across a mesh, so
  // this is what the brush covers where the parameterisation is even.
  const texelsAcross = Math.max(0.1, (brush.radius * 2 * resolution) / (modelRadius * 2))

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

      <ParamGroupLabel>Presets</ParamGroupLabel>
      <BrushPresetRow />

      <ParamGroupLabel>Shape</ParamGroupLabel>
      <Slider
        label="Radius"
        hint="World units, scaled to the model. The track is logarithmic: a linear one puts every detail-sized brush in the first two pixels of travel."
        value={brush.radius}
        min={minRadius}
        max={maxRadius}
        step={0.0001}
        curve="log"
        onChange={(radius) => api.setBrush({ radius })}
      />
      <p className="px-2 pb-0.5 text-[10px] text-app-faint">
        About {texelsAcross.toLocaleString(undefined, { maximumFractionDigits: texelsAcross < 10 ? 1 : 0 })} texels
        across at {resolution}px, where the UVs are even.
      </p>
      <Slider
        label="Hardness"
        hint="At 1 the edge is still antialiased against the texel size, so a hard brush is crisp rather than jagged."
        value={brush.hardness}
        min={0}
        max={1}
        onChange={(hardness) => api.setBrush({ hardness })}
      />
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
        hint="Stamp spacing as a fraction of the radius. Lower is smoother; a very fast stroke widens it automatically rather than falling behind the cursor."
        value={brush.spacing}
        min={0.01}
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

      <ParamGroupLabel>Pen Pressure</ParamGroupLabel>
      <Slider
        label="Size"
        hint="How much pressure scales the stamp radius. Ignored by a mouse, which always reports full pressure."
        value={brush.pressureSize}
        min={0}
        max={1}
        onChange={(pressureSize) => api.setBrush({ pressureSize })}
      />
      <Slider
        label="Flow"
        hint="How much pressure scales deposition. Size and flow are separate so a stroke can taper without also fading."
        value={brush.pressureFlow}
        min={0}
        max={1}
        onChange={(pressureFlow) => api.setBrush({ pressureFlow })}
      />
      <ParamGroupLabel>Alpha</ParamGroupLabel>
      <Row label="Shape" hint="Each shape is its own compiled pipeline, so switching one costs a short recompile.">
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
