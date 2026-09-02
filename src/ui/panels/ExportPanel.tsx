/**
 * Export and project I/O.
 *
 * Export flattens the composited channels through a preset's packing. The
 * project file is a different thing entirely: it stores the recipe, so a fully
 * authored surface is a couple of kilobytes rather than a folder of images.
 */

import { useRef, useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { EXPORT_PRESETS } from '../../core/gpu/exporter'
import { Button, Panel, SectionHeading, Select } from '../widgets/controls'

export function ExportPanel() {
  const api = useApi()
  useEngineVersion()
  const [presetId, setPresetId] = useState(EXPORT_PRESETS[0].id)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const smartInput = useRef<HTMLInputElement>(null)

  const preset = EXPORT_PRESETS.find((p) => p.id === presetId)!

  const doExport = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const maps = await api.exportMaps(presetId, api.project.name.replace(/\s+/g, '_') || 'texture')
      for (const map of maps) download(map.blob, map.name)
      setMessage(`Exported ${maps.length} map${maps.length === 1 ? '' : 's'} at ${maps[0]?.width ?? 0}px.`)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Export & Project">
      <SectionHeading>Texture Export</SectionHeading>
      <Select
        label="Preset"
        value={presetId}
        options={EXPORT_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
        onChange={setPresetId}
      />
      <p className="px-3 pb-1 text-[10px] leading-snug text-neutral-500">{preset.description}</p>
      <ul className="px-3 pb-2 text-[10px] text-neutral-600">
        {preset.maps.map((map) => (
          <li key={map.suffix}>· {map.label}</li>
        ))}
      </ul>
      <div className="px-3 pb-2">
        <Button variant="primary" disabled={busy} onClick={doExport}>
          {busy ? 'Exporting…' : `Export ${preset.maps.length} PNG${preset.maps.length === 1 ? '' : 's'}`}
        </Button>
      </div>

      <SectionHeading>Project</SectionHeading>
      <p className="px-3 py-1 text-[10px] leading-snug text-neutral-500">
        Saves the layer recipe, not pixels. Painted strokes are raster data and are not included, so a reloaded project
        comes back with its paint layers empty.
      </p>
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        <Button
          onClick={() => {
            const blob = new Blob([JSON.stringify(api.save(), null, 2)], { type: 'application/json' })
            download(blob, `${api.project.name.replace(/\s+/g, '_') || 'project'}.vibepainter.json`)
          }}
        >
          Save Project
        </Button>
        <Button onClick={() => fileInput.current?.click()}>Load Project</Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            if (!file) return
            try {
              api.load(JSON.parse(await file.text()))
              setMessage(`Loaded ${file.name}`)
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : String(cause))
            }
            event.target.value = ''
          }}
        />
      </div>

      <SectionHeading>Smart Materials</SectionHeading>
      <p className="px-3 py-1 text-[10px] leading-snug text-neutral-500">
        A smart material is a layer (usually a group) saved with its generators intact and its paint stripped, so it
        re-derives its wear from whatever mesh you apply it to.
      </p>
      <div className="flex flex-wrap gap-1 px-3 pb-3">
        <Button
          disabled={!api.activeLayerId}
          onClick={() => {
            const id = api.activeLayerId
            if (!id) return
            const layer = api.getLayer(id)
            const file = api.saveSmartMaterial(id, layer?.name ?? 'Smart Material')
            if (!file) return
            const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
            download(blob, `${file.name.replace(/\s+/g, '_')}.smartmat.json`)
          }}
        >
          Save Selected
        </Button>
        <Button onClick={() => smartInput.current?.click()}>Apply File</Button>
        <input
          ref={smartInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            if (!file) return
            try {
              api.applySmartMaterial(JSON.parse(await file.text()))
              setMessage(`Applied ${file.name}`)
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : String(cause))
            }
            event.target.value = ''
          }}
        />
      </div>

      {message && <p className="px-3 pb-3 text-[11px] text-neutral-400">{message}</p>}
    </Panel>
  )
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
