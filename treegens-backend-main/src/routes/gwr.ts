import { timingSafeEqual } from 'node:crypto'
import express, { NextFunction, Request, Response } from 'express'
import Joi from 'joi'
import env from '../config/environment'
import { gwrReadLimiter, gwrUploadLimiter } from '../middleware/rateLimits'
import { upload } from '../middleware/upload'
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
 */
const router = express.Router()
const gwrVideoService = new GwrVideoService()

/** Multer's ceiling in middleware/upload.ts, surfaced to the client. */
const MAX_FILE_SIZE_MB = 100
/** Advisory only — enforced client side when the clip is picked. */
const MAX_DURATION_SECONDS = 60

const uploadSchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  accuracyMeters: Joi.number().min(0).optional(),
  reverseGeocode: Joi.string().trim().max(500).optional().allow(''),
  uploaderName: Joi.string().trim().max(120).optional().allow(''),
  note: Joi.string().trim().max(500).optional().allow(''),
  recordedAt: Joi.date().iso().optional().allow(''),
  uploadCode: Joi.string().trim().max(200).optional().allow(''),
}).and('latitude', 'longitude')

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

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** When GWR_UPLOAD_CODE is set, every upload must carry it. */
const requireUploadCode = (req: Request, res: Response, next: NextFunction) => {
  const expected = env.GWR_UPLOAD_CODE
  if (!expected) return next()
  const given = String(req.body?.uploadCode ?? '').trim()
  if (!given) {
    return res
      .status(403)
      .json({ error: 'Upload code required', code: 'UPLOAD_CODE_REQUIRED' })
  }
  if (!safeEqual(given, expected)) {
    return res
      .status(403)
      .json({ error: 'Upload code is wrong', code: 'UPLOAD_CODE_INVALID' })
  }
  next()
}

/** Admin actions need GWR_ADMIN_KEY in `x-gwr-admin-key`; disabled when unset. */
const requireAdminKey = (req: Request, res: Response, next: NextFunction) => {
  const expected = env.GWR_ADMIN_KEY
  if (!expected) {
    return res.status(403).json({
      error: 'GWR admin actions are disabled (GWR_ADMIN_KEY not set)',
      code: 'ADMIN_DISABLED',
    })
  }
  const given = String(req.header('x-gwr-admin-key') ?? '').trim()
  if (!given || !safeEqual(given, expected)) {
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
 *               uploadCode: { type: string }
 *     responses:
 *       201:
 *         description: Clip stored
 *       400:
 *         description: Validation error / not a video
 *       403:
 *         description: Upload code missing or wrong
 *       413:
 *         description: File over 100MB
 */
router.post(
  '/videos',
  gwrUploadLimiter,
  upload.single('video'),
  validateUpload,
  requireUploadCode,
  async (req: Request, res: Response) => {
    try {
      const file = req.file
      if (!file) return sendBadRequest(res, 'No video file provided')

      const b = req.body
      const view = await gwrVideoService.uploadClip(file, {
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
 *     summary: One download URL per line (feed it to `wget -i`)
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
  gwrReadLimiter,
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
