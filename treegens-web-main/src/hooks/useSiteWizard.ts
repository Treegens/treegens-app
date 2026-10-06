import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { PendingPhotos } from '@/modules/siteCheck/sendSite'
import {
  formAnchor,
  formToDraft,
  type SiteForm,
} from '@/modules/siteCheck/siteForm'
import { reverseGeocode } from '@/services/geocodingService'
import type { IGpsCoordinates, SitePhotoKind } from '@/types'
import {
  clearSiteDraft,
  readSiteDraft,
  saveSiteDraft,
  type SiteDraft,
  siteDraftHasContent,
} from '@/utils/siteDraftStore'

/** Photos picked in the wizard, with preview URLs that are always revoked. */
export function usePendingPhotos() {
  const [pending, setPending] = useState<PendingPhotos>({})
  const pendingRef = useRef<PendingPhotos>({})

  const update = (next: PendingPhotos) => {
    pendingRef.current = next
    setPending(next)
  }

  const pick = useCallback(
    (kind: SitePhotoKind, file: File, coords: IGpsCoordinates | null) => {
      const old = pendingRef.current[kind]
      if (old) URL.revokeObjectURL(old.previewUrl)
      const previewUrl = URL.createObjectURL(file)
      update({ ...pendingRef.current, [kind]: { file, previewUrl, coords } })
    },
    [],
  )

  const remove = useCallback((kind: SitePhotoKind) => {
    const old = pendingRef.current[kind]
    if (!old) return
    URL.revokeObjectURL(old.previewUrl)
    const next = { ...pendingRef.current }
    delete next[kind]
    update(next)
  }, [])

  useEffect(
    () => () =>
      Object.values(pendingRef.current).forEach(p =>
        URL.revokeObjectURL(p.previewUrl),
      ),
    [],
  )

  return { pending, pick, remove }
}

/**
 * Keeps the unsent form in localStorage for this wallet. An older draft is
 * offered first and is not overwritten until the planter resumes or drops it.
 */
export function useSiteDraftSync(
  wallet: string,
  form: SiteForm,
  enabled: boolean,
) {
  const [offer, setOffer] = useState<SiteDraft | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!enabled || !wallet) return
    const stored = readSiteDraft(wallet)
    setOffer(siteDraftHasContent(stored) ? stored : null)
    setReady(true)
  }, [wallet, enabled])

  useEffect(() => {
    if (!enabled || !ready || offer || !wallet) return
    const draft = formToDraft(form)
    if (siteDraftHasContent(draft)) saveSiteDraft(wallet, draft)
  }, [form, enabled, ready, offer, wallet])

  const dismiss = useCallback(() => setOffer(null), [])
  const discard = useCallback(() => {
    clearSiteDraft(wallet)
    setOffer(null)
  }, [wallet])

  return { offer, dismiss, discard }
}

/** Fills the place name, country and default site name from the GPS. */
export function useSiteGeocode(
  form: SiteForm,
  setForm: Dispatch<SetStateAction<SiteForm>>,
  online: boolean,
) {
  const anchor = formAnchor(form)
  // About 100 m steps, so walking does not call the geocoder on every fix.
  const lat = anchor ? Number(anchor.latitude.toFixed(3)) : null
  const lon = anchor ? Number(anchor.longitude.toFixed(3)) : null

  useEffect(() => {
    if (!online || lat === null || lon === null || !anchor) return
    let cancelled = false
    void reverseGeocode(anchor.latitude, anchor.longitude, {
      zoom: 16,
      language: 'en',
    }).then(result => {
      if (cancelled || !result.success) return
      setForm(f => ({
        ...f,
        name: f.name.trim() ? f.name : (result.shortAddress ?? '').slice(0, 80),
        reverseGeocode: result.address ?? f.reverseGeocode,
        countryCode: result.countryCode ?? f.countryCode,
      }))
    })
    return () => {
      cancelled = true
    }
  }, [online, lat, lon, setForm])
}
