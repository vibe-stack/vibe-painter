/**
 * Mesh, resolution and lighting.
 *
 * The environment is generated, not loaded: an analytic sky rendered to a cube
 * map and pre-filtered. That keeps the "no external textures" rule honest all
 * the way through to the lighting, and metals still have something to reflect.
 */

import { useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { ENVIRONMENT_PRESETS } from '../../core/gpu/environment'
import { Button, Panel, SectionHeading, Select, Slider } from '../widgets/controls'

const RESOLUTIONS = [256, 512, 1024, 2048]

export function ScenePanel() {
  const api = useApi()
  useEngineVersion()
  const [preset, setPreset] = useState('studio')
  // Read straight off the engine rather than mirroring it into React state:
  // two copies of the same value is exactly how controls drift out of sync.
  const heightScale = api.engine.heightScale
  const normalScale = api.engine.normalScale
  const env = api.engine.environmentSettings
  const status = api.status()

  return (
    <Panel title="Scene">
      <SectionHeading>Mesh</SectionHeading>
      <div className="grid grid-cols-2 gap-1 px-3 py-1.5">
        {api.listPrimitives().map((primitive) => (
          <Button key={primitive.id} title={primitive.description} onClick={() => api.setMesh(primitive.id)}>
            {primitive.name}
          </Button>
        ))}
      </div>
      <p className="px-3 pb-2 text-[10px] text-neutral-500">
        {status.meshTriangles.toLocaleString()} triangles · geometry maps {status.geometryBaked ? 'ready' : 'pending'}
      </p>

      <SectionHeading>Texture Resolution</SectionHeading>
      <div className="flex gap-1 px-3 py-1.5">
        {RESOLUTIONS.map((size) => (
          <Button
            key={size}
            variant={status.resolution === size ? 'primary' : 'default'}
            onClick={() => api.setResolution(size)}
          >
            {size}
          </Button>
        ))}
      </div>
      <p className="px-3 pb-2 text-[10px] leading-snug text-neutral-500">
        Changing this reallocates every channel target and clears painted pixels.
      </p>

      <SectionHeading>Lighting</SectionHeading>
      <Select
        label="Environment"
        value={preset}
        options={Object.keys(ENVIRONMENT_PRESETS).map((id) => ({ value: id, label: id }))}
        onChange={(id) => {
          setPreset(id)
          api.setEnvironment(id)
        }}
      />
      <Slider label="Intensity" value={env.intensity} min={0} max={3} step={0.01} onChange={(intensity) => api.setEnvironment({ intensity })} />
      <Slider label="Sun Elevation" value={env.sunElevation} min={-10} max={90} step={0.5} onChange={(sunElevation) => api.setEnvironment({ sunElevation })} />
      <Slider label="Sun Azimuth" value={env.sunAzimuth} min={0} max={360} step={1} onChange={(sunAzimuth) => api.setEnvironment({ sunAzimuth })} />
      <Slider label="Sun Intensity" value={env.sunIntensity} min={0} max={30} step={0.1} onChange={(sunIntensity) => api.setEnvironment({ sunIntensity })} />
      <Slider label="Cloud Cover" value={env.clouds} min={0} max={1} step={0.01} onChange={(clouds) => api.setEnvironment({ clouds })} />

      <SectionHeading>Display</SectionHeading>
      <Slider
        label="Height Relief"
        hint="How strongly the height channel perturbs the shading normal in the viewport."
        value={heightScale}
        min={0}
        max={4}
        step={0.01}
        onChange={(value) => api.engine.setHeightScale(value)}
      />
      <Slider
        label="Normal Strength"
        value={normalScale}
        min={0}
        max={3}
        step={0.01}
        onChange={(value) => api.engine.setNormalScale(value)}
      />
    </Panel>
  )
}
