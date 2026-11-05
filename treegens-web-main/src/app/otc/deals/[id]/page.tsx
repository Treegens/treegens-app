'use client'

import { copyText } from '@/components/otc/OtcDealRow'
import {
  OtcStatusPill,
  OtcSubmissionStatusPill,
  OtcUnfundableBadge,
} from '@/components/otc/OtcStatusPill'
import { ClaimCard } from '@/components/submission-detail/ClaimCard'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { useUser } from '@/contexts/UserProvider'
import {
  OTC_CANCEL_FROM,
  OTC_DISPUTE_REASON_LABEL,
  OTC_PAYMENT_UPLOAD_FROM,
  cancelOtcDeal,
  confirmOtcDeal,
  disputeOtcDeal,
  formatKes,
  formatKesRate,
  getOtcDeal,
  otcErrorCode,
  otcEventLabel,
  paidKes,
  patchOtcDealCount,
  resolveOtcDeal,
  uploadOtcPayment,
} from '@/services/otcService'
import { claimReward, getRewardStatus } from '@/services/rewardService'
import type { OtcDealDetail, OtcDisputeReasonCode } from '@/types/otc'
import type { RewardStatusProjection } from '@/types/reward'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { planterClaimFooterState } from '@/utils/claimUiState'
import { formatWeiToMgro } from '@/utils/formatWeiToMgro'
import { truncateAddress } from '@/utils/helpers'
import { formatPhoneForDisplay, normalizeMpesaRef } from '@/utils/mpesaPhone'
import { formatTimeAgo } from '@/utils/timeAgo'
import axios from 'axios'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  HiArrowLeft,
  HiArrowPath,
  HiCheckBadge,
  HiOutlineClipboard,
} from 'react-icons/hi2'

const DISPUTE_CODES: OtcDisputeReasonCode[] = [
  'nothing_arrived',
  'wrong_amount',
  'wrong_number',
  'other',
]

export default function OtcDealPage() {
  const params = useParams()
  const id = typeof params.id === 'string' ? params.id : ''
  const router = useRouter()
  const { user } = useUser()
  const me = user?.walletAddress?.toLowerCase() ?? ''

  const [deal, setDeal] = useState<OtcDealDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (isRefresh = false) => {
      if (!id) {
        setError('Invalid deal link')
        setLoading(false)
        return
      }
      if (isRefresh) setRefreshing(true)
      else setLoading(true)
      setError(null)
      try {
        const res = await getOtcDeal(id)
        setDeal(res.data.data)
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 403) {
          setError('This deal belongs to someone else.')
        } else if (axios.isAxiosError(err) && err.response?.status === 404) {
          setError('Deal not found.')
        } else {
          setError(apiErrorMessage(err, 'Could not load this deal.'))
        }
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [id],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const isBuyer = !!deal && !!me && deal.buyerWallet.toLowerCase() === me
  const isPlanter = !!deal && !!me && deal.planterWallet.toLowerCase() === me

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-10 flex flex-row items-center justify-between border-b border-gray-100 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md p-0.5 text-[#111] hover:bg-gray-100"
            aria-label="Back"
          >
            <HiArrowLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing || loading}
            className="rounded-md p-0.5 text-[#111] hover:bg-gray-100 disabled:opacity-40"
            aria-label="Refresh"
          >
            <HiArrowPath
              className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
        <h1 className="text-[18px] font-bold text-[#111]">M-Pesa payout</h1>
        <span className="w-10" aria-hidden />
      </header>

      <div className="flex flex-1 flex-col overflow-y-auto px-[15px] pb-24 pt-[15px]">
        {loading ? (
          <div className="mt-8 flex items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : error || !deal ? (
          <div className="mt-8 flex flex-col items-center gap-3">
            <p className="text-center text-red-700">{error ?? 'Not found'}</p>
            <button
              type="button"
              onClick={() => void load(false)}
              className="min-h-11 rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            <DealHeader deal={deal} />
            <VideoBlock deal={deal} />
            <MpesaNumberBlock deal={deal} showCopy={isBuyer} />

            {isBuyer ? (
              <BuyerActions deal={deal} me={me} onChanged={setDeal} />
            ) : null}
            {isPlanter ? (
              <PlanterActions deal={deal} onChanged={setDeal} />
            ) : null}
            {!isBuyer && !isPlanter ? (
              <p className="text-center text-sm text-gray-500">
                You are viewing this deal read-only.
              </p>
            ) : null}

            <Timeline deal={deal} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- header ---

function DealHeader({ deal }: { deal: OtcDealDetail }) {
  const source =
    deal.countSource === 'ai'
      ? 'AI count'
      : deal.countSource === 'approved'
        ? 'verifier approved'
        : deal.countSource === 'manual'
          ? 'set by buyer'
          : 'no count yet'
  return (
    <section className="rounded-2xl border border-gray-200 bg-[#faf9f6] p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <OtcStatusPill status={deal.status} />
        <OtcUnfundableBadge releaseStatus={deal.release?.status} />
        <OtcSubmissionStatusPill
          status={deal.submissionStatus ?? deal.submission?.status}
        />
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-bold text-[#111827]">
            {deal.mpesaName}
          </p>
          {deal.planter?.name && deal.planter.name !== deal.mpesaName ? (
            <p className="truncate text-xs text-gray-500">
              App name: {deal.planter.name}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-[#374151]">
            <span className="font-semibold tabular-nums">{deal.trees}</span>{' '}
            tree{deal.trees === 1 ? '' : 's'}{' '}
            <span className="text-gray-500">· {source}</span>
          </p>
          <p className="mt-0.5 inline-flex items-center gap-1 text-xs">
            {deal.verified ? (
              <span className="inline-flex items-center gap-1 text-green-700">
                <HiCheckBadge className="h-4 w-4" aria-hidden /> Verified
              </span>
            ) : deal.status !== 'cancelled' && deal.countSource === 'ai' ? (
              <span className="text-orange-800">
                AI count not yet verified by verifiers
              </span>
            ) : deal.status !== 'cancelled' && deal.countSource === 'manual' ? (
              <span className="text-orange-800">
                Count set by buyer, not verified
              </span>
            ) : null}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-black tabular-nums text-[#1a2610]">
            {formatKes(deal.amountKes)}
          </p>
          <p className="text-xs text-gray-500">
            {formatKesRate(deal.ratePerTreeKes)} / tree
          </p>
        </div>
      </div>
      {deal.countNote && deal.status === 'awaiting_count' ? (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          {deal.countNote}
        </p>
      ) : null}
      {deal.release?.status === 'unfundable' ? (
        <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          Verifiers rejected this planting. No MGRO will mint for it.
        </p>
      ) : null}
    </section>
  )
}

// ----------------------------------------------------------------- video ---

function VideoBlock({ deal }: { deal: OtcDealDetail }) {
  const s = deal.submission
  const url = s?.plant?.publicUrl || s?.plant?.rawPublicUrl || ''
  const ai = s?.aiVerification
  const conf =
    typeof ai?.confidence === 'number'
      ? Math.round(ai.confidence * (ai.confidence <= 1 ? 100 : 1))
      : null
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-3">
      {url ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={url}
          className="aspect-[9/16] max-h-[60vh] w-full rounded-xl bg-black object-contain"
        />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-gray-100 text-sm text-gray-500">
          No plant clip yet
        </div>
      )}
      <div className="mt-2 flex flex-col gap-1 text-sm text-[#374151]">
        {s?.plant?.reverseGeocode ? <p>{s.plant.reverseGeocode}</p> : null}
        {s?.plant?.uploadedAt ? (
          <p className="text-xs text-gray-500">
            Filmed {formatTimeAgo(s.plant.uploadedAt)}
          </p>
        ) : null}
        {ai ? (
          <p className="text-xs text-gray-600">
            AI:{' '}
            {ai.status === 'completed'
              ? `${ai.countedMangroves ?? '?'} mangroves${conf != null ? `, ${conf}% confidence` : ''}${ai.decision ? ` · ${ai.decision.replace(/_/g, ' ')}` : ''}`
              : ai.status === 'failed'
                ? `failed${ai.error ? ` (${ai.error})` : ''}`
                : ai.status === 'skipped'
                  ? `skipped${ai.skipReason ? ` (${ai.skipReason})` : ''}`
                  : ai.status}
          </p>
        ) : null}
        <Link
          href={`/submissions/${encodeURIComponent(deal.submissionId)}`}
          className="mt-1 inline-flex min-h-10 items-center text-sm font-semibold text-[#435F24] underline underline-offset-2"
        >
          Open submission
        </Link>
      </div>
    </section>
  )
}

// ---------------------------------------------------------- m-pesa number ---

function MpesaNumberBlock({
  deal,
  showCopy,
}: {
  deal: OtcDealDetail
  showCopy: boolean
}) {
  const changed =
    !!deal.enrollment && deal.enrollment.mpesaNumber !== deal.mpesaNumber
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6b6560]">
        M-Pesa number for this deal
      </p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <div>
          <p className="text-xl font-black tabular-nums text-[#1a2610]">
            {formatPhoneForDisplay(deal.mpesaNumber)}
          </p>
          <p className="text-sm text-[#374151]">{deal.mpesaName}</p>
        </div>
        {showCopy ? (
          <button
            type="button"
            onClick={() => void copyText(deal.mpesaNumber, 'Number copied')}
            className="inline-flex min-h-12 items-center gap-1 rounded-xl border border-[#435F24]/30 bg-[#eef6e4] px-3 text-sm font-semibold text-[#303E1A]"
          >
            <HiOutlineClipboard className="h-5 w-5" aria-hidden /> Copy
          </button>
        ) : null}
      </div>
      {changed && deal.enrollment ? (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p className="font-semibold">
            Number changed since this deal was created
          </p>
          <p className="mt-0.5">
            Current enrollment:{' '}
            <span className="font-semibold tabular-nums">
              {formatPhoneForDisplay(deal.enrollment.mpesaNumber)}
            </span>{' '}
            ({deal.enrollment.mpesaName})
          </p>
        </div>
      ) : null}
    </section>
  )
}

// --------------------------------------------------------- buyer actions ---

function BuyerActions({
  deal,
  me,
  onChanged,
}: {
  deal: OtcDealDetail
  me: string
  onChanged: (d: OtcDealDetail) => void
}) {
  const canUpload = OTC_PAYMENT_UPLOAD_FROM.includes(deal.status)
  const canCancel = OTC_CANCEL_FROM.includes(deal.status)
  const sent = paidKes(deal)
  const partial = !!deal.payment?.partial

  return (
    <>
      {deal.payment?.screenshotUrl ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6b6560]">
            Payment proof
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={deal.payment.screenshotUrl}
            alt="M-Pesa confirmation screenshot"
            className="mt-2 max-h-72 w-full rounded-xl border border-gray-200 object-contain"
          />
          <p className="mt-2 text-sm text-[#374151]">
            Code{' '}
            <span className="font-mono font-semibold">
              {deal.payment.mpesaRef}
            </span>{' '}
            · {partial ? 'Sent' : 'Amount'} {formatKes(sent)}
            {partial ? ` · Deal ${formatKes(deal.amountKes)}` : ''}
          </p>
          {deal.payment.sentAt ? (
            <p className="text-xs text-gray-500">
              Uploaded {formatTimeAgo(deal.payment.sentAt)}
            </p>
          ) : null}
          {deal.status === 'payment_sent' ? (
            <p className="mt-2 text-sm text-blue-900">
              Waiting for {deal.mpesaName} to confirm. They were asked to check
              their M-Pesa SMS.
            </p>
          ) : null}
        </section>
      ) : null}

      {deal.status === 'disputed' ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-900">
            {deal.mpesaName} says the payment did not arrive
          </p>
          {deal.disputeReason ? (
            <p className="mt-1 text-sm text-red-900">
              Reason: {deal.disputeReason}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-red-900/80">
            You can re-upload proof below, resolve with evidence, or cancel the
            deal.
          </p>
        </section>
      ) : null}

      {canUpload ? (
        <PaymentUploadForm deal={deal} onChanged={onChanged} />
      ) : null}
      {deal.status === 'awaiting_count' ? (
        <SetCountForm deal={deal} onChanged={onChanged} />
      ) : null}
      {deal.status === 'disputed' ? (
        <ResolveForm deal={deal} onChanged={onChanged} />
      ) : null}
      {canCancel ? <CancelDeal deal={deal} onChanged={onChanged} /> : null}

      {deal.allocation?.exists &&
      !deal.allocation.hold &&
      deal.allocation.planterWallet?.toLowerCase() === me ? (
        <BuyerMgroCard deal={deal} />
      ) : deal.status === 'confirmed' &&
        deal.release?.status !== 'unfundable' ? (
        <section className="rounded-2xl border border-gray-200 bg-[#faf9f6] p-4 text-sm text-[#374151]">
          {deal.allocation?.exists
            ? 'MGRO is being moved to your wallet. Refresh in a moment.'
            : 'MGRO will be released to your wallet once verifiers approve the planting.'}
        </section>
      ) : null}
    </>
  )
}

function PaymentUploadForm({
  deal,
  onChanged,
}: {
  deal: OtcDealDetail
  onChanged: (d: OtcDealDetail) => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [ref, setRef] = useState('')
  const [amount, setAmount] = useState(String(deal.amountKes))
  const [partial, setPartial] = useState(false)
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(deal.status !== 'payment_sent')

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const amountNum = Number(amount)
  const amountOk = Number.isFinite(amountNum) && amountNum > 0
  const differs = amountOk && Math.round(amountNum) !== deal.amountKes
  const refOk = !!normalizeMpesaRef(ref)
  const canSubmit =
    !!file && refOk && amountOk && (!differs || partial) && !busy

  const submit = async () => {
    if (!file) {
      toast.error('Choose the M-Pesa screenshot first')
      return
    }
    const normalizedRef = normalizeMpesaRef(ref)
    if (!normalizedRef) {
      toast.error('The M-Pesa code is 10 letters/digits, e.g. QGH7X2K9LM')
      return
    }
    if (!amountOk) {
      toast.error('Enter the amount you sent')
      return
    }
    if (differs && !partial) {
      toast.error(
        `The amount differs from the deal (${formatKes(deal.amountKes)}). Tick "partial payment" to continue.`,
      )
      return
    }
    setBusy(true)
    setProgress(0)
    try {
      const res = await uploadOtcPayment(
        deal._id,
        {
          screenshot: file,
          mpesaRef: normalizedRef,
          amountKes: Math.round(amountNum),
          partial: differs && partial,
          note,
        },
        setProgress,
      )
      onChanged(res.data.data)
      toast.success(`${deal.mpesaName} has been asked to confirm`)
      setFile(null)
      setRef('')
      setNote('')
      setPartial(false)
      setOpen(false)
      if (fileRef.current) fileRef.current.value = ''
    } catch (err) {
      const code = otcErrorCode(err)
      if (code === 'PARTIAL_FLAG_REQUIRED') {
        toast.error(
          'Tick "This is a partial payment" to send a different amount.',
        )
      } else if (code === 'INVALID_IMAGE') {
        toast.error(
          'That file is not a photo. Upload a PNG or JPEG screenshot.',
        )
      } else if (code === 'INVALID_MPESA_REF') {
        toast.error('The M-Pesa code must be 10 letters/digits.')
      } else if (code === 'INVALID_TRANSITION') {
        toast.error('This deal changed. Refresh and try again.')
      } else {
        toast.error(apiErrorMessage(err, 'Upload failed. Try again.'))
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-12 w-full rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
      >
        Replace payment proof
      </button>
    )
  }

  return (
    <section className="rounded-2xl border border-[#435F24]/20 bg-[#eef6e4] p-4">
      <p className="text-base font-bold text-[#1a2610]">
        {deal.payment
          ? 'Replace M-Pesa screenshot'
          : 'Upload M-Pesa screenshot'}
      </p>
      <p className="mt-1 text-xs text-[#5c534a]">
        Send {formatKes(deal.amountKes)} to{' '}
        <span className="font-semibold tabular-nums">
          {formatPhoneForDisplay(deal.mpesaNumber)}
        </span>{' '}
        ({deal.mpesaName}) in M-Pesa first, then upload the confirmation.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-[#5c534a]">
            Screenshot
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
            className="block w-full rounded-xl border border-gray-300 bg-white text-sm text-gray-900 file:mr-3 file:min-h-12 file:rounded-l-xl file:border-0 file:bg-[#435F24] file:px-4 file:text-sm file:font-semibold file:text-white"
          />
          <span className="text-xs text-amber-900">
            Crop out your M-Pesa balance before uploading.
          </span>
        </label>
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Selected screenshot"
            className="max-h-56 w-full rounded-xl border border-gray-200 bg-white object-contain"
          />
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-[#5c534a]">
            M-Pesa transaction code
          </span>
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={10}
            placeholder="e.g. QGH7X2K9LM"
            value={ref}
            onChange={e => setRef(e.target.value.toUpperCase())}
            className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 font-mono text-base uppercase tracking-widest text-gray-900 focus:border-[#435F24] focus:outline-none"
          />
          {ref && !refOk ? (
            <span className="text-xs text-red-600">
              10 letters and digits, as in the M-Pesa message.
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-[#5c534a]">
            Amount sent (KES)
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base tabular-nums text-gray-900 focus:border-[#435F24] focus:outline-none"
          />
        </label>
        {differs ? (
          <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
            <input
              type="checkbox"
              checked={partial}
              onChange={e => setPartial(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[#435F24]"
            />
            <span className="text-sm text-amber-950">
              This is a partial payment. The deal is {formatKes(deal.amountKes)}
              ; I sent {formatKes(amountNum)}. The planter will be asked to
              confirm {formatKes(amountNum)}.
            </span>
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-[#5c534a]">
            Note (optional)
          </span>
          <input
            type="text"
            maxLength={300}
            value={note}
            onChange={e => setNote(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
          />
        </label>
        {progress != null ? (
          <div className="h-2 w-full overflow-hidden rounded-full bg-white">
            <div
              className="h-full bg-[#435F24] transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
        <div className="flex gap-2">
          {deal.payment ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="min-h-12 flex-1 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="tg-cta min-h-12 flex-1 px-4 text-sm disabled:opacity-60"
          >
            {busy ? 'Uploading…' : 'Send to planter to confirm'}
          </button>
        </div>
      </div>
    </section>
  )
}

function SetCountForm({
  deal,
  onChanged,
}: {
  deal: OtcDealDetail
  onChanged: (d: OtcDealDetail) => void
}) {
  const [trees, setTrees] = useState(deal.trees > 0 ? String(deal.trees) : '')
  const [busy, setBusy] = useState(false)
  const n = Number(trees)
  const ok = Number.isInteger(n) && n > 0

  const submit = async () => {
    if (!ok) {
      toast.error('Enter a whole number of trees')
      return
    }
    setBusy(true)
    try {
      const res = await patchOtcDealCount(deal._id, n)
      onChanged(res.data.data)
      toast.success(
        res.data.data.status === 'awaiting_payment'
          ? `Count set. Pay ${formatKes(res.data.data.amountKes)}.`
          : 'Count saved. Not payable yet.',
      )
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not set the count.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-base font-bold text-[#1a2610]">Set the tree count</p>
      <p className="mt-1 text-xs text-[#5c534a]">
        Use this when AI could not count the clip or the count must be
        corrected. The KES amount is recomputed at{' '}
        {formatKesRate(deal.ratePerTreeKes)} per tree.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          placeholder="Trees"
          value={trees}
          onChange={e => setTrees(e.target.value)}
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 text-base tabular-nums text-gray-900 focus:border-[#435F24] focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!ok || busy}
          className="min-h-12 shrink-0 rounded-2xl bg-[#435F24] px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Set count'}
        </button>
      </div>
      {ok ? (
        <p className="mt-2 text-xs text-[#5c534a]">
          = {formatKes(n * deal.ratePerTreeKes)}
        </p>
      ) : null}
    </section>
  )
}

function ResolveForm({
  deal,
  onChanged,
}: {
  deal: OtcDealDetail
  onChanged: (d: OtcDealDetail) => void
}) {
  const [evidence, setEvidence] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ok = evidence.trim().length >= 10

  const submit = async () => {
    setBusy(true)
    try {
      const res = await resolveOtcDeal(deal._id, {
        outcome: 'release_to_buyer',
        evidence: evidence.trim(),
      })
      onChanged(res.data.data)
      setConfirmOpen(false)
      toast.success('Resolved. MGRO is being released to you.')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not resolve the dispute.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-base font-bold text-[#1a2610]">
        Resolve: release MGRO to me
      </p>
      <p className="mt-1 text-xs text-[#5c534a]">
        Only when you have proof the money arrived (for example the M-Pesa
        statement). Your note is recorded on the deal and the planter is told.
      </p>
      <textarea
        value={evidence}
        onChange={e => setEvidence(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="Evidence, e.g. M-Pesa statement shows QGH7X2K9LM completed to 0712 345 678 on 3 Nov"
        className="mt-3 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
      />
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={!ok || busy}
        className="mt-2 min-h-12 w-full rounded-2xl bg-[#435F24] px-4 text-sm font-semibold text-white disabled:opacity-60"
      >
        Release MGRO to me
      </button>
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Release MGRO?"
      >
        <p className="text-sm text-gray-700">
          The planter reported they did not receive {formatKes(paidKes(deal))}.
          Releasing the MGRO to you overrides that. This is logged with your
          evidence note.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setConfirmOpen(false)}
            disabled={busy}
            className="min-h-12 flex-1 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="min-h-12 flex-1 rounded-2xl bg-[#435F24] px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Resolving…' : 'Yes, release'}
          </button>
        </div>
      </Modal>
    </section>
  )
}

function CancelDeal({
  deal,
  onChanged,
}: {
  deal: OtcDealDetail
  onChanged: (d: OtcDealDetail) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const reasonRequired =
    deal.status === 'payment_sent' || deal.status === 'disputed'
  const ok = !reasonRequired || reason.trim().length >= 3

  const submit = async () => {
    setBusy(true)
    try {
      const res = await cancelOtcDeal(deal._id, reason.trim() || undefined)
      onChanged(res.data.data)
      setOpen(false)
      toast.success('Deal cancelled. MGRO returns to the planter.')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not cancel the deal.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-12 w-full rounded-2xl border border-red-300 bg-white px-4 text-sm font-semibold text-red-700"
      >
        Cancel deal
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel this deal?"
      >
        <p className="text-sm text-gray-700">
          The planter keeps their MGRO for this planting and will be able to
          claim it as usual.
        </p>
        {deal.payment ? (
          <p className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            You already uploaded proof of {formatKes(paidKes(deal))}. Cancelling
            returns the MGRO to the planter and does not refund the M-Pesa.
          </p>
        ) : null}
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-xs font-semibold text-gray-600">
            Reason{reasonRequired ? ' (required)' : ' (optional)'}
          </span>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            maxLength={300}
            className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
          />
        </label>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="min-h-12 flex-1 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
          >
            Keep deal
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!ok || busy}
            className="min-h-12 flex-1 rounded-2xl bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Cancelling…' : 'Cancel deal'}
          </button>
        </div>
      </Modal>
    </>
  )
}

function BuyerMgroCard({ deal }: { deal: OtcDealDetail }) {
  const [status, setStatus] = useState<RewardStatusProjection | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const rs = await getRewardStatus(deal.submissionId)
      setStatus(rs.data.data)
      setLoadErr(null)
    } catch (err) {
      if (
        axios.isAxiosError(err) &&
        (err.response?.status === 404 || err.response?.status === 403)
      ) {
        setStatus(null)
        setLoadErr(null)
      } else {
        setLoadErr(apiErrorMessage(err, 'Could not load MGRO status.'))
      }
    }
  }, [deal.submissionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!status?.activeClaimJob) return
    const t = setInterval(() => void refresh(), 4000)
    return () => clearInterval(t)
  }, [status?.activeClaimJob, refresh])

  const footer = useMemo(
    () => planterClaimFooterState(status, !!status?.canClaim && !claiming),
    [status, claiming],
  )
  const claimed = formatWeiToMgro(status?.claimedAmountWei)
  const pending = formatWeiToMgro(status?.pendingClaimAmountWei)
  const total = formatWeiToMgro(
    status?.totalRewardWei ?? deal.allocation?.planterTotalWei,
  )

  const onClaim = async () => {
    if (claiming) return
    setClaiming(true)
    try {
      await claimReward(deal.submissionId)
      toast.success('Claim queued for processing')
      await refresh()
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to claim MGRO'))
    } finally {
      setClaiming(false)
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6b6560]">
        Your MGRO for this planting
      </p>
      <p className="mt-1 text-sm text-[#374151]">
        {deal.releaseMode === 'vesting'
          ? `${total.toLocaleString()} MGRO vests over the normal schedule; health-check videos are required from checkpoint 2 and you may film them.`
          : `${total.toLocaleString()} MGRO is released in one go (full release). You carry the survival risk you accepted by paying up front.`}
      </p>
      {loadErr ? <p className="mt-2 text-sm text-red-700">{loadErr}</p> : null}
      {status ? (
        <div className="mt-3">
          <ClaimCard
            variant={footer.variant}
            claimed={claimed}
            detailLabel="Ready to claim"
            detailValue={`${pending.toLocaleString()} MGRO`}
            buttonLabel={claiming ? 'Claiming…' : 'Claim MGRO'}
            onClaim={onClaim}
          />
        </div>
      ) : !loadErr ? (
        <p className="mt-2 text-xs text-gray-500">
          MGRO status not available yet (the planting may still be in review).
        </p>
      ) : null}
    </section>
  )
}

// ------------------------------------------------------- planter actions ---

function PlanterActions({
  deal,
  onChanged,
}: {
  deal: OtcDealDetail
  onChanged: (d: OtcDealDetail) => void
}) {
  const router = useRouter()
  // D9: planters see the buyer display name, never the desk invite label.
  const buyerLabel = deal.buyerLabel || 'TreeGens'
  const sent = paidKes(deal)
  const partial = !!deal.payment?.partial && sent !== deal.amountKes
  const requiresRef = deal.confirmRequiresRef !== false
  // The API masks the code for planters; they type it from their own SMS.
  const refHint =
    deal.payment?.mpesaRefHint || deal.payment?.mpesaRef?.slice(-2) || ''

  const [ref, setRef] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [reasonCode, setReasonCode] = useState<OtcDisputeReasonCode | null>(
    null,
  )
  const [reasonText, setReasonText] = useState('')

  const refOk = !requiresRef || !!normalizeMpesaRef(ref)

  const confirm = async () => {
    setBusy(true)
    try {
      const res = await confirmOtcDeal(deal._id, {
        mpesaRef: requiresRef ? ref : undefined,
      })
      onChanged(res.data.data)
      setConfirmOpen(false)
      toast.success('Thank you. Payment confirmed.')
    } catch (err) {
      const code = otcErrorCode(err)
      if (code === 'MPESA_REF_MISMATCH') {
        setConfirmOpen(false)
        toast.error(
          'The code does not match the payment. Check your M-Pesa SMS.',
        )
      } else if (code === 'INVALID_TRANSITION') {
        toast.error('This deal changed. Refresh and try again.')
      } else {
        toast.error(apiErrorMessage(err, 'Could not confirm. Try again.'))
      }
    } finally {
      setBusy(false)
    }
  }

  const dispute = async () => {
    if (!reasonCode) {
      toast.error('Pick a reason')
      return
    }
    if (reasonCode === 'other' && reasonText.trim().length < 3) {
      toast.error('Tell us what happened')
      return
    }
    setBusy(true)
    try {
      const res = await disputeOtcDeal(deal._id, {
        reasonCode,
        reason: reasonText.trim() || undefined,
      })
      onChanged(res.data.data)
      setDisputeOpen(false)
      toast.success(`${buyerLabel} has been told`)
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not send. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  if (deal.status === 'payment_sent') {
    return (
      <>
        <section className="rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-lg font-black text-blue-950">
            Did you receive {formatKes(sent)}?
          </p>
          {partial ? (
            <p className="mt-0.5 text-sm text-blue-900">
              Deal: {formatKes(deal.amountKes)} · Sent: {formatKes(sent)}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-blue-900">
            {buyerLabel} says it was sent to{' '}
            <span className="font-semibold tabular-nums">
              {formatPhoneForDisplay(deal.mpesaNumber)}
            </span>
            {refHint ? (
              <>
                {' '}
                with an M-Pesa code ending in{' '}
                <span className="font-mono font-semibold">..{refHint}</span>
              </>
            ) : null}
            . Check your M-Pesa SMS.
          </p>
          {deal.payment?.screenshotUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={deal.payment.screenshotUrl}
              alt="M-Pesa confirmation screenshot from the buyer"
              className="mt-3 max-h-96 w-full rounded-xl border border-blue-200 bg-white object-contain"
            />
          ) : null}
          {deal.payment?.note ? (
            <p className="mt-2 text-sm text-blue-900">
              Note from {buyerLabel}: {deal.payment.note}
            </p>
          ) : null}

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-xs font-semibold text-blue-950">
              M-Pesa code from your SMS{requiresRef ? '' : ' (optional)'}
            </span>
            <input
              type="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={10}
              placeholder="e.g. QGH7X2K9LM"
              value={ref}
              onChange={e => setRef(e.target.value.toUpperCase())}
              className="min-h-12 w-full rounded-xl border border-blue-200 bg-white px-3 font-mono text-base uppercase tracking-widest text-gray-900 focus:border-[#435F24] focus:outline-none"
            />
            <span className="text-xs text-blue-900/80">
              The code is in the M-Pesa message, e.g. &quot;QGH7X2K9LM
              Confirmed. You have received…&quot;
            </span>
          </label>

          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!refOk || busy}
            className="tg-cta mt-3 flex min-h-14 w-full items-center justify-center px-4 text-base disabled:opacity-60"
          >
            Yes, I received it
          </button>
          <button
            type="button"
            onClick={() => {
              toast('We will remind you to confirm later.')
              router.back()
            }}
            className="mt-2 flex min-h-12 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
          >
            Not yet, I&apos;ll check my M-Pesa
          </button>
          <button
            type="button"
            onClick={() => setDisputeOpen(v => !v)}
            className="mt-2 flex min-h-11 w-full items-center justify-center text-sm font-semibold text-red-700 underline underline-offset-2"
          >
            I did not receive it
          </button>

          {disputeOpen ? (
            <div className="mt-2 rounded-xl border border-red-200 bg-white p-3">
              <p className="text-sm font-semibold text-red-900">
                What happened?
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {DISPUTE_CODES.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setReasonCode(c)}
                    className={
                      reasonCode === c
                        ? 'min-h-11 rounded-full bg-red-600 px-4 text-sm font-semibold text-white'
                        : 'min-h-11 rounded-full border border-red-300 bg-white px-4 text-sm font-semibold text-red-800'
                    }
                  >
                    {OTC_DISPUTE_REASON_LABEL[c]}
                  </button>
                ))}
              </div>
              {reasonCode === 'other' || reasonCode === 'wrong_amount' ? (
                <textarea
                  value={reasonText}
                  onChange={e => setReasonText(e.target.value)}
                  rows={2}
                  maxLength={300}
                  placeholder={
                    reasonCode === 'wrong_amount'
                      ? 'How much did you receive?'
                      : 'Tell us what happened'
                  }
                  className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
                />
              ) : null}
              <button
                type="button"
                onClick={() => void dispute()}
                disabled={!reasonCode || busy}
                className="mt-3 min-h-12 w-full rounded-2xl bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? 'Sending…' : `Tell ${buyerLabel}`}
              </button>
            </div>
          ) : null}
        </section>

        <Modal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Confirm payment?"
        >
          <p className="text-sm text-gray-700">
            You confirm that {formatKes(sent)} arrived on your M-Pesa
            {requiresRef ? (
              <>
                {' '}
                with code <span className="font-mono font-semibold">{ref}</span>
              </>
            ) : null}
            . The MGRO for this planting then goes to {buyerLabel}. This cannot
            be undone.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
              className="min-h-12 flex-1 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className="tg-cta min-h-12 flex-1 px-4 text-sm disabled:opacity-60"
            >
              {busy ? 'Confirming…' : 'Yes, I received it'}
            </button>
          </div>
        </Modal>
      </>
    )
  }

  let text: string
  let cls = 'border-gray-200 bg-[#faf9f6] text-[#374151]'
  switch (deal.status) {
    case 'awaiting_payment':
      text = `Waiting for ${buyerLabel} to send ${formatKes(deal.amountKes)} to ${formatPhoneForDisplay(deal.mpesaNumber)}. You will get a notification.`
      cls = 'border-amber-200 bg-amber-50 text-amber-950'
      break
    case 'awaiting_count':
      text =
        deal.countNote ||
        'Waiting for the tree count before this planting can be paid.'
      break
    case 'confirmed':
      text = `Confirmed. The MGRO for this planting goes to ${buyerLabel}.`
      cls = 'border-green-200 bg-green-50 text-green-900'
      break
    case 'disputed':
      text = `You reported that the payment did not arrive. ${buyerLabel} will re-upload proof, resolve it, or cancel the deal.`
      cls = 'border-red-200 bg-red-50 text-red-900'
      break
    case 'cancelled':
      text =
        'Cancelled. Your MGRO for this planting will be paid to you as usual.'
      break
    default:
      text = ''
  }

  return (
    <section className={`rounded-2xl border p-4 text-sm ${cls}`}>
      <p>{text}</p>
      {deal.status === 'cancelled' && deal.cancelReason ? (
        <p className="mt-1 text-xs opacity-80">Reason: {deal.cancelReason}</p>
      ) : null}
      {deal.status === 'cancelled' ? (
        <Link
          href={`/submissions/${encodeURIComponent(deal.submissionId)}`}
          className="mt-2 inline-flex min-h-10 items-center text-sm font-semibold text-[#435F24] underline underline-offset-2"
        >
          Open submission to claim MGRO
        </Link>
      ) : null}
    </section>
  )
}

// -------------------------------------------------------------- timeline ---

function Timeline({ deal }: { deal: OtcDealDetail }) {
  const events = [...(deal.events ?? [])].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  )
  if (!events.length) return null
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6b6560]">
        History
      </p>
      <ol className="mt-2 flex flex-col gap-2">
        {events.map((e, i) => (
          <li key={`${e.type}-${e.at}-${i}`} className="flex gap-3">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#435F24]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#111827]">
                {otcEventLabel(e.type)}
              </p>
              {e.note ? (
                <p className="text-sm text-[#4b5563]">{e.note}</p>
              ) : null}
              <p className="text-xs text-gray-500">
                {formatTimeAgo(e.at)}
                {e.by && e.by !== 'system' && e.by.startsWith('0x')
                  ? ` · ${truncateAddress(e.by)}`
                  : e.by === 'system'
                    ? ' · system'
                    : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {deal.resolution ? (
        <p className="mt-3 rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700">
          Resolution ({deal.resolution.outcome.replace(/_/g, ' ')}):{' '}
          {deal.resolution.evidence}
        </p>
      ) : null}
    </section>
  )
}
