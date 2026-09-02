/**
 * Baking.
 *
 * Baking precomputes expensive geometric queries into UV space so generators
 * can read them as a cheap 2D lookup instead of raytracing the mesh every
 * frame. Without it, curvature, dirt, position and thickness generators have
 * nothing to read and quietly do nothing - which is why this panel says so.
 */

import { useEffect, useState } from 'react'
import { useApi, useEngineVersion } from '../context'
import { DEFAULT_BAKE_SETTINGS } from '../../core/doc/types'
import type { BakeSettings } from '../../core/doc/types'
import { Button, Panel, SectionHeading, Slider } from '../widgets/controls'
import type { BakeProgress } from '../../core/bake/baker'

export function BakePanel() {
  const api = useApi()
  useEngineVersion()
  const [settings, setSettings] = useState<BakeSettings>({ ...DEFAULT_BAKE_SETTINGS })
  const [progress, setProgress] = useState<BakeProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => api.on('bakeProgress', setProgress), [api])

  const patch = (part: Partial<BakeSettings>) => setSettings((s) => ({ ...s, ...part }))
  const running = progress !== null && progress.fraction < 1

  const run = async () => {
    setError(null)
    setProgress({ fraction: 0, message: 'Starting' })
    try {
      await api.bake(settings)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProgress(null)
    }
  }

  return (
    <Panel title="Bake Mesh Maps">
      <p className="px-3 py-2 text-[10px] leading-relaxed text-neutral-500">
        Traces ambient occlusion, curvature and thickness into UV space. Runs on worker threads, so the viewport stays
        live. Geometry maps (position, normal, tangent) are baked on the GPU automatically whenever the mesh changes.
      </p>

      <div className="px-3">
        <div className={`rounded border px-2 py-1 text-[11px] ${api.isBaked ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300' : 'border-amber-800 bg-amber-950/30 text-amber-300'}`}>
          {api.isBaked ? 'Mesh maps baked' : 'Not baked yet — geometry-driven generators are inactive'}
        </div>
      </div>

      <SectionHeading>Settings</SectionHeading>
      <Slider label="Resolution" hint="Mesh maps are low frequency, so they are usually fine at half the texture resolution." value={settings.resolution} min={128} max={2048} step={128} onChange={(resolution) => patch({ resolution: Math.round(resolution) })} />
      <Slider label="AO Rays" hint="More rays means less noise and a longer bake. Stratified sampling makes 32 go a long way." value={settings.aoRays} min={8} max={256} step={1} onChange={(aoRays) => patch({ aoRays: Math.round(aoRays) })} />
      <Slider label="AO Distance" hint="Fraction of the model size a ray may travel before it counts as unoccluded." value={settings.aoDistance} min={0.02} max={2} step={0.01} onChange={(aoDistance) => patch({ aoDistance })} />
      <Slider label="Thickness Rays" value={settings.thicknessRays} min={0} max={128} step={1} onChange={(thicknessRays) => patch({ thicknessRays: Math.round(thicknessRays) })} />
      <Slider label="Curvature Contrast" hint="Curvature is normalised against the mesh\u2019s own average, so this is contrast rather than an absolute scale." value={settings.curvatureIntensity} min={0.05} max={6} step={0.01} onChange={(curvatureIntensity) => patch({ curvatureIntensity })} />
      <Slider label="Curvature Radius" hint="How wide a neighbourhood curvature is averaged over. Larger picks up broad forms; smaller picks up fine creases." value={settings.curvatureRadius} min={0.05} max={4} step={0.01} onChange={(curvatureRadius) => patch({ curvatureRadius })} />
      <Slider label="Dilation" hint="How far results bleed past UV island borders." value={settings.dilation} min={0} max={32} step={1} onChange={(dilation) => patch({ dilation: Math.round(dilation) })} />

      <div className="flex items-center gap-2 px-3 py-2">
        <Button variant="primary" disabled={running} onClick={run}>{running ? 'Baking…' : 'Bake'}</Button>
        {running && <Button onClick={() => api.cancelBake()}>Cancel</Button>}
      </div>

      {progress && (
        <div className="px-3 pb-3">
          <div className="h-1 w-full overflow-hidden rounded bg-neutral-800">
            <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-neutral-500">{progress.message}</p>
        </div>
      )}
      {error && <p className="px-3 pb-3 text-[11px] text-red-400">{error}</p>}
    </Panel>
  )
}
