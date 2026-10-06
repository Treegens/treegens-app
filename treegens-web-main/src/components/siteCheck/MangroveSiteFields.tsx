'use client'

import type { ISiteDoc } from '@/types'
import { PlantingSiteCard } from './PlantingSiteCard'
import { SpeciesPicker } from './SpeciesPicker'
import { VerdictChip } from './VerdictChip'

type Props = {
  /** The submission already has a site from its land clip */
  linked: boolean
  site: ISiteDoc | null
  pickedSiteId: string
  onPickSite: (siteId: string, site: ISiteDoc | null) => void
  species: string[]
  onSpeciesChange: (speciesIds: string[]) => void
  /** See SitePicker */
  leaveWarning?: string
}

/** Plant step extras for mangroves: the site (if none yet) and species. */
export function MangroveSiteFields({
  linked,
  site,
  pickedSiteId,
  onPickSite,
  species,
  onSpeciesChange,
  leaveWarning,
}: Props) {
  return (
    <div className="mt-2 flex flex-col gap-4">
      {linked ? (
        site ? (
          <div className="flex flex-row flex-wrap items-center gap-2 text-sm text-gray-700">
            <span>
              Site: <span className="font-semibold">{site.name}</span>
            </span>
            <VerdictChip code={site.verdict?.code} />
          </div>
        ) : null
      ) : (
        <PlantingSiteCard
          value={pickedSiteId}
          onChange={onPickSite}
          className="bg-white"
          leaveWarning={leaveWarning}
        />
      )}
      <SpeciesPicker site={site} value={species} onChange={onSpeciesChange} />
    </div>
  )
}
