import { timingSafeEqual } from 'node:crypto'
import express, { NextFunction, Request, Response } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import Joi from 'joi'
import multer from 'multer'
import env from '../config/environment'
import {
  gwrAdminLimiter,
  gwrReadLimiter,
  gwrUploadLimiter,
} from '../middleware/rateLimits'
import { fileFilter } from '../middleware/upload'
import GwrVideoService from '../services/gwrVideoService'
import {
  sendBadRequest,
  sendCreated,
  sendError,
  sendNotFound,
  sendSuccess,
} from '../utils/responseHelpers'

/**
 * Guinness World Record clip collection — treegens.app/gwr and /gwr-vids.
 *
 * Public on purpose: everyone filming at the record site hands in an "after"
 * clip without an account, a wallet, a before clip or a verifier. Nothing here
 * touches submissions, rewards or MGRO.
 *
 * Public also means nothing counts callers by wallet, so the body is guarded
 * BEFORE it is read: the upload code (a header) and an in-flight cap per
 * network and overall both run ahead of multer.
 */
const router = express.Router()
const gwrVideoService = new GwrVideoService()

/** multer's ceiling (memory storage), surfaced to the client. */
const MAX_FILE_SIZE_MB = 100
/** Advisory only — the page shows it; nothing is refused for its length. */
const MAX_DURATION_SECONDS: number | null = null

const UPLOAD_CODE_HEADER = 'x-gwr-upload-code'
const UPLOAD_ID_HEADER = 'x-gwr-upload-id'
const ADMIN_KEY_HEADER = 'x-gwr-admin-key'

const uploadSchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  accuracyMeters: Joi.number().min(0).optional(),
  reverseGeocode: Joi.string().trim().max(500).optional().allow(''),
  uploaderName: Joi.string().trim().max(120).optional().allow(''),
  note: Joi.string().trim().max(500).optional().allow(''),
  recordedAt: Joi.date().iso().optional().allow(''),
}).and('latitude', 'longitude')

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** A refusal sent before the body was read: do not keep the connection. */
const refuseEarly = (
  res: Response,
  status: number,
  body: Record<string, unknown>,
) => {
  res.set('Connection', 'close')
  return res.status(status).json(body)
}

/**
 * When GWR_UPLOAD_CODE is set, every upload must carry it in a header. A
 * header, not a form field, so it is checked before a single byte of the
 * clip is read.
 */
const requireUploadCode = (req: Request, res: Response, next: NextFunction) => {
  const expected = env.GWR_UPLOAD_CODE
  if (!expected) return next()
  const given = String(
    req.header(UPLOAD_CODE_HEADER) ?? req.query.uploadCode ?? '',
  ).trim()
  if (!given) {
    return refuseEarly(res, 403, {
      error: 'Upload code required',
      code: 'UPLOAD_CODE_REQUIRED',
    })
  }
  if (!safeEqual(given, expected)) {
    return refuseEarly(res, 403, {
      error: 'Upload code is wrong',
      code: 'UPLOAD_CODE_INVALID',
    })
  }
  next()
}

/**
 * How many clips may be in flight at once, per network and overall: each
 * one is held in memory until it is in the bucket, and the request limiter
 * counts requests, not open streams.
 */
const inFlightByIp = new Map<string, number>()
let inFlightTotal = 0

const limitInFlight = (req: Request, res: Response, next: NextFunction) => {
  const key = ipKeyGenerator(req.ip ?? '0.0.0.0')
  const mine = inFlightByIp.get(key) ?? 0
  if (
    mine >= env.GWR_MAX_INFLIGHT_PER_IP ||
    inFlightTotal >= env.GWR_MAX_INFLIGHT
  ) {
    res.set('Retry-After', '15')
    return refuseEarly(res, 429, {
      error: 'Too many clips uploading at once; try again in a moment',
      code: 'TOO_MANY_UPLOADS',
    })
  }
  inFlightByIp.set(key, mine + 1)
  inFlightTotal++
  let released = false
  const release = () => {
    if (released) return
    released = true
    inFlightTotal--
    const left = (inFlightByIp.get(key) ?? 1) - 1
    if (left > 0) inFlightByIp.set(key, left)
    else inFlightByIp.delete(key)
  }
  res.once('close', release)
  res.once('finish', release)
  next()
}

/** This route's own multer: the text fields capped at what the schema takes. */
const gwrUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    files: 1,
    fields: 12,
    parts: 14,
    fieldSize: 4096,
    fieldNameSize: 64,
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
  },
})

const receiveGwrClip = (req: Request, res: Response, next: NextFunction) => {
  gwrUpload.single('video')(req, res, (error?: unknown) => {
    if (!error) return next()
    const code = (error as { code?: string })?.code
    const message = (error as Error)?.message
    if (code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That clip is larger than this server takes (${MAX_FILE_SIZE_MB} MB)`,
        code: 'FILE_TOO_LARGE',
      })
    }
    if (typeof code === 'string' && code.startsWith('LIMIT_')) {
      return res.status(400).json({
        error: 'Upload form has too many or too large fields',
        code: 'BAD_FORM',
      })
    }
    if (message === 'Only video files are allowed') {
      return res.status(400).json({
        error: 'Invalid file type',
        details: 'Only video files are allowed',
        code: 'INVALID_VIDEO',
      })
    }
    return next(error)
  })
}

const validateUpload = (req: Request, res: Response, next: NextFunction) => {
  const { error, value } = uploadSchema.validate(req.body, {
    stripUnknown: true,
    convert: true,
  })
  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(d => d.message),
    })
  }
  req.body = value
  next()
}

/** `x-gwr-upload-id`: the phone's id for this clip, or nothing. */
const clientUploadIdOf = (req: Request): string | undefined => {
  const raw = String(req.header(UPLOAD_ID_HEADER) ?? '').trim()
  return /^[A-Za-z0-9-]{8,64}$/.test(raw) ? raw : undefined
}

/** Admin actions need GWR_ADMIN_KEY in `x-gwr-admin-key`; closed when unset. */
const requireAdminKey = (req: Request, res: Response, next: NextFunction) => {
  const expected = env.GWR_ADMIN_KEY
  if (!expected) {
    return res.status(403).json({
      error: 'GWR admin actions are disabled (GWR_ADMIN_KEY not set)',
      code: 'ADMIN_DISABLED',
    })
  }
  const given = String(req.header(ADMIN_KEY_HEADER) ?? '').trim()
  if (!given || !safeEqual(given, expected)) {
    console.warn('GWR admin key rejected', {
      path: req.path,
      method: req.method,
      ip: req.ip,
    })
    return res
      .status(403)
      .json({ error: 'Admin key is wrong', code: 'ADMIN_KEY_INVALID' })
  }
  next()
}

/**
 * @swagger
 * tags:
 *   name: GWR
 *   description: Guinness World Record after-clips (public, no auth)
 */

/**
 * @swagger
 * /api/gwr/config:
 *   get:
 *     summary: Client limits and whether an upload code is required
 *     tags: [GWR]
 *     responses:
 *       200:
 *         description: Config
 */
router.get('/config', gwrReadLimiter, (_req: Request, res: Response) => {
  return sendSuccess(res, 'GWR config', {
    uploadCodeRequired: Boolean(env.GWR_UPLOAD_CODE),
    adminEnabled: Boolean(env.GWR_ADMIN_KEY),
    maxFileSizeMB: MAX_FILE_SIZE_MB,
    maxDurationSeconds: MAX_DURATION_SECONDS,
  })
})

/**
 * @swagger
 * /api/gwr/videos:
 *   post:
 *     summary: Upload an after-clip from the record site
 *     description: >
 *       Public. When GWR_UPLOAD_CODE is set, send it in the `x-gwr-upload-code`
 *       header (checked before the body is read). Send a client-minted id in
 *       `x-gwr-upload-id` so a retry after a lost response returns the first
 *       copy instead of storing a second.
 *     tags: [GWR]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [video]
 *             properties:
 *               video: { type: string, format: binary }
 *               latitude: { type: number }
 *               longitude: { type: number }
 *               accuracyMeters: { type: number }
 *               reverseGeocode: { type: string }
 *               uploaderName: { type: string }
 *               note: { type: string }
 *               recordedAt: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Clip stored (or the first copy of this upload id)
 *       400:
 *         description: Validation error / not a video
 *       403:
 *         description: Upload code missing or wrong
 *       413:
 *         description: File over 100MB
 *       429:
 *         description: Too many clips in flight from this network
 */
router.post(
  '/videos',
  gwrUploadLimiter,
  requireUploadCode,
  limitInFlight,
  receiveGwrClip,
  validateUpload,
  async (req: Request, res: Response) => {
    try {
      const file = req.file
      if (!file || file.size === 0) {
        return sendBadRequest(res, 'No video file provided')
      }

      const b = req.body
      const view = await gwrVideoService.uploadClip(file, {
        clientUploadId: clientUploadIdOf(req),
        latitude: typeof b.latitude === 'number' ? b.latitude : undefined,
        longitude: typeof b.longitude === 'number' ? b.longitude : undefined,
        accuracyMeters:
          typeof b.accuracyMeters === 'number' ? b.accuracyMeters : undefined,
        reverseGeocode: b.reverseGeocode || undefined,
        uploaderName: b.uploaderName || undefined,
        note: b.note || undefined,
        recordedAt: b.recordedAt instanceof Date ? b.recordedAt : undefined,
      })
      return sendCreated(res, 'GWR clip uploaded', view)
    } catch (error: any) {
      console.error('GWR upload error:', error)
      return sendError(res, `Failed to store clip: ${error.message}`, 500)
    }
  },
)

/**
 * @swagger
 * /api/gwr/videos:
 *   get:
 *     summary: List after-clips, newest first
 *     tags: [GWR]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 200 }
 *     responses:
 *       200:
 *         description: Clips and pagination
 */
router.get('/videos', gwrReadLimiter, async (req: Request, res: Response) => {
  try {
    const page = parseInt(String(req.query.page ?? '1'), 10)
    const limit = parseInt(String(req.query.limit ?? '50'), 10)
    const data = await gwrVideoService.list({
      page: Number.isFinite(page) ? page : 1,
      limit: Number.isFinite(limit) ? limit : 50,
    })
    return sendSuccess(res, 'GWR clips', data)
  } catch (error: any) {
    return sendError(res, error.message || 'Failed to list clips')
  }
})

/**
 * @swagger
 * /api/gwr/videos/manifest.csv:
 *   get:
 *     summary: CSV of every clip (filename, time, uploader, GPS, size, URL)
 *     tags: [GWR]
 *     responses:
 *       200:
 *         description: text/csv
 */
router.get(
  '/videos/manifest.csv',
  gwrReadLimiter,
  async (_req: Request, res: Response) => {
    try {
      const csv = await gwrVideoService.manifestCsv()
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="treegens-gwr-manifest.csv"',
      )
      return res.status(200).send(csv)
    } catch (error: any) {
      return sendError(res, error.message || 'Failed to build manifest')
    }
  },
)

/**
 * @swagger
 * /api/gwr/videos/urls.txt:
 *   get:
 *     summary: One download URL per line (wget --content-disposition -i urls.txt)
 *     tags: [GWR]
 *     responses:
 *       200:
 *         description: text/plain
 */
router.get(
  '/videos/urls.txt',
  gwrReadLimiter,
  async (_req: Request, res: Response) => {
    try {
      const txt = await gwrVideoService.urlList()
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="treegens-gwr-urls.txt"',
      )
      return res.status(200).send(txt)
    } catch (error: any) {
      return sendError(res, error.message || 'Failed to build URL list')
    }
  },
)

/**
 * @swagger
 * /api/gwr/admin/check:
 *   get:
 *     summary: Is this admin key right? (the gallery's manage mode asks first)
 *     tags: [GWR]
 *     responses:
 *       204:
 *         description: Key accepted
 *       403:
 *         description: Admin disabled or key wrong
 */
router.get(
  '/admin/check',
  gwrAdminLimiter,
  requireAdminKey,
  (_req: Request, res: Response) => res.status(204).end(),
)

/**
 * @swagger
 * /api/gwr/videos/{id}:
 *   delete:
 *     summary: Remove a clip (bucket object and record). Needs x-gwr-admin-key.
 *     tags: [GWR]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Removed
 *       403:
 *         description: Admin key missing/wrong or admin disabled
 *       404:
 *         description: No such clip
 */
router.delete(
  '/videos/:id',
  gwrAdminLimiter,
  requireAdminKey,
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id ?? '')
      if (!/^[a-fA-F0-9]{24}$/.test(id))
        return sendBadRequest(res, 'Invalid id')
      const removed = await gwrVideoService.remove(id)
      if (!removed) return sendNotFound(res, 'Clip')
      return sendSuccess(res, 'GWR clip removed', { id })
    } catch (error: any) {
      return sendError(res, error.message || 'Failed to remove clip')
    }
  },
)

export default router
