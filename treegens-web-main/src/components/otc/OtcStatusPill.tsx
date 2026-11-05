'use client'

import { OTC_STATUS_LABEL } from '@/services/otcService'
import type { OtcDealStatus, OtcReleaseStatus } from '@/types/otc'
import cn from 'classnames'
import {
  HiCheckCircle,
  HiClock,
  HiExclamationTriangle,
  HiPaperAirplane,
  HiXCircle,
} from 'react-icons/hi2'

/**
 * awaiting_count gray · awaiting_payment amber · payment_sent blue ·
 * confirmed green · disputed red · cancelled gray
 */
const STYLE: Record<OtcDealStatus, { cls: string; Icon: typeof HiClock }> = {
  awaiting_count: { cls: 'bg-gray-100 text-gray-700', Icon: HiClock },
  awaiting_payment: { cls: 'bg-amber-100 text-amber-900', Icon: HiClock },
  payment_sent: { cls: 'bg-blue-100 text-blue-900', Icon: HiPaperAirplane },
  confirmed: { cls: 'bg-green-100 text-green-800', Icon: HiCheckCircle },
  disputed: { cls: 'bg-red-100 text-red-800', Icon: HiExclamationTriangle },
  cancelled: { cls: 'bg-gray-100 text-gray-600', Icon: HiXCircle },
}

export function OtcStatusPill({
  status,
  label,
  className,
}: {
  status: OtcDealStatus
  /** Override the default label (e.g. "Pay now" on the buyer side). */
  label?: string
  className?: string
}) {
  const meta = STYLE[status] ?? STYLE.awaiting_count
  const Icon = meta.Icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-2xl px-2.5 py-1.5 text-xs font-medium',
        meta.cls,
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {label ?? OTC_STATUS_LABEL[status] ?? status}
    </span>
  )
}

/** Red "unfundable" badge: KES went out for a planting that will never mint. */
export function OtcUnfundableBadge({
  releaseStatus,
  className,
}: {
  releaseStatus?: OtcReleaseStatus
  className?: string
}) {
  if (releaseStatus !== 'unfundable') return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-2xl bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white',
        className,
      )}
      title="Verifiers rejected this planting after payment; no MGRO will mint for it"
    >
      <HiExclamationTriangle className="h-4 w-4 shrink-0" aria-hidden />
      Unfundable
    </span>
  )
}

/** Submission status pill: red when rejected, amber when pending review. */
export function OtcSubmissionStatusPill({
  status,
  className,
}: {
  status?: string | null
  className?: string
}) {
  if (!status) return null
  const s = status.toLowerCase()
  const cls =
    s === 'rejected'
      ? 'bg-red-100 text-red-800'
      : s === 'approved'
        ? 'bg-green-100 text-green-800'
        : s === 'pending_review'
          ? 'bg-amber-100 text-amber-900'
          : 'bg-gray-100 text-gray-700'
  const label =
    s === 'pending_review'
      ? 'In review'
      : s === 'awaiting_plant'
        ? 'Awaiting plant clip'
        : s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-2xl px-2.5 py-1 text-[11px] font-medium',
        cls,
        className,
      )}
    >
      Planting: {label}
    </span>
  )
}
