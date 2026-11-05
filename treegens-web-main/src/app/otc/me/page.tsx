'use client'

import { HubPageHeader } from '@/components/Layout/HubPageHeader'
import { OtcDealRow } from '@/components/otc/OtcDealRow'
import { Spinner } from '@/components/ui/Spinner'
import { routes } from '@/config/appConfig'
import { useUser } from '@/contexts/UserProvider'
import { formatKes, getOtcMe, patchOtcMe } from '@/services/otcService'
import type { OtcMeResponse } from '@/types/otc'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { formatPhoneForDisplay, normalizeKenyanPhone } from '@/utils/mpesaPhone'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { HiArrowLeft, HiArrowPath } from 'react-icons/hi2'

export default function OtcMePage() {
  const router = useRouter()
  const { user } = useUser()
  const [data, setData] = useState<OtcMeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [toggling, setToggling] = useState(false)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await getOtcMe()
      setData(res.data.data)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load your M-Pesa payouts.'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const enrollment = data?.enrollment ?? null
  const buyerLabel = data?.buyer?.label || 'the buyer'

  const startEdit = () => {
    if (!enrollment) return
    setPhone(formatPhoneForDisplay(enrollment.mpesaNumber))
    setName(enrollment.mpesaName)
    setEditing(true)
  }

  const normalizedPhone = useMemo(() => normalizeKenyanPhone(phone), [phone])

  const save = async () => {
    if (!enrollment) return
    if (!normalizedPhone) {
      toast.error('Enter a valid M-Pesa number, e.g. 0712 345 678')
      return
    }
    if (name.trim().length < 2) {
      toast.error('Enter the name shown on your M-Pesa')
      return
    }
    const body: { mpesaNumber?: string; mpesaName?: string } = {}
    if (normalizedPhone !== enrollment.mpesaNumber)
      body.mpesaNumber = normalizedPhone
    if (name.trim() !== enrollment.mpesaName) body.mpesaName = name.trim()
    if (!body.mpesaNumber && !body.mpesaName) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      const res = await patchOtcMe(body)
      setData(prev => (prev ? { ...prev, enrollment: res.data.data } : prev))
      setEditing(false)
      toast.success('M-Pesa details updated')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save. Try again.'))
    } finally {
      setSaving(false)
    }
  }

  const togglePause = async () => {
    if (!enrollment) return
    const next = enrollment.status === 'active' ? 'paused' : 'active'
    if (
      next === 'paused' &&
      !window.confirm(
        'Pause M-Pesa payouts? New plantings will earn MGRO as usual until you resume. Deals already open are not affected.',
      )
    ) {
      return
    }
    setToggling(true)
    try {
      const res = await patchOtcMe({ status: next })
      setData(prev => (prev ? { ...prev, enrollment: res.data.data } : prev))
      toast.success(next === 'paused' ? 'Payouts paused' : 'Payouts resumed')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update. Try again.'))
    } finally {
      setToggling(false)
    }
  }

  const deals = useMemo(() => {
    const list = data?.deals ?? []
    const rank: Record<string, number> = {
      payment_sent: 0,
      awaiting_payment: 1,
      disputed: 2,
      awaiting_count: 3,
      confirmed: 4,
      cancelled: 5,
    }
    return [...list].sort((a, b) => {
      const r = (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      if (r !== 0) return r
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  }, [data?.deals])

  const toConfirm = deals.filter(d => d.status === 'payment_sent')

  return (
    <div className="flex min-h-screen flex-col px-4 pb-28 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg p-1 text-[#435F24] hover:bg-black/5"
          aria-label="Back"
        >
          <HiArrowLeft className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing || loading}
          className="rounded-lg p-1 text-[#435F24] hover:bg-black/5 disabled:opacity-40"
          aria-label="Refresh"
        >
          <HiArrowPath
            className={`h-6 w-6 ${refreshing ? 'animate-spin' : ''}`}
          />
        </button>
      </div>
      <HubPageHeader title="M-Pesa payouts" subtitle="Cash for counted trees" />

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : error ? (
        <section className="tg-card p-5">
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => void load(false)}
            className="mt-3 min-h-11 rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
          >
            Try again
          </button>
        </section>
      ) : !enrollment ? (
        <section className="tg-card p-5">
          <p className="text-base font-bold text-[#1a2610]">
            You are not in the M-Pesa program
          </p>
          <p className="mt-2 text-sm text-[#374151]">
            Some buyers pay planters in KES by M-Pesa instead of MGRO tokens. To
            join, ask the buyer for an invite link and open it on this phone.
          </p>
          <p className="mt-2 text-sm text-[#374151]">
            Until then your plantings earn MGRO as usual.
          </p>
          {data?.isBuyer || user?.isOtcBuyer ? (
            <Link
              href={routes.OtcDesk}
              className="tg-cta mt-4 flex min-h-12 items-center justify-center px-4 text-sm"
            >
              Open the OTC desk
            </Link>
          ) : null}
        </section>
      ) : (
        <div className="flex flex-col gap-4">
          {toConfirm.length ? (
            <section className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
              <p className="text-sm font-bold text-blue-950">
                {toConfirm.length === 1
                  ? `${formatKes(toConfirm[0].payment?.amountKes ?? toConfirm[0].amountKes)} was sent to your M-Pesa`
                  : `${toConfirm.length} payments are waiting for your confirmation`}
              </p>
              <p className="mt-1 text-xs text-blue-900">
                Check your M-Pesa SMS, then open the deal and confirm with the
                code.
              </p>
            </section>
          ) : null}

          <section className="tg-glass-panel p-5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#6b6560]">
                Your enrollment
              </p>
              <span
                className={
                  enrollment.status === 'active'
                    ? 'rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-800'
                    : 'rounded-full bg-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-700'
                }
              >
                {enrollment.status === 'active' ? 'Active' : 'Paused'}
              </span>
            </div>

            {editing ? (
              <div className="mt-3 flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-[#5c534a]">
                    M-Pesa number
                  </span>
                  <input
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="07XX XXX XXX"
                    className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
                  />
                  {phone.trim() && !normalizedPhone ? (
                    <span className="text-xs text-red-600">
                      Use 07XX XXX XXX or +2547XX XXX XXX.
                    </span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-[#5c534a]">
                    Name on M-Pesa
                  </span>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="min-h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
                  />
                </label>
                <p className="text-xs text-[#6b6560]">
                  Changing the number only affects payments not yet sent. You
                  will get a notification confirming the change.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                    className="min-h-12 flex-1 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving}
                    className="tg-cta min-h-12 flex-1 px-4 text-sm disabled:opacity-60"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-[#6b6560]">M-Pesa</dt>
                <dd className="font-semibold tabular-nums text-[#1a2610]">
                  {formatPhoneForDisplay(enrollment.mpesaNumber)}
                </dd>
                <dt className="text-[#6b6560]">Name</dt>
                <dd className="font-semibold text-[#1a2610]">
                  {enrollment.mpesaName}
                </dd>
                <dt className="text-[#6b6560]">Rate</dt>
                <dd className="font-semibold text-[#1a2610]">
                  {formatKes(enrollment.ratePerTreeKes)} per tree
                </dd>
                <dt className="text-[#6b6560]">Paid by</dt>
                <dd className="font-semibold text-[#1a2610]">{buyerLabel}</dd>
              </dl>
            )}

            {!editing ? (
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={startEdit}
                  className="min-h-12 flex-1 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
                >
                  Edit details
                </button>
                <button
                  type="button"
                  onClick={() => void togglePause()}
                  disabled={toggling}
                  className="min-h-12 flex-1 rounded-2xl border border-[#435F24]/30 bg-[#eef6e4] px-4 text-sm font-semibold text-[#303E1A] disabled:opacity-60"
                >
                  {toggling
                    ? 'Updating…'
                    : enrollment.status === 'active'
                      ? 'Pause payouts'
                      : 'Resume payouts'}
                </button>
              </div>
            ) : null}
            {enrollment.status === 'paused' ? (
              <p className="mt-3 text-xs text-[#6b6560]">
                While paused, new plantings earn MGRO as usual.
              </p>
            ) : (
              <p className="mt-3 text-xs text-[#6b6560]">
                You get cash instead of MGRO for these plantings. The MGRO goes
                to {buyerLabel}.
              </p>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-lg font-black text-[#1a2610]">My payouts</h2>
              <span className="text-xs text-[#6b6560]">{deals.length}</span>
            </div>
            {deals.length === 0 ? (
              <div className="tg-card p-5 text-center">
                <p className="text-sm text-[#374151]">
                  No payouts yet. Film a planting and it will appear here once
                  the trees are counted.
                </p>
                <Link
                  href={routes.NewPlant}
                  className="tg-cta mt-4 inline-flex min-h-12 items-center justify-center px-5 text-sm"
                >
                  Plant trees
                </Link>
              </div>
            ) : (
              deals.map(d => <OtcDealRow key={d._id} deal={d} />)
            )}
          </section>
        </div>
      )}
    </div>
  )
}
