'use client'

import cn from 'classnames'
import type { VerdictReason } from '@/modules/siteCheck/siteVerdict'
import {
  REASON_SOURCE_LABELS,
  SEVERITY_ORDER,
  SEVERITY_STYLES,
  TONE_CLASSES,
} from '@/modules/siteCheck/verdictStyle'

function SourceBadge({ source }: { source: VerdictReason['source'] }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        source === 'satellite'
          ? 'bg-indigo-100 text-indigo-800'
          : 'bg-[#E8F7ED] text-tree-green-2',
      )}
    >
      {REASON_SOURCE_LABELS[source]}
    </span>
  )
}

/** All verdict reasons, grouped by severity, most serious first. */
export function ReasonList({ reasons }: { reasons: VerdictReason[] }) {
  const groups = SEVERITY_ORDER.map(severity => ({
    severity,
    items: reasons.filter(r => r.severity === severity),
  })).filter(g => g.items.length > 0)

  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ severity, items }) => {
        const style = SEVERITY_STYLES[severity]
        const Icon = style.icon
        return (
          <div key={severity}>
            <p
              className={cn(
                'mb-2 flex flex-row items-center gap-1.5 text-sm font-bold',
                TONE_CLASSES[style.tone].text,
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {style.label}
            </p>
            <ul className="flex flex-col gap-2">
              {items.map(reason => (
                <li
                  key={reason.code}
                  className={cn(
                    'flex flex-row items-start justify-between gap-2 rounded-xl border px-3 py-2.5',
                    TONE_CLASSES[style.tone].card,
                  )}
                >
                  <p className="text-sm leading-snug text-gray-800">
                    {reason.message}
                  </p>
                  <SourceBadge source={reason.source} />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
