import express, { Request, Response } from 'express'
import { authenticate, requireVerifier } from '../middleware/auth'
import {
  siteRecheckLimiter,
  siteVoteLimiter,
  siteWriteLimiter,
} from '../middleware/rateLimits'
import { imageUpload } from '../middleware/upload'
import {
  validateSiteCreate,
  validateSitePhoto,
  validateSiteUpdate,
  validateSiteVote,
} from '../middleware/validation'
import { SITE_ERRORS } from '../services/siteRules'
import SiteService from '../services/siteService'
import {
  sendBadRequest,
  sendCreated,
  sendError,
  sendNotFound,
  sendSuccess,
} from '../utils/responseHelpers'

const router = express.Router()
const siteService = new SiteService()

const SITE_MESSAGES = new Set<string>(Object.values(SITE_ERRORS))

/** Maps the service's error messages to 404 / 403 / 400, anything else 500. */
function sendSiteError(res: Response, error: any, fallback: string) {
  const message = String(error?.message || '')
  if (message === SITE_ERRORS.notFound) return sendNotFound(res, 'Site')
  if (message === SITE_ERRORS.accessDenied) return sendError(res, message, 403)
  if (
    SITE_MESSAGES.has(message) ||
    message.startsWith(SITE_ERRORS.missingAnswers)
  ) {
    return sendBadRequest(res, message)
  }
  console.error(`${fallback}:`, error)
  return sendError(res, fallback)
}

function walletOf(req: Request): string {
  return (req.user!.walletAddress as string).toLowerCase()
}

function pageOf(req: Request) {
  return {
    page: Math.max(1, Number(req.query.page) || 1),
    limit: Math.min(50, Math.max(1, Number(req.query.limit) || 20)),
  }
}

/**
 * @swagger
 * tags:
 *   name: Sites
 *   description: |
 *     Site Check: register a planting site (GPS boundary), answer the field
 *     questions, add photos and get a verdict (plant, fix_first, let_regrow,
 *     not_suitable). A background Sentinel-2 check measures how often the site
 *     is wet; verifiers vote on whether the site record is honest.
 */

/**
 * @swagger
 * /api/sites:
 *   post:
 *     summary: Register a site (saved as a draft)
 *     description: |
 *       `walked` needs `ring` ([lon, lat] pairs, 3 to 500). `pin_radius` needs
 *       `center` and `radiusM` (5 to 300 m). The verdict is computed from the
 *       answers straight away; the satellite check is queued in the background.
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, boundaryMethod]
 *             properties:
 *               name: { type: string, maxLength: 80 }
 *               boundaryMethod: { type: string, enum: [walked, pin_radius] }
 *               ring:
 *                 type: array
 *                 items:
 *                   type: array
 *                   items: { type: number }
 *                   minItems: 2
 *                   maxItems: 2
 *               center:
 *                 type: object
 *                 properties:
 *                   latitude: { type: number }
 *                   longitude: { type: number }
 *               radiusM: { type: number, minimum: 5, maximum: 300 }
 *               countryCode: { type: string, example: KE }
 *               reverseGeocode: { type: string, maxLength: 500 }
 *               answers:
 *                 type: object
 *                 description: Field questionnaire (SiteAnswers); unknown keys are dropped
 *     responses:
 *       201:
 *         description: Site created
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Site'
 *       400:
 *         description: Validation error, or the boundary is invalid, too small or too large
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/',
  authenticate,
  siteWriteLimiter,
  validateSiteCreate,
  async (req: Request, res: Response) => {
    try {
      const site = await siteService.createSite(walletOf(req), req.body)
      return sendCreated(res, 'Site created', site)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to create site')
    }
  },
)

/**
 * @swagger
 * /api/sites/mine:
 *   get:
 *     summary: List my sites, newest first
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *     responses:
 *       200:
 *         description: "`{ sites: Site[], pagination: { page, limit, total, pages } }`"
 *       401:
 *         description: Unauthorized
 */
router.get('/mine', authenticate, async (req: Request, res: Response) => {
  try {
    const { page, limit } = pageOf(req)
    const data = await siteService.listMySites(walletOf(req), page, limit)
    return sendSuccess(res, 'Sites retrieved', data)
  } catch (error: any) {
    return sendSiteError(res, error, 'Failed to list sites')
  }
})

/**
 * @swagger
 * /api/sites/moderation:
 *   get:
 *     summary: Sites waiting for this verifier's review, oldest first
 *     description: Excludes the verifier's own sites and sites they already voted on.
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 20 }
 *     responses:
 *       200:
 *         description: "`{ sites: Site[], pagination: { page, limit, total, pages } }`"
 *       403:
 *         description: Not a verifier
 */
router.get(
  '/moderation',
  authenticate,
  requireVerifier,
  async (req: Request, res: Response) => {
    try {
      const { page, limit } = pageOf(req)
      const data = await siteService.listModerationQueue(
        walletOf(req),
        page,
        limit,
      )
      return sendSuccess(res, 'Site moderation queue', data)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to list sites for review')
    }
  },
)

/**
 * @swagger
 * /api/sites/{siteId}:
 *   get:
 *     summary: Get a site (owner or verifier)
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Site
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Site'
 *       403:
 *         description: Not the owner or a verifier
 *       404:
 *         description: Site not found
 */
router.get('/:siteId', authenticate, async (req: Request, res: Response) => {
  try {
    const site = await siteService.getSiteForViewer(
      walletOf(req),
      req.params.siteId,
    )
    return sendSuccess(res, 'Site retrieved', site)
  } catch (error: any) {
    return sendSiteError(res, error, 'Failed to retrieve site')
  }
})

/**
 * @swagger
 * /api/sites/{siteId}:
 *   patch:
 *     summary: Edit a draft site
 *     description: |
 *       Same fields as create, all optional. `answers` replaces the stored
 *       answers. Moving the boundary restarts the satellite check. The verdict
 *       is always recomputed.
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Updated site
 *       400:
 *         description: Validation error, invalid boundary, or the site is already submitted
 *       404:
 *         description: Site not found
 */
router.patch(
  '/:siteId',
  authenticate,
  siteWriteLimiter,
  validateSiteUpdate,
  async (req: Request, res: Response) => {
    try {
      const site = await siteService.updateSite(
        walletOf(req),
        req.params.siteId,
        req.body,
      )
      return sendSuccess(res, 'Site updated', site)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to update site')
    }
  },
)

/**
 * @swagger
 * /api/sites/{siteId}/photos:
 *   post:
 *     summary: Add a photo to a draft site
 *     description: One photo per kind; a new one replaces the old. JPEG, PNG, WebP or HEIC, up to 15 MB.
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [photo, kind]
 *             properties:
 *               photo: { type: string, format: binary }
 *               kind:
 *                 type: string
 *                 enum: [low_tide_360, ground, tide_mark, high_tide]
 *               latitude: { type: number }
 *               longitude: { type: number }
 *     responses:
 *       201:
 *         description: Updated site
 *       400:
 *         description: Not an image, bad kind, or the site is already submitted
 *       413:
 *         description: Photo too large
 */
router.post(
  '/:siteId/photos',
  authenticate,
  siteWriteLimiter,
  imageUpload.single('photo'),
  validateSitePhoto,
  async (req: Request, res: Response) => {
    try {
      if (!req.file) return sendBadRequest(res, 'No photo provided')
      const { kind, latitude, longitude } = req.body
      const site = await siteService.addPhoto(
        walletOf(req),
        req.params.siteId,
        req.file,
        kind,
        latitude,
        longitude,
      )
      return sendCreated(res, 'Site photo uploaded', site)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to upload site photo')
    }
  },
)

/**
 * @swagger
 * /api/sites/{siteId}/submit:
 *   post:
 *     summary: Submit a draft site for verifier review
 *     description: Needs every required answer and the low_tide_360 and ground photos.
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Site now pending_review
 *       400:
 *         description: Answers or photos missing, or already submitted
 *       404:
 *         description: Site not found
 */
router.post(
  '/:siteId/submit',
  authenticate,
  siteWriteLimiter,
  async (req: Request, res: Response) => {
    try {
      const site = await siteService.submitSite(
        walletOf(req),
        req.params.siteId,
      )
      return sendSuccess(res, 'Site submitted for review', site)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to submit site')
    }
  },
)

/**
 * @swagger
 * /api/sites/{siteId}/hydrology/recheck:
 *   post:
 *     summary: Rerun the satellite check (owner or verifier)
 *     description: Allowed when the last check failed, was skipped, or completed more than 30 days ago.
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Site with the check queued
 *       400:
 *         description: Too soon to rerun
 *       403:
 *         description: Not the owner or a verifier
 */
router.post(
  '/:siteId/hydrology/recheck',
  authenticate,
  siteRecheckLimiter,
  async (req: Request, res: Response) => {
    try {
      const site = await siteService.recheckHydrology(
        walletOf(req),
        req.params.siteId,
      )
      return sendSuccess(res, 'Satellite check queued', site)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to queue satellite check')
    }
  },
)

/**
 * @swagger
 * /api/sites/{siteId}/vote:
 *   post:
 *     summary: Verifier vote on whether the site record is honest
 *     description: |
 *       A strict majority of all verifiers approves or rejects the site.
 *       Nothing is final while there are fewer than MINIMUM_ACTIVE_VERIFIERS
 *       verifiers (`finalizationBlockedByVerifierThreshold`).
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vote]
 *             properties:
 *               vote: { type: string, enum: [yes, no] }
 *               reasons:
 *                 type: array
 *                 maxItems: 10
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Vote recorded, with counts and the site status
 *       400:
 *         description: Own site, already voted, or not open for review
 *       403:
 *         description: Not a verifier
 */
router.post(
  '/:siteId/vote',
  authenticate,
  siteVoteLimiter,
  requireVerifier,
  validateSiteVote,
  async (req: Request, res: Response) => {
    try {
      const { vote, reasons } = req.body
      const result = await siteService.castSiteVote(
        req.params.siteId,
        walletOf(req),
        vote,
        reasons,
      )
      return sendSuccess(res, 'Vote recorded', result)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to vote')
    }
  },
)

/**
 * @swagger
 * /api/sites/{siteId}:
 *   delete:
 *     summary: Delete a draft site that no submission uses
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted
 *       400:
 *         description: Already submitted, or linked to a submission
 *       404:
 *         description: Site not found
 */
router.delete(
  '/:siteId',
  authenticate,
  siteWriteLimiter,
  async (req: Request, res: Response) => {
    try {
      const data = await siteService.deleteDraftSite(
        walletOf(req),
        req.params.siteId,
      )
      return sendSuccess(res, 'Site deleted', data)
    } catch (error: any) {
      return sendSiteError(res, error, 'Failed to delete site')
    }
  },
)

export default router
