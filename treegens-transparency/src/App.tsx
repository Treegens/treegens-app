import { useCallback, useEffect, useMemo, useState } from 'react'
import { Contracts } from './components/Contracts'
import { FlowRiver } from './components/FlowRiver'
import { Footer } from './components/Footer'
import { Header, type ThemeMode } from './components/Header'
import { Hero } from './components/Hero'
import { ImpactMap } from './components/ImpactMap'
import { Ledger, type LedgerFilter } from './components/Ledger'
import { PlantingDrawer } from './components/PlantingDrawer'
import { PlantingsGrid } from './components/PlantingsGrid'
import { Section } from './components/ui/Bits'
import { config, isDemoOnly } from './config'
import { useHashRoute, usePolling } from './hooks/usePolling'
import { api, onSourceChange, type FlowKind } from './lib/api'
import { readChainSnapshot } from './lib/chain'
import { formatInt } from './lib/format'

function useTheme(): [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem('tg-theme')
      return saved === 'light' || saved === 'dark' ? saved : 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    try {
      if (theme === 'system') localStorage.removeItem('tg-theme')
      else localStorage.setItem('tg-theme', theme)
    } catch {
      /* private mode */
    }
  }, [theme])
  const cycle = useCallback(() => setTheme(t => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system')), [])
  return [theme, cycle]
}

export default function App() {
  const [theme, cycleTheme] = useTheme()
  const overview = usePolling(api.overview, config.refreshMs)
  const feed = usePolling(signal => api.flows({ limit: 40 }, signal), config.refreshMs)
  const onchain = usePolling(api.onchain, config.refreshMs)
  const [source, setSource] = useState<{ kind: 'api'; baseUrl: string } | { kind: 'demo' } | null>(null)
  useEffect(() => onSourceChange(setSource), [])
  const demo = source?.kind === 'demo' || isDemoOnly
  const chain = usePolling(signal => (demo ? Promise.reject(new Error('demo')) : readChainSnapshot(signal)), config.refreshMs, [demo])
  const map = usePolling(api.map, config.refreshMs * 2)
  const { route, navigate } = useHashRoute()
  const [filter, setFilter] = useState<LedgerFilter>('all')

  const plantingId = useMemo(() => route.match(/^\/planting\/([a-fA-F0-9]{24})/)?.[1] ?? null, [route])
  const openPlanting = useCallback((id: string) => navigate(`#/planting/${id}`), [navigate])
  const closePlanting = useCallback(() => navigate(''), [navigate])

  const pickKind = useCallback((kind: FlowKind) => {
    setFilter(kind)
    document.getElementById('ledger')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const apiDown = Boolean(overview.error && !overview.data)
  const liveOk = Boolean(overview.data) || Boolean(chain.data)
  const block = chain.data?.blockNumber ?? (onchain.data && onchain.data.available ? onchain.data.blockNumber : null)

  return (
    <>
      <div className="tg-backdrop" aria-hidden="true" />
      <Header
        theme={theme}
        onCycleTheme={cycleTheme}
        live={{
          ok: liveOk,
          label: source?.kind === 'api' ? `API: ${source.baseUrl}${block ? ` · Base block #${formatInt(block)}` : ''}` : apiDown ? 'Ledger API unreachable' : demo ? 'Demo data' : 'Connecting to the ledger',
        }}
      />
      <main>
        <Hero overview={overview.data} loading={overview.loading} error={overview.error} onchain={onchain.data} chain={chain.data} />

        <Section
          id="flows"
          kicker="Follow the money"
          title="From a funder's card to a planter's wallet, with the proof flowing back."
          lede="Every ribbon is a real flow on Base. Hover for totals, click to see each transaction in the ledger. Particles move while the ledger is live."
        >
          <FlowRiver overview={overview.data} recent={feed.data?.items ?? []} onPick={pickKind} />
        </Section>

        <Section
          id="ledger"
          kicker="Live ledger"
          title="Every transaction, newest first."
          lede="Funding in, $TGN payouts, $MGRO rewards and retirements as the chain reports them, interleaved with the verifications and growth updates they pay for."
          aside={
            feed.updatedAt ? (
              <span className="tg-chip">
                <span className="tg-pulse" /> refreshed {new Date(feed.updatedAt).toLocaleTimeString()}
              </span>
            ) : null
          }
        >
          <Ledger initial={feed.data} filter={filter} onFilter={setFilter} onOpenPlanting={openPlanting} apiDown={apiDown} />
        </Section>

        <Section
          id="plantings"
          kicker="The trees"
          title="Watch the plantings the money paid for."
          lede="Before and after videos filmed at the site, the AI seedling count, the verifiers who approved it, the funder's payout and every reward tranche as it vests."
        >
          <PlantingsGrid onOpen={openPlanting} />
        </Section>

        <Section id="map" kicker="Where" title="Every verified planting on the map." lede="GPS captured by the planter's phone at filming time. Click a point to open its full chain of custody.">
          <ImpactMap points={map.data?.points ?? []} onOpenPlanting={openPlanting} />
        </Section>

        <Section
          id="contracts"
          kicker="Proof"
          title="The contracts behind every number."
          lede="Six addresses on Base run the whole system. Open any of them on Basescan; nothing on this page is more than one click from the chain."
        >
          <Contracts overview={overview.data} onchain={onchain.data} chain={chain.data} />
        </Section>
      </main>
      <Footer />
      {demo ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3" role="status">
          <p className="tg-card flex items-center gap-2 px-4 py-2 text-xs font-semibold text-ink shadow-lg" style={{ borderColor: 'var(--warning)' }}>
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--warning)' }} aria-hidden="true" />
            Demo data · fixtures, not the live ledger. Point <code className="tg-mono">config.js</code> at the Treegens API to go live.
          </p>
        </div>
      ) : null}
      {plantingId ? <PlantingDrawer id={plantingId} onClose={closePlanting} /> : null}
    </>
  )
}
