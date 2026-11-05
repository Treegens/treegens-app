'use client'

import { PhoneSignInForm } from '@/components/auth/PhoneSignInForm'
import { Spinner } from '@/components/ui/Spinner'
import { routes } from '@/config/appConfig'
import { useAuth } from '@/contexts/AuthProvider'
import { useUser } from '@/contexts/UserProvider'
import {
  formatKes,
  joinOtc,
  otcErrorCode,
  previewOtcInvite,
} from '@/services/otcService'
import type { OtcInvitePreview } from '@/types/otc'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { formatPhoneForDisplay, normalizeKenyanPhone } from '@/utils/mpesaPhone'
import {
  clearPostAuthRedirect,
  setPostAuthRedirect,
} from '@/utils/postAuthRedirect'
import axios from 'axios'
import Image from 'next/image'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  HiCheckCircle,
  HiDevicePhoneMobile,
  HiOutlineBanknotes,
  HiOutlineVideoCamera,
} from 'react-icons/hi2'

type JoinOutcome = { alreadyEnrolled: boolean } | null

const UNAVAILABLE_REASON: Record<string, string> = {
  inactive: 'This invite link has been switched off by the buyer.',
  expired: 'This invite link has expired.',
  exhausted: 'This invite link has been used the maximum number of times.',
}

export default function OtcJoinPage() {
  const params = useParams()
  const code = typeof params.code === 'string' ? params.code : ''
  const pathname = usePathname()
  const router = useRouter()
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const { user } = useUser()

  const [preview, setPreview] = useState<OtcInvitePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null)
  const [mpesaNumber, setMpesaNumber] = useState('')
  const [mpesaName, setMpesaName] = useState('')
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<JoinOutcome>(null)
  const [alreadyWithOther, setAlreadyWithOther] = useState(false)

  const buyerLabel = preview?.buyerLabel || 'the buyer'
  const releaseMode = preview?.releaseMode ?? 'full'

  // Remember the invite for after sign-in (survives a magic link opening a
  // new tab: localStorage + 1h TTL). Cleared once we are signed in here.
  useEffect(() => {
    if (!pathname) return
    if (authLoading) return
    if (isAuthenticated) clearPostAuthRedirect()
    else setPostAuthRedirect(pathname)
  }, [pathname, isAuthenticated, authLoading])

  const loadPreview = useCallback(async () => {
    if (!code) {
      setPreviewError('This invite link is missing its code.')
      setLoading(false)
      return
    }
    setLoading(true)
    setPreviewError(null)
    try {
      const res = await previewOtcInvite(code)
      setPreview(res.data.data)
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setPreviewError(
          'This invite link is not valid. Ask the buyer for a new one.',
        )
      } else {
        setPreviewError(apiErrorMessage(err, 'Could not load this invite.'))
      }
    } finally {
      setLoading(false)
    }
  }, [code])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  // Prefill: verified phone from SMS sign-in first, then the profile phone.
  useEffect(() => {
    if (mpesaNumber) return
    if (verifiedPhone) {
      setMpesaNumber(formatPhoneForDisplay(verifiedPhone))
    } else if (user?.phone != null && String(user.phone).trim()) {
      const normalized = normalizeKenyanPhone(String(user.phone))
      if (normalized) setMpesaNumber(formatPhoneForDisplay(normalized))
    }
  }, [verifiedPhone, user?.phone, mpesaNumber])

  useEffect(() => {
    if (!mpesaName && user?.name?.trim()) setMpesaName(user.name.trim())
  }, [user?.name, mpesaName])

  const normalizedPhone = useMemo(
    () => normalizeKenyanPhone(mpesaNumber),
    [mpesaNumber],
  )

  const goToEmailSignIn = () => {
    if (pathname) setPostAuthRedirect(pathname)
    router.push(
      `${routes.Login}?next=${encodeURIComponent(pathname || routes.OtcMe)}`,
    )
  }

  const canSubmit =
    !!normalizedPhone && mpesaName.trim().length >= 2 && consent && !submitting

  const handleJoin = async () => {
    if (!normalizedPhone) {
      toast.error('Enter a valid M-Pesa number, e.g. 0712 345 678')
      return
    }
    if (mpesaName.trim().length < 2) {
      toast.error('Enter the name shown on your M-Pesa')
      return
    }
    if (!consent) {
      toast.error('Please tick the agreement box')
      return
    }
    setSubmitting(true)
    try {
      const res = await joinOtc({
        code,
        mpesaNumber: normalizedPhone,
        mpesaName: mpesaName.trim(),
      })
      setOutcome({ alreadyEnrolled: !!res.data.data.alreadyEnrolled })
      clearPostAuthRedirect()
      toast.success(
        res.data.data.alreadyEnrolled ? 'Details updated' : 'You are in',
      )
    } catch (err) {
      const errCode = otcErrorCode(err)
      if (errCode === 'ALREADY_ENROLLED') {
        setAlreadyWithOther(true)
        return
      }
      if (errCode === 'INVITE_UNAVAILABLE') {
        toast.error('This invite is no longer available.')
        void loadPreview()
        return
      }
      if (errCode === 'INVALID_PHONE') {
        toast.error('That M-Pesa number is not valid.')
        return
      }
      toast.error(apiErrorMessage(err, 'Could not join. Try again.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col px-4 pb-16 pt-4">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div className="flex items-center gap-3 px-1">
          <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-2xl border border-white/50 bg-white/90 shadow-md ring-2 ring-white/40">
            <Image
              src="/img/treegens-logo.svg"
              alt=""
              fill
              className="object-contain p-1.5"
              sizes="44px"
              priority
            />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xl font-black tracking-tight text-[#1a2610]">
              TreeGens
            </p>
            <p className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-[#6b6560]">
              M-Pesa payouts
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : previewError || !preview ? (
          <section className="tg-card p-5">
            <p className="text-base font-bold text-[#1a2610]">
              Invite not available
            </p>
            <p className="mt-2 text-sm text-[#374151]">
              {previewError ?? 'Could not load this invite.'}
            </p>
            <Link
              href={routes.Home}
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
            >
              Go to the app
            </Link>
          </section>
        ) : (
          <>
            <section className="tg-card p-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#435F24]">
                You&apos;re invited
              </p>
              <h1 className="mt-1 text-2xl font-black leading-tight text-[#0f160c]">
                TreeGens M-Pesa payouts
              </h1>
              {preview.label ? (
                <p className="mt-1 text-sm font-semibold text-[#5c534a]">
                  {preview.label}
                </p>
              ) : null}
              <p className="mt-3 text-3xl font-black tabular-nums text-[#1a2610]">
                {formatKes(preview.ratePerTreeKes)}
                <span className="ml-1 text-sm font-semibold text-[#5c534a]">
                  per counted tree
                </span>
              </p>

              <ol className="mt-4 flex flex-col gap-3">
                <Step
                  icon={<HiOutlineVideoCamera className="h-5 w-5" />}
                  title="Film your planting"
                  text="Record the land and the planted mangroves in the app, as usual. AI counts the trees."
                />
                <Step
                  icon={<HiOutlineBanknotes className="h-5 w-5" />}
                  title={`${buyerLabel} pays you by M-Pesa`}
                  text="You get a notification with the amount as soon as the money is sent."
                />
                <Step
                  icon={<HiDevicePhoneMobile className="h-5 w-5" />}
                  title="Confirm with the M-Pesa code"
                  text="Type the code from your M-Pesa SMS to confirm you received it."
                />
              </ol>

              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
                <p className="text-sm text-amber-950">
                  You get cash instead of MGRO tokens for these plantings. The
                  MGRO goes to {buyerLabel}.
                </p>
              </div>

              {!preview.acceptable ? (
                <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
                  <p className="text-sm font-semibold text-red-800">
                    This invite cannot be used right now
                  </p>
                  <p className="mt-1 text-sm text-red-800">
                    {UNAVAILABLE_REASON[preview.reason ?? ''] ??
                      'Ask the buyer for a new link.'}
                  </p>
                </div>
              ) : null}
            </section>

            {!preview.acceptable ? null : outcome ? (
              <section className="tg-card p-5 text-center">
                <HiCheckCircle className="mx-auto h-12 w-12 text-tree-green-2" />
                <p className="mt-2 text-xl font-black text-[#1a2610]">
                  {outcome.alreadyEnrolled ? 'You’re already in' : 'You’re in'}
                </p>
                <p className="mt-1 text-sm text-[#374151]">
                  {outcome.alreadyEnrolled
                    ? 'Details updated.'
                    : `Film your planting and ${buyerLabel} will pay you by M-Pesa once the trees are counted.`}
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <Link
                    href={routes.NewPlant}
                    className="tg-cta flex min-h-12 items-center justify-center px-4 text-sm"
                  >
                    Start planting
                  </Link>
                  <Link
                    href={routes.OtcMe}
                    className="flex min-h-12 items-center justify-center rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
                  >
                    View my payouts
                  </Link>
                </div>
              </section>
            ) : alreadyWithOther ? (
              <section className="tg-card p-5">
                <p className="text-base font-bold text-[#1a2610]">
                  You already have an M-Pesa buyer
                </p>
                <p className="mt-2 text-sm text-[#374151]">
                  Your account is enrolled with another buyer, so this invite
                  cannot be used. You can see your enrollment and payouts on
                  your payouts page.
                </p>
                <Link
                  href={routes.OtcMe}
                  className="tg-cta mt-4 flex min-h-12 items-center justify-center px-4 text-sm"
                >
                  View my payouts
                </Link>
              </section>
            ) : authLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size="md" />
              </div>
            ) : !isAuthenticated ? (
              <section className="flex flex-col gap-3">
                <PhoneSignInForm
                  tone="light"
                  onSignedIn={phone => setVerifiedPhone(phone)}
                  fallback={
                    <button
                      type="button"
                      onClick={goToEmailSignIn}
                      className="min-h-10 w-full rounded-xl border border-red-300 bg-white px-3 text-sm font-semibold text-red-800"
                    >
                      Use email instead
                    </button>
                  }
                />
                <button
                  type="button"
                  onClick={goToEmailSignIn}
                  className="flex min-h-12 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
                >
                  Use email instead
                </button>
                <p className="px-2 text-center text-xs text-[#6b6560]">
                  Signing in creates your TreeGens account. Your M-Pesa number
                  is only shown to {buyerLabel}.
                </p>
              </section>
            ) : (
              <section className="tg-card p-5">
                <p className="text-base font-bold text-[#1a2610]">
                  Where should {buyerLabel} send the money?
                </p>
                <div className="mt-4 flex flex-col gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-[#5c534a]">
                      M-Pesa number
                    </span>
                    <input
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="07XX XXX XXX"
                      value={mpesaNumber}
                      onChange={e => setMpesaNumber(e.target.value)}
                      className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#435F24] focus:outline-none"
                    />
                    {mpesaNumber.trim() && !normalizedPhone ? (
                      <span className="text-xs text-red-600">
                        Use 07XX XXX XXX or +2547XX XXX XXX.
                      </span>
                    ) : normalizedPhone ? (
                      <span className="text-xs text-[#6b6560]">
                        Will be saved as {normalizedPhone}
                        {verifiedPhone && normalizedPhone === verifiedPhone
                          ? ' (verified by SMS)'
                          : ''}
                      </span>
                    ) : null}
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-[#5c534a]">
                      Name on M-Pesa
                    </span>
                    <input
                      type="text"
                      autoComplete="name"
                      placeholder="As shown on your M-Pesa"
                      value={mpesaName}
                      onChange={e => setMpesaName(e.target.value)}
                      className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#435F24] focus:outline-none"
                    />
                    <span className="text-xs text-[#6b6560]">
                      {buyerLabel} checks this name on the M-Pesa confirmation.
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={e => setConsent(e.target.checked)}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-[#435F24]"
                    />
                    <span className="text-sm text-[#374151]">
                      I agree to be paid in KES by M-Pesa for my counted trees
                      and to pass the MGRO for those trees to {buyerLabel}.
                      {releaseMode === 'vesting'
                        ? ' I will film the follow-up health-check videos for these trees.'
                        : ''}
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleJoin()}
                    disabled={!canSubmit}
                    className="tg-cta flex min-h-12 w-full items-center justify-center px-4 text-sm disabled:opacity-60"
                  >
                    {submitting ? 'Joining…' : 'Join M-Pesa payouts'}
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Step({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode
  title: string
  text: string
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#435F24]/10 text-[#435F24]">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-[#1a2610]">{title}</p>
        <p className="text-sm text-[#5c534a]">{text}</p>
      </div>
    </li>
  )
}
