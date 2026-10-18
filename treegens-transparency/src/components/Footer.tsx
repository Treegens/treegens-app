import { SITES } from '../config'

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-10 text-sm text-ink-2 sm:px-6 md:flex-row md:items-center md:justify-between">
        <p>
          <strong className="text-ink">Treegens Open Ledger</strong> · built on Base · every figure on this page is a sum over transactions you can open yourself.
        </p>
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
