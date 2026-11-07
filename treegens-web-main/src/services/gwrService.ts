import { getApiBaseUrl } from '@/config/apiBaseUrl'
import { axiosInstance } from './axiosInstance'

/**
 * GWR record after-clips — treegens.app/gwr (upload) and /gwr-vids (gallery).
 * Public endpoints: no wallet, no JWT, no submission id.
 */

export interface GwrConfig {
  uploadCodeRequired: boolean
  adminEnabled: boolean
  maxFileSizeMB: number
  maxDurationSeconds: number
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
  maxFileSizeMB: 100,
  maxDurationSeconds: 60,
}

export const gwrService = {
  async getConfig(): Promise<GwrConfig> {
    try {
      const res = await axiosInstance.get<{ data: Partial<GwrConfig> }>(
        '/api/gwr/config',
        { timeout: 10_000 },
      )
      return { ...DEFAULT_CONFIG, ...(res.data?.data ?? {}) }
    } catch {
      return DEFAULT_CONFIG
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
        form.append('accuracyMeters', String(Math.round(fields.accuracyMeters)))
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
    if (fields.uploadCode?.trim())
      form.append('uploadCode', fields.uploadCode.trim())

    const res = await axiosInstance.post<{ data: GwrVideo }>(
      '/api/gwr/videos',
      form,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        // Originals go up uncompressed; a 100MB clip on event wifi takes a while.
        timeout: 15 * 60_000,
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

  async deleteVideo(id: string, adminKey: string): Promise<void> {
    await axiosInstance.delete(`/api/gwr/videos/${encodeURIComponent(id)}`, {
      headers: { 'x-gwr-admin-key': adminKey },
      timeout: 20_000,
    })
  },

  /** Absolute URLs for the whole-collection downloads (same origin as the API). */
  manifestUrl(): string {
    return `${getApiBaseUrl()}/api/gwr/videos/manifest.csv`
  },
  urlListUrl(): string {
    return `${getApiBaseUrl()}/api/gwr/videos/urls.txt`
  },
}
