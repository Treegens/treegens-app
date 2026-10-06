import type { SiteAnswers } from '@/modules/siteCheck/siteVerdict'
import type { IGpsCoordinates, SiteBoundaryMethod } from '@/types'
import type { LonLat } from '@/utils/geo'

/**
 * An unsent Site Check kept on the phone, so the questions can be answered
 * offline and finished later. Photos are not kept (too large for storage).
 */
export interface SiteDraft {
  name: string
  boundaryMethod: SiteBoundaryMethod | null
  ring?: LonLat[]
  center?: IGpsCoordinates
  radiusM?: number
  countryCode?: string
  reverseGeocode?: string
  answers: SiteAnswers
  updatedAt: string
}

const draftKey = (wallet: string) =>
  `treegens_site_draft_${wallet.trim().toLowerCase()}`

export function saveSiteDraft(wallet: string, draft: SiteDraft) {
  if (typeof window === 'undefined' || !wallet) return
  try {
    localStorage.setItem(draftKey(wallet), JSON.stringify(draft))
  } catch (e) {
    console.warn('Failed to save site draft', e)
  }
}

export function readSiteDraft(wallet: string): SiteDraft | null {
  if (typeof window === 'undefined' || !wallet) return null
  try {
    const raw = localStorage.getItem(draftKey(wallet))
    const draft = raw ? (JSON.parse(raw) as SiteDraft) : null
    return draft && typeof draft === 'object' && draft.answers ? draft : null
  } catch {
    return null
  }
}

export function clearSiteDraft(wallet: string) {
  if (typeof window === 'undefined' || !wallet) return
  try {
    localStorage.removeItem(draftKey(wallet))
  } catch (e) {
    console.warn('Failed to clear site draft', e)
  }
}

/** True when the draft holds anything worth offering to resume. */
export function siteDraftHasContent(draft: SiteDraft | null): boolean {
  if (!draft) return false
  return Boolean(
    (draft.name ?? '').trim() ||
      draft.ring?.length ||
      draft.center ||
      Object.keys(draft.answers).length,
  )
}
