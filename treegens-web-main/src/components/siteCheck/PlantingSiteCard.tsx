'use client'

import cn from 'classnames'
import type { ISiteDoc } from '@/types'
import { SitePicker } from './SitePicker'

type Props = {
  value: string
  onChange: (siteId: string, site: ISiteDoc | null) => void
  className?: string
}

/** "Planting site" section for the submission flow. */
export function PlantingSiteCard({ value, onChange, className }: Props) {
  return (
    <section
      className={cn(
        'rounded-xl border border-gray-200 bg-gray-50/50 p-4',
        className,
      )}
    >
      <h2 className="mb-1 text-base font-semibold text-gray-800">
        Planting site
      </h2>
      <p className="mb-3 text-sm text-gray-500">
        Planting mangroves? Choose the site you checked.
      </p>
      <SitePicker value={value} onChange={onChange} />
    </section>
  )
}
