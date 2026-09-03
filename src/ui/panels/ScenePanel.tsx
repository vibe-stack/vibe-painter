/**
 * Mesh, resolution and lighting.
 *
 * The environment is generated, not loaded: an analytic sky rendered to a cube
 * map and pre-filtered. That keeps the "no external textures" rule honest all
 * the way through to the lighting, and metals still have something to reflect.
 */

import { useRef, useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { ENVIRONMENT_PRESETS } from '../../core/gpu/environment'
import { GLTF_ACCEPT, isGltfFileName } from '../../core/mesh/gltf'
import { Button, Panel, SectionHeading, Select, Slider } from '../widgets/controls'

const RESOLUTIONS = [256, 512, 1024, 2048]

export function ScenePanel() {
  const api = useApi()
  useEngineVersion()
  const [preset, setPreset] = useState('studio')
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // Read straight off the engine rather than mirroring it into React state:
  // two copies of the same value is exactly how controls drift out of sync.
  const heightScale = api.engine.heightScale
  const normalScale = api.engine.normalScale
  const env = api.engine.environmentSettings
  const status = api.status()
  const mesh = api.project.meshes[0]
  const activePrimitive = mesh?.source.kind === 'primitive' ? mesh.source.preset : null

  const importFile = async (file: File) => {
    if (!isGltfFileName(file.name)) {
      setImportNote('Drop a .glb or .gltf file. External .gltf buffers are not fetched; prefer a self-contained .glb.')
      return
    }
    setImporting(true)
    setImportNote(null)
    try {
      const imported = await api.importGltf(file)
      setImportNote(
        imported.generatedUVs
          ? 'UVs were missing or overlapping, so a unique unwrap was generated. Rebake mesh maps after import.'
          : null,
      )
    } catch (cause) {
      setImportNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Panel title="Scene">
      <SectionHeading>Mesh</SectionHeading>
      <div className="grid grid-cols-2 gap-1 px-3 py-1.5">
        {api.listPrimitives().map((primitive) => (
          <Button
            key={primitive.id}
            variant={activePrimitive === primitive.id ? 'primary' : 'default'}
            title={primitive.description}
            disabled={importing}
            onClick={() => {
              api.setMesh(primitive.id)
              setImportNote(null)
            }}
          >
            {primitive.name}
          </Button>
        ))}
      </div>
      <div
        className={`mx-3 mb-1 rounded border border-dashed px-3 py-2 ${
          dropActive ? 'border-sky-500 bg-sky-950/40' : 'border-neutral-700 bg-neutral-900/40'
        }`}
        onDragOver={(event) => {
          event.preventDefault()
          setDropActive(true)
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDropActive(false)
          const file = event.dataTransfer.files[0]
          if (file) void importFile(file)
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] leading-snug text-neutral-500">
            {importing ? 'Importing…' : 'Any .glb / .gltf, or pick a primitive above.'}
          </p>
          <Button disabled={importing} onClick={() => fileInput.current?.click()}>
            Import GLB
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={GLTF_ACCEPT}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importFile(file)
            event.target.value = ''
          }}
        />
      </div>
      <p className="px-3 pb-2 text-[10px] text-neutral-500">
        {mesh?.source.kind === 'imported' ? mesh.source.fileName : mesh?.name ?? 'Mesh'}
        {' · '}
        {status.meshTriangles.toLocaleString()} triangles
        {' · '}
        geometry maps {status.geometryBaked ? 'ready' : 'pending'}
      </p>
      {importNote && <p className="px-3 pb-2 text-[10px] leading-snug text-amber-400">{importNote}</p>}

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
