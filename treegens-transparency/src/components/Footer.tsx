import { SITES } from '../config'

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 text-sm text-ink-2 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <a href={SITES.org.url} target="_blank" rel="noreferrer noopener" aria-label="treegens.org" className="shrink-0">
            <img src="/brand/lockup-ink.svg" alt="Treegens" className="tg-light-only h-8 w-auto" />
            <img src="/brand/lockup-lime.svg" alt="Treegens" className="tg-dark-only h-8 w-auto" />
          </a>
          <p className="max-w-md">
            <strong className="text-ink">Treegens Transparency</strong> is the open ledger behind{' '}
            <a className="tg-link" href={SITES.org.url} target="_blank" rel="noreferrer noopener">
              treegens.org
            </a>
            . Built on Base; every figure on this page is a sum over transactions you can open yourself.
          </p>
        </div>
        <nav className="flex flex-wrap gap-4" aria-label="Treegens sites">
          {Object.values(SITES).map(s => (
            <a key={s.url} className="tg-link" href={s.url} target="_blank" rel="noreferrer noopener">
              {s.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  )
}
