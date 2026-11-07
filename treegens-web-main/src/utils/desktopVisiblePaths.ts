/** Routes that must render on desktop (not hidden behind the mobile-only gate). */
export function isDesktopVisiblePath(pathname: string): boolean {
  if (pathname === '/auth') return true
  // GWR record pages: clips get pulled down on a laptop, not a phone.
  if (pathname === '/gwr' || pathname === '/gwr-vids') return true
  if (pathname === '/submissions/create') return true
  if (pathname.startsWith('/submissions/create/')) return true
  if (/^\/submissions\/[a-fA-F0-9]{24}$/.test(pathname)) return true
  return false
}
