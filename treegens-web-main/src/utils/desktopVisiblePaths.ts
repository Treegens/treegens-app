/** Routes that must render on desktop (not hidden behind the mobile-only gate). */
export function isDesktopVisiblePath(pathname: string): boolean {
  if (pathname === '/auth') return true
  if (pathname === '/submissions/create') return true
  if (pathname.startsWith('/submissions/create/')) return true
  if (/^\/submissions\/[a-fA-F0-9]{24}$/.test(pathname)) return true
  if (pathname === '/sites' || pathname.startsWith('/sites/')) return true
  return false
}
