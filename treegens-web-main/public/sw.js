/**
 * TreeGens Service Worker
 * Handles offline video upload queue and background sync
 */

const SW_VERSION = 'v1.276'
const STATIC_CACHE = `treegens-static-${SW_VERSION}` // bump to refresh HTML/images
const RUNTIME_CACHE = `treegens-runtime-${SW_VERSION}` // keep stable for Next build assets
const FF_CACHE = 'treegens-ffmpeg-core' // dedicated, never-versioned cache for ffmpeg core
const UPLOAD_QUEUE_DB = 'treegens-upload-queue'
const UPLOAD_STORE = 'pending-uploads'
const SETTINGS_STORE = 'app-settings'

// Service worker logging: optionally forward logs to clients (main thread)
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info
}

const wait = (ms) =>
  new Promise(resolve => setTimeout(resolve, ms))

async function forwardLogToMainThread(level, args) {
  try {
    const clients = await self.clients.matchAll()
    const logData = {
      type: 'SW_LOG',
      level,
      message: args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '),
      timestamp: new Date().toISOString()
    }

    clients.forEach(client => {
      client.postMessage(logData)
    })
  } catch (error) {
    // Fallback to original console if forwarding fails
    originalConsole.error('Failed to forward log to main thread:', error)
  }
}

// Override console methods to forward logs
console.log = (...args) => {
  forwardLogToMainThread('log', args)
}

console.error = (...args) => {
  forwardLogToMainThread('error', args)
}

console.warn = (...args) => {
  forwardLogToMainThread('warn', args)
}

console.info = (...args) => {
  forwardLogToMainThread('info', args)
}

// Latest auth token (kept in-memory and persisted in IndexedDB)
let CURRENT_AUTH_TOKEN = null

// Service workers can't access process.env, so use hardcoded URL or receive from main thread
// API origin is pushed from the page via SET_BASE_URL (`getApiBaseUrl()`); same-origin when app is on treegens.app.
let BASE_URL = 'https://treegens.app'

// Files to cache for offline functionality
const STATIC_ASSETS = [
  '/',
  '/auth',
  '/profile',
  '/tutorial',
  '/tutorial/verify',
  '/leaderboard',
  '/leaderboard/funded',
  '/submissions',
  '/earn',
  '/inbox',
  '/submissions/create',
  '/manifest.webmanifest',
  '/img/treegens-logo.svg',
  '/img/tree.svg',
  '/img/home-icon.svg',
  '/img/leaderboard-icon.svg',
]

// Pages used in the field without signal. Precached best-effort with the
// /_next/static files their HTML loads, so they open (and run) offline.
// Kept out of STATIC_ASSETS: addAll there is all-or-nothing.
const OFFLINE_PAGES = ['/sites', '/sites/create']
const OFFLINE_PAGE_ASSETS_FROM = [...OFFLINE_PAGES, '/submissions/create']

// Upload refusals the API repeats on every retry (Site Check gate, unknown
// site); the list in src/modules/siteCheck/siteGateMessage.ts, less the
// refusals in WAITING_UPLOAD_ERRORS.
const PERMANENT_UPLOAD_ERRORS = [
  'Mangrove planting needs an approved Site Check',
  'This site was rejected in review',
  'The Site Check verdict for this site is',
  'Your before video was filmed',
  'Your planting video was filmed',
  'This video was filmed',
  'Site not found',
]
// Refusals that end once verifiers approve the site: the clip stays queued
// and is sent again on every sync, without using up its fail cycles.
const WAITING_UPLOAD_ERRORS = ['This site has not been approved yet']
// A failed upload is re-queued until it has failed this many cycles
const MAX_FAIL_CYCLES = 3

/**
 * Best-effort: caches each offline page and the build files its HTML
 * references. Never throws, so it cannot break install.
 */
async function precacheOfflinePages(staticCache) {
  try {
    await Promise.all(
      OFFLINE_PAGES.map(path =>
        staticCache.add(path).catch(e => {
          console.warn('[SW] Could not precache page', path, e)
        })
      )
    )
    const assets = new Set()
    for (const path of OFFLINE_PAGE_ASSETS_FROM) {
      const page = await staticCache.match(path)
      if (!page) continue
      const html = await page.text()
      const found = html.match(/\/_next\/static\/[^"'\s)\\]+/g) || []
      found.forEach(url => assets.add(url))
    }
    const runtime = await caches.open(RUNTIME_CACHE)
    await Promise.all(
      [...assets].map(async url => {
        if (await runtime.match(url)) return
        await runtime.add(url).catch(() => {})
      })
    )
    console.log(`[SW] Warmed ${assets.size} build files for offline pages`)
  } catch (e) {
    console.warn('[SW] Offline page precache failed', e)
  }
}

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing TreeGens Service Worker')

  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE)
        console.log('[SW] Caching static assets')
        await cache.addAll(STATIC_ASSETS)
        await precacheOfflinePages(cache)
        // Precache ffmpeg core files in dedicated cache (best-effort, only if not already cached)
        try {
          const ff = await caches.open(FF_CACHE)
          const ffmpegUrls = [
            'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js',
            'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm',
          ]

          // Check which files are not already cached
          const uncachedUrls = []
          for (const url of ffmpegUrls) {
            const cached = await ff.match(url)
            if (!cached) {
              uncachedUrls.push(url)
            }
          }

          if (uncachedUrls.length > 0) {
            console.log(`[SW] Caching ${uncachedUrls.length} uncached ffmpeg files`)
            await ff.addAll(uncachedUrls)
            console.log('[SW] Precached ffmpeg core files')
          } else {
            console.log('[SW] FFmpeg core files already cached')
          }
        } catch (e) {
          console.warn('[SW] Failed to precache ffmpeg core files', e)
        }
        console.log('[SW] Service Worker installed successfully')
      } catch (error) {
        console.error('[SW] Installation failed:', error)
      } finally {
        await self.skipWaiting()
      }
    })()
  )
})

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating TreeGens Service Worker')

  event.waitUntil(
    (async () => {
      // Delete old caches that are not the current ones (but NEVER delete ffmpeg cache)
      const keys = await caches.keys()
      let deletedAny = false
      await Promise.all(
        keys.map(async (key) => {
          const isTreegensCache = key.startsWith('treegens-')
          const isCurrent = key === STATIC_CACHE || key === RUNTIME_CACHE
          const isFF = key === FF_CACHE
          if (isTreegensCache && !isCurrent && !isFF) {
            console.log('[SW] Deleting old cache:', key)
            const deleted = await caches.delete(key)
            if (deleted) deletedAny = true
          }
        })
      )
      console.log('[SW] Service Worker activated')
      await self.clients.claim()
      try {
        const token = await readAuthTokenFromDB()
        if (token) {
          CURRENT_AUTH_TOKEN = token
          console.log('[SW] Loaded auth token from DB')
        }
      } catch (err) {
        console.warn('[SW] Could not load auth token from DB:', err)
      }
    })()
  )
})

// Background sync for video uploads
self.addEventListener('sync', (event) => {
  if (event.tag === 'video-upload-sync') {
    console.log('[SW] Background sync triggered:', event.tag)
    event.waitUntil(syncPendingUploads())
  }
})

// Fetch event - serve from cache when offline
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Check if this is an FFmpeg core file request (cross-origin allowed)
  const isFFmpegCore = (
    url.pathname === '/ffmpeg/ffmpeg-core.js' ||
    url.pathname === '/ffmpeg/ffmpeg-core.wasm' ||
    url.href.startsWith('https://cdn.jsdelivr.net/npm/@ffmpeg/core') ||
    url.href.startsWith('https://unpkg.com/@ffmpeg/core')
  )

  // Only handle GET requests, but allow cross-origin for FFmpeg files
  if (request.method !== 'GET') {
    return
  }

  const isSameOrigin = request.url.startsWith(self.location.origin)

  // Skip non-same-origin requests unless they're FFmpeg core files
  if (!isSameOrigin && !isFFmpegCore) {
    return
  }
  const isNextAsset = url.pathname.startsWith('/_next/')
  const isApi = url.pathname.startsWith('/api/')
  const isNavigate = request.mode === 'navigate'

  // Special handling for ffmpeg core: cache-first from dedicated cache, never purge
  if (isFFmpegCore) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FF_CACHE)
        const cached = await cache.match(request)
        if (cached) return cached
        try {
          const response = await fetch(request)
          if (response && response.status === 200) {
            cache.put(request, response.clone())
          }
          return response
        } catch (e) {
          return cached || new Response('', { status: 504 })
        }
      })()
    )
    return
  }

  // Cache-first for Next build assets
  if (isNextAsset) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE)
        const cached = await cache.match(request)
        if (cached) return cached
        try {
          const response = await fetch(request)
          if (response && response.status === 200) {
            cache.put(request, response.clone())
          }
          return response
        } catch (e) {
          return cached || new Response('', { status: 504 })
        }
      })()
    )
    return
  }

  // Network-first for other resources; fallback to cache
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request)
        if (!isApi && response && response.status === 200) {
          const cache = await caches.open(RUNTIME_CACHE)
          cache.put(request, response.clone())
        }
        return response
      } catch (e) {
        const cached = await caches.match(request)
        if (cached) return cached
        if (isNavigate) {
          // Fallback to offline page
          return (
            new Response('<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Offline</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b1b12;color:#fff}main{max-width:520px;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{opacity:.8;margin:0}</style></head><body><main><h1>You are offline</h1><p>Reconnect to get the latest TreeGens experience.</p></main></body></html>', { headers: { 'Content-Type': 'text/html' } })
          )
        }
      }
    })()
  )
})

// Message handling for communication with main thread
self.addEventListener('message', async (event) => {
  const { type, data } = event.data

  switch (type) {
    case 'SKIP_WAITING':
      await self.skipWaiting()
      break

    case 'QUEUE_VIDEO_UPLOAD':
      handleQueueVideoUpload(data)
        .then((result) => {
          event.ports[0].postMessage({ success: true, data: result })
        })
        .catch((error) => {
          event.ports[0].postMessage({ success: false, error: error.message })
        })
      break

    case 'GET_QUEUE_STATUS':
      getQueueStatus()
        .then((status) => {
          event.ports[0].postMessage({ success: true, data: status })
        })
        .catch((error) => {
          event.ports[0].postMessage({ success: false, error: error.message })
        })
      break

    case 'CLEAR_COMPLETED_UPLOADS':
      clearCompletedUploads()
        .then(() => {
          event.ports[0].postMessage({ success: true })
        })
        .catch((error) => {
          event.ports[0].postMessage({ success: false, error: error.message })
        })
      break

    case 'SET_BASE_URL':
      BASE_URL = data.baseURL
      event.ports[0].postMessage({ success: true })
      break

    case 'SET_AUTH_TOKEN':
      try {
        CURRENT_AUTH_TOKEN = data?.token || null
        await saveAuthTokenToDB(CURRENT_AUTH_TOKEN)
        event.ports[0].postMessage({ success: true })
      } catch (error) {
        console.error('[SW] Failed to update auth token:', error)
        event.ports[0].postMessage({ success: false, error: error.message })
      }
      break

    case 'GET_VERSION':
      event.ports[0].postMessage({
        success: true,
        data: { version: SW_VERSION }
      })
      break
  }
})

/**
 * Queue a video upload for background sync
 */
async function handleQueueVideoUpload(uploadData) {
  try {
    console.log(`🎥 Queuing video upload: ${uploadData.videoFile.name}`)

    const db = await openDB()
    const tx = db.transaction([UPLOAD_STORE], 'readwrite')
    const store = tx.objectStore(UPLOAD_STORE)

    const queueItem = {
      id: `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...uploadData,
      status: 'pending',
      timestamp: Date.now(),
      retryCount: 0,
      maxRetries: 3,
      failCycles: 0
    }

    await new Promise((resolve, reject) => {
      const request = store.add(queueItem)
      request.onsuccess = () => resolve()
      request.onerror = (event) => reject(new Error(event.target.error))
    })
    console.log('[SW] Video queued for upload:', queueItem.id)

    // Register for background sync (service worker context)
    try {
      if (self.registration && self.registration.sync && typeof self.registration.sync.register === 'function') {
        await self.registration.sync.register('video-upload-sync')
        console.log('[SW] Background sync registered!')
      } else {
        console.log('[SW] Background Sync not supported; using manual triggers')
      }
    } catch (e) {
      console.warn('[SW] Background Sync registration failed:', e)
    }

    return queueItem.id
  } catch (error) {
    console.error('[SW] Failed to queue video upload:', error)
    throw error
  }
}

/**
 * Sync all pending uploads
 */
async function syncPendingUploads() {
  console.log('[SW] Starting background sync for pending uploads')

  try {
    const db = await openDB()
    const tx = db.transaction([UPLOAD_STORE], 'readonly')
    const store = tx.objectStore(UPLOAD_STORE)

    // Properly handle IndexedDB request
    const allItems = await new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = (event) => {
        const result = event.target.result
        resolve(result)
      }
      request.onerror = (event) => {
        reject(new Error(event.target.error))
      }
    })

    if (!allItems || allItems.length === 0) {
      console.log('[SW] No pending uploads found')
      return
    }

    const pendingItems = allItems.filter(item => item.status === 'pending')

    console.log(`[SW] Found ${pendingItems.length} pending uploads`)

    for (const item of pendingItems) {
      try {
        console.log(`⬆️ Uploading: ${item.videoFile.name}`)
        // Wait to make sure user connectivity is finished
        await wait(5000)
        await uploadVideo(item)
        await updateUploadStatus(item.id, 'completed')

        console.log(`✅ Upload completed: ${item.id}`)

        // Notify main thread of successful upload
        await notifyClients('UPLOAD_SUCCESS', {
          uploadId: item.id,
          submissionId: item.submissionId
        })

      } catch (error) {
        console.error(`[SW] Upload failed for ${item.id}:`, error)

        // Increment retry count
        const newRetryCount = item.retryCount + 1

        if (error && error.permanent) {
          // Sending it again would only get the same answer
          await markUploadFailed(item.id, { permanent: true, error: error.message })
          console.error(`💀 Upload refused: ${error.message}`)
          await notifyClients('UPLOAD_FAILED', {
            uploadId: item.id,
            error: error.message,
            permanent: true
          })
        } else if (error && error.waiting) {
          // The site is still in review: keep the clip, try again next sync
          await markUploadWaiting(item.id, error.message)
          console.warn(`⏳ Upload waiting: ${error.message}`)
          if (item.lastError !== error.message) {
            // Told once per reason, not on every sync
            await notifyClients('UPLOAD_FAILED', {
              uploadId: item.id,
              error: `${withStop(error.message)} Your video is kept and will be sent once the site is approved.`,
              waiting: true
            })
          }
        } else if (newRetryCount >= item.maxRetries) {
          await markUploadFailed(item.id)
          console.error(`💀 Upload failed after ${item.maxRetries} retries (cycle incremented)`)
          await notifyClients('UPLOAD_FAILED', {
            uploadId: item.id,
            error: error.message
          })
        } else {
          await updateUploadRetryCount(item.id, newRetryCount)
          console.warn(`🔄 Will retry upload (attempt ${newRetryCount}/${item.maxRetries})`)
        }
      }
    }

    console.log('[SW] Background sync completed')
  } catch (error) {
    console.error('[SW] Background sync failed:', error)
  }
}

/**
 * Upload a single video to the backend
 */
async function uploadVideo(uploadItem) {
  const { videoFile, type, latitude, longitude, submissionId, treesPlanted, treetype, siteId, species, token: queuedToken } = uploadItem

  // Convert base64 back to File if needed
  const file = await base64ToFile(videoFile.data, videoFile.name, videoFile.type)

  // Resolve human-readable address before uploading
  const reverseGeocodeResult = await swReverseGeocode(latitude, longitude)

  const formData = new FormData()
  formData.append('video', file)
  const apiType = type === 'land' ? 'land' : 'plant'
  formData.append('type', apiType)
  formData.append('latitude', latitude.toString())
  formData.append('longitude', longitude.toString())
  if (apiType === 'plant') {
    formData.append('submissionId', submissionId)
  }
  if (reverseGeocodeResult?.success && reverseGeocodeResult.address) {
    formData.append('reverseGeocode', reverseGeocodeResult.address)
  }

  if (type === 'plant') {
    if (treesPlanted !== undefined) {
      formData.append('treesPlanted', treesPlanted.toString())
    }
    if (treetype) {
      formData.append('treetype', treetype)
    }
    if (Array.isArray(species) && species.length) {
      formData.append('species', JSON.stringify(species))
    }
  }
  if (siteId) {
    formData.append('siteId', siteId)
  }

  const effectiveToken = await getEffectiveAuthToken(queuedToken)

  const headers = {}
  if (effectiveToken) {
    headers['Authorization'] = effectiveToken
  }

  const response = await fetch(`${BASE_URL}/api/submissions/upload`, {
    method: 'POST',
    headers,
    body: formData
  })

  if (!response.ok) {
    // A 400 carrying a Site Check refusal will not change on retry
    const body = response.status === 400 ? await response.json().catch(() => null) : null
    const serverError = body && typeof body.error === 'string' ? body.error.trim() : ''
    if (isPermanentUploadError(serverError)) {
      const error = new Error(serverError)
      error.permanent = true
      throw error
    }
    if (startsWithAny(serverError, WAITING_UPLOAD_ERRORS)) {
      const error = new Error(serverError)
      error.waiting = true
      throw error
    }
    throw new Error(`Upload failed with status: ${response.status}`)
  }

  return await response.json()
}

function isPermanentUploadError(message) {
  return startsWithAny(message, PERMANENT_UPLOAD_ERRORS)
}

function startsWithAny(message, starts) {
  return Boolean(message) && starts.some(start => message.startsWith(start))
}

/** The message ending in a full stop, ready for another sentence. */
function withStop(message) {
  return /[.!?]$/.test(message) ? message : `${message}.`
}

// --- Reverse geocoding helpers (Service Worker context) ---
async function swReverseGeocode(latitude, longitude) {
  try {
    if (!swIsValidCoordinate(latitude, longitude)) {
      return { success: false, error: 'Invalid coordinates provided' }
    }

    const url = swBuildReverseGeocodeUrl(latitude, longitude, {
      zoom: 18,
      addressDetails: true,
      language: 'en',
      format: 'json'
    })

    const response = await fetch(url, {
      headers: { 'User-Agent': 'TreeGens-Frontend/1.0' }
    })

    if (!response.ok) {
      return { success: false, error: `Geocoding API returned ${response.status}` }
    }

    const data = await response.json()
    if (!data || !data.display_name) {
      return { success: false, error: 'No address found for coordinates' }
    }

    const fullAddress = data.display_name
    return {
      success: true,
      address: fullAddress,
      shortAddress: swExtractShortAddress(fullAddress)
    }
  } catch (error) {
    return { success: false, error: error && error.message ? error.message : 'Unknown geocoding error' }
  }
}

function swBuildReverseGeocodeUrl(latitude, longitude, options) {
  const params = new URLSearchParams({
    format: options.format || 'json',
    lat: String(latitude),
    lon: String(longitude),
    zoom: String(options.zoom || 18),
    addressdetails: options.addressDetails ? '1' : '0'
  })
  if (options.language) {
    params.set('accept-language', options.language)
  }
  return `https://nominatim.openstreetmap.org/reverse?${params.toString()}`
}

function swIsValidCoordinate(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    !isNaN(lat) && !isNaN(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180
  )
}

function swExtractShortAddress(fullAddress) {
  if (!fullAddress) return ''
  const parts = fullAddress.split(',').map(p => p.trim())
  const meaningful = parts.filter(part => {
    if (/^\d+$/.test(part)) return false
    if (/^\d{5,}/.test(part)) return false
    return true
  })
  return meaningful.slice(0, 3).join(', ')
}

/**
 * Helper functions for IndexedDB operations
 */
function openDB() {
  return new Promise((resolve, reject) => {
    // v2: add settings store for auth token persistence
    const request = indexedDB.open(UPLOAD_QUEUE_DB, 2)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = event.target.result

      if (!db.objectStoreNames.contains(UPLOAD_STORE)) {
        const store = db.createObjectStore(UPLOAD_STORE, { keyPath: 'id' })
        store.createIndex('status', 'status', { unique: false })
        store.createIndex('timestamp', 'timestamp', { unique: false })
      }

      // Create a simple key-value settings store
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' })
      }
    }
  })
}

async function updateUploadStatus(uploadId, status) {
  const db = await openDB()
  const tx = db.transaction([UPLOAD_STORE], 'readwrite')
  const store = tx.objectStore(UPLOAD_STORE)

  const item = await new Promise((resolve, reject) => {
    const request = store.get(uploadId)
    request.onsuccess = (event) => resolve(event.target.result)
    request.onerror = (event) => reject(new Error(event.target.error))
  })

  if (item) {
    item.status = status
    item.completedAt = Date.now()
    await new Promise((resolve, reject) => {
      const request = store.put(item)
      request.onsuccess = () => resolve()
      request.onerror = (event) => reject(new Error(event.target.error))
    })
  }
}

async function updateUploadRetryCount(uploadId, retryCount) {
  const db = await openDB()
  const tx = db.transaction([UPLOAD_STORE], 'readwrite')
  const store = tx.objectStore(UPLOAD_STORE)

  const item = await new Promise((resolve, reject) => {
    const request = store.get(uploadId)
    request.onsuccess = (event) => resolve(event.target.result)
    request.onerror = (event) => reject(new Error(event.target.error))
  })

  if (item) {
    item.retryCount = retryCount
    await new Promise((resolve, reject) => {
      const request = store.put(item)
      request.onsuccess = () => resolve()
      request.onerror = (event) => reject(new Error(event.target.error))
    })
  }
}

/**
 * Mark upload as failed and increment failure cycles. A permanent failure
 * uses up every cycle, so it is never re-queued.
 */
async function markUploadFailed(uploadId, options = {}) {
  const db = await openDB()
  const tx = db.transaction([UPLOAD_STORE], 'readwrite')
  const store = tx.objectStore(UPLOAD_STORE)

  const item = await new Promise((resolve, reject) => {
    const request = store.get(uploadId)
    request.onsuccess = (event) => resolve(event.target.result)
    request.onerror = (event) => reject(new Error(event.target.error))
  })

  if (item) {
    item.status = 'failed'
    item.failCycles = options.permanent ? MAX_FAIL_CYCLES : (item.failCycles || 0) + 1
    item.retryCount = 0
    item.failedAt = Date.now()
    if (options.error) item.lastError = options.error
    await new Promise((resolve, reject) => {
      const request = store.put(item)
      request.onsuccess = () => resolve()
      request.onerror = (event) => reject(new Error(event.target.error))
    })
  }
}

/**
 * Keeps an upload queued after a refusal that will clear on its own (site
 * still in review): no fail cycle is used, so it is never deleted for it.
 */
async function markUploadWaiting(uploadId, message) {
  const db = await openDB()
  const tx = db.transaction([UPLOAD_STORE], 'readwrite')
  const store = tx.objectStore(UPLOAD_STORE)

  const item = await new Promise((resolve, reject) => {
    const request = store.get(uploadId)
    request.onsuccess = (event) => resolve(event.target.result)
    request.onerror = (event) => reject(new Error(event.target.error))
  })

  if (item) {
    item.status = 'pending'
    item.retryCount = 0
    item.lastError = message
    await new Promise((resolve, reject) => {
      const request = store.put(item)
      request.onsuccess = () => resolve()
      request.onerror = (event) => reject(new Error(event.target.error))
    })
  }
}

async function getQueueStatus() {
  try {
    const db = await openDB()
    const tx = db.transaction([UPLOAD_STORE], 'readwrite')
    const store = tx.objectStore(UPLOAD_STORE)

    let items = await new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = (event) => {
        const result = event.target.result
        resolve(Array.isArray(result) ? result : [])
      }
      request.onerror = (event) => {
        reject(new Error(event.target.error))
      }
    })

    // Requeue or delete failed items per policy
    for (const item of items) {
      if (item.status === 'failed') {
        const failCycles = item.failCycles || 0
        if (failCycles >= MAX_FAIL_CYCLES) {
          // Delete permanently after third failure cycle
          await new Promise((resolve, reject) => {
            const del = store.delete(item.id)
            del.onsuccess = () => resolve()
            del.onerror = (event) => reject(new Error(event.target.error))
          })
        } else {
          // Requeue for another try
          item.status = 'pending'
          item.retryCount = 0
          await new Promise((resolve, reject) => {
            const put = store.put(item)
            put.onsuccess = () => resolve()
            put.onerror = (event) => reject(new Error(event.target.error))
          })
        }
      }
    }

    // Re-fetch to compute accurate counts after modifications
    items = await new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = (event) => {
        const result = event.target.result
        resolve(Array.isArray(result) ? result : [])
      }
      request.onerror = (event) => {
        reject(new Error(event.target.error))
      }
    })

    return {
      pending: items.filter(item => item.status === 'pending').length,
      completed: items.filter(item => item.status === 'completed').length,
      failed: items.filter(item => item.status === 'failed').length,
      total: items.length
    }
  } catch (error) {
    console.error('[SW] Error getting queue status:', error)
    return { pending: 0, completed: 0, failed: 0, total: 0 }
  }
}

async function clearCompletedUploads() {
  const db = await openDB()
  const tx = db.transaction([UPLOAD_STORE], 'readwrite')
  const store = tx.objectStore(UPLOAD_STORE)

  const allItems = await new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = (event) => {
      const result = event.target.result
      resolve(result)
    }
    request.onerror = (event) => {
      reject(new Error(event.target.error))
    }
  })

  const completedItems = allItems.filter(item => item.status === 'completed')

  for (const item of completedItems) {
    await new Promise((resolve, reject) => {
      const deleteRequest = store.delete(item.id)
      deleteRequest.onsuccess = () => resolve()
      deleteRequest.onerror = (event) => reject(new Error(event.target.error))
    })
  }
}

/**
 * Persist and retrieve auth token in IndexedDB
 */
async function saveAuthTokenToDB(token) {
  try {
    const db = await openDB()
    const tx = db.transaction([SETTINGS_STORE], 'readwrite')
    const store = tx.objectStore(SETTINGS_STORE)
    await new Promise((resolve, reject) => {
      const request = store.put({ key: 'authToken', value: token })
      request.onsuccess = () => resolve()
      request.onerror = (event) => reject(new Error(event.target.error))
    })
  } catch (error) {
    console.warn('[SW] Failed to save auth token to DB:', error)
  }
}

async function readAuthTokenFromDB() {
  try {
    const db = await openDB()
    const tx = db.transaction([SETTINGS_STORE], 'readonly')
    const store = tx.objectStore(SETTINGS_STORE)
    const record = await new Promise((resolve, reject) => {
      const request = store.get('authToken')
      request.onsuccess = (event) => resolve(event.target.result)
      request.onerror = (event) => reject(new Error(event.target.error))
    })
    return record ? record.value : null
  } catch (error) {
    console.warn('[SW] Failed to read auth token from DB:', error)
    return null
  }
}

async function getEffectiveAuthToken(fallbackToken) {
  if (CURRENT_AUTH_TOKEN) {
    return CURRENT_AUTH_TOKEN
  }
  const stored = await readAuthTokenFromDB()
  if (stored) {
    CURRENT_AUTH_TOKEN = stored
    return stored
  }
  return fallbackToken || null
}

/**
 * Convert base64 string back to File object
 */
async function base64ToFile(base64Data, fileName, mimeType) {
  const response = await fetch(`data:${mimeType};base64,${base64Data}`)
  const blob = await response.blob()
  return new File([blob], fileName, { type: mimeType })
}

/**
 * Show push notification for upload events
 */
async function showNotification(title, options) {
  if ('Notification' in self && self.Notification.permission === 'granted') {
    return self.registration.showNotification(title, {
      badge: '/img/tree.svg',
      icon: '/img/tree.svg',
      vibrate: [200, 100, 200],
      ...options
    })
  }
}

/**
 * Notify all clients about upload events
 */
async function notifyClients(type, data) {
  const clients = await self.clients.matchAll()

  clients.forEach(client => {
    client.postMessage({
      type,
      data
    })
  })

  // Show push notification for background uploads
  if (type === 'UPLOAD_SUCCESS') {
    await showNotification('TreeGens - Upload Complete', {
      body: 'Your tree planting video has been uploaded successfully!',
      tag: 'upload-success',
      requireInteraction: false,
      actions: [
        {
          action: 'view',
          title: 'View Submission'
        }
      ]
    })
  } else if (type === 'UPLOAD_FAILED') {
    await showNotification(data.waiting ? 'TreeGens - Upload Waiting' : 'TreeGens - Upload Failed', {
      body: data.permanent
        ? `Upload refused: ${withStop(data.error)} This video will not be sent.`
        : data.waiting
          ? `Not uploaded yet: ${data.error}`
          : `Upload failed: ${data.error}. We'll retry automatically.`,
      tag: 'upload-failed',
      requireInteraction: true
    })
  }
}

// Web Push (TreeGens inbox / alerts)
self.addEventListener('push', event => {
  let payload = {
    title: 'TreeGens',
    body: 'You have a new notification.',
    url: '/inbox',
  }
  try {
    const txt = event.data?.text?.()
    if (txt) {
      const parsed = JSON.parse(txt)
      payload = { ...payload, ...parsed }
    }
  } catch (_) {
    /* ignore */
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'TreeGens', {
      body: payload.body || '',
      icon: '/img/tree.svg',
      badge: '/img/tree.svg',
      data: { url: payload.url || '/inbox' },
      vibrate: [160, 80, 160],
    }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const rawUrl = event.notification?.data?.url || '/inbox'
  const targetUrl = new URL(rawUrl, self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus()
          if ('navigate' in client && typeof client.navigate === 'function') {
            try {
              client.navigate(targetUrl)
            } catch (_) {
              /* navigate may throw if unsupported */
            }
          }
          return
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
      return undefined
    }),
  )
})

console.log('[SW] TreeGens Service Worker loaded')
