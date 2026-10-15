'use client'

import cn from 'classnames'
import type {
  SiteVerdict,
  VerdictReason,
} from '@/modules/siteCheck/siteVerdict'
import {
  SEVERITY_ORDER,
  SEVERITY_STYLES,
  TONE_CLASSES,
  VERDICT_STYLES,
} from '@/modules/siteCheck/verdictStyle'

type Props = {
  verdict: SiteVerdict
  /** Small heading above the verdict, e.g. "Preview" */
  title?: string
  note?: string
  maxReasons?: number
  className?: string
}

/** The most serious reasons, which explain the verdict. */
function topReasons(reasons: VerdictReason[], max: number) {
  return [...reasons]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    )
    .slice(0, max)
}

export function VerdictCard({
  verdict,
  title,
  note,
  maxReasons = 3,
  className,
}: Props) {
  const style = VERDICT_STYLES[verdict.code]
  const tone = TONE_CLASSES[style.tone]
  const Icon = style.icon
  return (
    <section className={cn('rounded-2xl border-2 p-4', tone.card, className)}>
      {title ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {title}
        </p>
      ) : null}
      <div className="flex flex-row items-center gap-3">
        <span
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
            tone.disc,
          )}
        >
          <Icon className="h-7 w-7" aria-hidden />
        </span>
        <p className={cn('text-xl font-bold leading-tight', tone.text)}>
          {verdict.headline}
        </p>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {topReasons(verdict.reasons, maxReasons).map(reason => {
          const ReasonIcon = SEVERITY_STYLES[reason.severity].icon
          return (
            <li key={reason.code} className="flex flex-row gap-2">
              <ReasonIcon
                className={cn(
                  'mt-0.5 h-5 w-5 shrink-0',
                  TONE_CLASSES[SEVERITY_STYLES[reason.severity].tone].text,
                )}
                aria-hidden
              />
              <p className="text-sm leading-snug text-gray-800">
                {reason.message}
              </p>
            </li>
          )
        })}
      </ul>
      {note ? <p className="mt-3 text-xs text-gray-600">{note}</p> : null}
    </section>
  )
}
