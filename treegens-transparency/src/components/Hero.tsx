import type { ChainSnapshot } from '../lib/chain'
import type { OnchainLive, Overview } from '../lib/api'
import { formatInt, formatUsd, formatWei, timeAgo, weiToNumber } from '../lib/format'
import { Icon } from './ui/Icon'
import { Skeleton } from './ui/Bits'

function Tile({
  label,
  value,
  sub,
  color,
  verified,
}: {
  label: string
  value: string
  sub?: string
  color?: string
  verified?: boolean
}) {
  return (
    <div className="tg-card relative overflow-hidden p-5">
      {color ? <span className="absolute inset-y-0 left-0 w-1" style={{ background: color }} aria-hidden="true" /> : null}
      <p className="text-xs font-semibold text-ink-3">{label}</p>
      <p className="mt-1.5 text-3xl font-extrabold tracking-tight">{value}</p>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-ink-2">
        <span>{sub}</span>
        {verified ? (
          <span className="inline-flex items-center gap-1 whitespace-nowrap font-semibold text-ink-2" title="Summed from on-chain events, each with a tx hash">
            <Icon name="chain" size={12} /> on-chain
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function Hero({
  overview,
  loading,
  error,
  onchain,
  chain,
}: {
  overview: Overview | null
  loading: boolean
  error: Error | null
  onchain: OnchainLive | null
  chain: ChainSnapshot | null
}) {
  const t = overview?.totals
  const supplyWei = chain?.mgroSupplyWei ?? (onchain && onchain.available ? onchain.mgro.totalSupplyWei : null)
  const block = chain?.blockNumber ?? (onchain && onchain.available ? onchain.blockNumber : null)
  const mintedWei = t?.rewards.mgroMintedWei
  const consistent =
    supplyWei && mintedWei ? weiToNumber(mintedWei) <= weiToNumber(supplyWei) + 1e-9 : null

  return (
    <section id="top" className="mx-auto w-full max-w-7xl px-4 pb-6 pt-12 sm:px-6 md:pt-20">
      <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-end">
        <div>
          <p className="tg-kicker">Public ledger · Base mainnet</p>
          <h1 className="mt-4 text-[2.6rem] font-extrabold leading-[0.98] tracking-tight sm:text-6xl md:text-7xl">
            Every dollar in.
            <br />
            <span className="text-accent">Every tree out.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
            Money that funds trees on <strong className="font-semibold text-ink">world.treegens.app</strong> and{' '}
            <strong className="font-semibold text-ink">treegensfoundation.org</strong> flows to the people who plant and
            verify them, then growth videos flow back. All of it on Base, one click from the open ledger.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a href="#flows" className="tg-btn tg-btn-primary">
              Watch the money flow <Icon name="arrow" size={15} />
            </a>
            <a href="#plantings" className="tg-btn">
              <Icon name="play" size={14} /> See the trees
            </a>
            <a href="#contracts" className="tg-btn">
              <Icon name="chain" size={14} /> Verify it yourself
            </a>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2 text-xs text-ink-2">
            {block ? (
              <span className="tg-chip">
                <span className="tg-pulse" />
                Base block <span className="tabular font-bold text-ink">#{formatInt(block)}</span>
              </span>
            ) : null}
            {supplyWei ? (
              <span className="tg-chip" title="Read live from the $MGRO contract on Base">
                $MGRO supply <span className="tabular font-bold text-ink">{formatWei(supplyWei)}</span>
                {consistent === true ? <Icon name="check" size={12} /> : null}
              </span>
            ) : null}
            {overview?.ledger.lastSyncAt ? (
              <span className="tg-chip" title="When the ledger indexer last wrote a block">
                Ledger synced {timeAgo(overview.ledger.lastSyncAt)}
              </span>
            ) : null}
            {error && !overview ? (
              <span className="tg-chip" style={{ borderColor: 'var(--warning)' }}>
                Ledger API unreachable · showing live chain reads only
              </span>
            ) : null}
          </div>
        </div>

        <div className="tg-card relative overflow-hidden p-6 md:p-8">
          <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full opacity-60 blur-3xl" style={{ background: 'var(--leaf-soft)' }} />
          <p className="tg-kicker">Funded for trees</p>
          {loading && !overview ? (
            <Skeleton className="mt-3 h-16 w-3/4" />
          ) : (
            <p className="tg-hero-figure mt-3 text-6xl md:text-7xl" style={{ color: 'var(--s-funding)' }}>
              {formatUsd(t?.funding.grossUsd ?? 0)}
            </p>
          )}
          <p className="mt-3 text-sm text-ink-2">
            {t ? (
              <>
                across <strong className="text-ink">{formatInt(t.funding.count)}</strong> funded plantings · 95% to planters,
                5% to verifiers, every leg a Base transaction
              </>
            ) : (
              'Loading the ledger…'
            )}
          </p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-hairline bg-surface-2 p-3">
              <p className="text-[11px] font-semibold text-ink-3">To planters</p>
              <p className="tabular mt-0.5 text-lg font-extrabold">{t ? formatWei(t.funding.onchainTgnToPlantersWei) : '—'} <span className="text-xs font-semibold text-ink-2">TGN</span></p>
            </div>
            <div className="rounded-xl border border-hairline bg-surface-2 p-3">
              <p className="text-[11px] font-semibold text-ink-3">To verifiers</p>
              <p className="tabular mt-0.5 text-lg font-extrabold">{t ? formatWei(t.funding.onchainTgnToVerifiersWei) : '—'} <span className="text-xs font-semibold text-ink-2">TGN</span></p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Trees verified"
          value={t ? formatInt(t.plantings.trees) : '—'}
          sub={t ? `${formatInt(t.plantings.approved)} plantings · ${formatInt(t.plantings.countries)} countries · ${formatInt(t.plantings.verifiers)} verifiers` : undefined}
          color="var(--s-update)"
        />
        <Tile
          label="$MGRO rewarded"
          value={t ? formatWei(t.rewards.mgroMintedWei) : '—'}
          sub={t ? `${formatInt(t.rewards.mintCount)} mints · ${formatInt(t.rewards.tranchesPaid)} of ${formatInt(t.rewards.tranchesTotal)} tranches paid` : undefined}
          color="var(--s-reward)"
          verified
        />
        <Tile
          label="$MGRO retired forever"
          value={t ? formatWei(t.retired.mgroBurnedWei) : '—'}
          sub={t ? `${formatInt(t.retired.burnCount)} burns by ${formatInt(t.retired.funders)} funders` : undefined}
          color="var(--s-retire)"
          verified
        />
        <Tile
          label="Growth updates"
          value={t ? formatInt(t.updates.healthChecksApproved) : '—'}
          sub={t ? `${formatInt(t.updates.treesAliveReported)} trees counted alive · ${formatInt(t.updates.videos.total)} videos public` : undefined}
          color="var(--s-update)"
        />
      </div>
    </section>
  )
}
