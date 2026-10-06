import { isValidSubmissionObjectId } from '@/services/submissionApiMappers'
import { axiosInstance } from './axiosInstance'
import type { ReverseGeocodeResult } from './geocodingService'
import type { ISubmissionAiVerification, ISubmissionSiteCheck } from '@/types'
import type {
  CompressionProgress,
  CompressionResult,
} from './videoCompressionService'
import { videoCompressionService } from './videoCompressionService'

export enum VideoType {
  LAND = 'land',
  PLANT = 'plant',
}

/** Matches POST /api/submissions/upload success payload */
export interface VideoUploadResponse {
  message: string
  data: {
    submissionId: string
    videoCID: string
    publicUrl: string
    uploadTimestamp: string
    type: 'land' | 'plant'
    status: string
    treesPlanted?: number
    treeType?: string
    reverseGeocode?: string
    aiVerification?: ISubmissionAiVerification
    /** Where the clip was filmed relative to its linked Site Check */
    siteCheck?: ISubmissionSiteCheck
  }
}

/** Optional Site Check link sent with a clip (species only with plant). */
export interface SiteLinkFields {
  siteId?: string
  /** Mangrove species ids, sent as a JSON array string */
  species?: string[]
}

function appendSiteLinkFields(
  formData: FormData,
  apiType: 'land' | 'plant',
  link?: SiteLinkFields,
) {
  if (link?.siteId?.trim()) formData.append('siteId', link.siteId.trim())
  if (apiType === 'plant' && link?.species?.length) {
    formData.append('species', JSON.stringify(link.species))
  }
}

export const videoService = {
  // Upload video to IPFS with GPS coordinates
  async uploadVideo(
    videoFile: File,
    type: VideoType,
    latitude: number,
    longitude: number,
    submissionId: string,
    treesPlanted?: number,
    treetype?: string,
    reverseGeocode?: ReverseGeocodeResult,
    options?: SiteLinkFields & {
      onCompressionProgress?: (p: CompressionProgress) => void
      onUploadProgress?: (percent: number) => void
      onCompressionDone?: (
        result: CompressionResult & { durationMs: number },
      ) => void
    },
  ): Promise<VideoUploadResponse> {
    // Compress on client before uploading (graceful fallback)
    let fileToUpload = videoFile
    try {
      const start =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      const result = await videoCompressionService.compressVideo(
        videoFile,
        options?.onCompressionProgress,
      )
      const end =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      const durationMs = end - start
      if (options?.onCompressionDone) {
        options.onCompressionDone({ ...result, durationMs })
      }
      fileToUpload = result.compressedFile || videoFile
    } catch (e) {
      fileToUpload = videoFile
      console.error('Error compressing video:', e)
    }

    const formData = new FormData()
    formData.append('video', fileToUpload)
    const apiType = type === VideoType.LAND ? 'land' : 'plant'
    formData.append('type', apiType)
    formData.append('latitude', latitude.toString())
    formData.append('longitude', longitude.toString())
    if (apiType === 'land' && submissionId?.trim()) {
      throw new Error(
        'submissionId must not be sent for land upload. Start a new submission without an id.',
      )
    }
    if (apiType === 'plant') {
      if (!isValidSubmissionObjectId(submissionId)) {
        throw new Error('A valid submission id is required for the plant clip')
      }
      formData.append('submissionId', submissionId)
    }
    if (reverseGeocode?.success && reverseGeocode.address) {
      formData.append('reverseGeocode', reverseGeocode.address)
    }
    if (type === VideoType.PLANT) {
      if (treesPlanted !== undefined) {
        formData.append('treesPlanted', treesPlanted.toString())
      }
      if (treetype) {
        formData.append('treetype', treetype)
      }
    }
    appendSiteLinkFields(formData, apiType, options)

    const response = await axiosInstance.post(
      '/api/submissions/upload',
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        // Plant upload includes server-side AI counting (can take 1–2 min).
        timeout: 180_000,
        onUploadProgress: evt => {
          if (options?.onUploadProgress) {
            const total = evt.total ?? evt.loaded
            const percent = total ? Math.round((evt.loaded * 100) / total) : 0
            options.onUploadProgress(percent)
          }
        },
      },
    )

    return response.data
  },

  // Health check
  async healthCheck(): Promise<{ data: { status: string } }> {
    const response = await axiosInstance.get('/health')
    return response.data
  },

  // Test S3 connection
  async testS3Connection(): Promise<{ data: { status: string } }> {
    const response = await axiosInstance.get('/health/s3-test')
    return response.data
  },
}
