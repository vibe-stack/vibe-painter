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
import { Button, Row, Select, Slider } from '../widgets/controls'
import { Note, ParamGroupLabel } from '../widgets/sections'

const RESOLUTIONS = [256, 512, 1024, 2048]

export function MeshSection() {
  const api = useApi()
  useEngineVersion()
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
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
    <>
      <div className="grid grid-cols-3 gap-1 px-2 py-1">
        {api.listPrimitives().map((primitive) => (
          <button
            key={primitive.id}
            type="button"
            title={primitive.description}
            disabled={importing}
            onClick={() => {
              api.setMesh(primitive.id)
              setImportNote(null)
            }}
            className={`truncate rounded-[3px] px-1 py-[3px] text-[10px] transition-colors disabled:opacity-40 ${
              activePrimitive === primitive.id
                ? 'bg-app-accent text-white'
                : 'bg-app-raised text-app-muted hover:bg-app-hover hover:text-app-text'
            }`}
          >
            {primitive.name}
          </button>
        ))}
      </div>

      <div
        className={`mx-2 mt-1 rounded-[4px] border border-dashed px-2 py-2 transition-colors ${
          dropActive ? 'border-app-accent bg-app-accent-dim/25' : 'border-app-line-strong bg-app-bg'
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
          <p className="min-w-0 flex-1 text-[10px] leading-snug text-app-faint">
            {importing ? 'Importing…' : 'Drop a .glb / .gltf here'}
          </p>
          <Button disabled={importing} onClick={() => fileInput.current?.click()}>
            Browse
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

      <Note>
        {mesh?.source.kind === 'imported' ? mesh.source.fileName : (mesh?.name ?? 'Mesh')}
        {' · '}
        {status.meshTriangles.toLocaleString()} triangles
        {' · '}
        geometry maps {status.geometryBaked ? 'ready' : 'pending'}
      </Note>
      {importNote && <Note tone="warn">{importNote}</Note>}

      <ParamGroupLabel>Texture Resolution</ParamGroupLabel>
      <div className="grid grid-cols-4 gap-1 px-2">
        {RESOLUTIONS.map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => api.setResolution(size)}
            className={`rounded-[3px] px-1 py-[3px] text-[10px] tabular-nums transition-colors ${
              status.resolution === size
                ? 'bg-app-accent text-white'
                : 'bg-app-raised text-app-muted hover:bg-app-hover hover:text-app-text'
            }`}
          >
            {size}
          </button>
        ))}
      </div>
      <Note>Changing this reallocates every channel target and clears painted pixels.</Note>
    </>
  )
}

export function LightingSection() {
  const api = useApi()
  useEngineVersion()
  const [preset, setPreset] = useState('studio')
  const env = api.engine.environmentSettings
  // Read straight off the engine rather than mirroring it into React state:
  // two copies of the same value is exactly how controls drift out of sync.
  const heightScale = api.engine.heightScale
  const normalScale = api.engine.normalScale

  return (
    <>
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
      <Slider label="Sun Elevation" value={env.sunElevation} min={-10} max={90} step={0.5} suffix="°" onChange={(sunElevation) => api.setEnvironment({ sunElevation })} />
      <Slider label="Sun Azimuth" value={env.sunAzimuth} min={0} max={360} step={1} suffix="°" onChange={(sunAzimuth) => api.setEnvironment({ sunAzimuth })} />
      <Slider label="Sun Intensity" value={env.sunIntensity} min={0} max={30} step={0.1} onChange={(sunIntensity) => api.setEnvironment({ sunIntensity })} />
      <Slider label="Cloud Cover" value={env.clouds} min={0} max={1} step={0.01} onChange={(clouds) => api.setEnvironment({ clouds })} />

      <ParamGroupLabel>Display</ParamGroupLabel>
      <Row label="Background" hint="Hides the generated sky without turning off the lighting it provides.">
        <button
          type="button"
          role="switch"
          aria-checked={api.engine.showBackground}
          onClick={() => api.engine.setShowBackground(!api.engine.showBackground)}
          className={`relative h-[15px] w-[26px] shrink-0 rounded-full transition-colors ${
            api.engine.showBackground ? 'bg-app-accent' : 'bg-app-raised hover:bg-app-hover'
          }`}
        >
          <span
            className="absolute top-[2px] h-[11px] w-[11px] rounded-full bg-white transition-all"
            style={{ left: api.engine.showBackground ? 13 : 2 }}
          />
        </button>
      </Row>
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
    </>
  )
}
