'use client'

import {
  OtcStatusPill,
  OtcUnfundableBadge,
} from '@/components/otc/OtcStatusPill'
import { buildOtcDealPath } from '@/config/appConfig'
import { formatKes, paidKes } from '@/services/otcService'
import type { OtcDealDetail } from '@/types/otc'
import Link from 'next/link'
import { HiChevronRight } from 'react-icons/hi2'

type Props = {
  deal: OtcDealDetail
  /** Lower-cased wallet of the viewer; decides planter vs buyer copy. */
  viewerWallet?: string | null
  /** True when the reward status says the MGRO is held for this deal. */
  otcHold?: boolean
}

/**
 * Compact card on the submission page: this planting is paid by M-Pesa.
 * Planter with a payment waiting gets a prominent "Confirm you received" CTA.
 */
export function OtcPayoutCard({ deal, viewerWallet, otcHold }: Props) {
  const me = viewerWallet?.toLowerCase() ?? ''
  const isPlanter = !!me && deal.planterWallet.toLowerCase() === me
  const isBuyer = !!me && deal.buyerWallet.toLowerCase() === me
  const buyerLabel = deal.buyer?.label || 'the buyer'
  const sent = paidKes(deal)
  const href = buildOtcDealPath(deal._id)

  const confirmNow = isPlanter && deal.status === 'payment_sent'

  let line: string
  switch (deal.status) {
    case 'awaiting_count':
      line = deal.countNote || 'Waiting for the tree count.'
      break
    case 'awaiting_payment':
      line = isBuyer
        ? `Pay ${formatKes(deal.amountKes)} to ${deal.mpesaName}.`
        : `Waiting for ${buyerLabel} to send ${formatKes(deal.amountKes)}.`
      break
    case 'payment_sent':
      line = isPlanter
        ? `${buyerLabel} says ${formatKes(sent)} was sent to your M-Pesa.`
        : `Waiting for ${deal.mpesaName} to confirm ${formatKes(sent)}.`
      break
    case 'confirmed':
      line = isPlanter
        ? `Confirmed. The MGRO for this planting goes to ${buyerLabel}.`
        : `${deal.mpesaName} confirmed ${formatKes(sent)}. MGRO released to you.`
      break
    case 'disputed':
      line = isPlanter
        ? 'You reported the payment did not arrive.'
        : `${deal.mpesaName} did not receive the payment.`
      break
    case 'cancelled':
      line = isPlanter
        ? 'Cancelled. Your MGRO for this planting will be paid to you as usual.'
        : `Cancelled${deal.cancelReason ? `: ${deal.cancelReason}` : '.'}`
      break
    default:
      line = ''
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[#435F24]/15 bg-[#eef6e4] p-3.5">
      <div className="flex flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#435F24]">
            M-Pesa payout
          </p>
          <p className="mt-0.5 text-lg font-black tabular-nums text-[#1a2610]">
            {formatKes(deal.amountKes)}
            <span className="ml-1 text-xs font-semibold text-[#5c534a]">
              for {deal.trees} tree{deal.trees === 1 ? '' : 's'}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <OtcStatusPill status={deal.status} />
          <OtcUnfundableBadge releaseStatus={deal.release?.status} />
        </div>
      </div>

      {line ? <p className="text-sm text-[#374151]">{line}</p> : null}

      <Link
        href={href}
        className={
          confirmNow
            ? 'tg-cta flex min-h-12 w-full items-center justify-center gap-1 px-4 py-3 text-sm'
            : 'flex min-h-11 w-full items-center justify-between rounded-xl border border-[#435F24]/20 bg-white px-4 py-2.5 text-sm font-semibold text-[#303E1A]'
        }
      >
        {confirmNow
          ? `Confirm you received ${formatKes(sent)}`
          : 'Open M-Pesa payout'}
        <HiChevronRight className="h-4 w-4" aria-hidden />
      </Link>

      {otcHold && isPlanter ? (
        <p className="text-center text-xs text-[#6b6560]">
          MGRO held for your M-Pesa deal
        </p>
      ) : null}
    </div>
  )
}
