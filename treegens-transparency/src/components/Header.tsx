import { Icon } from './ui/Icon'

export type ThemeMode = 'system' | 'light' | 'dark'

const NAV = [
  { href: '#flows', label: 'Flows' },
  { href: '#ledger', label: 'Ledger' },
  { href: '#plantings', label: 'Plantings' },
  { href: '#map', label: 'Map' },
  { href: '#contracts', label: 'Contracts' },
]

export function Header({
  theme,
  onCycleTheme,
  live,
}: {
  theme: ThemeMode
  onCycleTheme: () => void
  live: { ok: boolean; label: string }
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-page/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5" aria-label="Treegens Transparency, back to top">
          {/* The Treegens mark and wordmark, as on treegens.org and treegens.app. */}
          <img src="/brand/mark.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0" />
          <span className="flex flex-col items-start leading-none">
            <img src="/brand/wordmark-ink.svg" alt="Treegens" className="tg-light-only h-[1.15rem] w-auto" />
            <img src="/brand/wordmark-lime.svg" alt="Treegens" className="tg-dark-only h-[1.15rem] w-auto" />
            <span className="mt-1 text-[10.5px] font-bold uppercase tracking-[0.22em] text-ink-3">Transparency</span>
          </span>
        </a>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Sections">
          {NAV.map(n => (
            <a key={n.href} href={n.href} className="rounded-full px-3 py-1.5 text-sm font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <span className="tg-chip" title={live.label}>
            <span className="tg-pulse" style={{ background: live.ok ? 'var(--good)' : 'var(--warning)' }} />
            <span className="hidden sm:inline">{live.ok ? 'Live on Base' : 'Connecting…'}</span>
          </span>
          <button
            type="button"
            className="tg-btn !px-2.5"
            onClick={onCycleTheme}
            aria-label={`Theme: ${theme}. Click to change.`}
            title={`Theme: ${theme}`}
          >
            <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'globe'} size={15} />
          </button>
        </div>
      </div>
    </header>
  )
}
