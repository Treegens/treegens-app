import { useEffect, useState, type ReactNode } from 'react'
import { addressUrl, txUrl } from '../../lib/explorer'
import { shortAddress, shortHash } from '../../lib/format'
import { Icon } from './Icon'

export function Section({
  id,
  kicker,
  title,
  lede,
  children,
  aside,
}: {
  id: string
  kicker: string
  title: string
  lede?: string
  children: ReactNode
  aside?: ReactNode
}) {
  return (
    <section id={id} className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 md:py-20" aria-labelledby={`${id}-title`}>
      <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl">
          <p className="tg-kicker">{kicker}</p>
          <h2 id={`${id}-title`} className="tg-section-title mt-2">
            {title}
          </h2>
          {lede ? <p className="mt-3 text-base leading-relaxed text-ink-2">{lede}</p> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function KindBadge({ label, color, icon, compact = false }: { label: string; color: string; icon: Parameters<typeof Icon>[0]['name']; compact?: boolean }) {
  return (
    <span className="tg-chip" style={{ borderColor: color }}>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full" style={{ background: color, color: 'var(--surface)' }}>
        <Icon name={icon} size={11} strokeWidth={2.4} />
      </span>
      {compact ? null : <span>{label}</span>}
    </span>
  )
}

export function TxLink({ hash, label = 'View on Basescan', small = true }: { hash?: string | null; label?: string; small?: boolean }) {
  const url = txUrl(hash)
  if (!url) return null
  return (
    <a className={`tg-btn ${small ? 'tg-btn-sm' : ''}`} href={url} target="_blank" rel="noreferrer noopener" title={hash || ''}>
      <Icon name="chain" size={14} />
      <span>{label}</span>
      <span className="tg-mono text-ink-3">{shortHash(hash)}</span>
      <Icon name="external" size={13} />
    </a>
  )
}

export function AddressChip({ address, label, name }: { address?: string | null; label?: string; name?: string }) {
  if (!address) return null
  const url = addressUrl(address)
  const text = name ? `${name}` : label || 'Wallet'
  return (
    <a
      className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-xs text-ink-2 hover:border-accent"
      href={url || '#'}
      target="_blank"
      rel="noreferrer noopener"
      title={address}
    >
      <span className="font-semibold text-ink">{text}</span>
      <span className="tg-mono text-ink-3">{shortAddress(address)}</span>
    </a>
  )
}

export function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1500)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-hairline text-ink-2 hover:border-accent"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => setDone(true))
      }}
      aria-label={done ? 'Copied' : 'Copy address'}
      title={done ? 'Copied' : 'Copy'}
    >
      <Icon name={done ? 'check' : 'copy'} size={13} />
    </button>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`tg-skeleton ${className}`} aria-hidden="true" />
}

export function Stat({ label, value, sub, accent = false }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className="tg-card-2 p-4">
      <p className="text-xs font-semibold text-ink-3">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tracking-tight ${accent ? 'text-accent' : 'text-ink'}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-ink-2">{sub}</p> : null}
    </div>
  )
}

export function VideoPlayer({
  src,
  landscape = false,
  autoPlayOnHover = true,
  caption,
}: {
  src: string | null | undefined
  landscape?: boolean
  autoPlayOnHover?: boolean
  caption?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className={`tg-video ${landscape ? 'tg-video-landscape' : ''} flex items-center justify-center bg-surface-3`}>
        <div className="flex flex-col items-center gap-2 p-4 text-center text-xs text-ink-3">
          <Icon name="camera" size={22} />
          <span>{src ? 'Video unavailable right now' : 'No video yet'}</span>
        </div>
      </div>
    )
  }
  return (
    <figure className="m-0">
      <div className={`tg-video ${landscape ? 'tg-video-landscape' : ''}`}>
        <video
          src={src}
          controls
          playsInline
          muted
          loop
          preload="metadata"
          onError={() => setFailed(true)}
          onMouseEnter={e => {
            if (autoPlayOnHover) void (e.currentTarget as HTMLVideoElement).play().catch(() => {})
          }}
        />
      </div>
      {caption ? <figcaption className="mt-2 text-xs text-ink-2">{caption}</figcaption> : null}
    </figure>
  )
}

export function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const [pos, setPos] = useState({ left: x + 14, top: y + 14 })
  useEffect(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    setPos({ left: x + 14 + 280 > w ? x - 290 : x + 14, top: y + 14 + 140 > h ? y - 150 : y + 14 })
  }, [x, y])
  return (
    <div className="tg-tooltip" style={pos} role="tooltip">
      {children}
    </div>
  )
}
