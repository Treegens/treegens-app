'use client'

import cn from 'classnames'
import type { VerdictCode } from '@/modules/siteCheck/siteVerdict'
import { TONE_CLASSES, VERDICT_STYLES } from '@/modules/siteCheck/verdictStyle'

type Props = { code?: VerdictCode | null; className?: string }

export function VerdictChip({ code, className }: Props) {
  const style = code ? VERDICT_STYLES[code] : null
  const tone = TONE_CLASSES[style?.tone ?? 'gray']
  const Icon = style?.icon
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold',
        tone.chip,
        className,
      )}
    >
      {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
      {style?.label ?? 'No verdict yet'}
    </span>
  )
}
