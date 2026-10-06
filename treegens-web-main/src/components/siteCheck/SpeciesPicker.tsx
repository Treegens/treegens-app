'use client'

import { speciesFor } from '@/modules/siteCheck/mangroveSpecies'
import { speciesLabel } from '@/modules/siteCheck/speciesLabels'
import type { ISiteDoc } from '@/types'
import { ChoiceChip } from './ChoiceChip'

/** Same limit as the API. */
export const MAX_SPECIES = 8

type Props = {
  site: ISiteDoc | null
  value: string[]
  onChange: (speciesIds: string[]) => void
}

/** Species chips: the site's recommended ones first, then its region's. */
export function SpeciesPicker({ site, value, onChange }: Props) {
  const recommended = site?.verdict?.recommendedSpeciesIds ?? []
  const others = speciesFor(null, site?.countryCode)
    .map(s => s.id)
    .filter(id => !recommended.includes(id))
  // Chosen before the site (and so its region) was known: still shown, so
  // they can be seen and removed rather than sent unseen.
  const outside = value.filter(
    id => !recommended.includes(id) && !others.includes(id),
  )
  const full = value.length >= MAX_SPECIES

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id])

  const group = (title: string, ids: string[]) =>
    ids.length ? (
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ids.map(id => (
            <ChoiceChip
              key={id}
              selected={value.includes(id)}
              disabled={full && !value.includes(id)}
              onClick={() => toggle(id)}
            >
              {speciesLabel(id)}
            </ChoiceChip>
          ))}
        </div>
      </div>
    ) : null

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm text-gray-600">Which mangroves did you plant?</p>
        <p className="text-xs text-gray-500">
          Optional. Choose up to {MAX_SPECIES}.
        </p>
      </div>
      {group('Recommended for this site', recommended)}
      {group(recommended.length ? 'Other species' : 'Species', others)}
      {group('Chosen, but not from this region', outside)}
    </div>
  )
}
