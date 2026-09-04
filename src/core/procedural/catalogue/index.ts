/**
 * Importing this module registers the whole built-in catalogue. Anything that
 * wants materials available should import it once, near start-up.
 */

import { METALS } from './metals'
import { MASONRY } from './masonry'
import { ORGANIC } from './organic'
import { MANUFACTURED } from './manufactured'
import { TERRAIN } from './terrain'
import { FABRIC } from './fabric'
import { SCIFI } from './scifi'
import { COATINGS } from './coatings'

export * from './metals'
export * from './masonry'
export * from './organic'
export * from './manufactured'
export * from './terrain'
export * from './fabric'
export * from './scifi'
export * from './coatings'

export const BUILT_IN_MATERIALS = [
  ...MANUFACTURED,
  ...METALS,
  ...MASONRY,
  ...ORGANIC,
  ...TERRAIN,
  ...FABRIC,
  ...SCIFI,
  ...COATINGS,
]

/** Id of the material new fill layers get by default. */
export const DEFAULT_MATERIAL_ID = 'plain'
