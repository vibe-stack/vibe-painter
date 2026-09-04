/**
 * Importing this module registers the whole built-in catalogue. Anything that
 * wants materials available should import it once, near start-up.
 */

import { METALS } from './metals'
import { ALLOYS } from './alloys'
import { MASONRY } from './masonry'
import { STONE } from './stone'
import { ORGANIC } from './organic'
import { WOOD } from './wood'
import { CREATURE } from './creature'
import { MANUFACTURED } from './manufactured'
import { SYNTHETICS } from './synthetics'
import { INDUSTRIAL } from './industrial'
import { PAPER } from './paper'
import { GLASS } from './glass'
import { TERRAIN } from './terrain'
import { WEATHER } from './weather'
import { FABRIC } from './fabric'
import { SCIFI } from './scifi'
import { ALIEN } from './alien'
import { COATINGS } from './coatings'

export * from './metals'
export * from './alloys'
export * from './masonry'
export * from './stone'
export * from './organic'
export * from './wood'
export * from './creature'
export * from './manufactured'
export * from './synthetics'
export * from './industrial'
export * from './paper'
export * from './glass'
export * from './terrain'
export * from './weather'
export * from './fabric'
export * from './scifi'
export * from './alien'
export * from './coatings'

export const BUILT_IN_MATERIALS = [
  ...MANUFACTURED,
  ...SYNTHETICS,
  ...METALS,
  ...ALLOYS,
  ...INDUSTRIAL,
  ...MASONRY,
  ...STONE,
  ...GLASS,
  ...WOOD,
  ...PAPER,
  ...ORGANIC,
  ...CREATURE,
  ...TERRAIN,
  ...WEATHER,
  ...FABRIC,
  ...SCIFI,
  ...ALIEN,
  ...COATINGS,
]

/** Id of the material new fill layers get by default. */
export const DEFAULT_MATERIAL_ID = 'plain'
