import { v4 as uuidv4 } from 'uuid'
import { deleteFromStorage, uploadGwrClipToStorage } from '../config/gcs'
import GwrVideo from '../models/GwrVideo'
import {
  GWR_STORAGE_PREFIX,
  buildGwrDownloadFilename,
  buildGwrManifestCsv,
  gwrFileExtension,
  gwrMimeForExtension,
} from './gwrVideoNaming'

export interface GwrUploadFields {
  /** The phone's own id for this upload; a retry with the same id gets the
   * first copy back instead of storing a second. */
  clientUploadId?: string
  latitude?: number
  longitude?: number
  accuracyMeters?: number
  reverseGeocode?: string
  uploaderName?: string
  note?: string
  recordedAt?: Date
}

/** Wire shape for the gallery. `downloadUrl` is the public object URL, which
 * serves with Content-Disposition: attachment (see uploadGwrClipToStorage). */
export interface GwrVideoView {
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

const clean = (v: unknown) =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

export function toGwrVideoView(doc: any): GwrVideoView {
  const gps = doc.gpsCoordinates
  return {
    id: String(doc._id),
    publicUrl: doc.publicUrl,
    downloadUrl: doc.publicUrl,
    downloadFilename: doc.downloadFilename,
    originalFilename: clean(doc.originalFilename),
    mimeType: clean(doc.mimeType),
    sizeBytes: typeof doc.sizeBytes === 'number' ? doc.sizeBytes : undefined,
    gpsCoordinates:
      gps &&
      typeof gps.latitude === 'number' &&
      typeof gps.longitude === 'number'
        ? {
            latitude: gps.latitude,
            longitude: gps.longitude,
            ...(typeof gps.accuracyMeters === 'number'
              ? { accuracyMeters: gps.accuracyMeters }
              : {}),
          }
        : undefined,
    reverseGeocode: clean(doc.reverseGeocode),
    uploaderName: clean(doc.uploaderName),
    note: clean(doc.note),
    recordedAt: doc.recordedAt
      ? new Date(doc.recordedAt).toISOString()
      : undefined,
    uploadedAt: new Date(
      doc.uploadedAt ?? doc.createdAt ?? Date.now(),
    ).toISOString(),
  }
}

class GwrVideoService {
  async uploadClip(
    file: Express.Multer.File,
    fields: GwrUploadFields,
  ): Promise<GwrVideoView> {
    // A lost response after the last byte makes the phone send the clip
    // again. Same id, same clip: answer with what is already stored.
    if (fields.clientUploadId) {
      const existing: any = await GwrVideo.findOne({
        clientUploadId: fields.clientUploadId,
      }).lean()
      if (existing) return toGwrVideoView(existing)
    }

    const uploadedAt = new Date()
    const id = uuidv4()
    const extension = gwrFileExtension(file.originalname, file.mimetype)
    const objectName = `${GWR_STORAGE_PREFIX}${id}.${extension}`
    const downloadFilename = buildGwrDownloadFilename({
      uploadedAt,
      uploaderName: fields.uploaderName,
      uniqueId: id,
      extension,
    })
    // Served under OUR extension's type, never the part's declared one.
    const mimeType = gwrMimeForExtension(extension)

    const stored = await uploadGwrClipToStorage(
      file.buffer,
      objectName,
      mimeType,
      downloadFilename,
    )

    const hasGps =
      typeof fields.latitude === 'number' &&
      typeof fields.longitude === 'number'

    try {
      const doc = await GwrVideo.create({
        clientUploadId: fields.clientUploadId || undefined,
        objectName: stored.videoCID,
        publicUrl: stored.publicUrl,
        downloadFilename,
        originalFilename: file.originalname,
        mimeType,
        sizeBytes: file.size,
        gpsCoordinates: hasGps
          ? {
              latitude: fields.latitude,
              longitude: fields.longitude,
              ...(typeof fields.accuracyMeters === 'number'
                ? { accuracyMeters: fields.accuracyMeters }
                : {}),
            }
          : undefined,
        reverseGeocode: fields.reverseGeocode,
        uploaderName: fields.uploaderName,
        note: fields.note,
        recordedAt: fields.recordedAt,
        uploadedAt,
      })
      return toGwrVideoView(doc.toObject())
    } catch (error) {
      // Never leave an orphan in the bucket that the gallery cannot see.
      await deleteFromStorage(objectName).catch(() => undefined)
      // Two copies of the same retry raced: the other one won, serve it.
      if (
        fields.clientUploadId &&
        (error as { code?: number })?.code === 11000
      ) {
        const winner: any = await GwrVideo.findOne({
          clientUploadId: fields.clientUploadId,
        }).lean()
        if (winner) return toGwrVideoView(winner)
      }
      throw error
    }
  }

  async list(params: { page: number; limit: number }) {
    const page = Math.max(1, params.page)
    const limit = Math.min(200, Math.max(1, params.limit))
    const [docs, total] = await Promise.all([
      GwrVideo.find()
        .sort({ uploadedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      GwrVideo.countDocuments(),
    ])
    return {
      videos: docs.map(toGwrVideoView),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    }
  }

  /** Every clip, oldest first — the order you would want files on disk. */
  async listAllViews(): Promise<GwrVideoView[]> {
    const docs = await GwrVideo.find().sort({ uploadedAt: 1, _id: 1 }).lean()
    return docs.map(toGwrVideoView)
  }

  async manifestCsv(): Promise<string> {
    const views = await this.listAllViews()
    return buildGwrManifestCsv(
      views.map(v => ({
        downloadFilename: v.downloadFilename,
        publicUrl: v.downloadUrl,
        uploadedAt: v.uploadedAt,
        uploaderName: v.uploaderName,
        latitude: v.gpsCoordinates?.latitude,
        longitude: v.gpsCoordinates?.longitude,
        accuracyMeters: v.gpsCoordinates?.accuracyMeters,
        reverseGeocode: v.reverseGeocode,
        sizeBytes: v.sizeBytes,
        note: v.note,
      })),
    )
  }

  /** One URL per line: `wget -i urls.txt` pulls the whole collection. */
  async urlList(): Promise<string> {
    const views = await this.listAllViews()
    return views.map(v => v.downloadUrl).join('\n') + (views.length ? '\n' : '')
  }

  async remove(id: string): Promise<boolean> {
    const doc = await GwrVideo.findById(id)
    if (!doc) return false
    await deleteFromStorage(doc.objectName)
    await doc.deleteOne()
    return true
  }
}

export default GwrVideoService
