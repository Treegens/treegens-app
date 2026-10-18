import { useCallback, useEffect, useRef, useState } from 'react'

export type Poll<T> = {
  data: T | null
  error: Error | null
  loading: boolean
  updatedAt: number | null
  refresh: () => void
}

/**
 * Fetch once, then every `intervalMs`. Keeps the last good value on error so
 * the page never flashes empty (the dataviz "refetch keeps the frame" rule).
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): Poll<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    fetcherRef
      .current(controller.signal)
      .then(value => {
        if (cancelled) return
        setData(value)
        setError(null)
        setUpdatedAt(Date.now())
      })
      .catch(err => {
        if (cancelled || controller.signal.aborted) return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    const timer = window.setInterval(() => setTick(t => t + 1), intervalMs)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, intervalMs, ...deps])

  const refresh = useCallback(() => setTick(t => t + 1), [])
  return { data, error, loading, updatedAt, refresh }
}

/** Tracks `prefers-reduced-motion` so animation can step aside. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** Simple hash router: `#/planting/<id>` opens a planting. */
export function useHashRoute(): { route: string; navigate: (hash: string) => void } {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, ''))
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace(/^#/, ''))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const navigate = useCallback((hash: string) => {
    if (hash) window.location.hash = hash
    else history.replaceState(null, '', window.location.pathname + window.location.search)
    setRoute(hash.replace(/^#/, ''))
  }, [])
  return { route, navigate }
}
