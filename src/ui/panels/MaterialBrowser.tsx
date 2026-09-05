/**
 * The catalogue, browsed.
 *
 * Every entry here is a shader, not an asset. There is no download, no texture
 * memory and no resolution: picking one rewrites the active fill layer's graph
 * and the next composite shows it.
 *
 * The list itself lives in `MaterialPicker`, because the brush and the layer
 * inspector need exactly the same thing in a popover.
 */

import { useApi, useEngineVersion } from '../context'
import { MaterialGrid } from '../widgets/MaterialPicker'

export function MaterialBrowser() {
  const api = useApi()
  useEngineVersion()

  const layer = api.activeLayerId ? api.getLayer(api.activeLayerId) : null
  const activeMaterialId = layer?.kind === 'fill' ? layer.material.defId : null

  const apply = (defId: string) => {
    if (layer?.kind === 'fill' && api.activeLayerId) {
      api.setLayerMaterial(api.activeLayerId, defId)
    } else {
      // Nothing suitable is selected: adding a layer is what the user meant.
      api.addFillLayer({ materialId: defId })
    }
  }

  return (
    <div className="flex h-[380px] flex-col">
      <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-app-faint">
        Click to apply to the selected fill. Drag onto the mesh to assign to a source material or ID part.
      </p>
      <MaterialGrid activeId={activeMaterialId} onPick={apply} />
    </div>
  )
}
