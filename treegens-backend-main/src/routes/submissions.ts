import express, { Request, Response } from 'express'
import mongoose from 'mongoose'
import { authenticate, requireVerifier } from '../middleware/auth'
import {
  conversationMessageLimiter,
  submissionUploadLimiter,
  submissionVoteLimiter,
} from '../middleware/rateLimits'
import { upload } from '../middleware/upload'
import {
  validateHealthCheckUpload,
  validateHealthCheckVote,
  validateSubmissionUpload,
} from '../middleware/validation'
import User from '../models/User'
import * as conversationService from '../services/conversationService'
import HealthCheckService from '../services/healthCheckService'
import SubmissionService from '../services/submissionService'
import {
  sendBadRequest,
  sendCreated,
  sendError,
  sendNotFound,
  sendSuccess,
} from '../utils/responseHelpers'

const router = express.Router()
const submissionService = new SubmissionService()
const healthCheckService = new HealthCheckService()

router.get(
  '/health-checks/moderation',
  authenticate,
  requireVerifier,
  async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20))
      const data = await healthCheckService.listModerationQueue(page, limit)
      return sendSuccess(res, 'Health check moderation queue', data)
    } catch (error: any) {
      console.error('Health check moderation list error:', error)
      return sendError(res, error.message || 'Failed to list health checks')
    }
  },
)

/**
 * @swagger
 * tags:
 *   name: Submissions
 *   description: Land and plant video submissions (one document per submission)
 */

/**
 * @swagger
 * /api/submissions/upload:
 *   post:
 *     summary: Upload land or plant clip to IPFS
 *     description: |
 *       multipart/form-data with file field `video`. `type=land` creates a new submission (do not send submissionId).
 *       `type=plant` requires `submissionId`, `treesPlanted`, and `treeType` or `treetype`; sets submission to `pending_review`.
 *       `treeType` is stored trimmed and lowercased.
 *     tags: [Submissions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - video
 *               - latitude
 *               - longitude
 *               - type
 *             properties:
 *               video:
 *                 type: string
 *                 format: binary
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               type:
 *                 type: string
 *                 enum: [land, plant]
 *               submissionId:
 *                 type: string
 *                 description: Required when type=plant; must be omitted when type=land
 *               treesPlanted:
 *                 type: integer
 *                 description: Required when type=plant
 *               treeType:
 *                 type: string
 *                 description: Required when type=plant (or send treetype). Verifier review applies when value is mangrove (case-insensitive).
 *               treetype:
 *                 type: string
 *                 description: Alternate field name for treeType when type=plant
 *               reverseGeocode:
 *                 type: string
 *     responses:
 *       201:
 *         description: Clip uploaded
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/SubmissionUploadResponse'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Upload failed
 */

router.post(
  '/upload',
  authenticate,
  submissionUploadLimiter,
  upload.single('video'),
  validateSubmissionUpload,
  async (req: Request, res: Response) => {
    try {
      const {
        latitude,
        longitude,
        type,
        submissionId,
        treesPlanted,
        treeType,
        treetype,
        reverseGeocode,
      } = req.body
      const file = req.file
      const userWalletAddress = req.user?.walletAddress as string

      if (!file) {
        return sendBadRequest(res, 'No video file provided')
      }

      const uploadData = await submissionService.uploadClip(
        file,
        userWalletAddress,
        latitude,
        longitude,
        type,
        submissionId || undefined,
        treesPlanted,
        treeType || treetype,
        reverseGeocode,
      )
      return sendCreated(
        res,
        'Submission clip uploaded successfully to IPFS',
        uploadData,
      )
    } catch (error: any) {
      console.error('Submission upload error:', error)
      return sendError(res, `Failed to upload to IPFS: ${error.message}`, 500)
    }
  },
)

/**
 * @swagger
 * /api/submissions/my-submissions:
 *   get:
 *     summary: List current user's submissions
 *     tags: [Submissions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, default: 10 }
 *     responses:
 *       200:
 *         description: Paginated submissions with hasLandClip / hasPlantClip flags
 *       401:
 *         description: Unauthorized
 */

router.get(
  '/my-submissions',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { page = 1, limit = 10 } = req.query
      const walletAddress = req.user?.walletAddress as string
      const data = await submissionService.getSubmissionsByUser(
        walletAddress,
        Number(page),
        Number(limit),
      )
      return sendSuccess(res, 'User submissions retrieved successfully', data)
    } catch (error: any) {
      console.error('Error fetching submissions:', error)
      return sendError(res, 'Failed to retrieve submissions')
    }
  },
)

/**
 * @swagger
 * /api/submissions:
 *   get:
 *     summary: List submissions
 *     description: |
 *       Default (no scope): same as caller's submissions. `scope=moderation`: verifier moderation queue; only submissions with treeType mangrove (case-insensitive) and vote/status filters as before.
 *       `scope=verifier_inbox`: approved submissions the caller voted yes on with verifier rewards not fully claimed.
 *     tags: [Submissions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *           enum: [moderation, verifier_inbox]
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, default: 10 }
 *       - in: query
 *         name: minYes
 *         schema: { type: integer }
 *         description: moderation scope only
 *       - in: query
 *         name: minNo
 *         schema: { type: integer }
 *       - in: query
 *         name: maxVotes
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Submissions list
 *       403:
 *         description: Verifier role required for scoped lists
 */

router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const scope = (req.query.scope as string | undefined)?.trim()
    const wallet = req.user?.walletAddress as string
    if (!wallet) {
      return sendError(res, 'Wallet address missing from token', 403)
    }

    if (scope === 'moderation' || scope === 'verifier_inbox') {
      const user = await User.findOne({
        walletAddress: wallet.toLowerCase(),
      }).lean()
      if (!user?.isVerifier) {
        return sendError(res, 'Access denied. Verifier role required.', 403)
      }
    }

    const page = Number(req.query.page) || 1
    const limit = Number(req.query.limit) || 10

    if (scope === 'moderation') {
      const { minYes, minNo, maxVotes, status } = req.query as Record<
        string,
        string | undefined
      >
      const result = await submissionService.getSubmissionsWithVoteFilters({
        minYes: minYes !== undefined ? Number(minYes) : undefined,
        minNo: minNo !== undefined ? Number(minNo) : undefined,
        maxVotes: maxVotes !== undefined ? Number(maxVotes) : undefined,
        status: status as string | undefined,
        page,
        limit,
      })
      return sendSuccess(res, 'Submissions retrieved', result)
    }

    if (scope === 'verifier_inbox') {
      const result = await submissionService.getVerifierInbox(
        wallet,
        page,
        limit,
      )
      return sendSuccess(res, 'Verifier inbox retrieved', result)
    }

    const data = await submissionService.getSubmissionsByUser(
      wallet,
      page,
      limit,
    )
    return sendSuccess(res, 'Submissions retrieved successfully', data)
  } catch (error: any) {
    console.error('Submissions list error:', error)
    return sendError(res, 'Failed to retrieve submissions')
  }
})

router.post(
  '/:submissionId/health-checks',
  authenticate,
  submissionUploadLimiter,
  upload.single('video'),
  validateHealthCheckUpload,
  async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      const file = req.file
      const userWalletAddress = req.user?.walletAddress as string
      if (!file) {
        return sendBadRequest(res, 'No video file provided')
      }
      const { latitude, longitude, treesAlive, reverseGeocode } = req.body
      const data = await healthCheckService.createHealthCheckUpload({
        submissionId,
        planterWallet: userWalletAddress,
        file,
        latitude,
        longitude,
        treesAlive,
        reverseGeocode,
      })
      return sendCreated(res, 'Health check uploaded', data)
    } catch (error: any) {
      console.error('Health check upload error:', error)
      return sendError(res, error.message || 'Failed to upload health check')
    }
  },
)

router.get(
  '/:submissionId/health-checks/:healthCheckId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { submissionId, healthCheckId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      if (!mongoose.Types.ObjectId.isValid(healthCheckId)) {
        return sendBadRequest(res, 'Invalid healthCheckId')
      }
      const wallet = (req.user!.walletAddress as string).toLowerCase()
      const user = await User.findOne({ walletAddress: wallet }).lean()
      const isVerifier = Boolean(user?.isVerifier)
      const data = await healthCheckService.getById(
        submissionId,
        healthCheckId,
        wallet,
        isVerifier,
      )
      return sendSuccess(res, 'Health check retrieved', data)
    } catch (error: any) {
      console.error('Health check get error:', error)
      if (error.message === 'Health check not found') {
        return sendNotFound(res, 'Health check')
      }
      return sendError(res, error.message || 'Failed to get health check')
    }
  },
)

router.get(
  '/:submissionId/health-checks',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      const wallet = (req.user!.walletAddress as string).toLowerCase()
      const user = await User.findOne({ walletAddress: wallet }).lean()
      const isVerifier = Boolean(user?.isVerifier)
      const data = await healthCheckService.listForSubmission(
        submissionId,
        wallet,
        isVerifier,
      )
      return sendSuccess(res, 'Health checks retrieved', data)
    } catch (error: any) {
      console.error('Health check list error:', error)
      return sendError(res, error.message || 'Failed to list health checks')
    }
  },
)

router.post(
  '/:submissionId/health-checks/:healthCheckId/vote',
  authenticate,
  submissionVoteLimiter,
  requireVerifier,
  validateHealthCheckVote,
  async (req: Request, res: Response) => {
    try {
      const { submissionId, healthCheckId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      if (!mongoose.Types.ObjectId.isValid(healthCheckId)) {
        return sendBadRequest(res, 'Invalid healthCheckId')
      }
      const { vote, reasons } = req.body
      const voterWalletAddress = req.user!.walletAddress as string
      const result = await healthCheckService.castVote({
        healthCheckId,
        submissionId,
        voterWalletAddress,
        vote,
        reasons,
      })
      return sendSuccess(res, 'Vote recorded', result)
    } catch (error: any) {
      console.error('Health check vote error:', error)
      return sendError(res, error.message || 'Failed to vote')
    }
  },
)

/**
 * @swagger
 * /api/submissions/{submissionId}:
 *   get:
 *     summary: Get submission by id
 *     tags: [Submissions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Submission document (land + plant)
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/Submission'
 *       400:
 *         description: Invalid id
 *       401:
 *         description: Unauthorized — missing or invalid token
 *       403:
 *         description: Forbidden — not the submission owner or a verifier
 *       404:
 *         description: Not found
 */

router.get(
  '/:submissionId/conversation',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      const wallet = (req.user!.walletAddress as string).toLowerCase()
      const data = await conversationService.getOrCreateConversation(
        submissionId,
        wallet,
      )
      return sendSuccess(res, 'Conversation', data)
    } catch (error: any) {
      console.error('conversation get error:', error)
      if (error.message === 'Access denied') {
        return sendError(res, error.message, 403)
      }
      return sendError(res, error.message || 'Failed to load conversation')
    }
  },
)

router.post(
  '/:submissionId/conversation/messages',
  authenticate,
  conversationMessageLimiter,
  async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      const wallet = (req.user!.walletAddress as string).toLowerCase()
      const body = typeof req.body?.body === 'string' ? req.body.body : ''
      const msg = await conversationService.postMessage(
        submissionId,
        wallet,
        body,
      )
      return sendCreated(res, 'Message sent', msg)
    } catch (error: any) {
      console.error('conversation message error:', error)
      if (error.message === 'Access denied') {
        return sendError(res, error.message, 403)
      }
      return sendBadRequest(res, error.message || 'Failed to send')
    }
  },
)

router.get(
  '/:submissionId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params
      const wallet = (req.user!.walletAddress as string).toLowerCase()
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      const doc = await submissionService.getSubmissionById(submissionId)
      if (!doc) {
        return sendNotFound(res, 'Submission')
      }
      const owner = String(doc.userWalletAddress || '').toLowerCase()
      if (owner && owner === wallet) {
        return sendSuccess(res, 'Submission retrieved successfully', doc)
      }
      const user = await User.findOne({ walletAddress: wallet }).lean()
      if (user?.isVerifier) {
        return sendSuccess(res, 'Submission retrieved successfully', doc)
      }
      return sendError(res, 'Access denied', 403)
    } catch {
      return sendError(res, 'Failed to retrieve submission')
    }
  },
)

/**
 * @swagger
 * /api/submissions/{submissionId}/vote:
 *   post:
 *     summary: Cast verifier vote
 *     description: Only allowed for submissions in pending_review with treeType mangrove (case-insensitive).
 *     tags: [Submissions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
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
 *               vote:
 *                 type: string
 *                 enum: [yes, no]
 *               reasons:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Vote recorded; may include approval transition
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Not a verifier
 */

router.post(
  '/:submissionId/vote',
  authenticate,
  submissionVoteLimiter,
  requireVerifier,
  async (req: Request, res: Response) => {
    try {
      const { submissionId } = req.params
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }
      const { vote, reasons } = req.body
      const voterWalletAddress = req.user!.walletAddress
      const result = await submissionService.castVote({
        submissionId,
        voterWalletAddress,
        vote,
        reasons,
      })
      return sendSuccess(res, 'Vote recorded', result)
    } catch (error: any) {
      console.error('Vote error:', error)
      return sendError(res, error.message || 'Failed to vote')
    }
  },
)

export default router
