import { useEffect, useState } from 'react'
import { api, type PlantingSummary } from '../lib/api'
import { formatDate, formatInt, formatUsd, formatWei } from '../lib/format'
import { Skeleton, VideoPlayer } from './ui/Bits'
import { Icon } from './ui/Icon'

type Sort = 'recent' | 'trees' | 'funded'

export function PlantingCard({ p, onOpen }: { p: PlantingSummary; onOpen: (id: string) => void }) {
  const fundedUsd = p.funding.status === 'funded' ? p.funding.grossUsd : null
  const funded = fundedUsd !== null
  return (
    <article className="tg-card flex flex-col overflow-hidden">
      <div className="relative">
        <div className="tg-video !aspect-[4/5] !rounded-none">
          {p.video.url ? (
            <video src={p.video.url} muted playsInline loop preload="metadata" onMouseEnter={e => void e.currentTarget.play().catch(() => {})} onMouseLeave={e => e.currentTarget.pause()} />
          ) : (
            <div className="flex h-full items-center justify-center text-ink-3">
              <Icon name="camera" size={26} />
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">
            {formatInt(p.trees)} {p.isMangrove ? 'mangroves' : 'trees'}
          </span>
          {p.ai?.decision === 'auto_approved' ? (
            <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white backdrop-blur">AI counted</span>
          ) : null}
        </div>
        <div className="absolute inset-x-3 bottom-3 text-white">
          <p className="truncate text-sm font-extrabold drop-shadow">{p.location || 'Verified planting'}</p>
          <p className="text-[11px] opacity-90">
            {p.species || 'Trees'} · verified {formatDate(p.approvedAt)}
          </p>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
          <span className="tg-chip" style={{ borderColor: funded ? 'var(--s-funding)' : 'var(--hairline)' }}>
            {fundedUsd !== null ? `Funded ${formatUsd(fundedUsd)}` : p.funding.status === 'reserved' ? 'In checkout' : 'Open to fund'}
          </span>
          {p.rewards ? (
            <span className="tg-chip" style={{ borderColor: 'var(--s-reward)' }}>
              {p.rewards.tranchesPaid}/{p.rewards.tranchesTotal} tranches
            </span>
          ) : null}
          <span className="tg-chip" style={{ borderColor: 'var(--s-update)' }}>
            {p.updates.approved} update{p.updates.approved === 1 ? '' : 's'}
          </span>
        </div>
        {p.rewards ? (
          <div className="tg-progress" style={{ gridTemplateColumns: `repeat(${p.rewards.tranchesTotal || 6}, 1fr)` }} aria-label={`${p.rewards.tranchesPaid} of ${p.rewards.tranchesTotal} reward tranches paid`}>
            {Array.from({ length: p.rewards.tranchesTotal || 6 }).map((_, i) => (
              <span key={i} data-paid={i < p.rewards!.tranchesPaid} />
            ))}
          </div>
        ) : null}
        <p className="text-xs text-ink-2">
          {p.rewards ? (
            <>
              <span className="tabular font-bold text-ink">{formatWei(p.rewards.onchainPlanterMintedWei)}</span> of{' '}
              <span className="tabular">{formatWei(p.rewards.planterTotalWei)}</span> MGRO minted to the planter
            </>
          ) : (
            'Reward allocation pending'
          )}
          {' · '}verified by {p.verifiers.count}
        </p>
        <button type="button" className="tg-btn mt-auto justify-center" onClick={() => onOpen(p.id)}>
          Videos, verifiers & every transaction <Icon name="arrow" size={13} />
        </button>
      </div>
    </article>
  )
}

export function PlantingsGrid({ onOpen }: { onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<Sort>('recent')
  const [items, setItems] = useState<PlantingSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    api
      .plantings({ page: 1, limit: 12, sort }, controller.signal)
      .then(res => {
        if (cancelled) return
        setItems(res.items)
        setTotal(res.total)
        setPage(1)
        setError(null)
      })
      .catch(e => {
        if (!cancelled && !controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [sort])

  async function more() {
    const next = page + 1
    setLoading(true)
    try {
      const res = await api.plantings({ page: next, limit: 12, sort })
      setItems(prev => [...prev, ...res.items.filter(i => !prev.some(p => p.id === i.id))])
      setPage(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Sort plantings">
        {(
          [
            ['recent', 'Most recent'],
            ['trees', 'Most trees'],
            ['funded', 'Funded first'],
          ] as [Sort, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" className="tg-chip" data-active={sort === k} onClick={() => setSort(k)}>
            {label}
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-3">{total ? `${formatInt(total)} verified plantings` : ''}</span>
      </div>
      {error && !items.length ? <p className="tg-card p-6 text-sm text-ink-2">Could not load plantings: {error}</p> : null}
      {loading && !items.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-80" />
          ))}
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <p className="tg-card p-6 text-sm text-ink-2">No verified plantings yet. The first approved planting appears here with its video and GPS.</p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(p => (
          <PlantingCard key={p.id} p={p} onOpen={onOpen} />
        ))}
      </div>
      {items.length < total ? (
        <div className="mt-6 text-center">
          <button type="button" className="tg-btn" onClick={more} disabled={loading}>
            {loading ? 'Loading…' : `Show more (${formatInt(total - items.length)} left)`}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export { VideoPlayer }
