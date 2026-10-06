import { useCallback, useEffect, useState } from 'react'
import { getSite } from '@/services/siteService'
import type { ISiteDoc, SiteHydrologyStatus } from '@/types'
import { apiErrorMessage } from '@/utils/apiErrorMessage'

const POLL_MS = 15_000
const RUNNING: SiteHydrologyStatus[] = ['not_started', 'queued', 'processing']

export function isHydrologyRunning(site?: ISiteDoc | null) {
  return !!site && RUNNING.includes(site.hydrology?.status ?? 'not_started')
}

/** Loads one site and refreshes it every 15 s while the satellite check runs. */
export function useSite(siteId: string) {
  const [site, setSite] = useState<ISiteDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = useCallback(
    async (silent = false) => {
      if (!siteId) return
      try {
        const { data } = await getSite(siteId)
        setSite(data.data)
        setError('')
      } catch (e) {
        console.error('Failed to load site', e)
        if (!silent) setError(apiErrorMessage(e, 'Could not load this site.'))
      } finally {
        setLoading(false)
      }
    },
    [siteId],
  )

  useEffect(() => {
    setLoading(true)
    void reload()
  }, [reload])

  const running = isHydrologyRunning(site)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => void reload(true), POLL_MS)
    return () => clearInterval(id)
  }, [running, reload])

  return { site, setSite, loading, error, reload }
}
