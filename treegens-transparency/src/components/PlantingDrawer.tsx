import { useEffect, useState } from 'react'
import { api, type PlantingDetail } from '../lib/api'
import { formatDate, formatInt, formatUsd, formatWei, shortAddress } from '../lib/format'
import { addressUrl } from '../lib/explorer'
import { config } from '../config'
import { LedgerRow } from './Ledger'
import { AddressChip, Skeleton, TxLink, VideoPlayer } from './ui/Bits'
import { Icon } from './ui/Icon'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-hairline py-2 text-sm last:border-b-0">
      <span className="text-ink-2">{label}</span>
      <span className="text-right font-semibold text-ink">{children}</span>
    </div>
  )
}

export function PlantingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<PlantingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setData(null)
    setError(null)
    api
      .planting(id, controller.signal)
      .then(d => !cancelled && setData(d))
      .catch(e => !cancelled && !controller.signal.aborted && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const funded = data?.funding.status === 'funded' ? data.funding : null
  const jsonUrl = `${config.apiBaseUrl}/api/transparency/plantings/${id}`

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <button type="button" className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" aria-label="Close" onClick={onClose} />
      <aside className="tg-drawer tg-scrollbar relative h-full w-full max-w-2xl overflow-y-auto border-l border-hairline bg-page shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-hairline bg-page/90 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <p className="tg-kicker">Chain of custody</p>
            <h2 id="drawer-title" className="mt-1 truncate text-xl font-extrabold tracking-tight">
              {data ? data.location || 'Verified planting' : 'Loading planting…'}
            </h2>
            {data ? (
              <p className="mt-0.5 text-sm text-ink-2">
                {formatInt(data.trees)} {data.isMangrove ? 'mangroves' : 'trees'}
                {data.species ? ` · ${data.species}` : ''} · verified {formatDate(data.approvedAt)}
                {data.gps ? ` · ${data.gps.lat.toFixed(4)}, ${data.gps.lng.toFixed(4)}` : ''}
              </p>
            ) : null}
          </div>
          <button type="button" className="tg-btn !px-2.5" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        {error ? <p className="p-6 text-sm text-ink-2">Could not load this planting: {error}</p> : null}
        {!data && !error ? (
          <div className="grid gap-4 p-5">
            <Skeleton className="h-64" />
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : null}

        {data ? (
          <div className="grid gap-6 p-5">
            {/* Videos */}
            <section aria-labelledby="videos-title">
              <h3 id="videos-title" className="mb-3 text-sm font-extrabold uppercase tracking-[0.18em] text-ink-3">The proof</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <VideoPlayer src={data.videos.land} caption={<><strong className="text-ink">Before</strong> · plot video{data.landFilmedAt ? ` · ${formatDate(data.landFilmedAt)}` : ''}</>} />
                <VideoPlayer src={data.videos.plant} caption={<><strong className="text-ink">After</strong> · planting video{data.videos.stitched ? ' · verified cut' : ''}{data.plantFilmedAt ? ` · ${formatDate(data.plantFilmedAt)}` : ''}</>} />
                {data.healthChecks.filter(h => h.status === 'approved' && h.videoUrl).map(h => (
                  <VideoPlayer key={h.id} src={h.videoUrl} caption={<><strong className="text-ink">Growth update {h.checkpointIndex}</strong> · {formatInt(h.treesAlive)} alive · {formatDate(h.reviewedAt)}</>} />
                ))}
              </div>
              {data.healthChecks.some(h => h.status === 'pending_review') ? (
                <p className="mt-2 text-xs text-ink-2">A new growth update is awaiting verifier review. Its video becomes public once approved.</p>
              ) : null}
            </section>

            {/* Verification */}
            <section className="tg-card-2 p-4" aria-labelledby="verify-title">
              <h3 id="verify-title" className="mb-2 text-sm font-extrabold uppercase tracking-[0.18em] text-ink-3">Verification</h3>
              <Row label="Planter">
                <AddressChip address={data.planter.address} label="Planter" name={data.planter.name} />
              </Row>
              {data.ai ? (
                <Row label="AI seedling count">
                  {data.ai.counted ?? '—'} counted{data.ai.confidence ? ` · ${Math.round(data.ai.confidence * 100)}% confidence` : ''}
                  {data.declaredTrees !== null ? ` · ${data.declaredTrees} declared` : ''}
                </Row>
              ) : null}
              <Row label="Verifier votes">
                {data.votes.filter(v => v.vote === 'yes').length} yes · {data.votes.filter(v => v.vote === 'no').length} no
              </Row>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.votes.map(v => (
                  <a key={v.wallet} href={v.explorerUrl || addressUrl(v.wallet) || '#'} target="_blank" rel="noreferrer noopener" className="tg-chip" style={{ borderColor: v.vote === 'yes' ? 'var(--good)' : 'var(--critical)' }} title={v.wallet}>
                    <Icon name={v.vote === 'yes' ? 'check' : 'close'} size={11} /> {shortAddress(v.wallet)}
                  </a>
                ))}
              </div>
            </section>

            {/* Funding */}
            <section className="tg-card-2 p-4" aria-labelledby="funding-title">
              <h3 id="funding-title" className="mb-2 text-sm font-extrabold uppercase tracking-[0.18em] text-ink-3">Funding</h3>
              {funded ? (
                <>
                  <Row label="Paid by a funder">{formatUsd(funded.grossUsd)} via {funded.rail === 'mgro' ? 'direct $MGRO' : 'card'} · {formatDate(funded.distributedAt)}</Row>
                  <Row label="To the planter (95%)">
                    <span className="tabular">{formatWei(funded.onchainPlanterTgnWei !== '0' ? funded.onchainPlanterTgnWei : funded.recordedPlanterTgnWei)} TGN</span>
                    {funded.onchainPlanterTgnWei !== '0' ? <span className="ml-1 text-xs text-ink-2">(read from the receipt)</span> : null}
                  </Row>
                  <Row label="To verifiers (5%)">
                    <span className="tabular">{formatWei(funded.onchainVerifierTgnWei !== '0' ? funded.onchainVerifierTgnWei : funded.recordedVerifierTgnWei)} TGN</span> · {funded.verifierPayouts.length} wallets
                  </Row>
                  {funded.mgroBurnedWei !== '0' ? <Row label="$MGRO retired">{formatWei(funded.mgroBurnedWei)} MGRO burned</Row> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {funded.planterTx ? <TxLink hash={funded.planterTx} label="Planter payout" /> : null}
                    {funded.verifierPayouts.slice(0, 4).map(v => (
                      <TxLink key={v.txHash || v.wallet} hash={v.txHash} label={`Verifier ${shortAddress(v.wallet)}`} />
                    ))}
                  </div>
                </>
              ) : data.funding.status === 'reserved' ? (
                <p className="text-sm text-ink-2">A funder is in checkout right now. The payout appears here the moment it lands on Base.</p>
              ) : (
                <p className="text-sm text-ink-2">
                  Not funded yet. Fund it on{' '}
                  <a className="tg-link" href="https://world.treegens.app" target="_blank" rel="noreferrer noopener">
                    world.treegens.app
                  </a>{' '}
                  and the payout will show up here.
                </p>
              )}
            </section>

            {/* Rewards */}
            <section className="tg-card-2 p-4" aria-labelledby="rewards-title">
              <h3 id="rewards-title" className="mb-2 text-sm font-extrabold uppercase tracking-[0.18em] text-ink-3">$MGRO reward schedule</h3>
              {data.rewards ? (
                <>
                  <p className="text-sm text-ink-2">
                    <span className="tabular font-bold text-ink">{formatWei(data.rewards.allocatedWei)} MGRO</span> allocated (1 per tree) · 95% to the planter over {data.tranches.length || 6} checkpoints, 5% to verifiers.
                    Each checkpoint after the first needs a growth video showing how many trees are alive.
                  </p>
                  <ol className="mt-3 grid gap-2">
                    {data.tranches.map(t => (
                      <li key={t.index} className="flex items-center gap-3 text-sm">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-extrabold" style={{ background: t.status === 'paid' ? 'var(--s-reward)' : 'var(--surface-3)', color: t.status === 'paid' ? '#fff' : 'var(--ink-2)' }}>
                          {t.index + 1}
                        </span>
                        <span className="flex-1">
                          <span className="font-semibold text-ink">
                            {t.status === 'paid' ? `Paid ${formatWei(t.amountWei)} MGRO` : t.status === 'processing' ? 'Minting…' : `Unlocks ${formatDate(t.unlockAt)}`}
                          </span>
                          <span className="block text-xs text-ink-2">
                            {t.index === 0 ? 'Released at approval' : 'Needs an approved growth update'}
                            {t.proposalId !== null && t.status !== 'paid' ? ` · proposal #${t.proposalId} awaiting verifiers` : ''}
                          </span>
                        </span>
                        {t.txHash ? <TxLink hash={t.txHash} label="Mint" /> : null}
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="text-sm text-ink-2">Reward allocation pending.</p>
              )}
            </section>

            {/* Timeline */}
            <section aria-labelledby="timeline-title">
              <h3 id="timeline-title" className="mb-3 text-sm font-extrabold uppercase tracking-[0.18em] text-ink-3">Everything that happened, on-chain and off</h3>
              <div className="tg-card overflow-hidden">
                <ul className="m-0 list-none p-0">
                  {data.timeline.length ? (
                    data.timeline.map(item => <LedgerRow key={item.id} item={item} />)
                  ) : (
                    <li className="p-5 text-sm text-ink-2">No ledger entries yet.</li>
                  )}
                </ul>
              </div>
            </section>

            <p className="text-xs text-ink-3">
              Open data:{' '}
              <a className="tg-link" href={jsonUrl} target="_blank" rel="noreferrer noopener">
                this planting as JSON
              </a>
              . Addresses and transactions open on {new URL(config.explorerBaseUrl).hostname}.
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
