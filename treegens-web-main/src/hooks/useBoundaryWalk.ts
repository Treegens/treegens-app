import { useCallback, useEffect, useRef, useState } from 'react'

export interface GpsFix {
  latitude: number
  longitude: number
  accuracy: number
}

/** GeolocationPositionError.PERMISSION_DENIED */
const PERMISSION_DENIED = 1

const GEO_ERRORS: Record<number, string> = {
  [PERMISSION_DENIED]: 'Location access denied by user',
  2: 'Location information unavailable',
  3: 'Location request timed out',
}

/**
 * Streams GPS fixes to `onFix` while the planter walks a site boundary.
 * Unlike useGeolocation it keeps exactly one watch and always clears it.
 */
export function useBoundaryWalk(onFix: (fix: GpsFix) => void) {
  const [watching, setWatching] = useState(false)
  const [lastFix, setLastFix] = useState<GpsFix | null>(null)
  const [error, setError] = useState<string | null>(null)
  const watchIdRef = useRef<number | null>(null)
  const onFixRef = useRef(onFix)

  useEffect(() => {
    onFixRef.current = onFix
  }, [onFix])

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    watchIdRef.current = null
    setWatching(false)
  }, [])

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('Location is not available on this phone')
      return
    }
    if (watchIdRef.current !== null) return
    setError(null)
    const id = navigator.geolocation.watchPosition(
      pos => {
        const fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }
        setError(null)
        setLastFix(fix)
        onFixRef.current(fix)
      },
      err => {
        setError(GEO_ERRORS[err.code] ?? 'Could not read your location')
        // A refusal ends the watch for good; drop it so start() asks again.
        if (err.code === PERMISSION_DENIED && watchIdRef.current === id) stop()
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    )
    watchIdRef.current = id
    setWatching(true)
  }, [stop])

  useEffect(() => stop, [stop])

  return { watching, lastFix, error, start, stop }
}
