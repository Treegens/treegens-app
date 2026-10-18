import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useReducedMotion } from '../hooks/usePolling'
import type { FlowItem, FlowKind, Overview } from '../lib/api'
import { formatInt, formatUsd, formatWei } from '../lib/format'
import { KINDS } from '../lib/kinds'
import { SITES } from '../config'
import { Tooltip } from './ui/Bits'
import { Icon } from './ui/Icon'

/**
 * The money river. Left: where funding comes from. Middle: the Treegens
 * protocol on Base. Right: where it goes, and the proof that flows back.
 *
 * Ribbon width = number of transactions on that flow (one unit for every
 * ribbon, so widths are comparable). Each ribbon is labelled at its node and
 * in the legend — colour never carries identity alone.
 */

const W = 1200
const H = 560

type Ribbon = {
  key: string
  kind: FlowKind
  from: { x: number; y: number }
  to: { x: number; y: number }
  count: number
  label: string
  amount: string
  blurb: string
  dashed?: boolean
}

type Node = {
  key: string
  x: number
  y: number
  w: number
  h: number
  title: string
  lines: string[]
  href?: string
  tone: 'source' | 'core' | 'outcome' | 'proof'
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`
}

function layout(o: Overview | null) {
  const t = o?.totals
  const fundingCount = t?.funding.byRail?.card ?? 0
  const mgroRailCount = t?.funding.byRail?.mgro ?? 0
  const planterPayouts = Math.max(0, Math.round((t?.funding.onchainPayoutCount ?? 0) * 0.5))
  const verifierPayouts = Math.max(0, (t?.funding.onchainPayoutCount ?? 0) - planterPayouts)
  const mints = t?.rewards.mintCount ?? 0
  const planterMints = Math.round(mints * 0.4)
  const verifierMints = mints - planterMints
  const burns = t?.retired.burnCount ?? 0
  const updates = (t?.plantings.approved ?? 0) + (t?.updates.healthChecksApproved ?? 0)
  const donations = t?.donations && t.donations.count > 0 ? t.donations : null

  const src = { x: 40, w: 230 }
  const core = { x: 470, w: 260, y: 80, h: 400 }
  const out = { x: 940, w: 220 }

  const nodes: Node[] = [
    {
      key: 'world',
      tone: 'source',
      x: src.x,
      y: 72,
      w: src.w,
      h: 84,
      title: SITES.world.label,
      href: SITES.world.url,
      lines: t
        ? [`${formatUsd(t.funding.grossUsd)} · ${formatInt(fundingCount + mgroRailCount)} purchases`, 'Card checkout for verified trees']
        : ['Card checkout for verified trees'],
    },
    {
      key: 'foundation',
      tone: 'source',
      x: src.x,
      y: 206,
      w: src.w,
      h: 84,
      title: SITES.foundation.label,
      href: SITES.foundation.url,
      lines: donations
        ? [
            `${formatUsd(donations.usd)} · ${formatInt(donations.count)} donation${donations.count === 1 ? '' : 's'}`,
            'Bank → Stripe (USDC) → $MGRO on Base',
          ]
        : ['Donations & grants → treasury Safe', 'Live balance in Contracts below'],
    },
    {
      key: 'holders',
      tone: 'source',
      x: src.x,
      y: 340,
      w: src.w,
      h: 84,
      title: '$MGRO holders',
      href: SITES.burn.url,
      lines: t ? [`${formatWei(t.retired.mgroBurnedWei)} MGRO burned · ${formatInt(burns)} burns`, 'Retire trees on burn.treegens.app'] : ['Retire trees on burn.treegens.app'],
    },
    {
      key: 'core',
      tone: 'core',
      x: core.x,
      y: core.y,
      w: core.w,
      h: core.h,
      title: 'Treegens on Base',
      lines: [
        'Relayer swaps USD → $TGN',
        '95% planter · 5% verifiers',
        'VerifierMinter mints 1 $MGRO per tree',
        'once staked verifiers approve',
        'Treasury: 2-of-4 Safe',
      ],
    },
    {
      key: 'planters',
      tone: 'outcome',
      x: out.x,
      y: 60,
      w: out.w,
      h: 96,
      title: 'Planters',
      lines: t
        ? [`${formatWei(t.funding.onchainTgnToPlantersWei)} TGN · ${formatInt(planterPayouts)} payouts`, `${formatWei(t.rewards.toPlantersWei)} MGRO · 6-step vesting`]
        : ['95% of funding in $TGN', '$MGRO rewards vest over 3 years'],
    },
    {
      key: 'verifiers',
      tone: 'outcome',
      x: out.x,
      y: 190,
      w: out.w,
      h: 96,
      title: 'Verifiers',
      lines: t
        ? [`${formatWei(t.funding.onchainTgnToVerifiersWei)} TGN · ${formatInt(verifierPayouts)} payouts`, `${formatWei(t.rewards.toVerifiersWei)} MGRO · ${formatInt(t.plantings.verifiers)} staked wallets`]
        : ['5% of funding in $TGN', '5% of $MGRO rewards'],
    },
    {
      key: 'retired',
      tone: 'outcome',
      x: out.x,
      y: 320,
      w: out.w,
      h: 84,
      title: 'Retired forever',
      lines: t ? [`${formatWei(t.retired.mgroBurnedWei)} MGRO · ${formatInt(t.retired.funders)} funders`, 'Burned to the zero address'] : ['$MGRO burned to the zero address'],
    },
    {
      key: 'proof',
      tone: 'proof',
      x: out.x,
      y: 438,
      w: out.w,
      h: 96,
      title: 'Proof flows back',
      lines: t
        ? [`${formatInt(t.plantings.approved)} plantings · ${formatInt(t.updates.healthChecksApproved)} growth updates`, `${formatInt(t.updates.videos.total)} videos, GPS + AI count`]
        : ['Planting videos & growth updates'],
    },
  ]

  const n = (k: string) => nodes.find(x => x.key === k)!
  const right = (k: string, dy = 0) => ({ x: n(k).x + n(k).w, y: n(k).y + n(k).h / 2 + dy })
  const left = (k: string, dy = 0) => ({ x: n(k).x, y: n(k).y + n(k).h / 2 + dy })

  const ribbons: Ribbon[] = [
    {
      key: 'funding',
      kind: 'funding',
      from: right('world'),
      to: left('core', -120),
      count: fundingCount + mgroRailCount,
      label: 'Funding in',
      amount: t ? formatUsd(t.funding.grossUsd) : '',
      blurb: 'Card and direct-$MGRO purchases of verified plantings on world.treegens.app.',
    },
    {
      key: 'donations',
      kind: 'donation',
      from: right('foundation'),
      to: left('core', 0),
      count: donations ? donations.count : 0,
      label: 'Donations',
      amount: donations ? formatUsd(donations.usd) : 'treasury Safe',
      blurb: donations
        ? `Gifts to treegensfoundation.org: ${formatInt(donations.count)} received at the bank, ${formatWei(donations.mgroBoughtWei)} MGRO bought so far. Each one is swept to Stripe, paid out as USDC on Base and swapped for $MGRO.`
        : 'Donations through treegensfoundation.org land in the Treegens treasury Safe. Its live balance is read from Base in the Contracts section.',
      dashed: !donations,
    },
    {
      key: 'burn-in',
      kind: 'retire',
      from: right('holders'),
      to: left('core', 120),
      count: burns,
      label: '$MGRO sent to burn',
      amount: t ? `${formatWei(t.retired.mgroBurnedWei)} MGRO` : '',
      blurb: 'Holders burn $MGRO against verified trees; the burn is final and public.',
    },
    {
      key: 'payout-planters',
      kind: 'payout',
      from: right('core', -150),
      to: left('planters', -16),
      count: planterPayouts,
      label: '$TGN to planters (95%)',
      amount: t ? `${formatWei(t.funding.onchainTgnToPlantersWei)} TGN` : '',
      blurb: 'Each purchase is swapped to $TGN and 95% is sent straight to the planter wallet.',
    },
    {
      key: 'reward-planters',
      kind: 'reward',
      from: right('core', -110),
      to: left('planters', 16),
      count: planterMints,
      label: '$MGRO rewards to planters',
      amount: t ? `${formatWei(t.rewards.toPlantersWei)} MGRO` : '',
      blurb: 'One $MGRO per tree, 95% to the planter, vested over six survival checkpoints with a growth video at each.',
    },
    {
      key: 'payout-verifiers',
      kind: 'payout',
      from: right('core', -50),
      to: left('verifiers', -16),
      count: verifierPayouts,
      label: '$TGN to verifiers (5%)',
      amount: t ? `${formatWei(t.funding.onchainTgnToVerifiersWei)} TGN` : '',
      blurb: '5% of each purchase is split across the staked verifiers who approved the planting.',
    },
    {
      key: 'reward-verifiers',
      kind: 'reward',
      from: right('core', -10),
      to: left('verifiers', 16),
      count: verifierMints,
      label: '$MGRO rewards to verifiers',
      amount: t ? `${formatWei(t.rewards.toVerifiersWei)} MGRO` : '',
      blurb: '5% of every planting reward goes to the verifiers who voted yes.',
    },
    {
      key: 'retire',
      kind: 'retire',
      from: right('core', 60),
      to: left('retired'),
      count: burns,
      label: '$MGRO retired',
      amount: t ? `${formatWei(t.retired.mgroBurnedWei)} MGRO` : '',
      blurb: 'Burned tokens leave circulation forever: the on-chain proof that a funder retired these trees.',
    },
    {
      key: 'proof',
      kind: 'update',
      from: right('core', 150),
      to: left('proof'),
      count: updates,
      label: 'Impact updates out',
      amount: t ? `${formatInt(t.updates.videos.total)} videos` : '',
      blurb: 'Before/after planting videos, AI seedling counts and growth check-ins, all public with GPS.',
    },
  ]
  return { nodes, ribbons }
}

type Particle = { ribbon: number; t: number; speed: number; size: number }

export function FlowRiver({
  overview,
  recent,
  onPick,
}: {
  overview: Overview | null
  recent: FlowItem[]
  onPick: (kind: FlowKind) => void
}) {
  const reduced = useReducedMotion()
  const { nodes, ribbons } = useMemo(() => layout(overview), [overview])
  const maxCount = Math.max(1, ...ribbons.map(r => r.count))
  const width = (r: Ribbon) => (r.count === 0 ? 3 : 7 + 34 * Math.sqrt(r.count / maxCount))
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const pathRefs = useRef<(SVGPathElement | null)[]>([])
  const particleLayer = useRef<SVGGElement | null>(null)
  const burstLayer = useRef<SVGGElement | null>(null)
  const samples = useRef<{ x: number; y: number }[][]>([])
  const [compact, setCompact] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const seenIds = useRef<Set<string>>(new Set())
  const burstQueue = useRef<{ ribbon: number; label: string; color: string; born: number }[]>([])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setCompact(e.contentRect.width < 720)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Sample every ribbon path once per layout so particles can ride it cheaply.
  useLayoutEffect(() => {
    samples.current = ribbons.map((_, i) => {
      const p = pathRefs.current[i]
      if (!p) return []
      const len = p.getTotalLength()
      const pts: { x: number; y: number }[] = []
      for (let k = 0; k <= 120; k++) {
        const pt = p.getPointAtLength((len * k) / 120)
        pts.push({ x: pt.x, y: pt.y })
      }
      return pts
    })
  }, [ribbons, compact])

  // Recent ledger items become labelled bursts on their ribbon.
  useEffect(() => {
    if (!recent.length) return
    const first = seenIds.current.size === 0
    for (const item of recent.slice(0, 12)) {
      if (seenIds.current.has(item.id)) continue
      seenIds.current.add(item.id)
      if (first) continue
      const ribbonIndex = ribbons.findIndex(r => {
        if (item.kind === 'payout') return item.meta?.role === 'verifier' ? r.key === 'payout-verifiers' : r.key === 'payout-planters'
        if (item.kind === 'reward') return item.meta?.role === 'verifier' ? r.key === 'reward-verifiers' : r.key === 'reward-planters'
        if (item.kind === 'retire') return r.key === 'retire'
        if (item.kind === 'funding') return r.key === 'funding'
        if (item.kind === 'donation') return r.key === 'donations'
        if (item.kind === 'verified' || item.kind === 'update') return r.key === 'proof'
        return false
      })
      if (ribbonIndex < 0) continue
      const label = item.amount
        ? item.amount.token === 'USD'
          ? formatUsd(item.amount.value)
          : `${formatWei(item.amount.wei)} ${item.amount.token}`
        : item.kind === 'update'
          ? 'growth update'
          : 'verified'
      burstQueue.current.push({ ribbon: ribbonIndex, label, color: KINDS[item.kind].color, born: performance.now() })
    }
  }, [recent, ribbons])

  // Particle animation — DOM updated directly, no React re-render per frame.
  useEffect(() => {
    if (compact) return
    const layer = particleLayer.current
    const bursts = burstLayer.current
    if (!layer || !bursts) return
    const particles: Particle[] = []
    ribbons.forEach((r, i) => {
      if (r.count === 0) return
      const n = Math.max(2, Math.min(14, Math.round((r.count / maxCount) * 14)))
      for (let k = 0; k < n; k++) {
        particles.push({ ribbon: i, t: k / n, speed: 0.09 + 0.05 * Math.random(), size: 2.6 + Math.random() * 1.6 })
      }
    })
    layer.replaceChildren()
    const ns = 'http://www.w3.org/2000/svg'
    const els = particles.map(p => {
      const g = document.createElementNS(ns, 'g')
      const halo = document.createElementNS(ns, 'circle')
      halo.setAttribute('r', String(p.size * 2.6))
      halo.setAttribute('fill', KINDS[ribbons[p.ribbon].kind].color)
      halo.setAttribute('opacity', '0.22')
      const core = document.createElementNS(ns, 'circle')
      core.setAttribute('r', String(p.size))
      core.setAttribute('fill', KINDS[ribbons[p.ribbon].kind].color)
      core.setAttribute('stroke', 'var(--chart-surface)')
      core.setAttribute('stroke-width', '1.5')
      g.append(halo, core)
      layer.append(g)
      return g
    })
    let raf = 0
    let last = performance.now()
    const place = (g: SVGGElement, ribbon: number, t: number) => {
      const pts = samples.current[ribbon]
      if (!pts || !pts.length) return
      const idx = Math.min(pts.length - 1, Math.max(0, Math.round(t * (pts.length - 1))))
      const pt = pts[idx]
      g.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`)
    }
    if (reduced) {
      particles.forEach((p, i) => place(els[i], p.ribbon, p.t))
      return
    }
    const burstEls = new Map<number, SVGGElement>()
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      particles.forEach((p, i) => {
        p.t += p.speed * dt
        if (p.t > 1) p.t -= 1
        place(els[i], p.ribbon, p.t)
      })
      // bursts: travel once over 4.5s then vanish
      const queue = burstQueue.current
      for (let i = queue.length - 1; i >= 0; i--) {
        const b = queue[i]
        const age = (now - b.born) / 1000
        const t = age / 4.5
        let g = burstEls.get(b.born)
        if (!g) {
          g = document.createElementNS(ns, 'g')
          const c = document.createElementNS(ns, 'circle')
          c.setAttribute('r', '6')
          c.setAttribute('fill', b.color)
          c.setAttribute('stroke', 'var(--chart-surface)')
          c.setAttribute('stroke-width', '2')
          const bg = document.createElementNS(ns, 'rect')
          bg.setAttribute('x', '10')
          bg.setAttribute('y', '-11')
          bg.setAttribute('rx', '6')
          bg.setAttribute('height', '22')
          bg.setAttribute('width', String(b.label.length * 7 + 14))
          bg.setAttribute('fill', 'var(--surface)')
          bg.setAttribute('stroke', b.color)
          const txt = document.createElementNS(ns, 'text')
          txt.setAttribute('x', '17')
          txt.setAttribute('y', '4')
          txt.setAttribute('class', 'tg-river-label')
          txt.textContent = b.label
          g.append(c, bg, txt)
          bursts.append(g)
          burstEls.set(b.born, g)
        }
        if (t >= 1) {
          g.remove()
          burstEls.delete(b.born)
          queue.splice(i, 1)
          continue
        }
        place(g, b.ribbon, t)
        g.setAttribute('opacity', String(t > 0.85 ? (1 - t) / 0.15 : 1))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      bursts.replaceChildren()
    }
  }, [ribbons, maxCount, reduced, compact])

  const onMove = (i: number) => (e: MouseEvent) => setHover({ i, x: e.clientX, y: e.clientY })

  const legend = (['funding', 'payout', 'reward', 'retire', 'update'] as FlowKind[]).map(k => KINDS[k])

  return (
    <div ref={wrapRef}>
      {compact ? (
        <ul className="grid gap-3">
          {ribbons.map(r => (
            <li key={r.key}>
              <button
                type="button"
                className="tg-card-2 flex w-full items-center gap-3 p-3 text-left"
                onClick={() => onPick(r.kind)}
              >
                <span className="h-10 w-1.5 rounded-full" style={{ background: KINDS[r.kind].color, opacity: r.dashed ? 0.5 : 1 }} aria-hidden="true" />
                <span className="flex-1">
                  <span className="block text-sm font-bold">{r.label}</span>
                  <span className="block text-xs text-ink-2">{r.amount}{r.count ? ` · ${formatInt(r.count)} tx` : ''}</span>
                </span>
                <Icon name="arrow" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="tg-card overflow-hidden p-2 md:p-4" style={{ background: 'var(--chart-surface)' }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Diagram of funding flowing into the Treegens protocol on Base and out to planters, verifiers, retired tokens and public proof.">
            <defs>
              <filter id="tg-soft" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
            </defs>

            {/* ribbons */}
            <g onMouseLeave={() => setHover(null)}>
              {ribbons.map((r, i) => {
                const w = width(r)
                const color = KINDS[r.kind].color
                const dim = hover !== null && hover.i !== i
                return (
                  <g key={r.key} className={`tg-ribbon ${dim ? 'tg-ribbon-dim' : ''}`} onMouseMove={onMove(i)} onMouseEnter={onMove(i)} onClick={() => onPick(r.kind)} role="button" tabIndex={0} aria-label={`${r.label}: ${r.amount}${r.count ? `, ${r.count} transactions` : ''}. Show in ledger.`} onKeyDown={e => e.key === 'Enter' && onPick(r.kind)}>
                    <path d={curve(r.from, r.to)} stroke={color} strokeOpacity={0.14} strokeWidth={w + 10} fill="none" filter="url(#tg-soft)" />
                    <path
                      ref={el => {
                        pathRefs.current[i] = el
                      }}
                      d={curve(r.from, r.to)}
                      stroke={color}
                      strokeOpacity={r.dashed ? 0.35 : 0.42}
                      strokeWidth={w}
                      strokeDasharray={r.dashed ? '6 8' : undefined}
                      fill="none"
                    />
                    <path d={curve(r.from, r.to)} stroke="transparent" strokeWidth={Math.max(24, w + 16)} fill="none" />
                  </g>
                )
              })}
            </g>

            <g ref={particleLayer} pointerEvents="none" />
            <g ref={burstLayer} pointerEvents="none" />

            {/* nodes */}
            {nodes.map(nd => {
              const fill = nd.tone === 'core' ? 'var(--surface-2)' : 'var(--surface)'
              const stroke = nd.tone === 'core' ? 'var(--accent)' : 'var(--hairline-strong)'
              return (
                <g key={nd.key}>
                  <rect x={nd.x} y={nd.y} width={nd.w} height={nd.h} rx={16} fill={fill} stroke={stroke} strokeWidth={nd.tone === 'core' ? 1.5 : 1} />
                  {nd.tone === 'core' ? <rect x={nd.x} y={nd.y} width={nd.w} height={6} rx={3} fill="var(--accent)" /> : null}
                  <text x={nd.x + 16} y={nd.y + 28} className="tg-river-label" style={{ fontSize: nd.tone === 'core' ? 15 : 13 }}>
                    {nd.title}
                  </text>
                  {nd.lines.map((line, k) => (
                    <text key={k} x={nd.x + 16} y={nd.y + 48 + k * 16} className={nd.tone === 'core' ? 'tg-river-sub' : k === 0 ? 'tg-river-sub' : 'tg-river-muted'}>
                      {line}
                    </text>
                  ))}
                  {nd.href ? (
                    <a href={nd.href} target="_blank" rel="noreferrer noopener">
                      <text x={nd.x + nd.w - 16} y={nd.y + 28} textAnchor="end" className="tg-river-muted" style={{ textDecoration: 'underline' }}>
                        open ↗
                      </text>
                    </a>
                  ) : null}
                </g>
              )
            })}

            {/* column captions */}
            <text x={40} y={40} className="tg-river-muted" style={{ letterSpacing: '0.2em', fontWeight: 800 }}>MONEY IN</text>
            <text x={470} y={40} className="tg-river-muted" style={{ letterSpacing: '0.2em', fontWeight: 800 }}>ON BASE</text>
            <text x={940} y={40} className="tg-river-muted" style={{ letterSpacing: '0.2em', fontWeight: 800 }}>MONEY OUT · PROOF BACK</text>
          </svg>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-2" aria-label="Legend">
        {legend.map(k => (
          <span key={k.key} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-5 rounded-full" style={{ background: k.color }} aria-hidden="true" />
            <span className="font-semibold text-ink">{k.label}</span>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-5 border-t-2 border-dashed" style={{ borderColor: 'var(--s-funding)' }} aria-hidden="true" />
          <span>not yet measured on-chain</span>
        </span>
        <span className="ml-auto text-ink-3">Ribbon width = number of transactions · click a ribbon to filter the ledger</span>
      </div>

      {hover !== null && !compact ? (
        <Tooltip x={hover.x} y={hover.y}>
          <strong>{ribbons[hover.i].label}</strong>
          <div className="mt-1 text-sm font-bold text-ink">{ribbons[hover.i].amount || '—'}</div>
          <div className="mt-0.5">{ribbons[hover.i].count ? `${formatInt(ribbons[hover.i].count)} on-chain transactions` : 'No transactions indexed yet'}</div>
          <div className="mt-1.5 leading-snug">{ribbons[hover.i].blurb}</div>
          <div className="mt-1.5 font-semibold text-accent">Click to filter the ledger</div>
        </Tooltip>
      ) : null}
    </div>
  )
}
