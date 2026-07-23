import mongoose from 'mongoose'
import env from '../config/environment'
import { uploadToStorage } from '../config/gcs'
import { generateUniqueFileName } from '../middleware/upload'
import Submission from '../models/Submission'
import User from '../models/User'
import { determineMajorityVote } from '../utils/verifierMajority'
import type { AiMangroveVerifyFailure } from './aiMangroveVerificationService'
import {
  stringifyAiRawForStorage,
  verifyMangrovePlantVideo,
} from './aiMangroveVerificationService'
import { enqueueNotification } from './notificationService'
import RewardService from './rewardService'
import { applyMinorityPenaltiesForVotes } from './verifierPenaltyService'
import { evaluateMangroveAiRouting } from './submissionAiRouting'

const rewardService = new RewardService()

type SubmissionVote = {
  voterWalletAddress: string
  vote: 'yes' | 'no'
  reasons?: string[]
}

type ResolveSubmissionResult = {
  submissionId: mongoose.Types.ObjectId | string
  status: string
  yesCount: number
  noCount: number
  totalVotes: number
  totalVerifiers: number
  votes: SubmissionVote[]
  majorityVote?: 'yes' | 'no'
  finalizationBlockedByVerifierThreshold?: boolean
}

export type UploadSlot = 'land' | 'plant'

const MANGROVE_TREE_TYPE = 'mangrove'

class SubmissionService {
  private normalizeTreeType(value: string): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
  }

  private isMangroveSubmission(submission: {
    treeType?: string | null
  }): boolean {
    return (
      this.normalizeTreeType(submission.treeType ?? '') === MANGROVE_TREE_TYPE
    )
  }

  private buildResolveResult(
    submission: any,
    totalVerifiers: number,
    extras?: Partial<ResolveSubmissionResult>,
  ): ResolveSubmissionResult {
    const votes = ((submission.votes || []) as SubmissionVote[]).map(v => ({
      voterWalletAddress: v.voterWalletAddress,
      vote: v.vote,
      reasons: v.reasons,
    }))
    const yesCount = votes.filter(v => v.vote === 'yes').length
    const noCount = votes.filter(v => v.vote === 'no').length
    const counts = {
      yesCount,
      noCount,
      totalVotes: votes.length,
    }
    return {
      submissionId: submission._id,
      status: submission.status,
      totalVerifiers,
      votes,
      ...counts,
      ...extras,
    }
  }

  private async applyApprovalSideEffects(submission: any) {
    const planterWallet = String(
      submission.userWalletAddress || '',
    ).toLowerCase()
    const treesToCredit = Number(submission.treesPlanted || 0)
    if (planterWallet && treesToCredit > 0) {
      await User.updateOne(
        { walletAddress: planterWallet },
        { $inc: { treesPlanted: treesToCredit } },
      )
    }
    try {
      const rewardResult =
        await rewardService.handleSubmissionApproved(submission)
      if (rewardResult.claimJobEnqueued) {
        console.log('[SubmissionService] Planter claim queued after approval', {
          submissionId: submission._id,
          allocationId: rewardResult.allocationId,
          claimJobId: rewardResult.claimJobId,
        })
      }
    } catch (e: any) {
      console.error(
        '[SubmissionService] Reward queueing after approval failed',
        {
          submissionId: submission._id,
          message: e?.message,
        },
      )
    }
  }

  private async applyMinorityPenalties(
    submission: any,
    majorityVote: 'yes' | 'no',
  ) {
    return applyMinorityPenaltiesForVotes(
      String(submission._id),
      (submission.votes || []) as SubmissionVote[],
      majorityVote,
    )
  }

  async uploadClip(
    file: {
      originalname: string
      size: number
      mimetype: string
      buffer: Buffer
    },
    userWalletAddress: string,
    latitude: number | string,
    longitude: number | string,
    type: UploadSlot,
    submissionId?: string | null,
    treesPlanted?: number | string | null,
    treeType?: string,
    reverseGeocode?: string,
  ) {
    const w = String(userWalletAddress).toLowerCase()
    const uniqueFileName = generateUniqueFileName(file.originalname)
    const mimeType = file.mimetype.startsWith('video/')
      ? file.mimetype
      : 'video/mp4'
    const uploadResult = await uploadToStorage(
      file.buffer,
      uniqueFileName,
      mimeType,
    )

    const clipData = {
      uploaded: true,
      originalFilename: file.originalname,
      sizeBytes: file.size,
      mimeType,
      videoCID: uploadResult.videoCID,
      publicUrl: uploadResult.publicUrl,
      gpsCoordinates: {
        latitude: parseFloat(String(latitude)),
        longitude: parseFloat(String(longitude)),
      },
      uploadedAt: new Date(),
      version: 1,
    }

    if (reverseGeocode) {
      ;(clipData as any).reverseGeocode = reverseGeocode
    }

    if (type === 'land') {
      if (submissionId) {
        throw new Error('submissionId must not be set when uploading land')
      }
      return this.createSubmissionWithLand(w, clipData)
    }

    if (!submissionId) {
      throw new Error('submissionId is required when uploading plant')
    }
    if (!mongoose.Types.ObjectId.isValid(submissionId)) {
      throw new Error('Invalid submissionId')
    }
    return this.attachPlantToSubmission(
      new mongoose.Types.ObjectId(submissionId),
      w,
      clipData,
      treesPlanted,
      treeType,
      {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: mimeType,
      },
    )
  }

  private async createSubmissionWithLand(
    userWalletAddress: string,
    landClip: Record<string, unknown>,
  ) {
    try {
      const doc = await Submission.create({
        userWalletAddress,
        status: 'awaiting_plant',
        land: landClip,
        plant: { uploaded: false },
        votes: [],
      })
      return this.formatUploadResponse(doc, 'land')
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new Error(
          'Land clip already exists. Record a new land video to create a new submission.',
        )
      }
      throw err
    }
  }

  private async findSubmissionByClipIdentifiers(videoCID: string) {
    return Submission.findOne({
      $or: [{ 'land.videoCID': videoCID }, { 'plant.videoCID': videoCID }],
    })
  }

  private async attachPlantToSubmission(
    submissionOid: mongoose.Types.ObjectId,
    userWalletAddress: string,
    plantClip: Record<string, unknown>,
    treesPlanted?: number | string | null,
    treeType?: string,
    rawVideo?: {
      buffer: Buffer
      originalname: string
      mimetype: string
    },
  ) {
    const submission = await Submission.findById(submissionOid)
    if (!submission) throw new Error('Submission not found')
    if (submission.userWalletAddress !== userWalletAddress) {
      throw new Error('Not allowed to modify this submission')
    }
    if (submission.status !== 'awaiting_plant') {
      throw new Error('Plant upload not allowed in current submission state')
    }
    if (submission.plant?.uploaded) {
      throw new Error('Plant clip already uploaded for this submission')
    }

    const trees = Math.floor(Number(treesPlanted ?? 0))
    if (!trees || trees <= 0) {
      throw new Error('treesPlanted is required and must be greater than 0')
    }

    const normalizedTreeType = this.normalizeTreeType(treeType ?? '')
    if (!normalizedTreeType) {
      throw new Error('treeType is required when uploading plant')
    }

    submission.plant = plantClip as any
    submission.treesPlanted = trees
    submission.treeType = normalizedTreeType

    const gps = plantClip.gpsCoordinates as
      | { latitude?: unknown; longitude?: unknown }
      | undefined
    const latitude = Number(gps?.latitude ?? NaN)
    const longitude = Number(gps?.longitude ?? NaN)

    const snapshotBase = (): Record<string, unknown> => ({
      provider:
        env.AI_PROVIDER === 'roboflow_workflow'
          ? 'roboflow_workflow'
          : env.AI_PROVIDER === 'treegens_ml'
            ? 'treegens_ml'
            : 'ultralytics',
      walletAddress: userWalletAddress,
      ...(Number.isFinite(latitude) && Number.isFinite(longitude)
        ? {
            gpsCoordinates: { latitude, longitude },
          }
        : {}),
      declaredTreesPlanted: trees,
      verifiedAt: new Date(),
      autoApproveThreshold: {
        minConfidence: env.AI_AUTO_APPROVE_MIN_CONFIDENCE,
        maxCountDelta: env.AI_MAX_COUNT_DELTA,
      },
    })

    if (normalizedTreeType === MANGROVE_TREE_TYPE && rawVideo?.buffer?.length) {
      const aiResult = await verifyMangrovePlantVideo({
        videoBuffer: rawVideo.buffer,
        filename: rawVideo.originalname || 'plant.mp4',
        contentType: rawVideo.mimetype || 'video/mp4',
        ctx: {
          submissionId: String(submissionOid),
          userWalletAddress,
          latitude: Number.isFinite(latitude) ? latitude : 0,
          longitude: Number.isFinite(longitude) ? longitude : 0,
          declaredTreesPlanted: trees,
        },
      })

      if (aiResult.skipped) {
        submission.aiVerification = {
          status: 'skipped',
          ...(snapshotBase() as object),
          decision: 'skipped',
          skipReason: aiResult.reason,
        } as any
        submission.status = 'pending_review'
      } else if (aiResult.ok) {
        const counted = aiResult.countedMangroves
        const conf = aiResult.confidence
        const routing = evaluateMangroveAiRouting({
          countedMangroves: counted,
          declaredTreesPlanted: trees,
          confidence: conf,
          maxCountDelta: env.AI_MAX_COUNT_DELTA,
          minConfidence: env.AI_AUTO_APPROVE_MIN_CONFIDENCE,
        })
        const shouldAutoApprove = routing.shouldAutoApprove

        submission.aiVerification = {
          status: 'completed',
          ...(snapshotBase() as object),
          countedMangroves: counted,
          ...(typeof conf === 'number' ? { confidence: conf } : {}),
          rawResponse: stringifyAiRawForStorage(aiResult.raw),
          decision: routing.decision,
        } as any

        if (shouldAutoApprove) {
          submission.status = routing.submissionStatus
          submission.reviewedAt = new Date()
        } else {
          submission.status = routing.submissionStatus
        }
      } else {
        const failure = aiResult as AiMangroveVerifyFailure
        submission.aiVerification = {
          status: 'failed',
          ...(snapshotBase() as object),
          decision: 'ai_failed',
          error: failure.error,
          rawResponse: stringifyAiRawForStorage(failure.raw),
        } as any
        submission.status = 'pending_review'
      }
    } else {
      submission.status = 'pending_review'
    }

    try {
      await submission.save()
      if (normalizedTreeType === MANGROVE_TREE_TYPE && submission.aiVerification) {
        void enqueueNotification({
          recipientWalletAddress: userWalletAddress,
          kind: 'ai_verification',
          title: 'AI verification update',
          body: 'Your mangrove clip was analyzed by TreeGens AI.',
          link: `/submissions/${String(submissionOid)}`,
          payload: { submissionId: String(submissionOid) },
        }).catch(() => {})
      }
      if (
        submission.status === 'approved' &&
        normalizedTreeType === MANGROVE_TREE_TYPE
      ) {
        const aiDec = submission.aiVerification as
          | { decision?: string }
          | undefined
        if (aiDec?.decision === 'auto_approved') {
          await this.applyApprovalSideEffects(submission)
        }
      }
      return this.formatUploadResponse(submission, 'plant')
    } catch (err: any) {
      if (err?.code === 11000) {
        const existing = await this.findSubmissionByClipIdentifiers(
          plantClip.videoCID as string,
        )
        if (existing) {
          throw new Error('Duplicate IPFS CID')
        }
      }
      throw err
    }
  }

  private formatUploadResponse(submission: any, uploadedType: UploadSlot) {
    const land = submission.land || {}
    const plant = submission.plant || {}
    const clip = uploadedType === 'land' ? land : plant
    const plain =
      typeof submission.toObject === 'function'
        ? submission.toObject({ flattenMaps: true })
        : submission
    return {
      submissionId: String(submission._id),
      videoCID: clip.videoCID,
      publicUrl: clip.publicUrl,
      uploadTimestamp: clip.uploadedAt || submission.updatedAt,
      type: uploadedType,
      status: submission.status,
      treesPlanted: submission.treesPlanted,
      treeType: submission.treeType,
      reverseGeocode: clip.reverseGeocode,
      ...(uploadedType === 'plant' && plain.aiVerification
        ? { aiVerification: plain.aiVerification }
        : {}),
    }
  }

  async getSubmissionById(submissionId: string) {
    return Submission.findById(submissionId)
  }

  async getSubmissionsByUser(
    userWalletAddress: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const normalizedWallet = String(userWalletAddress).toLowerCase()
    const submissions = await Submission.find({
      userWalletAddress: normalizedWallet,
    })
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec()

    const total = await Submission.countDocuments({
      userWalletAddress: normalizedWallet,
    })

    return {
      submissions,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      totalSubmissions: total,
      hasLandClip: submissions.some(s => s.land?.uploaded),
      hasPlantClip: submissions.some(s => s.plant?.uploaded),
    }
  }

  async getSubmissionsWithVoteFilters({
    minYes,
    minNo,
    maxVotes,
    status,
    page = 1,
    limit = 10,
  }: {
    minYes?: number
    minNo?: number
    maxVotes?: number
    status?: string
    page?: number
    limit?: number
  }) {
    const match: Record<string, unknown> = {}
    if (status) {
      if (status === 'pending') {
        match.status = 'pending_review'
      } else {
        match.status = status
      }
    }

    match.treeType = { $regex: /^mangrove$/i }

    const pipeline: any[] = [
      { $match: match },
      {
        $addFields: {
          yesCount: {
            $size: {
              $filter: {
                input: { $ifNull: ['$votes', []] },
                as: 'v',
                cond: { $eq: ['$$v.vote', 'yes'] },
              },
            },
          },
          noCount: {
            $size: {
              $filter: {
                input: { $ifNull: ['$votes', []] },
                as: 'v',
                cond: { $eq: ['$$v.vote', 'no'] },
              },
            },
          },
          totalVotes: { $size: { $ifNull: ['$votes', []] } },
        },
      },
    ]

    const filters: any[] = []
    if (minYes !== undefined)
      filters.push({ $expr: { $gte: ['$yesCount', parseInt(String(minYes))] } })
    if (minNo !== undefined)
      filters.push({ $expr: { $gte: ['$noCount', parseInt(String(minNo))] } })
    if (maxVotes !== undefined)
      filters.push({
        $expr: { $lte: ['$totalVotes', parseInt(String(maxVotes))] },
      })
    if (filters.length > 0) pipeline.push({ $match: { $and: filters } })

    pipeline.push({ $sort: { userWalletAddress: 1, _id: 1 } })

    const skip = (parseInt(String(page)) - 1) * parseInt(String(limit))
    const [items, countArr] = await Promise.all([
      Submission.aggregate([
        ...pipeline,
        { $skip: skip },
        { $limit: parseInt(String(limit)) },
      ]),
      Submission.aggregate([...pipeline, { $count: 'total' }]),
    ])

    const total = countArr[0]?.total || 0
    return {
      submissions: items,
      pagination: {
        page: parseInt(String(page)),
        limit: parseInt(String(limit)),
        total,
        pages: Math.ceil(total / parseInt(String(limit))),
      },
    }
  }

  /**
   * Approved submissions where verifier voted yes and verifier MGRO is not yet paid.
   */
  async getVerifierInbox(
    verifierWalletAddress: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const w = String(verifierWalletAddress).toLowerCase()
    const skip = (page - 1) * limit

    const pipeline: any[] = [
      {
        $match: {
          status: 'approved',
          votes: { $elemMatch: { voterWalletAddress: w, vote: 'yes' } },
        },
      },
      {
        $lookup: {
          from: 'rewardallocations',
          let: { sid: '$_id' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$submissionId', '$$sid'] } },
            },
          ],
          as: 'alloc',
        },
      },
      { $unwind: '$alloc' },
      {
        $match: {
          'alloc.yesVoterCount': { $gt: 0 },
        },
      },
      {
        $addFields: {
          verifierPaid: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$alloc.verifierClaims', []] },
                    as: 'c',
                    cond: {
                      $and: [
                        { $eq: ['$$c.wallet', w] },
                        { $eq: ['$$c.status', 'paid'] },
                      ],
                    },
                  },
                },
              },
              0,
            ],
          },
        },
      },
      { $match: { verifierPaid: false } },
      {
        $addFields: {
          poolZero: {
            $or: [
              { $eq: ['$alloc.verifierPoolWei', '0'] },
              { $eq: ['$alloc.verifierPoolWei', null] },
            ],
          },
        },
      },
      { $match: { poolZero: false } },
      { $sort: { updatedAt: -1 } },
    ]

    const [items, countArr] = await Promise.all([
      Submission.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
      Submission.aggregate([...pipeline, { $count: 'total' }]),
    ])

    const total = countArr[0]?.total || 0
    return {
      submissions: items,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    }
  }

  async castVote({
    submissionId,
    voterWalletAddress,
    vote,
    reasons,
  }: {
    submissionId: string
    voterWalletAddress: string
    vote: 'yes' | 'no'
    reasons?: string[]
  }) {
    if (!['yes', 'no'].includes(vote)) {
      throw new Error('Invalid vote')
    }

    const submission = await Submission.findById(submissionId)
    if (!submission) throw new Error('Submission not found')

    if (submission.status === 'approved' || submission.status === 'rejected') {
      throw new Error('Voting closed for this submission')
    }

    if (submission.status !== 'pending_review') {
      throw new Error('Submission is not open for voting')
    }

    if (!this.isMangroveSubmission(submission)) {
      throw new Error('Voting is only available for mangrove submissions')
    }

    const totalVerifiers = await User.countDocuments({ isVerifier: true })
    if (totalVerifiers === 0) {
      throw new Error('Cannot vote: no verifiers configured')
    }

    const totalVotes = (submission.votes || []).length
    if (totalVotes >= totalVerifiers) {
      throw new Error('All verifiers have already voted')
    }

    const alreadyVoted = (submission.votes || []).some(
      v =>
        v.voterWalletAddress.toLowerCase() === voterWalletAddress.toLowerCase(),
    )
    if (alreadyVoted) throw new Error('You have already voted')

    let reasonsArr: string[] = []
    if (Array.isArray(reasons)) {
      reasonsArr = reasons
        .filter(r => typeof r === 'string' && r.trim().length > 0)
        .slice(0, 10)
    }

    const voterNorm = voterWalletAddress.toLowerCase()
    const delegators = await User.find({
      verifierDelegate: voterNorm,
    })
      .select({ walletAddress: 1 })
      .lean()
    const delegatedFor = delegators.map(d =>
      String(d.walletAddress || '').toLowerCase(),
    )

    submission.votes.push({
      voterWalletAddress,
      vote,
      reasons: reasonsArr,
      delegatedFor,
    })
    await submission.save()
    return this.attemptResolveSubmission(submissionId, {
      knownTotalVerifiers: totalVerifiers,
    })
  }

  async attemptResolveSubmission(
    submissionId: string,
    options?: { knownTotalVerifiers?: number },
  ): Promise<ResolveSubmissionResult> {
    const submission = await Submission.findById(submissionId)
    if (!submission) {
      throw new Error('Submission not found')
    }

    const totalVerifiers =
      options?.knownTotalVerifiers ??
      (await User.countDocuments({ isVerifier: true }))

    if (submission.status === 'approved' || submission.status === 'rejected') {
      const majorityVote = determineMajorityVote(
        submission.votes as SubmissionVote[],
        totalVerifiers,
      )
      return this.buildResolveResult(submission, totalVerifiers, {
        majorityVote: majorityVote || undefined,
      })
    }

    if (submission.status !== 'pending_review') {
      return this.buildResolveResult(submission, totalVerifiers)
    }

    if (!this.isMangroveSubmission(submission)) {
      return this.buildResolveResult(submission, totalVerifiers)
    }

    if (totalVerifiers < env.MINIMUM_ACTIVE_VERIFIERS) {
      return this.buildResolveResult(submission, totalVerifiers, {
        finalizationBlockedByVerifierThreshold: true,
      })
    }

    const majorityVote = determineMajorityVote(
      submission.votes as SubmissionVote[],
      totalVerifiers,
    )
    if (!majorityVote) {
      return this.buildResolveResult(submission, totalVerifiers)
    }

    submission.status = majorityVote === 'yes' ? 'approved' : 'rejected'
    submission.reviewedAt = new Date()
    await submission.save()

    const planter = String(submission.userWalletAddress || '').toLowerCase()
    if (planter) {
      void enqueueNotification({
        recipientWalletAddress: planter,
        kind: 'submission_outcome',
        title:
          majorityVote === 'yes' ? 'Submission approved' : 'Submission reviewed',
        body:
          majorityVote === 'yes'
            ? 'Verifier consensus approved your planting submission.'
            : 'Your submission was reviewed by verifiers.',
        link: `/submissions/${String(submission._id)}`,
        payload: {
          submissionId: String(submission._id),
          status: submission.status,
        },
      }).catch(() => {})
    }

    await this.applyMinorityPenalties(submission, majorityVote)

    if (majorityVote === 'yes') {
      await this.applyApprovalSideEffects(submission)
    }

    return this.buildResolveResult(submission, totalVerifiers, {
      majorityVote,
    })
  }

  async attemptResolvePendingSubmissions() {
    const totalVerifiers = await User.countDocuments({ isVerifier: true })
    if (totalVerifiers < env.MINIMUM_ACTIVE_VERIFIERS) {
      return {
        processed: 0,
        resolved: 0,
        totalVerifiers,
      }
    }

    const pendingSubmissions = await Submission.find(
      { status: 'pending_review' },
      { _id: 1 },
    ).lean()

    let resolved = 0
    for (const pending of pendingSubmissions) {
      const result = await this.attemptResolveSubmission(String(pending._id), {
        knownTotalVerifiers: totalVerifiers,
      })
      if (result.status === 'approved' || result.status === 'rejected') {
        resolved += 1
      }
    }

    return {
      processed: pendingSubmissions.length,
      resolved,
      totalVerifiers,
    }
  }
}

export default SubmissionService
