'use client'

import { useRef, useState } from 'react'
import { MangroveSpeciesGuide } from '@/components/planting/MangroveSpeciesGuide'
import { useTutorialLang } from '@/components/planting/useTutorialLang'
import { speciesGuideUi } from '@/components/tutorial/mangroveSpeciesCopy'
import {
  mangrovesNative,
  speciesFor,
} from '@/modules/siteCheck/mangroveSpecies'
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
  const longitude = site?.center?.longitude
  // Where mangroves were brought in, none are offered, even by a verdict
  // stored before that was known.
  const native = mangrovesNative(site?.countryCode, longitude)
  const recommended = native ? (site?.verdict?.recommendedSpeciesIds ?? []) : []
  const others = speciesFor(null, site?.countryCode, longitude)
    .map(s => s.id)
    .filter(id => !recommended.includes(id))
  // Chosen before the site (and so its region) was known: still shown, so
  // they can be seen and removed rather than sent unseen.
  const outside = value.filter(
    id => !recommended.includes(id) && !others.includes(id),
  )
  const full = value.length >= MAX_SPECIES

  // Rule 3 (Jimi 2026-10-14): the planter can learn the species right where
  // they name them. The same guide as the planting rules card (ported from
  // Treegens/treegens-web, lang-en, PR #15), in the saved guidance language.
  const [guideLang, setGuideLang] = useTutorialLang()
  const [guideHost, setGuideHost] = useState<Element | null>(null)
  const learnRef = useRef<HTMLButtonElement>(null)

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
      <div className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-gray-600">
            Which mangroves did you plant?
          </p>
          <p className="text-xs text-gray-500">
            Optional. Choose up to {MAX_SPECIES}.
          </p>
        </div>
        <button
          ref={learnRef}
          type="button"
          onClick={() => setGuideHost(document.body)}
          aria-haspopup="dialog"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-tree-green-2 bg-white px-3 text-xs font-bold text-tree-green-2 transition-colors hover:bg-green-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tree-green-2 motion-reduce:transition-none"
        >
          <span aria-hidden="true">🌿</span>
          {(speciesGuideUi[guideLang] ?? speciesGuideUi.English).open}
        </button>
      </div>
      <MangroveSpeciesGuide
        open={guideHost !== null}
        onClose={() => setGuideHost(null)}
        lang={guideLang}
        onLangChange={setGuideLang}
        container={guideHost}
        returnFocusRef={learnRef}
      />
      {native ? null : (
        <p className="text-sm text-gray-600">
          Mangroves are not native here, so none are listed.
        </p>
      )}
      {group('Recommended for this site', recommended)}
      {group(recommended.length ? 'Other species' : 'Species', others)}
      {group('Chosen, but not from this region', outside)}
    </div>
  )
}
