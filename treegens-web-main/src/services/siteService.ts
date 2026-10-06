import type { SiteAnswers } from '@/modules/siteCheck/siteVerdict'
import type {
  IGpsCoordinates,
  ISiteDoc,
  ISiteVoteResult,
  SiteBoundaryMethod,
  SitePhotoKind,
} from '@/types'
import { axiosInstance } from './axiosInstance'

type Envelope<T> = { message: string; data: T }

type SitePage = {
  sites: ISiteDoc[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

/** Body of POST /api/sites; PATCH takes the same fields, all optional. */
export interface SiteInput {
  name: string
  boundaryMethod: SiteBoundaryMethod
  /** [lon, lat] pairs, needed for 'walked' */
  ring?: [number, number][]
  /** Needed with radiusM for 'pin_radius' */
  center?: IGpsCoordinates
  radiusM?: number
  countryCode?: string
  reverseGeocode?: string
  answers?: SiteAnswers
}

const sitePath = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}`

export function createSite(input: SiteInput) {
  return axiosInstance.post<Envelope<ISiteDoc>>('/api/sites', input)
}

export function updateSite(siteId: string, patch: Partial<SiteInput>) {
  return axiosInstance.patch<Envelope<ISiteDoc>>(sitePath(siteId), patch)
}

export function uploadSitePhoto(
  siteId: string,
  file: File,
  kind: SitePhotoKind,
  coords?: IGpsCoordinates | null,
  onProgress?: (percent: number) => void,
) {
  const formData = new FormData()
  formData.append('photo', file)
  formData.append('kind', kind)
  if (coords) {
    formData.append('latitude', String(coords.latitude))
    formData.append('longitude', String(coords.longitude))
  }
  return axiosInstance.post<Envelope<ISiteDoc>>(
    `${sitePath(siteId)}/photos`,
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120_000,
      onUploadProgress: evt => {
        if (!onProgress) return
        const total = evt.total ?? evt.loaded
        onProgress(total ? Math.round((evt.loaded * 100) / total) : 0)
      },
    },
  )
}

export function submitSite(siteId: string) {
  return axiosInstance.post<Envelope<ISiteDoc>>(`${sitePath(siteId)}/submit`)
}

export function getSite(siteId: string) {
  return axiosInstance.get<Envelope<ISiteDoc>>(sitePath(siteId))
}

export function listMySites(page = 1, limit = 20) {
  return axiosInstance.get<Envelope<SitePage>>(
    `/api/sites/mine?page=${page}&limit=${limit}`,
  )
}

export function listSiteModeration(page = 1, limit = 20) {
  return axiosInstance.get<Envelope<SitePage>>(
    `/api/sites/moderation?page=${page}&limit=${limit}`,
  )
}

export function voteOnSite(
  siteId: string,
  vote: 'yes' | 'no',
  reasons?: string[],
) {
  return axiosInstance.post<Envelope<ISiteVoteResult>>(
    `${sitePath(siteId)}/vote`,
    { vote, reasons },
  )
}

export function recheckSiteHydrology(siteId: string) {
  return axiosInstance.post<Envelope<ISiteDoc>>(
    `${sitePath(siteId)}/hydrology/recheck`,
  )
}

export function deleteSite(siteId: string) {
  return axiosInstance.delete<Envelope<{ siteId: string; deleted: boolean }>>(
    sitePath(siteId),
  )
}
