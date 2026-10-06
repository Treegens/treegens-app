'use client'

import cn from 'classnames'
import {
  SITE_STATUS_STYLES,
  TONE_CLASSES,
} from '@/modules/siteCheck/verdictStyle'
import type { SiteStatus } from '@/types'

export function SiteStatusPill({ status }: { status: SiteStatus }) {
  const style = SITE_STATUS_STYLES[status] ?? SITE_STATUS_STYLES.draft
  const Icon = style.icon
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-2xl border px-2.5 py-1 text-xs font-medium',
        TONE_CLASSES[style.tone].chip,
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {style.label}
    </span>
  )
}
