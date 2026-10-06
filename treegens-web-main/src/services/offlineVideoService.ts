/**
 * Offline Video Upload Service
 * Handles queuing videos for background sync when offline
 */

import { getApiBaseUrl } from '@/config/apiBaseUrl'
import { AuthService } from './authService'
import {
  CompressionProgress,
  CompressionResult,
  videoCompressionService,
} from './videoCompressionService'
import { type SiteLinkFields, VideoType } from './videoService'

// Extend ServiceWorkerRegistration to include Background Sync API
declare global {
  interface ServiceWorkerRegistration {
    sync: {
      register(tag: string): Promise<void>
    }
  }
}

interface PendingUploadData {
  videoFile: {
    data: string // base64 encoded file
    name: string
    type: string
    size: number
  }
  type: VideoType
  latitude: number
  longitude: number
  submissionId: string
  treesPlanted?: number
  treetype?: string
  siteId?: string
  species?: string[]
  token: string
}

export interface QueueStatus {
  pending: number
  completed: number
  failed: number
  total: number
}

export interface UploadQueueItem {
  id: string
  status: 'pending' | 'completed' | 'failed'
  timestamp: number
  retryCount: number
  maxRetries: number
  submissionId: string
  type: VideoType
}

export class OfflineVideoService {
  private static instance: OfflineVideoService
  private serviceWorkerReady: Promise<ServiceWorkerRegistration | null>
  public activeVersion: string | null = null

  constructor() {
    this.serviceWorkerReady = this.initializeServiceWorker()
  }

  static getInstance(): OfflineVideoService {
    if (!OfflineVideoService.instance) {
      OfflineVideoService.instance = new OfflineVideoService()
    }
    return OfflineVideoService.instance
  }

  /**
   * Public: Get active Service Worker version
   */
  async getServiceWorkerVersion(): Promise<string | null> {
    try {
      const sw = await this.serviceWorkerReady
      if (!sw || !navigator.serviceWorker?.controller) return null
      const result = (await this.sendMessageToServiceWorker('GET_VERSION')) as
        | { version?: string }
        | undefined
      return result?.version ?? null
    } catch (error) {
      console.warn('[OfflineVideoService] Failed to get SW version:', error)
      return null
    }
  }

  /**
   * Initialize service worker
   */
  private async initializeServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (
      typeof window === 'undefined' ||
      !navigator.serviceWorker ||
      !('serviceWorker' in navigator)
    ) {
      console.warn('[OfflineVideoService] Service Worker not supported')
      return null
    }

    const nsw = navigator.serviceWorker

    try {
      const registration = await nsw.register('/sw.js', {
        updateViaCache: 'none',
      })
      console.log('[OfflineVideoService] SW registered!')
      let hasRefreshed = false
      nsw.addEventListener('controllerchange', () => {
        if (hasRefreshed) return
        hasRefreshed = true
        window.location.reload()
      })
      registration.addEventListener('updatefound', () => {
        console.log('[OfflineVideoService] Service Worker update found')
        const newWorker = registration.installing
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && registration.waiting) {
              registration.waiting.postMessage({ type: 'SKIP_WAITING' })
            }
          })
        }
      })
      try {
        await registration.update()
      } catch (e) {
        console.warn('[OfflineVideoService] SW update check failed:', e)
      }

      // Ensure the active controller is ready before attempting messaging
      try {
        await nsw.ready
      } catch (e) {
        console.warn(
          '[OfflineVideoService] navigator.serviceWorker.ready awaiting failed:',
          e,
        )
      }

      await this.waitForActiveController(8000)

      // Listen for messages from service worker
      nsw.addEventListener(
        'message',
        this.handleServiceWorkerMessage.bind(this),
      )

      // Request notification permission for background upload alerts
      await this.requestNotificationPermission()

      // Send base URL to service worker
      await this.sendBaseURLToServiceWorker()

      // Send current auth token to service worker (if available)
      await this.sendAuthTokenToServiceWorker(AuthService.getToken())

      // Log service worker version on app open
      try {
        const versionInfo = (await this.sendMessageToServiceWorker(
          'GET_VERSION',
        )) as { version?: string }
        if (versionInfo && versionInfo.version) {
          this.activeVersion = versionInfo.version
          console.log(
            '[OfflineVideoService] Active SW version:',
            versionInfo.version,
          )
        }
      } catch (e) {
        console.warn('[OfflineVideoService] Failed to read SW version', e)
      }

      console.log('[OfflineVideoService] Service Worker initialized')
      return registration
    } catch (error) {
      console.warn(
        '[OfflineVideoService] Service Worker registration failed:',
        error,
      )
      return null
    }
  }

  /**
   * Request notification permission for upload alerts
   */
  private async requestNotificationPermission(): Promise<void> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return
    }

    if (Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission()
        console.log(
          '[OfflineVideoService] Notification permission:',
          permission,
        )
      } catch (error) {
        console.warn(
          '[OfflineVideoService] Failed to request notification permission:',
          error,
        )
      }
    }
  }

  /**
   * Handle messages from service worker
   */
  private handleServiceWorkerMessage(event: MessageEvent) {
    const { type, data, message } = event.data
    switch (type) {
      case 'UPLOAD_SUCCESS':
        console.log('[OfflineVideoService] Upload completed:', data.uploadId)
        this.notifyUploadSuccess(data)
        break

      case 'UPLOAD_FAILED':
        console.log(
          '[OfflineVideoService] Upload failed:',
          data.uploadId,
          data.error,
        )
        this.notifyUploadFailure(data)
        break

      default:
        console.log('[OfflineVideoService] SW LOG:', message)
    }
  }

  /**
   * Queue a video for offline upload
   */
  async queueVideoUpload(
    file: File,
    type: VideoType,
    latitude: number,
    longitude: number,
    submissionId: string,
    treesPlanted?: number,
    treetype?: string,
    onCompressionProgress?: (progress: CompressionProgress) => void,
    onCompressionDone?: (
      result: CompressionResult & { durationMs: number },
    ) => void,
    siteLink?: SiteLinkFields,
  ): Promise<string> {
    try {
      // Compress before queuing for offline upload (smaller storage, faster upload later)
      let fileToQueue = file
      try {
        const start =
          typeof performance !== 'undefined' ? performance.now() : Date.now()
        const result = await videoCompressionService.compressVideo(
          file,
          onCompressionProgress,
        )
        const end =
          typeof performance !== 'undefined' ? performance.now() : Date.now()
        const durationMs = end - start

        if (onCompressionDone) {
          onCompressionDone({ ...result, durationMs })
        }

        fileToQueue = result.compressedFile || file
      } catch {
        fileToQueue = file
      }

      // Convert file to base64 for storage
      const base64Data = await this.fileToBase64(fileToQueue)

      // Get current JWT token
      const token = AuthService.getToken()
      if (!token) {
        throw new Error('No authentication token available')
      }

      const uploadData: PendingUploadData = {
        videoFile: {
          data: base64Data,
          name: fileToQueue.name,
          type: fileToQueue.type,
          size: fileToQueue.size,
        },
        type,
        latitude,
        longitude,
        submissionId,
        treesPlanted,
        treetype,
        siteId: siteLink?.siteId?.trim() || undefined,
        species: type === VideoType.PLANT ? siteLink?.species : undefined,
        token,
      }

      // Send to service worker
      const sw = await this.serviceWorkerReady
      if (!sw) {
        throw new Error('Service Worker not available')
      }

      // Ensure SW has the latest token before queuing
      await this.sendAuthTokenToServiceWorker(token)

      const uploadId = (await this.sendMessageToServiceWorker(
        'QUEUE_VIDEO_UPLOAD',
        uploadData,
      )) as string

      console.log('[OfflineVideoService] Video queued successfully:', uploadId)
      return uploadId
    } catch (error) {
      console.error('[OfflineVideoService] Failed to queue video:', error)
      throw error
    }
  }

  /**
   * Get current queue status
   */
  async getQueueStatus(): Promise<QueueStatus> {
    try {
      const sw = await this.serviceWorkerReady
      if (!sw || !sw.active) {
        return { pending: 0, completed: 0, failed: 0, total: 0 }
      }

      return (await this.sendMessageToServiceWorker(
        'GET_QUEUE_STATUS',
      )) as QueueStatus
    } catch (error) {
      console.error('[OfflineVideoService] Failed to get queue status:', error)
      return { pending: 0, completed: 0, failed: 0, total: 0 }
    }
  }

  /**
   * Clear completed uploads from queue
   */
  async clearCompletedUploads(): Promise<void> {
    try {
      const sw = await this.serviceWorkerReady
      if (!sw || !sw.active) {
        return
      }

      await this.sendMessageToServiceWorker('CLEAR_COMPLETED_UPLOADS')
      console.log('[OfflineVideoService] Cleared completed uploads')
    } catch (error) {
      console.error(
        '[OfflineVideoService] Failed to clear completed uploads:',
        error,
      )
    }
  }

  /**
   * Manually trigger background sync
   */
  async triggerBackgroundSync(): Promise<void> {
    try {
      const sw = await this.serviceWorkerReady
      if (!sw) {
        console.warn(
          '[OfflineVideoService] Service Worker not available for sync',
        )
        return
      }

      if ('sync' in window.ServiceWorkerRegistration.prototype) {
        // Keep SW token fresh before triggering sync
        await this.sendAuthTokenToServiceWorker(AuthService.getToken())
        await sw.sync.register('video-upload-sync')
        console.log('[OfflineVideoService] Background sync triggered')
      } else {
        console.warn('[OfflineVideoService] Background Sync not supported')
      }
    } catch (error) {
      console.error(
        '[OfflineVideoService] Failed to trigger background sync:',
        error,
      )
    }
  }

  /**
   * Check if PWA can be installed
   */
  canInstallPWA(): boolean {
    return typeof window !== 'undefined' && 'beforeinstallprompt' in window
  }

  /**
   * Private helper methods
   */
  private async fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()

      reader.onload = () => {
        const result = reader.result as string
        // Remove data URL prefix to get just the base64 data
        const base64Data = result.split(',')[1]
        resolve(base64Data)
      }

      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  private async sendMessageToServiceWorker(
    type: string,
    data?: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !navigator.serviceWorker) {
        reject(new Error('Service workers not available'))
        return
      }

      const channel = new MessageChannel()

      channel.port1.onmessage = event => {
        if (event.data.success) {
          resolve(event.data.data)
        } else {
          reject(new Error(event.data.error))
        }
      }

      const attemptPostMessage = async () => {
        const nsw = navigator.serviceWorker
        if (!nsw) {
          reject(new Error('Service workers not available'))
          return
        }
        let controller = nsw.controller
        if (!controller) {
          try {
            await this.waitForActiveController(8000)
            controller = nsw.controller
          } catch {
            reject(new Error('No active service worker'))
            return
          }
        }
        if (!controller) {
          reject(new Error('No active service worker'))
          return
        }
        controller.postMessage({ type, data }, [channel.port2])
      }

      void attemptPostMessage()
    })
  }

  private async waitForActiveController(
    timeoutMs: number = 8000,
  ): Promise<void> {
    if (typeof window === 'undefined') return
    const nsw = navigator.serviceWorker
    if (!nsw) {
      throw new Error('Service workers not available')
    }
    if (nsw.controller) return
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        cleanup()
        resolve()
      }, timeoutMs)

      const onControllerChange = () => {
        if (nsw.controller) {
          cleanup()
          resolve()
        }
      }

      const cleanup = () => {
        clearTimeout(timeout)
        nsw.removeEventListener('controllerchange', onControllerChange)
      }

      nsw.addEventListener('controllerchange', onControllerChange)
    })
  }

  /**
   * Send current auth token to the service worker
   */
  private async sendAuthTokenToServiceWorker(
    token: string | null,
  ): Promise<void> {
    try {
      await this.sendMessageToServiceWorker('SET_AUTH_TOKEN', { token })
    } catch (error) {
      console.warn(
        '[OfflineVideoService] Failed to send auth token to SW:',
        error,
      )
    }
  }

  /**
   * Public: Push current auth token to the service worker
   */
  async pushAuthTokenToServiceWorker(token: string | null): Promise<void> {
    return this.sendAuthTokenToServiceWorker(token)
  }

  private notifyUploadSuccess(data: unknown) {
    // Dispatch custom event for UI to listen to
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('offlineUploadSuccess', {
          detail: data,
        }),
      )
    }
  }

  private notifyUploadFailure(data: unknown) {
    // Dispatch custom event for UI to listen to
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('offlineUploadFailure', {
          detail: data,
        }),
      )
    }
  }

  /**
   * Send base URL to service worker
   */
  private async sendBaseURLToServiceWorker(): Promise<void> {
    try {
      await this.sendMessageToServiceWorker('SET_BASE_URL', {
        baseURL: getApiBaseUrl(),
      })
    } catch (error) {
      console.log(
        '[OfflineVideoService] Failed to send base URL to service worker:',
        error,
      )
    }
  }
}

// Export singleton instance
export const offlineVideoService = OfflineVideoService.getInstance()
