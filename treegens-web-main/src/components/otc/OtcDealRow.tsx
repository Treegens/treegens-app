'use client'

import {
  OtcStatusPill,
  OtcSubmissionStatusPill,
  OtcUnfundableBadge,
} from '@/components/otc/OtcStatusPill'
import { buildOtcDealPath } from '@/config/appConfig'
import { formatKes, paidKes } from '@/services/otcService'
import type { OtcDeal, OtcDealDetail } from '@/types/otc'
import { formatPhoneForDisplay } from '@/utils/mpesaPhone'
import { formatTimeAgo } from '@/utils/timeAgo'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { HiChevronRight, HiOutlineClipboard } from 'react-icons/hi2'

type Props = {
  deal: OtcDeal | OtcDealDetail
  /** Buyer desk: show planter name + phone with tap-to-copy. */
  showPlanter?: boolean
}

export async function copyText(text: string, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    toast.error('Could not copy. Long-press to copy instead.')
  }
}

/** One deal in a list: tap anywhere to open the deal page. */
export function OtcDealRow({ deal, showPlanter = false }: Props) {
  const detail = deal as Partial<OtcDealDetail>
  const confidence = detail.submission?.aiVerification?.confidence
  const sent = paidKes(deal)
  const partial = deal.payment?.partial && sent !== deal.amountKes
  const submissionStatus =
    deal.submissionStatus ?? detail.submission?.status ?? null

  return (
    <div className="tg-card flex flex-col gap-2 border px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {showPlanter ? (
            <p className="truncate text-base font-bold text-[#111827]">
              {deal.mpesaName}
            </p>
          ) : null}
          <p className="text-sm text-[#374151]">
            <span className="font-semibold tabular-nums">{deal.trees}</span>{' '}
            tree{deal.trees === 1 ? '' : 's'}
            {deal.countSource === 'ai' ? (
              <span className="text-[#6b7280]">
                {' '}
                · AI
                {typeof confidence === 'number'
                  ? ` ${Math.round(confidence * (confidence <= 1 ? 100 : 1))}%`
                  : ''}
              </span>
            ) : deal.countSource === 'manual' ? (
              <span className="text-[#6b7280]"> · set by buyer</span>
            ) : deal.countSource === 'approved' ? (
              <span className="text-[#6b7280]"> · verifier approved</span>
            ) : null}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-lg font-black tabular-nums text-[#1a2610]">
            {formatKes(deal.amountKes)}
          </p>
          {partial ? (
            <p className="text-[11px] text-amber-800">Sent {formatKes(sent)}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <OtcStatusPill status={deal.status} />
        <OtcUnfundableBadge releaseStatus={deal.release?.status} />
        {deal.verified === false && deal.status !== 'cancelled' ? (
          <span className="inline-flex items-center rounded-2xl bg-orange-100 px-2.5 py-1 text-[11px] font-medium text-orange-900">
            Not verified yet
          </span>
        ) : null}
        <OtcSubmissionStatusPill status={submissionStatus} />
      </div>

      {deal.status === 'awaiting_count' && deal.countNote ? (
        <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
          {deal.countNote}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        {showPlanter ? (
          <button
            type="button"
            onClick={() => void copyText(deal.mpesaNumber, 'Number copied')}
            className="inline-flex min-h-10 items-center gap-1 rounded-lg px-1 text-sm font-medium text-[#435F24]"
            aria-label="Copy M-Pesa number"
          >
            <HiOutlineClipboard className="h-4 w-4" aria-hidden />
            <span className="tabular-nums">
              {formatPhoneForDisplay(deal.mpesaNumber)}
            </span>
          </button>
        ) : (
          <span className="text-xs text-[#9ca3af]">
            {formatTimeAgo(deal.createdAt)}
          </span>
        )}
        <Link
          href={buildOtcDealPath(deal._id)}
          className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-[#303E1A]"
        >
          {showPlanter ? (
            <span className="text-xs font-normal text-[#9ca3af]">
              {formatTimeAgo(deal.createdAt)}
            </span>
          ) : (
            'Open'
          )}
          <HiChevronRight className="h-5 w-5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
