import express, { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import Submission from '../models/Submission'
import TgnDistribution from '../models/TgnDistribution'
import { sendError, sendSuccess } from '../utils/responseHelpers'

/**
 * Service-to-service API for the world.treegens.app $TGN distribution engine.
 *
 * Auth: shared secret in the `x-distributor-key` header, compared against the
 * DISTRIBUTOR_API_KEY env var. Routes are disabled entirely when the env var
 * is unset. The caller is the trusted payout relayer, never a browser.
 *
 *   GET  /api/distributions/pending[?excludeMangrove=1&limit=50]
 *        → approved submissions with no payout yet: planter wallet,
 *          yes-voting verifier wallets, tree count, video, GPS.
 *   GET  /api/distributions/:submissionId
 *        → the payout record for one submission (404 when none). Lets the
 *          relayer distinguish "already paid" from "backend unavailable"
 *          instead of guessing from an empty list.
 *   POST /api/distributions/:submissionId/reserve
 *        → claims the submission BEFORE any money moves. The unique index
 *          makes a concurrent/duplicate claim impossible (409). Re-running
 *          the same payment returns 200 so a retry can safely resume.
 *   POST /api/distributions/:submissionId/mark
 *        → fills in the completed payout (tx hashes / amounts).
 */
const router = express.Router()

function requireDistributorKey(req: Request, res: Response, next: NextFunction) {
  const configured = process.env.DISTRIBUTOR_API_KEY
  if (!configured) return sendError(res, 'Distributions API not enabled', 503)
  if (req.header('x-distributor-key') !== configured) {
    return sendError(res, 'Unauthorized', 401)
  }
  return next()
}

function validObjectId(id: string) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id
}

router.get('/pending', requireDistributorKey, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    // Mangroves have their own $MGRO retirement rail (burn + soulbound NFT);
    // the two rails must never list the same planting, so callers pick a side.
    //   excludeMangrove=1 → non-mangrove only (TGN 95/5 rail)
    //   onlyMangrove=1    → mangrove only     ($MGRO burn rail)
    const excludeMangrove = req.query.excludeMangrove === '1'
    const onlyMangrove = req.query.onlyMangrove === '1'

    // A video is unavailable if it is already sold (planterTx set) OR currently
    // held in someone's checkout (a live, unexpired reservation). Expired
    // holds from abandoned checkouts are ignored, so the video reappears.
    const now = new Date()
    const blockedIds = await TgnDistribution.find({
      $or: [
        { planterTx: { $nin: ['', null] } },
        { holdExpiresAt: { $gt: now } },
      ],
    }).distinct('submissionId')
    const filter: Record<string, any> = {
      status: 'approved',
      _id: { $nin: blockedIds },
    }
    // The MGRO rail burns tokens and does not pay a planter, so it does not
    // require a planter wallet on the submission; the TGN rail does.
    if (!onlyMangrove) filter.userWalletAddress = { $exists: true, $nin: [null, ''] }
    if (excludeMangrove) filter.treeType = { $not: /mangrove/i }
    if (onlyMangrove) filter.treeType = /mangrove/i

    const subs = await Submission.find(filter, {
      userWalletAddress: 1,
      treesPlanted: 1,
      treeType: 1,
      reviewedAt: 1,
      votes: 1,
      'plant.publicUrl': 1,
      'plant.videoCID': 1,
      'plant.gpsCoordinates': 1,
      'plant.reverseGeocode': 1,
    })
      .sort({ reviewedAt: -1 })
      .limit(limit)
      .lean()

    const pending = subs.map(s => ({
      submissionId: String(s._id),
      planterWallet: s.userWalletAddress,
      verifierWallets: [
        ...new Set(
          (s.votes || [])
            .filter((v: any) => v.vote === 'yes' && v.voterWalletAddress)
            .map((v: any) => String(v.voterWalletAddress).toLowerCase()),
        ),
      ],
      trees: s.treesPlanted || 1,
      treeType: s.treeType || '',
      reviewedAt: s.reviewedAt,
      video: s.plant?.publicUrl || null,
      videoCID: s.plant?.videoCID || null,
      gps: s.plant?.gpsCoordinates || null,
      location: s.plant?.reverseGeocode || '',
    }))

    return sendSuccess(res, 'Pending distributions', { pending })
  } catch (error: any) {
    console.error('Distributions pending error:', error)
    return sendError(res, 'Failed to list pending distributions')
  }
})

// Persistent metadata for one approved submission — used to build the NFT's
// tokenURI JSON. Unlike /pending it returns the record whether or not it has
// been sold, so an NFT's metadata never disappears after purchase.
router.get('/submission/:submissionId', requireDistributorKey, async (req: Request, res: Response) => {
  try {
    const { submissionId } = req.params
    if (!validObjectId(submissionId)) return sendError(res, 'Invalid submission id', 400)
    const s: any = await Submission.findOne(
      { _id: submissionId, status: 'approved' },
      {
        treesPlanted: 1, treeType: 1, reviewedAt: 1,
        'plant.publicUrl': 1, 'plant.videoCID': 1,
        'plant.gpsCoordinates': 1, 'plant.reverseGeocode': 1,
      },
    ).lean()
    if (!s) return sendError(res, 'Not found', 404)
    return sendSuccess(res, 'Submission metadata', {
      trees: s.treesPlanted || 1,
      species: s.treeType || '',
      video: s.plant?.publicUrl || null,
      videoCID: s.plant?.videoCID || null,
      gps: s.plant?.gpsCoordinates || null,
      location: s.plant?.reverseGeocode || '',
      verifiedAt: s.reviewedAt,
    })
  } catch (error: any) {
    console.error('Submission metadata error:', error)
    return sendError(res, 'Failed to load submission')
  }
})

router.get('/:submissionId', requireDistributorKey, async (req: Request, res: Response) => {
  try {
    const { submissionId } = req.params
    if (!validObjectId(submissionId)) return sendError(res, 'Invalid submission id', 400)
    const record = await TgnDistribution.findOne({ submissionId }).lean()
    if (!record) return sendError(res, 'No distribution for this submission', 404)
    return sendSuccess(res, 'Distribution', { distribution: record })
  } catch (error: any) {
    console.error('Distribution lookup error:', error)
    return sendError(res, 'Failed to look up distribution')
  }
})

router.post('/:submissionId/reserve', requireDistributorKey, async (req: Request, res: Response) => {
  try {
    const { submissionId } = req.params
    const { paymentRef } = req.body || {}
    if (!validObjectId(submissionId)) return sendError(res, 'Invalid submission id', 400)
    if (!paymentRef) return sendError(res, 'Missing paymentRef', 400)

    const now = new Date()
    // Hold window (flight-booking style). Card checkout ~30 min, direct-MGRO
    // voucher shorter; clamp to a sane range. Default 15 min.
    const holdSeconds = Math.min(3600, Math.max(60, Number(req.body?.holdSeconds) || 900))
    const holdExpiresAt = new Date(now.getTime() + holdSeconds * 1000)

    // Fast path: already completed by THIS payment → idempotent success (a
    // fulfillment re-run must not be told the video is "already reserved").
    const done = await TgnDistribution.findOne(
      { submissionId, paymentRef, planterTx: { $nin: ['', null] } },
    ).lean()
    if (done) {
      return sendSuccess(res, 'Reservation resumed', { resumed: true, completed: true })
    }

    // Everything else in ONE atomic conditional upsert — no read-modify-write,
    // so two buyers racing a just-expired video can never both "win". The
    // filter matches only when the slot is free to (re)take:
    //   • our own uncompleted reservation (resume + refresh the hold), OR
    //   • an uncompleted reservation whose hold has expired (steal a stale one).
    // A live hold by another payment, or a completed sale, does NOT match, so
    // the upsert falls through to an INSERT that the unique submissionId index
    // rejects (11000) → 409. MongoDB evaluates the filter atomically per doc,
    // so of N concurrent callers exactly one updates/inserts and the rest 409.
    const acquirable = {
      submissionId,
      planterTx: { $in: ['', null] },
      $or: [
        { paymentRef },
        { holdExpiresAt: { $lte: now } },
        { holdExpiresAt: null },
      ],
    }
    const acquired = await TgnDistribution.findOneAndUpdate(
      acquirable,
      {
        $set: {
          paymentRef,
          grossUsd: Number(req.body?.grossUsd) || 0,
          planterWallet: String(req.body?.planterWallet || '').toLowerCase(),
          holdExpiresAt,
          rail: String(req.body?.rail || ''),
        },
        $setOnInsert: { submissionId, planterTgnWei: '0', planterTx: '' },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    return sendSuccess(res, 'Reserved', { reserved: true, completed: !!acquired?.planterTx })
  } catch (error: any) {
    if (error?.code === 11000) return sendError(res, 'Already reserved', 409)
    console.error('Distribution reserve error:', error)
    return sendError(res, 'Failed to reserve distribution')
  }
})

// Release a reservation that never completed (e.g. the buyer was refunded
// because the swap couldn't be funded). Only removes UNCOMPLETED reservations
// for the same payment, so a finished distribution can never be undone.
router.post('/:submissionId/release', requireDistributorKey, async (req: Request, res: Response) => {
  try {
    const { submissionId } = req.params
    const { paymentRef } = req.body || {}
    if (!validObjectId(submissionId)) return sendError(res, 'Invalid submission id', 400)
    const r = await TgnDistribution.deleteOne({
      submissionId,
      paymentRef: paymentRef || undefined,
      $or: [{ planterTx: '' }, { planterTx: { $exists: false } }],
    })
    return sendSuccess(res, 'Released', { released: r.deletedCount })
  } catch (error: any) {
    console.error('Distribution release error:', error)
    return sendError(res, 'Failed to release reservation')
  }
})

router.post('/:submissionId/mark', requireDistributorKey, async (req: Request, res: Response) => {
  try {
    const { submissionId } = req.params
    const { paymentRef, grossUsd, planterWallet, planterTgnWei, planterTx, verifiers } =
      req.body || {}
    if (!validObjectId(submissionId)) return sendError(res, 'Invalid submission id', 400)
    if (!paymentRef || !planterWallet || !planterTx) {
      return sendError(res, 'Missing paymentRef/planterWallet/planterTx', 400)
    }

    const record = await TgnDistribution.findOneAndUpdate(
      { submissionId },
      {
        $set: {
          paymentRef,
          grossUsd: Number(grossUsd) || 0,
          planterWallet: String(planterWallet).toLowerCase(),
          planterTgnWei: String(planterTgnWei || '0'),
          planterTx,
          verifiers: Array.isArray(verifiers) ? verifiers : [],
          distributedAt: new Date(),
          holdExpiresAt: null, // completed → permanent, no longer a timed hold
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )
    return sendSuccess(res, 'Distribution recorded', { id: String(record._id) })
  } catch (error: any) {
    if (error?.code === 11000) return sendError(res, 'Already distributed', 409)
    console.error('Distribution mark error:', error)
    return sendError(res, 'Failed to record distribution')
  }
})

export default router
