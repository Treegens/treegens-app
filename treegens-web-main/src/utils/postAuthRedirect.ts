/**
 * Where to send the user after they sign in.
 *
 * The invite link `/otc/join/<code>` is opened by planters who have never used
 * the app. They must sign in first, and without this they would land on the
 * home page and lose the invite. Only same-origin relative paths are stored
 * so a crafted link can never bounce someone to another site.
 *
 * Stored in `localStorage` with a 1-hour TTL (not `sessionStorage`): on
 * low-end Android a magic link or OAuth return often opens a NEW tab, whose
 * sessionStorage is empty. The auth page also receives the target as `?next=`
 * so the stored value is refreshed from whichever tab finishes sign-in.
 */
import { routes } from '@/config/appConfig'

const KEY = 'tg_post_auth_redirect'
const TTL_MS = 60 * 60 * 1000

type Stored = { path: string; expiresAt: number }

/** The login page itself must never be a post-login target (it would loop). */
function isLoginPath(path: string): boolean {
  const login = routes.Login
  return (
    path === login ||
    path.startsWith(`${login}?`) ||
    path.startsWith(`${login}/`) ||
    path.startsWith(`${login}#`)
  )
}

export function isSafeRedirectPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !/[\s\\]/.test(path) &&
    path.length < 512 &&
    !isLoginPath(path)
  )
}

function readStored(): Stored | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    // Legacy format: a bare path (pre-TTL). Treat as fresh.
    if (raw.startsWith('/')) {
      return isSafeRedirectPath(raw)
        ? { path: raw, expiresAt: Date.now() + TTL_MS }
        : null
    }
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (
      !isSafeRedirectPath(parsed.path) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null
    }
    if (parsed.expiresAt <= Date.now()) {
      clearPostAuthRedirect()
      return null
    }
    return { path: parsed.path, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

export function setPostAuthRedirect(path: string): void {
  if (typeof window === 'undefined') return
  if (!isSafeRedirectPath(path)) return
  try {
    const value: Stored = { path, expiresAt: Date.now() + TTL_MS }
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    /* storage may be blocked (private mode) */
  }
}

/** Returns the stored path when present, safe and not expired. */
export function peekPostAuthRedirect(): string | null {
  return readStored()?.path ?? null
}

/** Read and clear. Returns null when nothing (safe) was stored. */
export function consumePostAuthRedirect(): string | null {
  const v = peekPostAuthRedirect()
  clearPostAuthRedirect()
  return v
}

export function clearPostAuthRedirect(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
