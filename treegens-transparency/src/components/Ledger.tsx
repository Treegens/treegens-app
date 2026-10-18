import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type FlowItem, type FlowKind } from '../lib/api'
import { formatUsd, formatWei, timeAgo } from '../lib/format'
import { KINDS, LEDGER_FILTERS } from '../lib/kinds'
import { AddressChip, KindBadge, Skeleton, TxLink } from './ui/Bits'
import { Icon } from './ui/Icon'

export type LedgerFilter = 'all' | FlowKind

function Amount({ item }: { item: FlowItem }) {
  if (!item.amount) return null
  const sign = item.kind === 'retire' ? '−' : '+'
  const text =
    item.amount.token === 'USD'
      ? formatUsd(item.amount.value)
      : `${formatWei(item.amount.wei, { maxFraction: 2 })} ${item.amount.token}`
  return (
    <span className="tabular text-base font-extrabold text-ink">
      {item.amount.token === 'USD' ? '' : sign}
      {text}
    </span>
  )
}

export function LedgerRow({
  item,
  fresh,
  onOpenPlanting,
  compact = false,
}: {
  item: FlowItem
  fresh?: boolean
  onOpenPlanting?: (id: string) => void
  compact?: boolean
}) {
  const meta = KINDS[item.kind]
  return (
    <li className={`grid gap-3 border-b border-hairline px-3 py-3.5 last:border-b-0 sm:grid-cols-[auto_1fr_auto] sm:items-start ${fresh ? 'tg-row-in' : ''}`}>
      <div className="pt-0.5">
        <KindBadge label={meta.short} color={meta.color} icon={meta.icon} compact={compact} />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-bold leading-snug text-ink">{item.title}</p>
        {item.detail ? <p className="mt-0.5 text-xs leading-snug text-ink-2">{item.detail}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.from ? <AddressChip address={item.from.address} label={item.from.label} name={item.from.name} /> : null}
          {item.from && item.to ? <Icon name="arrow" size={12} className="text-ink-3" /> : null}
          {item.to ? <AddressChip address={item.to.address} label={item.to.label} name={item.to.name} /> : null}
          {item.planting ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-xs text-ink-2 hover:border-accent"
              onClick={() => item.submissionId && onOpenPlanting?.(item.submissionId)}
            >
              <Icon name="pin" size={12} />
              <span className="font-semibold text-ink">{item.planting.trees} {/mangrove/i.test(item.planting.species) ? 'mangroves' : 'trees'}</span>
              {item.planting.location ? <span className="max-w-[180px] truncate">· {item.planting.location}</span> : null}
            </button>
          ) : null}
        </div>
        {!compact ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {item.txHash ? <TxLink hash={item.txHash} label={item.verified ? 'Verified on Basescan' : 'View on Basescan'} /> : null}
            {item.video ? (
              <a className="tg-btn tg-btn-sm" href={item.video.url} target="_blank" rel="noreferrer noopener">
                <Icon name="play" size={13} /> Watch {item.video.kind === 'health_check' ? 'growth update' : 'planting video'}
              </a>
            ) : null}
            {item.submissionId && onOpenPlanting ? (
              <button type="button" className="tg-btn tg-btn-sm" onClick={() => onOpenPlanting(item.submissionId!)}>
                Open planting <Icon name="arrow" size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-row items-center justify-between gap-3 sm:flex-col sm:items-end sm:text-right">
        <Amount item={item} />
        <time className="text-xs text-ink-3" dateTime={item.at} title={new Date(item.at).toLocaleString()}>
          {timeAgo(item.at)}
        </time>
      </div>
    </li>
  )
}

export function Ledger({
  initial,
  filter,
  onFilter,
  onOpenPlanting,
  apiDown,
}: {
  initial: { items: FlowItem[]; nextCursor: string | null } | null
  filter: LedgerFilter
  onFilter: (f: LedgerFilter) => void
  onOpenPlanting: (id: string) => void
  apiDown: boolean
}) {
  const [pages, setPages] = useState<FlowItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const knownIds = useRef<Set<string>>(new Set())
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set())

  const [visible, setVisible] = useState(12)

  // Filtered views fetch their own first page; the unfiltered view rides the
  // shared feed. Changing the filter resets what is shown.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setError(null)
    setVisible(12)
    if (filter === 'all') {
      setPages(initial?.items ?? [])
      setCursor(initial?.nextCursor ?? null)
      return
    }
    setLoading(true)
    api
      .flows({ limit: 40, kinds: [filter] }, controller.signal)
      .then(page => {
        if (cancelled) return
        setPages(page.items)
        setCursor(page.nextCursor)
      })
      .catch(e => {
        if (!cancelled && !controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  // Each poll of the shared feed merges new entries in without dropping the
  // older pages the reader has already loaded.
  useEffect(() => {
    if (filter !== 'all' || !initial) return
    setPages(prev => {
      const ids = new Set(initial.items.map(i => i.id))
      const older = prev.filter(p => !ids.has(p.id))
      return [...initial.items, ...older]
    })
    setCursor(prevCursor => prevCursor ?? initial.nextCursor)
  }, [initial, filter])

  // Highlight rows that arrived since the previous poll.
  useEffect(() => {
    if (!pages.length) return
    if (knownIds.current.size === 0) {
      pages.forEach(p => knownIds.current.add(p.id))
      return
    }
    const fresh = new Set<string>()
    for (const p of pages) {
      if (!knownIds.current.has(p.id)) {
        fresh.add(p.id)
        knownIds.current.add(p.id)
      }
    }
    if (fresh.size) {
      setFreshIds(fresh)
      const t = window.setTimeout(() => setFreshIds(new Set()), 2500)
      return () => window.clearTimeout(t)
    }
  }, [pages])

  async function loadMore() {
    if (!cursor || loading) return
    setLoading(true)
    try {
      const page = await api.flows({ limit: 40, cursor, kinds: filter === 'all' ? undefined : [filter] })
      setPages(prev => {
        const ids = new Set(prev.map(p => p.id))
        return [...prev, ...page.items.filter(i => !ids.has(i.id))]
      })
      setCursor(page.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const counts = useMemo(() => {
    const c: Partial<Record<FlowKind, number>> = {}
    for (const i of initial?.items || []) c[i.kind] = (c[i.kind] || 0) + 1
    return c
  }, [initial])

  return (
    <div className="tg-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-3" role="tablist" aria-label="Ledger filters">
        {LEDGER_FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className="tg-chip"
            data-active={filter === f.key}
            onClick={() => onFilter(f.key)}
          >
            {f.key !== 'all' ? <span className="h-2 w-2 rounded-full" style={{ background: KINDS[f.key].color }} aria-hidden="true" /> : null}
            {f.label}
            {f.key !== 'all' && counts[f.key] ? <span className="tabular opacity-70">{counts[f.key]}</span> : null}
          </button>
        ))}
      </div>
      {apiDown && !pages.length ? (
        <div className="p-8 text-center text-sm text-ink-2">
          <Icon name="chain" size={22} className="mx-auto mb-2 text-ink-3" />
          The ledger API is unreachable right now. The on-chain contracts below are still live and verifiable on Basescan.
        </div>
      ) : null}
      {!apiDown && !pages.length && !loading && initial ? (
        <div className="p-8 text-center text-sm text-ink-2">Nothing indexed for this filter yet. Flows appear here the moment they land on Base.</div>
      ) : null}
      {loading && !pages.length ? (
        <div className="grid gap-3 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : null}
      <ul className="m-0 list-none p-0">
        {pages.slice(0, visible).map(item => (
          <LedgerRow key={item.id} item={item} fresh={freshIds.has(item.id)} onOpenPlanting={onOpenPlanting} />
        ))}
      </ul>
      {error ? <p className="px-4 py-3 text-xs text-ink-2">Could not load more: {error}</p> : null}
      {pages.length > visible || cursor ? (
        <div className="flex items-center justify-center gap-3 border-t border-hairline p-3 text-center">
          <button
            type="button"
            className="tg-btn"
            onClick={() => {
              if (pages.length > visible) setVisible(v => v + 20)
              else void loadMore()
            }}
            disabled={loading}
          >
            {loading ? 'Loading…' : pages.length > visible ? `Show more (${pages.length - visible} loaded)` : 'Load older entries'}
          </button>
          <span className="text-xs text-ink-3">Showing {Math.min(visible, pages.length)} of {pages.length}{cursor ? '+' : ''}</span>
        </div>
      ) : null}
    </div>
  )
}
