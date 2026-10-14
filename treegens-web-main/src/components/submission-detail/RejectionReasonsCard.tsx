'use client'

import cn from 'classnames'
import Link from 'next/link'
import { IoCloseCircle } from 'react-icons/io5'
import { appConfig } from '@/config/appConfig'
import type { RejectionDetails } from '@/utils/rejectionFeedback'

type Props = {
  details: RejectionDetails
  /** Planter next steps (new submission, planting guide). Off for verifier views. */
  showNextSteps?: boolean
  className?: string
}

function formatRejectedAt(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Everything a planter needs to understand a rejection: who decided, when,
 * each reason in the verifiers' own words with a plain explanation, and what
 * to do next. Shown at the top of a rejected submission.
 */
export function RejectionReasonsCard({
  details,
  showNextSteps = true,
  className,
}: Props) {
  const date = formatRejectedAt(details.rejectedAt)
  const tally =
    details.totalVotes > 0
      ? `${details.noVotes} of ${details.totalVotes} verifiers voted no`
      : 'Rejected by verifiers'
  const subline = [tally, date ? `on ${date}` : null].filter(Boolean).join(' ')
  const numbered = details.reasons.length > 1

  return (
    <section
      aria-labelledby="rejection-reasons-title"
      className={cn(
        'rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <IoCloseCircle
          className="mt-0.5 h-6 w-6 shrink-0 text-red-600"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h2
            id="rejection-reasons-title"
            className="text-lg font-bold leading-tight text-red-900"
          >
            Why this was rejected
          </h2>
          <p className="mt-0.5 text-xs font-medium text-red-800/80">
            {subline}
          </p>
        </div>
      </div>

      {details.reasons.length === 0 ? (
        <p className="mt-3 text-sm leading-6 text-red-950">
          The verifiers did not leave a written reason. Ask them what went wrong
          in the message thread on this submission.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2.5">
          {details.reasons.map((item, index) => (
            <li
              key={`${index}-${item.reason}`}
              className="rounded-xl border border-red-200/80 bg-white px-3.5 py-3"
            >
              <p className="text-sm font-bold leading-snug text-[#1a1510]">
                {numbered ? `${index + 1}. ` : ''}
                {item.reason}
              </p>
              {item.meaning ? (
                <p className="mt-1 text-sm leading-6 text-[#5c534a]">
                  {item.meaning}
                </p>
              ) : null}
              {item.fix ? (
                <p className="mt-1.5 text-sm leading-6 text-tree-green-3">
                  <span className="font-semibold">Next time:</span> {item.fix}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {showNextSteps ? (
        <div className="mt-4 rounded-xl bg-white/70 px-3.5 py-3">
          <p className="text-sm font-bold text-[#1a1510]">What to do next</p>
          <p className="mt-1 text-sm leading-6 text-[#5c534a]">
            This submission is closed and cannot be resubmitted. Fix what the
            verifiers flagged, then start a new submission with a fresh before
            video and after video.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={appConfig.routes.NewPlant}
              className="tg-cta inline-flex items-center justify-center px-4 py-2.5 text-sm font-bold"
            >
              New submission
            </Link>
            <Link
              href={appConfig.routes.Tutorial}
              className="inline-flex items-center justify-center rounded-2xl border border-tree-green-2/30 bg-white px-4 py-2.5 text-sm font-bold text-tree-green-2"
            >
              Planting guide
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  )
}
