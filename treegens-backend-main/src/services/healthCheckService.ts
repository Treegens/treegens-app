import mongoose from 'mongoose'
import env from '../config/environment'
import { uploadToStorage } from '../config/gcs'
import { generateUniqueFileName } from '../middleware/upload'
import HealthCheck from '../models/HealthCheck'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import User from '../models/User'
import { enqueueNotification } from './notificationService'
import { haversineMeters } from '../utils/geo'
import { determineMajorityVote } from '../utils/verifierMajority'
import {
  computeLatestDueCheckpointOneBased,
  getClaimScheduleConfig,
} from './rewardService'
import { applyMinorityPenaltiesForVotes } from './verifierPenaltyService'

const MANGROVE_TREE_TYPE = 'mangrove'

function normalizeTreeType(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

function isMangroveSubmission(submission: {
  treeType?: string | null
}): boolean {
  return normalizeTreeType(submission.treeType ?? '') === MANGROVE_TREE_TYPE
}

export type HealthCheckVote = {
  voterWalletAddress: string
  vote: 'yes' | 'no'
  reasons?: string[]
}

/**
 * Health-check documents use checkpoint indices 2..N only: checkpoint k gates tranche index k-1
 * (tranche 0 has no health check; first HC is for the second unlock window).
 */
export function isPriorTranchePaidForHealthCheckpoint(
  checkpointIndex: number,
  tranches: Array<{ index: number; status?: string }> | undefined,
): boolean {
  const priorIdx = checkpointIndex - 2
  if (priorIdx < 0) return true
  const pt = (tranches || []).find(x => x.index === priorIdx)
  return !!pt && pt.status === 'paid'
}

export function deriveLatestDueHealthCheckpoint(input: {
  approvedAt: Date | string
  now: Date
  intervalSeconds: number
  totalTranches: number
}): number | null {
  const dueCheckpoint = computeLatestDueCheckpointOneBased({
    approvedAt: input.approvedAt,
    now: input.now,
    intervalSeconds: input.intervalSeconds,
    totalTranches: input.totalTranches,
  })
  return dueCheckpoint >= 2 ? dueCheckpoint : null
}

export class HealthCheckService {
  /**
   * Latest due checkpoint k in 2..N by elapsed time, where there is no approved
   * or pending_review HealthCheck for k.
   */
  async deriveNextCheckpointIndex(
    submissionId: mongoose.Types.ObjectId,
    now: Date,
  ): Promise<
    | { k: number }
    | { error: 'too_early' }
    | { error: 'pending_review' }
    | { error: 'all_complete' }
  > {
    const allocation = await RewardAllocation.findOne({ submissionId })
    if (!allocation) {
      throw new Error('No reward allocation for this submission')
    }
    const { intervalSeconds, totalTranches: N } = getClaimScheduleConfig()
    const k = deriveLatestDueHealthCheckpoint({
      approvedAt: allocation.approvedAt,
      now,
      intervalSeconds,
      totalTranches: N,
    })
    if (!k) {
      return { error: 'too_early' }
    }

    const pending = await HealthCheck.findOne({
      submissionId,
      checkpointIndex: k,
      status: 'pending_review',
    }).lean()
    if (pending) {
      return { error: 'pending_review' }
    }

    const approved = await HealthCheck.findOne({
      submissionId,
      checkpointIndex: k,
      status: 'approved',
    }).lean()
    if (approved) {
      return { error: 'all_complete' }
    }

    return { k }
  }

  async createHealthCheckUpload(input: {
    submissionId: string
    planterWallet: string
    file: {
      originalname: string
      size: number
      mimetype: string
      buffer: Buffer
    }
    latitude: number | string
    longitude: number | string
    treesAlive: number | string
    reverseGeocode?: string
  }) {
    const sid = new mongoose.Types.ObjectId(input.submissionId)
    const w = input.planterWallet.toLowerCase()

    const submission = await Submission.findById(sid)
    if (!submission) throw new Error('Submission not found')
    if (submission.userWalletAddress !== w) {
      throw new Error('Not allowed to modify this submission')
    }
    if (submission.status !== 'approved') {
      throw new Error('Submission must be approved')
    }
    if (!isMangroveSubmission(submission)) {
      throw new Error('Health checks apply to mangrove submissions only')
    }

    const plant = submission.plant as
      | { gpsCoordinates?: { latitude: number; longitude: number } }
      | undefined
    const baseLat = plant?.gpsCoordinates?.latitude
    const baseLon = plant?.gpsCoordinates?.longitude
    if (baseLat === undefined || baseLon === undefined) {
      throw new Error('Submission is missing plant GPS coordinates')
    }

    const allocation = await RewardAllocation.findOne({ submissionId: sid })
    if (!allocation) throw new Error('No reward allocation for this submission')

    const now = new Date()
    const derived = await this.deriveNextCheckpointIndex(sid, now)
    if ('error' in derived) {
      if (derived.error === 'too_early') {
        throw new Error('No health check window is open yet')
      }
      if (derived.error === 'pending_review') {
        throw new Error(
          'A health check is already awaiting review for the current checkpoint',
        )
      }
      throw new Error(
        'All health check checkpoints are complete for this submission',
      )
    }
    const k = derived.k

    const treesAlive = Math.max(0, Math.floor(Number(input.treesAlive)))
    if (!Number.isFinite(treesAlive)) {
      throw new Error('treesAlive is required')
    }

    const initialTrees = Math.max(
      0,
      Math.floor(Number(submission.treesPlanted ?? 0)),
    )
    if (treesAlive > initialTrees) {
      throw new Error(
        `Trees alive cannot exceed the number of trees planted (${initialTrees})`,
      )
    }

    const lat = parseFloat(String(input.latitude))
    const lon = parseFloat(String(input.longitude))
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error('Invalid latitude or longitude')
    }

    const distanceMeters = haversineMeters(baseLat, baseLon, lat, lon)
    if (distanceMeters > env.HEALTH_CHECK_MAX_DISTANCE_METERS) {
      throw new Error(
        `Health check location is too far from planted location (${distanceMeters.toFixed(1)}m > ${env.HEALTH_CHECK_MAX_DISTANCE_METERS}m)`,
      )
    }

    const uniqueFileName = generateUniqueFileName(input.file.originalname)
    const mimeType = input.file.mimetype.startsWith('video/')
      ? input.file.mimetype
      : 'video/mp4'
    const uploadResult = await uploadToStorage(
      input.file.buffer,
      uniqueFileName,
      mimeType,
    )

    const clip: Record<string, unknown> = {
      uploaded: true,
      originalFilename: input.file.originalname,
      sizeBytes: input.file.size,
      mimeType,
      videoCID: uploadResult.videoCID,
      publicUrl: uploadResult.publicUrl,
      gpsCoordinates: { latitude: lat, longitude: lon },
      uploadedAt: new Date(),
      version: 1,
    }
    if (input.reverseGeocode) {
      clip.reverseGeocode = input.reverseGeocode
    }

    const doc = await HealthCheck.create({
      submissionId: sid,
      checkpointIndex: k,
      treesAlive,
      distanceMeters,
      ...clip,
      status: 'pending_review',
      votes: [],
    })

    return {
      healthCheckId: String(doc._id),
      checkpointIndex: k,
      distanceMeters,
      videoCID: uploadResult.videoCID,
      publicUrl: uploadResult.publicUrl,
      status: doc.status,
    }
  }

  async castVote(input: {
    healthCheckId: string
    submissionId: string
    voterWalletAddress: string
    vote: 'yes' | 'no'
    reasons?: string[]
  }) {
    if (!['yes', 'no'].includes(input.vote)) {
      throw new Error('Invalid vote')
    }
    if (!mongoose.Types.ObjectId.isValid(input.healthCheckId)) {
      throw new Error('Invalid healthCheckId')
    }

    const hc = await HealthCheck.findById(input.healthCheckId)
    if (!hc) throw new Error('Health check not found')
    if (String(hc.submissionId) !== input.submissionId) {
      throw new Error('Health check does not belong to this submission')
    }

    const submission = await Submission.findById(hc.submissionId)
    if (!submission) throw new Error('Submission not found')
    if (!isMangroveSubmission(submission)) {
      throw new Error('Voting is only available for mangrove submissions')
    }

    // The planter cannot confirm their own trees' survival — that would let
    // them unlock survival-vesting reward tranches without independent review.
    if (
      String(submission.userWalletAddress || '').toLowerCase() ===
      String(input.voterWalletAddress || '').toLowerCase()
    ) {
      throw new Error('You cannot vote on your own health check')
    }

    if (hc.status !== 'pending_review') {
      throw new Error('Voting closed for this health check')
    }

    const totalVerifiers = await User.countDocuments({ isVerifier: true })
    if (totalVerifiers === 0) {
      throw new Error('Cannot vote: no verifiers configured')
    }

    const votes = (hc.votes || []) as HealthCheckVote[]
    const totalVotes = votes.length
    if (totalVotes >= totalVerifiers) {
      throw new Error('All verifiers have already voted')
    }

    const alreadyVoted = votes.some(
      v =>
        v.voterWalletAddress.toLowerCase() ===
        input.voterWalletAddress.toLowerCase(),
    )
    if (alreadyVoted) throw new Error('You have already voted')

    let reasonsArr: string[] = []
    if (Array.isArray(input.reasons)) {
      reasonsArr = input.reasons
        .filter(r => typeof r === 'string' && r.trim().length > 0)
        .slice(0, 10)
    }

    const voterNorm = input.voterWalletAddress.toLowerCase()
    const delegRows = await User.find({
      verifierDelegate: voterNorm,
    })
      .select({ walletAddress: 1 })
      .lean()
    const delegatedFor = delegRows.map(d =>
      String(d.walletAddress || '').toLowerCase(),
    )

    hc.votes.push({
      voterWalletAddress: input.voterWalletAddress,
      vote: input.vote,
      reasons: reasonsArr,
      delegatedFor,
    })
    await hc.save()

    return this.attemptResolveHealthCheck(String(hc._id), {
      knownTotalVerifiers: totalVerifiers,
    })
  }

  async attemptResolveHealthCheck(
    healthCheckId: string,
    options?: { knownTotalVerifiers?: number },
  ) {
    const hc = await HealthCheck.findById(healthCheckId)
    if (!hc) throw new Error('Health check not found')

    const submission = await Submission.findById(hc.submissionId)
    if (!submission) throw new Error('Submission not found')

    const totalVerifiers =
      options?.knownTotalVerifiers ??
      (await User.countDocuments({ isVerifier: true }))

    const votes = (hc.votes || []) as HealthCheckVote[]

    if (hc.status === 'approved' || hc.status === 'rejected') {
      const majorityVote = determineMajorityVote(votes, totalVerifiers)
      return this.buildResolveResult(hc, submission, totalVerifiers, {
        majorityVote: majorityVote || undefined,
      })
    }

    if (hc.status !== 'pending_review') {
      return this.buildResolveResult(hc, submission, totalVerifiers)
    }

    if (!isMangroveSubmission(submission)) {
      return this.buildResolveResult(hc, submission, totalVerifiers)
    }

    if (totalVerifiers < env.MINIMUM_ACTIVE_VERIFIERS) {
      return this.buildResolveResult(hc, submission, totalVerifiers, {
        finalizationBlockedByVerifierThreshold: true,
      })
    }

    const majorityVote = determineMajorityVote(votes, totalVerifiers)
    if (!majorityVote) {
      return this.buildResolveResult(hc, submission, totalVerifiers)
    }

    hc.status = majorityVote === 'yes' ? 'approved' : 'rejected'
    hc.reviewedAt = new Date()
    await hc.save()

    const planter = String(submission.userWalletAddress || '').toLowerCase()
    if (planter) {
      void enqueueNotification({
        recipientWalletAddress: planter,
        kind: 'health_check_outcome',
        title:
          majorityVote === 'yes'
            ? 'Health check approved'
            : 'Health check reviewed',
        body:
          majorityVote === 'yes'
            ? 'Your survival verification passed verifier consensus.'
            : 'Your health check was reviewed.',
        link: `/submissions/${String(submission._id)}`,
        payload: {
          submissionId: String(submission._id),
          healthCheckId: String(hc._id),
          status: hc.status,
        },
      }).catch(() => {})
    }

    await applyMinorityPenaltiesForVotes(
      String(hc.submissionId),
      votes,
      majorityVote,
      hc._id as mongoose.Types.ObjectId,
    )

    return this.buildResolveResult(hc, submission, totalVerifiers, {
      majorityVote,
    })
  }

  private buildResolveResult(
    hc: any,
    submission: any,
    totalVerifiers: number,
    extras?: Record<string, unknown>,
  ) {
    const votes = ((hc.votes || []) as HealthCheckVote[]).map(v => ({
      voterWalletAddress: v.voterWalletAddress,
      vote: v.vote,
      reasons: v.reasons,
    }))
    const yesCount = votes.filter(v => v.vote === 'yes').length
    const noCount = votes.filter(v => v.vote === 'no').length
    return {
      healthCheckId: String(hc._id),
      submissionId: String(hc.submissionId),
      checkpointIndex: hc.checkpointIndex,
      status: hc.status,
      totalVerifiers,
      votes,
      yesCount,
      noCount,
      totalVotes: votes.length,
      ...extras,
    }
  }

  async getById(
    submissionId: string,
    healthCheckId: string,
    requesterWallet: string,
    isVerifier: boolean,
  ) {
    if (!mongoose.Types.ObjectId.isValid(healthCheckId)) {
      throw new Error('Invalid healthCheckId')
    }
    const sid = new mongoose.Types.ObjectId(submissionId)
    const submission = await Submission.findById(sid)
    if (!submission) throw new Error('Submission not found')
    const owner = String(submission.userWalletAddress || '').toLowerCase()
    const w = requesterWallet.toLowerCase()
    if (owner !== w && !isVerifier) {
      throw new Error('Access denied')
    }
    const doc = await HealthCheck.findOne({
      _id: new mongoose.Types.ObjectId(healthCheckId),
      submissionId: sid,
    }).lean()
    if (!doc) throw new Error('Health check not found')
    return { healthCheck: doc }
  }

  async listForSubmission(
    submissionId: string,
    requesterWallet: string,
    isVerifier: boolean,
  ) {
    const sid = new mongoose.Types.ObjectId(submissionId)
    const submission = await Submission.findById(sid)
    if (!submission) throw new Error('Submission not found')
    const owner = String(submission.userWalletAddress || '').toLowerCase()
    const w = requesterWallet.toLowerCase()
    if (owner !== w && !isVerifier) {
      throw new Error('Access denied')
    }

    const items = await HealthCheck.find({ submissionId: sid })
      .sort({ checkpointIndex: 1, createdAt: -1 })
      .lean()
    return { healthChecks: items }
  }

  async listModerationQueue(page = 1, limit = 20) {
    const skip = (page - 1) * limit
    const pipeline: mongoose.PipelineStage[] = [
      { $match: { status: 'pending_review' } },
      {
        $lookup: {
          from: 'submissions',
          localField: 'submissionId',
          foreignField: '_id',
          as: 'sub',
        },
      },
      { $unwind: '$sub' },
      {
        $match: {
          'sub.treeType': new RegExp(`^${MANGROVE_TREE_TYPE}$`, 'i'),
        },
      },
      { $sort: { createdAt: 1 } },
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'n' }],
        },
      },
    ]

    const agg = await HealthCheck.aggregate(pipeline)
    const row = agg[0] || { items: [], total: [] }
    const items = row.items || []
    const total = row.total?.[0]?.n ?? 0
    return {
      healthChecks: items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    }
  }
}

export default HealthCheckService
