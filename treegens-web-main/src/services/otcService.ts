import type {
  OtcDeal,
  OtcDealDetail,
  OtcDealStatus,
  OtcEnrollment,
  OtcEnrollmentRow,
  OtcEnvelope,
  OtcInvite,
  OtcInvitePreview,
  OtcMeResponse,
  OtcPaginated,
  OtcSummary,
} from '@/types/otc'
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

export function patchOtcMe(body: { mpesaNumber?: string; mpesaName?: string }) {
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

export function confirmOtcDeal(dealId: string) {
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/confirm`,
    {},
  )
}

export function disputeOtcDeal(dealId: string, reason: string) {
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/dispute`,
    { reason },
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

export function listOtcDeals(params?: {
  status?: OtcDealStatus | OtcDealStatus[] | string
  page?: number
  limit?: number
}) {
  const q = new URLSearchParams()
  if (params?.status) {
    q.set(
      'status',
      Array.isArray(params.status) ? params.status.join(',') : params.status,
    )
  }
  if (params?.page) q.set('page', String(params.page))
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return axiosInstance.get<OtcEnvelope<OtcPaginated<OtcDealDetail>>>(
    `/api/otc/deals${qs ? `?${qs}` : ''}`,
  )
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
    mpesaRef?: string
    amountKes?: number
    note?: string
  },
  onUploadProgress?: (percent: number) => void,
) {
  const form = new FormData()
  form.append('screenshot', input.screenshot)
  if (input.mpesaRef) form.append('mpesaRef', input.mpesaRef)
  if (typeof input.amountKes === 'number' && Number.isFinite(input.amountKes)) {
    form.append('amountKes', String(input.amountKes))
  }
  if (input.note) form.append('note', input.note)
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

export function cancelOtcDeal(dealId: string, reason?: string) {
  return axiosInstance.post<OtcEnvelope<OtcDealDetail>>(
    `/api/otc/deals/${encodeURIComponent(dealId)}/cancel`,
    { reason: reason ?? '' },
  )
}

/** Exported for tests / UI copy. */
export const OTC_STATUS_LABEL: Record<OtcDealStatus, string> = {
  awaiting_count: 'Count pending',
  awaiting_payment: 'To pay',
  payment_sent: 'Sent, awaiting confirmation',
  confirmed: 'Confirmed',
  disputed: 'Not received',
  cancelled: 'Cancelled',
}

export type OtcDealLike = Pick<OtcDeal, 'status'>
