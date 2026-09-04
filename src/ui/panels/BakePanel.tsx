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
import { Button, Slider } from '../widgets/controls'
import { ParamGroupLabel } from '../widgets/sections'
import type { BakeProgress } from '../../core/bake/baker'

export function BakeSection() {
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
    <>
      <div className="px-2 pt-1">
        <div
          className={`rounded-[3px] border px-2 py-1 text-[10px] ${
            api.isBaked
              ? 'border-app-good/40 bg-app-good/10 text-app-good'
              : 'border-app-warn/40 bg-app-warn/10 text-app-warn'
          }`}
        >
          {api.isBaked ? 'Mesh maps baked' : 'Not baked — geometry-driven generators are inactive'}
        </div>
      </div>

      <p className="px-2 py-1.5 text-[10px] leading-snug text-app-faint">
        Ambient occlusion and thickness are traced against the mesh itself; curvature is measured on its
        connectivity. All three rasterise the mesh into UV space at the texture set’s resolution, so nothing can
        disagree about which texel is surface. Geometry maps update whenever the mesh changes; these three need an
        explicit bake.
      </p>

      <ParamGroupLabel>Settings</ParamGroupLabel>
      <Slider
        label="AO Rays"
        hint="Rays traced per texel. Noise falls as the square root of this, so doubling it halves the grain — and doubles the bake."
        value={settings.aoRays}
        min={8}
        max={512}
        step={8}
        onChange={(aoRays) => patch({ aoRays: Math.round(aoRays) })}
      />
      <Slider
        label="AO Distance"
        hint="Fraction of the model size a ray may travel before it counts as unoccluded."
        value={settings.aoDistance}
        min={0.02}
        max={2}
        step={0.01}
        onChange={(aoDistance) => patch({ aoDistance })}
      />
      <Slider
        label="Thickness Depth"
        hint="How far a probe looks for the far side of the model, as a fraction of its size. Anything thicker than this reads as solid."
        value={settings.thicknessDistance}
        min={0.05}
        max={2}
        step={0.01}
        onChange={(thicknessDistance) => patch({ thicknessDistance })}
      />
      <Slider
        label="Curv. Contrast"
        hint="Curvature is normalised against the mesh’s own average, so this is contrast rather than an absolute scale."
        value={settings.curvatureIntensity}
        min={0.05}
        max={6}
        step={0.01}
        onChange={(curvatureIntensity) => patch({ curvatureIntensity })}
      />
      <Slider
        label="Curv. Radius"
        hint="How wide a neighbourhood curvature is averaged over. Larger picks up broad forms; smaller picks up fine creases."
        value={settings.curvatureRadius}
        min={0.05}
        max={4}
        step={0.01}
        onChange={(curvatureRadius) => patch({ curvatureRadius })}
      />
      <Slider
        label="Dilation"
        hint="How far results bleed past UV island borders."
        value={settings.dilation}
        min={0}
        max={32}
        step={1}
        onChange={(dilation) => patch({ dilation: Math.round(dilation) })}
      />

      <div className="flex items-center gap-1.5 px-2 pt-2">
        <Button variant="primary" disabled={running} onClick={run} full={!running}>
          {running ? 'Baking…' : 'Bake Mesh Maps'}
        </Button>
        {running && <Button onClick={() => api.cancelBake()}>Cancel</Button>}
      </div>

      {progress && (
        <div className="px-2 pt-2">
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-app-raised">
            <div
              className="h-full bg-app-accent transition-[width]"
              style={{ width: `${Math.round(progress.fraction * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] text-app-faint">{progress.message}</p>
        </div>
      )}
      {error && <p className="px-2 pt-2 text-[11px] text-app-danger">{error}</p>}
    </>
  )
}
