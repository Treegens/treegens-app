import { findSpecies, type MangroveSpecies } from './mangroveSpecies'

/** Swahili name first, then any other local name. */
export function localName(species: MangroveSpecies): string | null {
  const names = species.localNames ?? {}
  return names.sw ?? Object.values(names)[0] ?? null
}

/** "Rhizophora mucronata (Mkoko)", or the raw id for unknown species. */
export function speciesLabel(id: string): string {
  const species = findSpecies(id)
  if (!species) return id
  const local = localName(species)
  return local ? `${species.scientificName} (${local})` : species.scientificName
}
