'use client'

import { IoLeafOutline } from 'react-icons/io5'
import {
  findSpecies,
  type PlantingZone,
} from '@/modules/siteCheck/mangroveSpecies'
import { localName } from '@/modules/siteCheck/speciesLabels'
import { ZONE_LABELS } from '@/modules/siteCheck/verdictStyle'

type Props = { zone: PlantingZone | null; speciesIds: string[] }

/** Recommended planting zone and the species that suit it. */
export function SpeciesList({ zone, speciesIds }: Props) {
  if (!zone) return null
  const species = speciesIds
    .map(id => findSpecies(id))
    .filter(s => s !== undefined)
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <h3 className="text-base font-bold text-gray-900">What to plant</h3>
      <p className="mt-1 text-sm text-gray-700">
        <span className="font-semibold">{ZONE_LABELS[zone].label}.</span>{' '}
        {ZONE_LABELS[zone].help}
      </p>
      {species.length ? (
        <ul className="mt-3 flex flex-col gap-2">
          {species.map(s => (
            <li
              key={s.id}
              className="flex flex-row items-start gap-2.5 rounded-xl bg-[#f7fbf3] px-3 py-2.5"
            >
              <IoLeafOutline
                className="mt-0.5 h-5 w-5 shrink-0 text-tree-green-2"
                aria-hidden
              />
              <div>
                <p className="text-sm font-semibold italic text-gray-900">
                  {s.scientificName}
                </p>
                {localName(s) ? (
                  <p className="text-sm text-gray-700">{localName(s)}</p>
                ) : null}
                {s.note ? (
                  <p className="text-xs text-gray-500">{s.note}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-gray-500">
          Ask a mangrove expert which species grow in this zone near you.
        </p>
      )}
    </section>
  )
}
