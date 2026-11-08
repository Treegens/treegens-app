'use client'

import { PlantAiResultSummary } from '@/components/submission/PlantAiResultSummary'
import { formatKes } from '@/services/otcService'
import type { ISubmissionAiVerification } from '@/types'
import type { OtcDealUploadSummary } from '@/types/otc'
import { useEffect } from 'react'
import { HiCheck } from 'react-icons/hi2'

type Props = {
  open: boolean
  onFinished: () => void
  /** Queued for upload vs submitted immediately */
  variant?: 'submitted' | 'queued'
  /** When set, show mangrove AI headline (count or offline message) */
  mangrovePlantAi?: ISubmissionAiVerification | null
  queuedOfflineMangrove?: boolean
  /** OTC: the planter is paid in KES by M-Pesa for this planting. */
  otcDeal?: OtcDealUploadSummary | null
}

const DISPLAY_MS_DEFAULT = 3800
const DISPLAY_MS_WITH_AI = 6500

/**
 * Brief full-screen celebration after the plant clip step finishes (online submit or offline queue).
 */
export function SubmissionCompleteCelebration({
  open,
  onFinished,
  variant = 'submitted',
  mangrovePlantAi,
  queuedOfflineMangrove,
  otcDeal,
}: Props) {
  const showAiBlock =
    queuedOfflineMangrove ||
    (mangrovePlantAi != null &&
      (mangrovePlantAi.status === 'completed' ||
        mangrovePlantAi.status === 'skipped' ||
        mangrovePlantAi.status === 'failed'))

  useEffect(() => {
    if (!open) return
    const ms = showAiBlock ? DISPLAY_MS_WITH_AI : DISPLAY_MS_DEFAULT
    const id = window.setTimeout(() => onFinished(), ms)
    return () => window.clearTimeout(id)
  }, [open, onFinished, showAiBlock])

  if (!open) return null

  const subtitle =
    variant === 'queued'
      ? 'Your videos are queued and will upload when you’re back online.'
      : 'Your proof-of-plant submission was received.'

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
    >
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white px-6 py-8 shadow-2xl sm:px-8 sm:py-10">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full bg-[#E8F7ED] shadow-inner animate-submission-complete-pop sm:mb-5 sm:h-[5.25rem] sm:w-[5.25rem]">
            <HiCheck
              className="h-10 w-10 text-tree-green-2 sm:h-12 sm:w-12"
              strokeWidth={2.2}
            />
          </div>
          <p className="text-xl font-semibold text-gray-900">
            Submission complete!
          </p>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            {subtitle}
          </p>
          {showAiBlock ? (
            <div className="mt-5 w-full">
              <PlantAiResultSummary
                variant="hero"
                ai={mangrovePlantAi ?? null}
                queuedOffline={variant === 'queued' && !!queuedOfflineMangrove}
              />
            </div>
          ) : null}
          {otcDeal ? (
            <p className="mt-4 w-full rounded-xl border border-[#435F24]/15 bg-[#eef6e4] px-3 py-2 text-sm font-semibold text-[#303E1A]">
              {otcDeal.trees > 0
                ? `You will be paid ${formatKes(otcDeal.amountKes)} by M-Pesa for ${otcDeal.trees} tree${otcDeal.trees === 1 ? '' : 's'}`
                : 'M-Pesa payout: count pending'}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
