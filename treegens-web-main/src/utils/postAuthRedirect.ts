/**
 * Where to send the user after they sign in.
 *
 * The invite link `/otc/join/<code>` is opened by planters who have never used
 * the app. They must sign in first, and without this they would land on the
 * home page and lose the invite. Only same-origin relative paths are stored
 * so a crafted link can never bounce someone to another site.
 */
const KEY = 'tg_post_auth_redirect'

function isSafePath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !/[\s\\]/.test(path) &&
    path.length < 512
  )
}

export function setPostAuthRedirect(path: string): void {
  if (typeof window === 'undefined') return
  if (!isSafePath(path)) return
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    /* storage may be blocked (private mode) */
  }
}

export function peekPostAuthRedirect(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const v = sessionStorage.getItem(KEY)
    return v && isSafePath(v) ? v : null
  } catch {
    return null
  }
}

/** Read and clear. Returns null when nothing (safe) was stored. */
export function consumePostAuthRedirect(): string | null {
  const v = peekPostAuthRedirect()
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      /* ignore */
    }
  }
  return v
}

export function clearPostAuthRedirect(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
