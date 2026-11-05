import type {
  OtcDeal,
  OtcDealDetail,
  OtcDealStatus,
  OtcDisputeReasonCode,
  OtcEligibleSubmission,
  OtcEnrollment,
  OtcEnrollmentRow,
  OtcEnvelope,
  OtcInvite,
  OtcInvitePreview,
  OtcMeResponse,
  OtcPaginated,
  OtcResolutionOutcome,
  OtcSummary,
} from '@/types/otc'
import axios from 'axios'
import { axiosInstance } from './axiosInstance'

/** REST client for the OTC (M-Pesa) desk: /api/otc/*. */

// ---------------------------------------------------------------- public ---

export function previewOtcInvite(code: string) {
  return axiosInstance.get<OtcEnvelope<OtcInvitePreview>>(
    `/api/otc/invites/${encodeURIComponent(code.trim())}/preview`,
  )
}

// --------------------------------------------------------------- planter ---

export function joinOtc(body: {
  code: string
  mpesaNumber: string
  mpesaName: string
}) {
  return axiosInstance.post<
    OtcEnvelope<{ enrollment: OtcEnrollment; alreadyEnrolled: boolean }>
  >('/api/otc/join', body)
}

export function getOtcMe() {
  return axiosInstance.get<OtcEnvelope<OtcMeResponse>>('/api/otc/me')
}

export function patchOtcMe(body: {
  mpesaNumber?: string
  mpesaName?: string
  status?: 'active' | 'paused'
}) {
  return axiosInstance.patch<OtcEnvelope<OtcEnrollment>>('/api/otc/me', body)
}

export function getOtcDeal(dealId: string) {
  return axiosInstance.get<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}`,
  )
}

export function getOtcDealBySubmission(submissionId: string) {
  return axiosInstance.get<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/by-submission/${encodeURIComponent(submissionId)}`,
  )
}

/** Planter confirms the M-Pesa arrived; `mpesaRef` is the code from their SMS. */
export function confirmOtcDeal(dealId: string, body: { mpesaRef?: string }) {
  const mpesaRef = body.mpesaRef?.trim().toUpperCase()
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/confirm`,
    mpesaRef ? { mpesaRef } : {},
  )
}

export function disputeOtcDeal(
  dealId: string,
  body: { reasonCode: OtcDisputeReasonCode; reason?: string },
) {
  const reason = body.reason?.trim()
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/dispute`,
    reason ? { reasonCode: body.reasonCode, reason } : body,
  )
}

// ----------------------------------------------------------------- buyer ---

export function getOtcSummary() {
  return axiosInstance.get<OtcEnvelope<OtcSummary>>('/api/otc/summary')
}

export function createOtcInvite(body: {
  label?: string
  ratePerTreeKes: number
  maxUses?: number | null
  expiresAt?: string | null
}) {
  return axiosInstance.post<OtcEnvelope<{ invite: OtcInvite; url: string }>>(
    '/api/otc/invites',
    body,
  )
}

export function listOtcInvites() {
  return axiosInstance.get<OtcEnvelope<{ items: OtcInvite[] }>>(
    '/api/otc/invites',
  )
}

export function patchOtcInvite(
  code: string,
  body: {
    isActive?: boolean
    ratePerTreeKes?: number
    label?: string
    maxUses?: number | null
    expiresAt?: string | null
  },
) {
  return axiosInstance.patch<OtcEnvelope<OtcInvite>>(
    `/api/otc/invites/${encodeURIComponent(code)}`,
    body,
  )
}

export function listOtcEnrollments(params?: { page?: number; limit?: number }) {
  const q = new URLSearchParams()
  if (params?.page) q.set('page', String(params.page))
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return axiosInstance.get<OtcEnvelope<OtcPaginated<OtcEnrollmentRow>>>(
    `/api/otc/enrollments${qs ? `?${qs}` : ''}`,
  )
}

export function patchOtcEnrollment(
  planterWallet: string,
  body: { ratePerTreeKes?: number; status?: 'active' | 'paused' },
) {
  return axiosInstance.patch<OtcEnvelope<OtcEnrollment>>(
    `/api/otc/enrollments/${encodeURIComponent(planterWallet)}`,
    body,
  )
}

/** The planter's mangrove submissions the buyer may add a deal for. */
export function listOtcEligibleSubmissions(planterWallet: string) {
  return axiosInstance.get<OtcEnvelope<{ items: OtcEligibleSubmission[] }>>(
    `/api/otc/enrollments/${encodeURIComponent(planterWallet)}/submissions`,
  )
}

export type OtcDealListFilters = {
  status?: OtcDealStatus | OtcDealStatus[] | string
  q?: string
  from?: string
  to?: string
  page?: number
  limit?: number
}

function dealQuery(params?: OtcDealListFilters) {
  const q = new URLSearchParams()
  if (params?.status) {
    q.set(
      'status',
      Array.isArray(params.status) ? params.status.join(',') : params.status,
    )
  }
  if (params?.q?.trim()) q.set('q', params.q.trim())
  if (params?.from) q.set('from', params.from)
  if (params?.to) q.set('to', params.to)
  if (params?.page) q.set('page', String(params.page))
  if (params?.limit) q.set('limit', String(params.limit))
  return q.toString()
}

export function listOtcDeals(params?: OtcDealListFilters) {
  const qs = dealQuery(params)
  return axiosInstance.get<OtcEnvelope<OtcPaginated<OtcDealDetail>>>(
    `/api/otc/deals${qs ? `?${qs}` : ''}`,
  )
}

/**
 * CSV export needs the JWT header, so it cannot be a plain link: fetch as a
 * blob and hand it to the browser as a download.
 */
export async function downloadOtcDealsCsv(
  params?: Omit<OtcDealListFilters, 'page' | 'limit'>,
) {
  const qs = dealQuery(params)
  const res = await axiosInstance.get<Blob>(
    `/api/otc/deals/export.csv${qs ? `?${qs}` : ''}`,
    { responseType: 'blob' },
  )
  const blob =
    res.data instanceof Blob
      ? res.data
      : new Blob([res.data as unknown as string], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `otc-deals-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function createOtcDeal(submissionId: string) {
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>('/api/otc/deals', {
    submissionId,
  })
}

export function uploadOtcPayment(
  dealId: string,
  input: {
    screenshot: File
    mpesaRef: string
    amountKes?: number
    partial?: boolean
    note?: string
  },
  onUploadProgress?: (percent: number) => void,
) {
  const form = new FormData()
  form.append('screenshot', input.screenshot)
  form.append('mpesaRef', input.mpesaRef.trim().toUpperCase())
  if (typeof input.amountKes === 'number' && Number.isFinite(input.amountKes)) {
    form.append('amountKes', String(input.amountKes))
  }
  if (input.partial) form.append('partial', 'true')
  if (input.note?.trim()) form.append('note', input.note.trim())
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/payment`,
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: evt => {
        if (!onUploadProgress || !evt.total) return
        onUploadProgress(Math.round((evt.loaded / evt.total) * 100))
      },
    },
  )
}

export function patchOtcDealCount(dealId: string, trees: number) {
  return axiosInstance.patch<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/count`,
    { trees },
  )
}

export function cancelOtcDeal(dealId: string, reason?: string) {
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/cancel`,
    { reason: reason ?? '' },
  )
}

export function resolveOtcDeal(
  dealId: string,
  body: { outcome: OtcResolutionOutcome; evidence: string },
) {
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/resolve`,
    body,
  )
}

// --------------------------------------------------------------- helpers ---

/** Reads `{ code }` from an OTC API error body (e.g. ALREADY_ENROLLED). */
export function otcErrorCode(err: unknown): string | null {
  if (!axios.isAxiosError(err)) return null
  const data = err.response?.data as { code?: unknown } | undefined
  return typeof data?.code === 'string' ? data.code : null
}

/** `KES 1,250` */
export function formatKes(amount?: number | null): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return 'KES 0'
  return `KES ${Math.round(n).toLocaleString('en-KE')}`
}

/** Per-tree rate: up to 2 decimals (`KES 12.5`); whole numbers as `KES 13`. */
export function formatKesRate(rate?: number | null): string {
  const n = Number(rate)
  if (!Number.isFinite(n)) return 'KES 0'
  if (Number.isInteger(n)) return formatKes(n)
  return `KES ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`
}

/** Deal amount vs amount the buyer actually sent (D10 partial payments). */
export function paidKes(deal: Pick<OtcDeal, 'amountKes' | 'payment'>): number {
  const sent = deal.payment?.amountKes
  return typeof sent === 'number' && Number.isFinite(sent)
    ? sent
    : deal.amountKes
}

/** Statuses from which the buyer may upload (or replace) payment proof. */
export const OTC_PAYMENT_UPLOAD_FROM: readonly OtcDealStatus[] = [
  'awaiting_payment',
  'payment_sent',
  'disputed',
]

/** Statuses from which the buyer may cancel. */
export const OTC_CANCEL_FROM: readonly OtcDealStatus[] = [
  'awaiting_count',
  'awaiting_payment',
  'payment_sent',
  'disputed',
]

/** Exported for tests / UI copy. */
export const OTC_STATUS_LABEL: Record<OtcDealStatus, string> = {
  awaiting_count: 'Count pending',
  awaiting_payment: 'To pay',
  payment_sent: 'Sent, awaiting confirmation',
  confirmed: 'Confirmed',
  disputed: 'Not received',
  cancelled: 'Cancelled',
}

export const OTC_DISPUTE_REASON_LABEL: Record<OtcDisputeReasonCode, string> = {
  nothing_arrived: 'Nothing arrived',
  wrong_amount: 'Wrong amount',
  wrong_number: 'Sent to another number',
  other: 'Something else',
}

/** Timeline labels for `deal.events[].type`. */
export const OTC_EVENT_LABEL: Record<string, string> = {
  created: 'Deal created',
  count_set_manually: 'Count set by buyer',
  count_updated: 'Count updated',
  payment_uploaded: 'Payment proof uploaded',
  confirmed: 'Planter confirmed payment',
  disputed: 'Planter reported a problem',
  cancelled: 'Deal cancelled',
  count_approved: 'Count approved by verifiers',
  approved_without_count: 'Approved, count needed',
  mgro_released: 'MGRO released to buyer',
  mgro_returned: 'MGRO returned to planter',
  resolved_release_to_buyer: 'Dispute resolved: MGRO to buyer',
  resolved_return_to_planter: 'Dispute resolved: MGRO stays with planter',
  allocation_already_paid: 'MGRO was already paid to the planter',
  planter_phone_changed: 'Planter changed their M-Pesa number',
  submission_rejected: 'Planting rejected by verifiers',
}

export function otcEventLabel(type: string): string {
  return OTC_EVENT_LABEL[type] ?? type.replace(/_/g, ' ')
}

export type OtcDealLike = Pick<OtcDeal, 'status'>
