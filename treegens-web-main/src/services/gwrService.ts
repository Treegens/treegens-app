import axios from 'axios'
import { getApiBaseUrl } from '@/config/apiBaseUrl'
import { axiosInstance } from './axiosInstance'

/**
 * GWR record after-clips — treegens.app/gwr (upload) and /gwr-vids (gallery).
 * Public endpoints on the backend: no wallet, no JWT, no submission id.
 */

export interface GwrConfig {
  uploadCodeRequired: boolean
  adminEnabled: boolean
  /** null = no ceiling, the same rule as planting clips. */
  maxFileSizeMB: number | null
  maxDurationSeconds: number | null
}

export interface GwrVideo {
  id: string
  publicUrl: string
  downloadUrl: string
  downloadFilename: string
  originalFilename?: string
  mimeType?: string
  sizeBytes?: number
  gpsCoordinates?: {
    latitude: number
    longitude: number
    accuracyMeters?: number
  }
  reverseGeocode?: string
  uploaderName?: string
  note?: string
  recordedAt?: string
  uploadedAt: string
}

export interface GwrVideoListResponse {
  message: string
  data: {
    videos: GwrVideo[]
    pagination: {
      page: number
      limit: number
      total: number
      totalPages: number
    }
  }
}

export interface GwrUploadFields {
  /**
   * The page's own id for this clip, kept for every retry of the same file.
   * A retry after a lost response then gets the first copy back instead of
   * storing a second.
   */
  uploadId?: string
  latitude?: number | null
  longitude?: number | null
  accuracyMeters?: number | null
  reverseGeocode?: string
  uploaderName?: string
  note?: string
  recordedAt?: Date | null
  uploadCode?: string
}

const DEFAULT_CONFIG: GwrConfig = {
  uploadCodeRequired: false,
  adminEnabled: false,
  maxFileSizeMB: null,
  maxDurationSeconds: null,
}

/** The API's `{ error, code }` body, when the answer was ours. */
function apiBody(
  err: unknown,
): { error?: string; code?: string; details?: string | string[] } | null {
  if (!axios.isAxiosError(err)) return null
  const data = err.response?.data
  return data && typeof data === 'object'
    ? (data as { error?: string; code?: string; details?: string | string[] })
    : null
}

/** A 403 that means "the upload code is needed / wrong". */
export function isUploadCodeRefusal(err: unknown): boolean {
  const code = apiBody(err)?.code
  return code === 'UPLOAD_CODE_REQUIRED' || code === 'UPLOAD_CODE_INVALID'
}

/**
 * Plain words for whatever went wrong: the API's own `{ error }` when the
 * answer was ours, otherwise by status, because the proxies in front of the
 * API (Cloudflare, Render's edge) answer with HTML pages a volunteer must
 * never see raw.
 */
export function gwrErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNABORTED') {
      return 'The upload took too long. Check your signal and try again.'
    }
    const status = err.response?.status
    const body = apiBody(err)
    const detail = Array.isArray(body?.details)
      ? body?.details.join('; ')
      : body?.details
    const ours =
      typeof body?.error === 'string' && body.error.trim()
        ? detail
          ? `${body.error.trim()}: ${detail}`
          : body.error.trim()
        : ''
    if (body?.code === 'GWR_STORAGE_UNAVAILABLE') {
      return 'The server has no video storage set up yet, so clips cannot be saved. Tell the Treegens team.'
    }
    if (body?.code === 'TOO_MANY_UPLOADS') {
      return 'A lot of clips are uploading from this network right now. Wait a moment and tap Upload again.'
    }
    if (body?.code === 'UPLOAD_STORAGE_FULL') {
      return 'The server is out of room for uploads right now. Keep the clip and try again in a few minutes.'
    }
    if (status === 429) {
      return 'This network has sent a lot of uploads in the last 15 minutes. Wait a few minutes and try again.'
    }
    if (status === 413) {
      return ours || 'That clip is larger than the server accepts.'
    }
    if (ours) return ours
    if (status === 502 || status === 503 || status === 504) {
      return 'The Treegens server is busy. Try again in a few minutes.'
    }
    if (!err.response) {
      return 'Cannot reach the server. Check your connection and try again.'
    }
    if (status && status >= 500) {
      return 'The server hit a problem. Try again in a minute; the clip is still on your phone.'
    }
    if (status) return `The server refused the upload (${status}). Try again.`
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  return fallback
}

export const gwrService = {
  /**
   * null when the API could not be asked: the page must not take that for
   * "no upload code needed", or a volunteer uploads a whole clip only to be
   * refused for a code they were never asked for.
   */
  async getConfig(): Promise<GwrConfig | null> {
    try {
      const res = await axiosInstance.get<{ data: Partial<GwrConfig> }>(
        '/api/gwr/config',
        { timeout: 10_000 },
      )
      return { ...DEFAULT_CONFIG, ...(res.data?.data ?? {}) }
    } catch {
      return null
    }
  },

  async uploadClip(
    file: File,
    fields: GwrUploadFields,
    onUploadProgress?: (percent: number) => void,
  ): Promise<GwrVideo> {
    const form = new FormData()
    form.append('video', file, file.name || 'clip.mp4')
    if (
      typeof fields.latitude === 'number' &&
      typeof fields.longitude === 'number'
    ) {
      form.append('latitude', String(fields.latitude))
      form.append('longitude', String(fields.longitude))
      if (typeof fields.accuracyMeters === 'number') {
        form.append('accuracyMeters', String(fields.accuracyMeters))
      }
    }
    if (fields.reverseGeocode?.trim())
      form.append('reverseGeocode', fields.reverseGeocode.trim())
    if (fields.uploaderName?.trim())
      form.append('uploaderName', fields.uploaderName.trim())
    if (fields.note?.trim()) form.append('note', fields.note.trim())
    if (fields.recordedAt && !Number.isNaN(fields.recordedAt.getTime())) {
      form.append('recordedAt', fields.recordedAt.toISOString())
    }
    // Headers, not form fields: the API checks the code before it reads a
    // byte of the clip, and the id is what makes a retry safe.
    const headers: Record<string, string> = {
      'Content-Type': 'multipart/form-data',
    }
    if (fields.uploadCode?.trim())
      headers['x-gwr-upload-code'] = fields.uploadCode.trim()
    if (fields.uploadId) headers['x-gwr-upload-id'] = fields.uploadId

    const res = await axiosInstance.post<{ data: GwrVideo }>(
      '/api/gwr/videos',
      form,
      {
        headers,
        // Originals go up as filmed, in one request; no deadline of our own,
        // the server has none either.
        timeout: 0,
        onUploadProgress: evt => {
          if (!onUploadProgress) return
          const total = evt.total ?? evt.loaded
          onUploadProgress(total ? Math.round((evt.loaded * 100) / total) : 0)
        },
      },
    )
    return res.data.data
  },

  async listVideos(page = 1, limit = 50): Promise<GwrVideoListResponse> {
    const res = await axiosInstance.get<GwrVideoListResponse>(
      '/api/gwr/videos',
      { params: { page, limit }, timeout: 20_000 },
    )
    return res.data
  },

  /** True when the key is right; false when wrong or admin is disabled. */
  async checkAdminKey(adminKey: string): Promise<boolean> {
    try {
      await axiosInstance.get('/api/gwr/admin/check', {
        headers: { 'x-gwr-admin-key': adminKey },
        timeout: 15_000,
      })
      return true
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 403) return false
      throw err
    }
  },

  async deleteVideo(id: string, adminKey: string): Promise<void> {
    await axiosInstance.delete(`/api/gwr/videos/${encodeURIComponent(id)}`, {
      headers: { 'x-gwr-admin-key': adminKey },
      timeout: 20_000,
    })
  },

  /** Absolute URLs for the whole-collection downloads, on the API's origin. */
  manifestUrl(): string {
    return `${getApiBaseUrl()}/api/gwr/videos/manifest.csv`
  },
  urlListUrl(): string {
    return `${getApiBaseUrl()}/api/gwr/videos/urls.txt`
  },
}
