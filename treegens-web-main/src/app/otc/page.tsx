'use client'

import { HubPageHeader } from '@/components/Layout/HubPageHeader'
import { OtcDealRow, copyText } from '@/components/otc/OtcDealRow'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { routes } from '@/config/appConfig'
import { useUser } from '@/contexts/UserProvider'
import {
  createOtcDeal,
  createOtcInvite,
  downloadOtcDealsCsv,
  formatKes,
  formatKesRate,
  getOtcSummary,
  listOtcDeals,
  listOtcEligibleSubmissions,
  listOtcEnrollments,
  listOtcInvites,
  otcErrorCode,
  patchOtcEnrollment,
  patchOtcInvite,
} from '@/services/otcService'
import type {
  OtcDealDetail,
  OtcEligibleSubmission,
  OtcEnrollmentRow,
  OtcInvite,
  OtcSummary,
} from '@/types/otc'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { truncateAddress } from '@/utils/helpers'
import { formatPhoneForDisplay } from '@/utils/mpesaPhone'
import { formatTimeAgo } from '@/utils/timeAgo'
import cn from 'classnames'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  HiArrowDownTray,
  HiArrowLeft,
  HiArrowPath,
  HiMagnifyingGlass,
  HiOutlineClipboard,
} from 'react-icons/hi2'

type TabKey = 'to_pay' | 'sent' | 'issues' | 'done' | 'cancelled' | 'all'

const TABS: Array<{ key: TabKey; label: string; status?: string }> = [
  { key: 'to_pay', label: 'To pay', status: 'awaiting_payment' },
  { key: 'sent', label: 'Sent', status: 'payment_sent' },
  { key: 'issues', label: 'Issues', status: 'disputed,awaiting_count' },
  { key: 'done', label: 'Done', status: 'confirmed' },
  { key: 'cancelled', label: 'Cancelled', status: 'cancelled' },
  { key: 'all', label: 'All' },
]

const PAGE_SIZE = 50

export default function OtcDeskPage() {
  const router = useRouter()
  const { user, isLoading: userLoading } = useUser()

  if (!user && userLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (!user?.isOtcBuyer) {
    return (
      <div className="flex min-h-screen flex-col px-4 pb-28 pt-3">
        <div className="mb-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-lg p-1 text-[#435F24] hover:bg-black/5"
            aria-label="Back"
          >
            <HiArrowLeft className="h-6 w-6" />
          </button>
        </div>
        <HubPageHeader title="OTC desk" subtitle="M-Pesa payouts" />
        <section className="tg-card p-5">
          <p className="text-base font-bold text-[#1a2610]">
            This area is for the OTC buyer
          </p>
          <p className="mt-2 text-sm text-[#374151]">
            Only wallets listed as OTC buyers can pay planters by M-Pesa from
            here. If you are a planter, your payouts are on your own page.
          </p>
          <Link
            href={routes.OtcMe}
            className="tg-cta mt-4 flex min-h-12 items-center justify-center px-4 text-sm"
          >
            My M-Pesa payouts
          </Link>
        </section>
      </div>
    )
  }

  return <Desk />
}

// ------------------------------------------------------------------ desk ---

function Desk() {
  const router = useRouter()
  const [summary, setSummary] = useState<OtcSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('to_pay')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [deals, setDeals] = useState<OtcDealDetail[]>([])
  const [dealsTotal, setDealsTotal] = useState(0)
  const [dealsLoading, setDealsLoading] = useState(true)
  const [dealsError, setDealsError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 350)
    return () => window.clearTimeout(t)
  }, [q])

  const loadSummary = useCallback(async () => {
    try {
      const res = await getOtcSummary()
      setSummary(res.data.data)
      setSummaryError(null)
    } catch (err) {
      setSummaryError(apiErrorMessage(err, 'Could not load the summary.'))
    }
  }, [])

  const loadDeals = useCallback(async () => {
    setDealsLoading(true)
    setDealsError(null)
    try {
      const status = TABS.find(t => t.key === tab)?.status
      const res = await listOtcDeals({
        status,
        q: debouncedQ || undefined,
        page: 1,
        limit: PAGE_SIZE,
      })
      setDeals(res.data.data.items)
      setDealsTotal(res.data.data.total)
    } catch (err) {
      setDealsError(apiErrorMessage(err, 'Could not load deals.'))
    } finally {
      setDealsLoading(false)
    }
  }, [tab, debouncedQ])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary, reloadKey])

  useEffect(() => {
    void loadDeals()
  }, [loadDeals, reloadKey])

  const refreshAll = async () => {
    setRefreshing(true)
    setReloadKey(k => k + 1)
    window.setTimeout(() => setRefreshing(false), 600)
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      const status = TABS.find(t => t.key === tab)?.status
      await downloadOtcDealsCsv({ status, q: debouncedQ || undefined })
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Export failed.'))
    } finally {
      setExporting(false)
    }
  }

  const counts = summary?.counts

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
          onClick={() => void refreshAll()}
          disabled={refreshing}
          className="rounded-lg p-1 text-[#435F24] hover:bg-black/5 disabled:opacity-40"
          aria-label="Refresh"
        >
          <HiArrowPath
            className={`h-6 w-6 ${refreshing ? 'animate-spin' : ''}`}
          />
        </button>
      </div>
      <HubPageHeader title="OTC desk" subtitle="Pay planters by M-Pesa" />

      {/* Summary tiles */}
      <section className="tg-glass-panel mb-4 p-4">
        {summaryError ? (
          <p className="text-sm text-red-700">{summaryError}</p>
        ) : !summary ? (
          <div className="flex justify-center py-4">
            <Spinner size="md" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Tile
                label="To pay"
                count={counts?.awaiting_payment ?? 0}
                value={formatKes(summary.kesToPay)}
                tone="amber"
                onClick={() => setTab('to_pay')}
              />
              <Tile
                label="Awaiting confirmation"
                count={counts?.payment_sent ?? 0}
                value={formatKes(summary.kesAwaitingConfirmation)}
                tone="blue"
                onClick={() => setTab('sent')}
              />
              <Tile
                label="Confirmed"
                count={counts?.confirmed ?? 0}
                value={formatKes(summary.kesConfirmed)}
                tone="green"
                onClick={() => setTab('done')}
              />
              <Tile
                label="MGRO released"
                count={summary.releasedCount}
                value={`${summary.treesConfirmed.toLocaleString()} trees`}
                tone="plain"
                onClick={() => setTab('done')}
              />
            </div>
            <p className="mt-3 text-[11px] text-[#6b6560]">
              Release:{' '}
              <span className="font-semibold">
                {summary.releaseMode === 'vesting' ? 'vesting' : 'full'}
              </span>{' '}
              · Payable on:{' '}
              <span className="font-semibold">
                {summary.payOn === 'approval'
                  ? 'verifier approval'
                  : 'AI count'}
              </span>{' '}
              · Telegram:{' '}
              <span className="font-semibold">
                {summary.telegram ? 'on' : 'off'}
              </span>
              {summary.unfundableCount ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="font-semibold text-red-700">
                    {summary.unfundableCount} unfundable
                  </span>
                </>
              ) : null}
              {(counts?.disputed ?? 0) > 0 ? (
                <>
                  {' '}
                  ·{' '}
                  <span className="font-semibold text-red-700">
                    {counts?.disputed} disputed
                  </span>
                </>
              ) : null}
            </p>
          </>
        )}
      </section>

      {/* Search + export */}
      <div className="mb-3 flex items-center gap-2">
        <label className="flex min-h-12 flex-1 items-center gap-2 rounded-2xl border border-gray-300 bg-white px-3">
          <HiMagnifyingGlass className="h-5 w-5 shrink-0 text-gray-400" />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Name, phone or M-Pesa code"
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-base text-gray-900 placeholder:text-gray-400 focus:outline-none"
            aria-label="Search deals"
          />
        </label>
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting}
          className="flex min-h-12 shrink-0 items-center gap-1 rounded-2xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60"
          aria-label="Export CSV"
        >
          <HiArrowDownTray className="h-5 w-5" />
          <span className="hidden sm:inline">
            {exporting ? 'Exporting…' : 'Export CSV'}
          </span>
        </button>
      </div>

      {/* Tabs */}
      <div className="-mx-4 mb-3 overflow-x-auto px-4">
        <div className="flex w-max gap-1 rounded-2xl bg-white p-1 shadow-sm ring-1 ring-black/5">
          {TABS.map(t => {
            const n =
              t.key === 'to_pay'
                ? counts?.awaiting_payment
                : t.key === 'sent'
                  ? counts?.payment_sent
                  : t.key === 'issues'
                    ? (counts?.disputed ?? 0) + (counts?.awaiting_count ?? 0)
                    : t.key === 'done'
                      ? counts?.confirmed
                      : t.key === 'cancelled'
                        ? counts?.cancelled
                        : undefined
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex min-h-11 items-center gap-1.5 rounded-xl px-3.5 text-sm font-bold transition-colors',
                  tab === t.key ? 'bg-[#435F24] text-white' : 'text-[#6b7280]',
                )}
              >
                {t.label}
                {typeof n === 'number' && n > 0 ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 text-[11px] tabular-nums',
                      tab === t.key
                        ? 'bg-white/20 text-white'
                        : 'bg-gray-100 text-gray-700',
                    )}
                  >
                    {n}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      {/* Deals */}
      <section className="mb-6 flex flex-col gap-3">
        {dealsLoading ? (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : dealsError ? (
          <div className="tg-card p-4">
            <p className="text-sm text-red-700">{dealsError}</p>
            <button
              type="button"
              onClick={() => void loadDeals()}
              className="mt-3 min-h-11 rounded-xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
            >
              Try again
            </button>
          </div>
        ) : deals.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#6b6560]">
            {debouncedQ
              ? 'No deals match your search.'
              : tab === 'to_pay'
                ? 'Nothing to pay right now. New deals appear here as soon as AI counts a planting.'
                : 'No deals here yet.'}
          </p>
        ) : (
          <>
            {deals.map(d => (
              <OtcDealRow key={d._id} deal={d} showPlanter />
            ))}
            {dealsTotal > deals.length ? (
              <p className="text-center text-xs text-[#6b6560]">
                Showing {deals.length} of {dealsTotal}. Use search or Export CSV
                for the rest.
              </p>
            ) : null}
          </>
        )}
      </section>

      <InvitesSection defaultRate={summary?.defaults.ratePerTreeKes ?? null} />
      <PlantersSection
        reloadKey={reloadKey}
        onDealCreated={() => setReloadKey(k => k + 1)}
      />
    </div>
  )
}

function Tile({
  label,
  count,
  value,
  tone,
  onClick,
}: {
  label: string
  count: number
  value: string
  tone: 'amber' | 'blue' | 'green' | 'plain'
  onClick: () => void
}) {
  const toneCls =
    tone === 'amber'
      ? 'text-amber-800'
      : tone === 'blue'
        ? 'text-blue-800'
        : tone === 'green'
          ? 'text-green-800'
          : 'text-[#435F24]'
  return (
    <button
      type="button"
      onClick={onClick}
      className="tg-impact-card min-h-[5.5rem] px-3 py-3 text-left"
    >
      <p className={`text-[10px] font-bold uppercase tracking-wide ${toneCls}`}>
        {label}
      </p>
      <p className="mt-1 text-[22px] font-black tabular-nums leading-none text-[#1a2610]">
        {count}
      </p>
      <p className="mt-1.5 text-xs font-semibold tabular-nums text-[#5c534a]">
        {value}
      </p>
    </button>
  )
}

// --------------------------------------------------------------- invites ---

function InvitesSection({ defaultRate }: { defaultRate: number | null }) {
  const [invites, setInvites] = useState<OtcInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [rate, setRate] = useState('')
  const [maxUses, setMaxUses] = useState('')
  const [creating, setCreating] = useState(false)
  const [togglingCode, setTogglingCode] = useState<string | null>(null)

  useEffect(() => {
    if (!rate && defaultRate) setRate(String(defaultRate))
  }, [defaultRate, rate])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listOtcInvites()
      setInvites(res.data.data.items)
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load invite links.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rateNum = Number(rate)
  const rateOk = Number.isFinite(rateNum) && rateNum > 0
  const maxNum = maxUses.trim() ? Number(maxUses) : null
  const maxOk = maxNum === null || (Number.isInteger(maxNum) && maxNum > 0)

  const create = async () => {
    if (!rateOk) {
      toast.error('Enter the KES rate per tree')
      return
    }
    if (!maxOk) {
      toast.error('Max uses must be a whole number')
      return
    }
    setCreating(true)
    try {
      const res = await createOtcInvite({
        label: label.trim() || undefined,
        ratePerTreeKes: rateNum,
        maxUses: maxNum,
      })
      const url = res.data.data.url || res.data.data.invite.url
      setInvites(prev => [{ ...res.data.data.invite, url }, ...prev])
      setLabel('')
      setMaxUses('')
      setOpen(false)
      toast.success('Invite link created')
      await copyText(url, 'Invite link copied')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not create the invite.'))
    } finally {
      setCreating(false)
    }
  }

  const toggle = async (inv: OtcInvite) => {
    setTogglingCode(inv.code)
    try {
      const res = await patchOtcInvite(inv.code, { isActive: !inv.isActive })
      setInvites(prev =>
        prev.map(x =>
          x.code === inv.code ? { ...x, ...res.data.data, url: x.url } : x,
        ),
      )
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update the invite.'))
    } finally {
      setTogglingCode(null)
    }
  }

  return (
    <section className="mb-6 flex flex-col gap-3 rounded-3xl bg-warm-grey p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold">Invite links</h3>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="min-h-10 rounded-full bg-[#435F24] px-4 text-sm font-semibold text-white"
        >
          {open ? 'Close' : 'New link'}
        </button>
      </div>
      <p className="text-xs text-brown-1">
        Planters open the link, sign in with their phone and enter their M-Pesa
        number. Each link carries its own KES rate.
      </p>

      {open ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-white p-3">
          <input
            type="text"
            placeholder="Label (e.g. Kilifi group, Nov)"
            value={label}
            onChange={e => setLabel(e.target.value)}
            maxLength={80}
            className="min-h-12 w-full rounded-xl border border-gray-300 px-3 text-base text-gray-900 focus:border-[#435F24] focus:outline-none"
          />
          <div className="flex gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-semibold text-[#5c534a]">
                KES per tree
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                value={rate}
                onChange={e => setRate(e.target.value)}
                className="min-h-12 w-full rounded-xl border border-gray-300 px-3 text-base tabular-nums text-gray-900 focus:border-[#435F24] focus:outline-none"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-semibold text-[#5c534a]">
                Max uses (optional)
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                placeholder="Unlimited"
                value={maxUses}
                onChange={e => setMaxUses(e.target.value)}
                className="min-h-12 w-full rounded-xl border border-gray-300 px-3 text-base tabular-nums text-gray-900 focus:border-[#435F24] focus:outline-none"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={() => void create()}
            disabled={creating || !rateOk || !maxOk}
            className="tg-cta min-h-12 w-full px-4 text-sm disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create and copy link'}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-4">
          <Spinner size="md" />
        </div>
      ) : invites.length === 0 ? (
        <p className="text-center text-sm text-[#6b6560]">
          No invite links yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {invites.map(inv => (
            <li
              key={inv.code}
              className={cn(
                'flex flex-col gap-2 rounded-2xl bg-white p-3',
                !inv.isActive && 'opacity-70',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[#111827]">
                    {inv.label || 'Untitled link'}
                  </p>
                  <p className="text-xs text-[#6b7280]">
                    <span className="font-mono">{inv.code}</span> ·{' '}
                    {formatKesRate(inv.ratePerTreeKes)}/tree · {inv.uses}
                    {inv.maxUses != null ? `/${inv.maxUses}` : ''} used
                    {inv.expiresAt
                      ? ` · expires ${formatTimeAgo(inv.expiresAt)}`
                      : ''}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                    inv.isActive
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-200 text-gray-700',
                  )}
                >
                  {inv.isActive ? 'Active' : 'Off'}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyText(inv.url, 'Invite link copied')}
                  className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl border border-[#435F24]/30 bg-[#eef6e4] px-3 text-sm font-semibold text-[#303E1A]"
                >
                  <HiOutlineClipboard className="h-4 w-4" /> Copy link
                </button>
                <button
                  type="button"
                  onClick={() => void toggle(inv)}
                  disabled={togglingCode === inv.code}
                  className="min-h-11 flex-1 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60"
                >
                  {inv.isActive ? 'Switch off' : 'Switch on'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// -------------------------------------------------------------- planters ---

function PlantersSection({
  reloadKey,
  onDealCreated,
}: {
  reloadKey: number
  onDealCreated: () => void
}) {
  const [rows, setRows] = useState<OtcEnrollmentRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [rateDraft, setRateDraft] = useState('')
  const [busyWallet, setBusyWallet] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<OtcEnrollmentRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listOtcEnrollments({ page: 1, limit: 100 })
      setRows(res.data.data.items)
      setTotal(res.data.data.total)
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load planters.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const saveRate = async (row: OtcEnrollmentRow) => {
    const n = Number(rateDraft)
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Enter a KES rate per tree')
      return
    }
    setBusyWallet(row.planterWallet)
    try {
      const res = await patchOtcEnrollment(row.planterWallet, {
        ratePerTreeKes: n,
      })
      setRows(prev =>
        prev.map(r =>
          r.planterWallet === row.planterWallet
            ? { ...r, ...res.data.data }
            : r,
        ),
      )
      setEditing(null)
      toast.success('Rate updated. Applies to new plantings.')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update the rate.'))
    } finally {
      setBusyWallet(null)
    }
  }

  const togglePause = async (row: OtcEnrollmentRow) => {
    const next = row.status === 'active' ? 'paused' : 'active'
    setBusyWallet(row.planterWallet)
    try {
      const res = await patchOtcEnrollment(row.planterWallet, { status: next })
      setRows(prev =>
        prev.map(r =>
          r.planterWallet === row.planterWallet
            ? { ...r, ...res.data.data }
            : r,
        ),
      )
      toast.success(next === 'paused' ? 'Planter paused' : 'Planter resumed')
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not update the planter.'))
    } finally {
      setBusyWallet(null)
    }
  }

  return (
    <section className="mb-6 flex flex-col gap-3 rounded-3xl bg-warm-grey p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold">Planters</h3>
        <span className="text-sm font-semibold text-brown-2">{total}</span>
      </div>
      {loading ? (
        <div className="flex justify-center py-4">
          <Spinner size="md" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-[#6b6560]">
          No planters yet. Share an invite link to get started.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(row => {
            const open =
              row.dealCounts.awaiting_payment +
              row.dealCounts.payment_sent +
              row.dealCounts.disputed +
              row.dealCounts.awaiting_count
            const busy = busyWallet === row.planterWallet
            return (
              <li
                key={row.planterWallet}
                className="flex flex-col gap-2 rounded-2xl bg-white p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-[#111827]">
                      {row.mpesaName}
                      {row.planterName && row.planterName !== row.mpesaName ? (
                        <span className="font-normal text-[#6b7280]">
                          {' '}
                          · {row.planterName}
                        </span>
                      ) : null}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        void copyText(row.mpesaNumber, 'Number copied')
                      }
                      className="inline-flex min-h-9 items-center gap-1 text-sm text-[#435F24]"
                    >
                      <HiOutlineClipboard className="h-4 w-4" />
                      <span className="tabular-nums">
                        {formatPhoneForDisplay(row.mpesaNumber)}
                      </span>
                    </button>
                    <p className="text-[11px] text-[#9ca3af]">
                      {truncateAddress(row.planterWallet)} · joined{' '}
                      {formatTimeAgo(row.joinedAt || row.createdAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                      row.status === 'active'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-gray-200 text-gray-700',
                    )}
                  >
                    {row.status === 'active' ? 'Active' : 'Paused'}
                  </span>
                </div>

                <p className="text-xs text-[#374151]">
                  {row.dealCounts.total} deal
                  {row.dealCounts.total === 1 ? '' : 's'}
                  {open ? ` · ${open} open` : ''}
                  {row.dealCounts.confirmed
                    ? ` · ${row.dealCounts.confirmed} confirmed`
                    : ''}
                  {row.dealCounts.disputed
                    ? ` · ${row.dealCounts.disputed} disputed`
                    : ''}
                </p>

                {editing === row.planterWallet ? (
                  <div className="flex gap-2">
                    <input
                      type="number"
                      inputMode="decimal"
                      min={1}
                      value={rateDraft}
                      onChange={e => setRateDraft(e.target.value)}
                      className="min-h-11 min-w-0 flex-1 rounded-xl border border-gray-300 px-3 text-base tabular-nums text-gray-900 focus:border-[#435F24] focus:outline-none"
                      aria-label="KES per tree"
                    />
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="min-h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveRate(row)}
                      disabled={busy}
                      className="min-h-11 rounded-xl bg-[#435F24] px-3 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(row.planterWallet)
                        setRateDraft(String(row.ratePerTreeKes))
                      }}
                      className="min-h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800"
                    >
                      {formatKesRate(row.ratePerTreeKes)}/tree · Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void togglePause(row)}
                      disabled={busy}
                      className="min-h-11 rounded-xl border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 disabled:opacity-60"
                    >
                      {row.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPickerFor(row)}
                      className="min-h-11 rounded-xl border border-[#435F24]/30 bg-[#eef6e4] px-3 text-sm font-semibold text-[#303E1A]"
                    >
                      Add planting
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <SubmissionPicker
        row={pickerFor}
        onClose={() => setPickerFor(null)}
        onCreated={() => {
          onDealCreated()
          void load()
        }}
      />
    </section>
  )
}

/** Plain-English reasons for the picker's `ineligibleReason` codes. */
const REASON_LABEL: Record<string, string> = {
  planter_already_paid: 'Planter already claimed MGRO',
  not_reviewable: 'Not reviewable yet',
  bound_to_other_deal: 'MGRO already tied to another deal',
  rejected: 'Rejected by verifiers',
  deal_exists: 'Already on the desk',
}

function SubmissionPicker({
  row,
  onClose,
  onCreated,
}: {
  row: OtcEnrollmentRow | null
  onClose: () => void
  onCreated: () => void
}) {
  const [items, setItems] = useState<OtcEligibleSubmission[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)

  const wallet = row?.planterWallet ?? null

  useEffect(() => {
    if (!wallet) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])
    ;(async () => {
      try {
        const res = await listOtcEligibleSubmissions(wallet)
        if (!cancelled) setItems(res.data.data.items)
      } catch (err) {
        if (!cancelled)
          setError(apiErrorMessage(err, 'Could not load plantings.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [wallet])

  const add = async (s: OtcEligibleSubmission) => {
    setAdding(s.submissionId)
    try {
      const res = await createOtcDeal(s.submissionId)
      setItems(prev =>
        prev.map(x =>
          x.submissionId === s.submissionId
            ? { ...x, hasDeal: true, eligible: false }
            : x,
        ),
      )
      const d = res.data.data
      toast.success(
        d.status === 'awaiting_payment'
          ? `Deal added: pay ${formatKes(d.amountKes)}`
          : 'Deal added (not payable yet)',
      )
      onCreated()
    } catch (err) {
      const code = otcErrorCode(err)
      if (code === 'PLANTER_ALREADY_PAID') {
        toast.error('The planter already claimed MGRO for this planting.')
      } else if (code === 'DEAL_EXISTS') {
        toast.error('This planting already has a deal.')
      } else {
        toast.error(apiErrorMessage(err, 'Could not add the planting.'))
      }
    } finally {
      setAdding(null)
    }
  }

  const title = row ? `Add planting · ${row.mpesaName}` : ''

  return (
    <Modal open={!!row} onClose={onClose} title={title}>
      <p className="text-xs text-gray-600">
        Mangrove plantings with a plant clip. Eligible ones can be added to the
        desk; the planter is told they will be paid by M-Pesa instead.
      </p>
      <div className="mt-3 max-h-[60vh] overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-600">
            This planter has no mangrove plantings with a clip yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map(s => {
              const count =
                typeof s.aiCount === 'number'
                  ? `${s.aiCount} (AI)`
                  : typeof s.treesPlanted === 'number'
                    ? `${s.treesPlanted} (declared)`
                    : '?'
              const disabled = !s.eligible || s.hasDeal
              return (
                <li
                  key={s.submissionId}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-xl border border-gray-200 px-3 py-2',
                    disabled && 'opacity-60',
                  )}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      {count} trees ·{' '}
                      <span className="font-normal capitalize">
                        {s.status.replace(/_/g, ' ')}
                      </span>
                    </p>
                    <p className="truncate text-xs text-gray-500">
                      {s.uploadedAt ? formatTimeAgo(s.uploadedAt) : ''}
                      {s.location ? ` · ${s.location}` : ''}
                    </p>
                    {disabled ? (
                      <p className="text-xs text-amber-800">
                        {s.hasDeal
                          ? 'Already on the desk'
                          : (s.ineligibleReason &&
                              REASON_LABEL[s.ineligibleReason]) ||
                            'Not eligible'}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={disabled || adding === s.submissionId}
                    onClick={() => void add(s)}
                    className="min-h-11 shrink-0 rounded-xl bg-[#435F24] px-4 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    {adding === s.submissionId ? 'Adding…' : 'Add'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-4 min-h-12 w-full rounded-2xl border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800"
      >
        Close
      </button>
    </Modal>
  )
}
