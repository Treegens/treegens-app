import express, { Request, Response } from 'express'
import mongoose from 'mongoose'
import { authenticate } from '../middleware/auth'
import { rewardClaimLimiter } from '../middleware/rateLimits'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import RewardClaimQueueService from '../services/rewardClaimQueueService'
import RewardService from '../services/rewardService'
import {
  sendBadRequest,
  sendError,
  sendSuccess,
} from '../utils/responseHelpers'

const router = express.Router()
const rewardService = new RewardService()
const rewardClaimQueueService = new RewardClaimQueueService()

/**
 * @swagger
 * tags:
 *   name: Rewards
 *   description: MGRO reward claims after submission approval
 */

/**
 * @swagger
 * /api/rewards/status/{submissionId}:
 *   get:
 *     summary: Get reward status projection for authenticated wallet
 *     description: |
 *       Returns frontend-ready reward state for the caller and submission.
 *       For planters this includes pending claim amount, next claim amount and countdown.
 *       Response `data` includes **activeClaimJob** (boolean): `true` if at least one
 *       RewardClaimJob exists for this wallet and submission with `status` not `completed`
 *       (`queued`, `processing`, or `failed`); `false` when none or all completed. Poll after POST /claim.
 *       Planter projections may include **nextPlanterAction** (`claim` | `health_check` | `wait`),
 *       **healthCheckRequiredForNextClaim**, and **pendingHealthCheckpointIndex** for survival-based vesting.
 *     tags: [Rewards]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: |
 *           Reward projection for the wallet plus **activeClaimJob** (see summary).
 *           Standard SuccessResponse envelope with `data` containing projection fields.
 *       400:
 *         description: Invalid submission id
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Wallet not eligible for this submission
 *       404:
 *         description: No allocation found
 *       500:
 *         description: Server error
 */
router.get(
  '/status/:submissionId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const submissionId = req.params.submissionId
      if (!submissionId || typeof submissionId !== 'string') {
        return sendBadRequest(res, 'submissionId is required')
      }
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }

      const wallet = req.user?.walletAddress
      if (!wallet) {
        return sendError(res, 'Wallet address missing from token', 403)
      }

      const status = await rewardService.getRewardStatusForWallet(
        submissionId,
        wallet,
      )
      const activeClaimJob =
        await rewardClaimQueueService.hasActiveClaimJobForSubmissionWallet(
          submissionId,
          wallet,
        )
      return sendSuccess(res, 'Reward status retrieved successfully', {
        ...status,
        activeClaimJob,
      })
    } catch (e: any) {
      if (e?.message === 'No reward allocation for this submission') {
        return sendError(res, e.message, 404)
      }
      if (
        e?.message ===
        'This wallet has no reward allocation for this submission'
      ) {
        return sendError(res, e.message, 403)
      }
      return sendError(res, e?.message || e, 500)
    }
  },
)

/**
 * @swagger
 * /api/rewards/claim:
 *   post:
 *     summary: Claim MGRO rewards for an approved submission
 *     description: |
 *       Mints verifier MGRO for yes-voters (manual only; sparse ledger) and/or due planter tranches.
 *       Planter and verifier paths both run when the wallet qualifies for both.
 *     tags: [Rewards]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - submissionId
 *             properties:
 *               submissionId:
 *                 type: string
 *                 description: MongoDB ObjectId of the approved submission
 *     responses:
 *       202:
 *         description: |
 *           Claim accepted and queued for async processing.
 *           Poll GET /api/rewards/status/{submissionId} — activeClaimJob becomes false when the async job completes.
 *       400:
 *         description: Invalid submission id
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Wallet not eligible for this submission
 *       500:
 *         description: Server or chain error
 */
router.post(
  '/claim',
  authenticate,
  rewardClaimLimiter,
  async (req: Request, res: Response) => {
    try {
      const submissionId = req.body?.submissionId
      if (!submissionId || typeof submissionId !== 'string') {
        return sendBadRequest(res, 'submissionId is required')
      }
      if (!mongoose.Types.ObjectId.isValid(submissionId)) {
        return sendBadRequest(res, 'Invalid submissionId')
      }

      const wallet = req.user?.walletAddress
      if (!wallet) {
        return sendError(res, 'Wallet address missing from token', 403)
      }

      const w = wallet.toLowerCase()
      const sid = new mongoose.Types.ObjectId(submissionId)
      const allocationPre = await RewardAllocation.findOne({
        submissionId: sid,
      })
      if (!allocationPre) {
        return sendError(res, 'No reward allocation for this submission', 404)
      }
      const submissionPre = await Submission.findById(sid).lean()
      if (!submissionPre || submissionPre.status !== 'approved') {
        return sendError(res, 'Submission not found or not approved', 400)
      }
      const { planter, verifier } = rewardService.getClaimEligibility(
        submissionPre,
        allocationPre,
        w,
      )
      if (!planter && !verifier) {
        return sendError(
          res,
          'This wallet has no reward allocation for this submission',
          403,
        )
      }

      const status = await rewardService.getRewardStatusForWallet(
        submissionId,
        w,
      )
      const planterCanClaim = status.role === 'planter' && status.canClaim
      const verifierCanClaim =
        status.role === 'verifier'
          ? status.canClaim
          : Boolean(status.verifier?.canClaim)
      if (!planterCanClaim && !verifierCanClaim) {
        return sendError(res, 'No claimable rewards at this time', 409)
      }

      const claimType =
        planterCanClaim && verifierCanClaim
          ? 'both'
          : planterCanClaim
            ? 'planter'
            : 'verifier'
      const { job, created } =
        await rewardClaimQueueService.enqueueOrReuseClaimJob({
          submissionId,
          walletAddress: w,
          claimType,
        })

      return sendSuccess(
        res,
        created
          ? 'Reward claim queued for processing'
          : 'Existing reward claim is already processing',
        {
          submissionId,
          jobId: job.jobId,
          status: job.status,
          claimType: job.claimType,
          queuedAt: job.queuedAt,
          updatedAt: job.updatedAt,
          created,
        },
        202,
      )
    } catch (e: any) {
      return sendError(res, e?.message || e, 500)
    }
  },
)

export default router
