import { Storage } from '@google-cloud/storage'
import env from './environment'

/**
 * Google Cloud Storage — the sole media backend (replaces Pinata/IPFS).
 *
 * Returns the same `{ videoCID, publicUrl }` shape the rest of the app already
 * persists, so nothing downstream had to change:
 *   - videoCID  → the object's unique storage path. It keeps the existing
 *                 unique indexes on land/plant.videoCID meaningful and lets
 *                 dedup-by-clip keep working; it is no longer an IPFS CID.
 *   - publicUrl → the object's public https URL.
 *
 * Auth: GCS_SERVICE_ACCOUNT_JSON (the full service-account key JSON, as a
 * string) + GCS_BUCKET. Nothing is written until an upload actually happens,
 * so a missing/invalid config never blocks server boot — it surfaces in
 * /health and throws only at upload time.
 */

type StorageUploadResult = {
  videoCID: string
  publicUrl: string
}

let cachedStorage: Storage | null = null
let cachedBucketName: string | null = null

function parseServiceAccount(): Record<string, unknown> | null {
  const raw = env.GCS_SERVICE_ACCOUNT_JSON?.trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // Some hosts store the JSON base64-encoded to avoid newline issues.
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    } catch {
      throw new Error('GCS_SERVICE_ACCOUNT_JSON is not valid JSON (or base64 JSON)')
    }
  }
}

function getStorage(): { storage: Storage; bucketName: string } {
  const bucketName = env.GCS_BUCKET?.trim()
  if (!bucketName) throw new Error('GCS_BUCKET is not configured')

  if (!cachedStorage || cachedBucketName !== bucketName) {
    const credentials = parseServiceAccount()
    // Fall back to Application Default Credentials when no explicit key is set
    // (e.g. running on GCP with a bound service account).
    cachedStorage = credentials
      ? new Storage({ credentials, projectId: credentials.project_id as string })
      : new Storage()
    cachedBucketName = bucketName
  }
  return { storage: cachedStorage, bucketName }
}

function buildPublicUrl(bucketName: string, objectName: string) {
  return `https://storage.googleapis.com/${bucketName}/${encodeURI(objectName)}`
}

async function uploadToStorage(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<StorageUploadResult> {
  const { storage, bucketName } = getStorage()
  // Namespace uploads under a folder; fileName is already made unique upstream.
  const objectName = `submissions/${fileName}`
  const fileRef = storage.bucket(bucketName).file(objectName)

  try {
    await fileRef.save(fileBuffer, {
      contentType: mimeType,
      resumable: false,
      metadata: {
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { 'uploaded-by': 'treegens-backend' },
      },
    })
  } catch (error) {
    const e = error as { message?: string; code?: number }
    console.error('GCS upload error details:', {
      message: e.message,
      code: e.code,
      bucket: bucketName,
      object: objectName,
    })
    throw new Error(e.message || 'Failed to upload to Google Cloud Storage')
  }

  return {
    videoCID: objectName,
    publicUrl: buildPublicUrl(bucketName, objectName),
  }
}

async function testStorageConnection() {
  const bucketName = env.GCS_BUCKET?.trim()
  if (!bucketName) {
    return { connected: false, message: 'GCS_BUCKET not configured' }
  }
  try {
    const { storage } = getStorage()
    const [exists] = await storage.bucket(bucketName).exists()
    return exists
      ? { connected: true, message: `Google Cloud Storage bucket "${bucketName}" reachable` }
      : { connected: false, message: `Bucket "${bucketName}" not found or not accessible` }
  } catch (error) {
    return { connected: false, message: (error as { message?: string }).message || 'GCS check failed' }
  }
}

export { buildPublicUrl, testStorageConnection, uploadToStorage }
