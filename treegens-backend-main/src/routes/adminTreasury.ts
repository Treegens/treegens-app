import express, { Request, Response } from 'express'
import mongoose from 'mongoose'
import adminAuth from '../middleware/adminAuth'
import DonationFlow, { DONATION_FLOW_STATUSES } from '../models/DonationFlow'
import type { TreasuryPipelineService } from '../services/treasury/treasuryPipelineService'
import {
  sendBadRequest,
  sendError,
  sendNotFound,
  sendSuccess,
} from '../utils/responseHelpers'

/**
 * Operator console for the donation pipeline (bearer ADMIN_API_TOKEN).
 *
 *   GET  /api/admin/treasury/status            mode, problems, caps, balances, last tick
 *   GET  /api/admin/treasury/flows             newest flows (?status=&mode=&limit=)
 *   GET  /api/admin/treasury/flows/:id         one flow with its full event trail
 *   POST /api/admin/treasury/flows/:id/release let a held / failed / dry-run flow go
 *   POST /api/admin/treasury/flows/:id/hold    park a moving flow ({ reason })
 *   POST /api/admin/treasury/tick              run one pass now
 *   GET  /api/admin/treasury/stripe            financial accounts, bank details, payout methods
 *   GET  /api/admin/treasury/mercury           accounts and saved recipients
 *
 * Everything that moves money lives in the pipeline service; these routes
 * only read, release or hold. Donor identity is never stored, so there is
 * nothing here to leak beyond amounts and ids.
 */
let pipeline: TreasuryPipelineService | null = null

/** Set by server.ts when the pipeline runs in this process. */
export function attachTreasuryPipeline(
  instance: TreasuryPipelineService | null,
) {
  pipeline = instance
}

const router = express.Router()

router.use(adminAuth)

const notStarted = (res: Response) =>
  res.status(503).json({
    error: 'Treasury pipeline is not running in this process',
    code: 'TREASURY_NOT_STARTED',
  })

router.get('/status', async (_req: Request, res: Response) => {
  if (!pipeline) return notStarted(res)
  try {
    return sendSuccess(res, 'Treasury status', await pipeline.status())
  } catch (error: any) {
    return sendError(res, 'Failed to read treasury status', 500, error)
  }
})

router.get('/flows', async (req: Request, res: Response) => {
  try {
    const filter: Record<string, unknown> = {}
    const status = String(req.query.status || '')
    if (status) {
      if (!(DONATION_FLOW_STATUSES as readonly string[]).includes(status))
        return sendBadRequest(res, `Unknown status "${status}"`)
      filter.status = status
    }
    const mode = String(req.query.mode || '')
    if (mode) {
      if (mode !== 'dry_run' && mode !== 'live')
        return sendBadRequest(res, 'mode must be dry_run or live')
      filter.mode = mode
    }
    const limit = Math.min(
      200,
      Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50),
    )
    const flows = await DonationFlow.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
    return sendSuccess(res, 'Donation flows', { flows })
  } catch (error: any) {
    return sendError(res, 'Failed to list donation flows', 500, error)
  }
})

router.get('/flows/:id', async (req: Request, res: Response) => {
  if (!mongoose.isValidObjectId(req.params.id))
    return sendBadRequest(res, 'Invalid flow id')
  try {
    const flow = await DonationFlow.findById(req.params.id).lean()
    if (!flow) return sendNotFound(res, 'Donation flow')
    return sendSuccess(res, 'Donation flow', { flow })
  } catch (error: any) {
    return sendError(res, 'Failed to load donation flow', 500, error)
  }
})

router.post('/flows/:id/release', async (req: Request, res: Response) => {
  if (!pipeline) return notStarted(res)
  if (!mongoose.isValidObjectId(req.params.id))
    return sendBadRequest(res, 'Invalid flow id')
  try {
    const flow = await pipeline.release(req.params.id)
    if (!flow) return sendNotFound(res, 'Donation flow')
    return sendSuccess(res, 'Donation flow released', {
      flow: flow.toObject ? flow.toObject() : flow,
    })
  } catch (error: any) {
    return sendError(res, 'Failed to release donation flow', 500, error)
  }
})

router.post('/flows/:id/hold', async (req: Request, res: Response) => {
  if (!pipeline) return notStarted(res)
  if (!mongoose.isValidObjectId(req.params.id))
    return sendBadRequest(res, 'Invalid flow id')
  try {
    const reason = String(req.body?.reason || '').slice(0, 200)
    const flow = await pipeline.hold(req.params.id, reason)
    if (!flow) return sendNotFound(res, 'Donation flow')
    return sendSuccess(res, 'Donation flow held', {
      flow: flow.toObject ? flow.toObject() : flow,
    })
  } catch (error: any) {
    return sendError(res, 'Failed to hold donation flow', 500, error)
  }
})

router.post('/tick', async (_req: Request, res: Response) => {
  if (!pipeline) return notStarted(res)
  try {
    return sendSuccess(res, 'Treasury tick', await pipeline.tick())
  } catch (error: any) {
    return sendError(res, 'Treasury tick failed', 500, error)
  }
})

router.get('/stripe', async (_req: Request, res: Response) => {
  if (!pipeline) return notStarted(res)
  try {
    return sendSuccess(res, 'Stripe overview', await pipeline.stripeOverview())
  } catch (error: any) {
    return sendError(res, 'Failed to read Stripe', 500, error)
  }
})

router.get('/mercury', async (_req: Request, res: Response) => {
  if (!pipeline) return notStarted(res)
  try {
    return sendSuccess(
      res,
      'Mercury overview',
      await pipeline.mercuryOverview(),
    )
  } catch (error: any) {
    return sendError(res, 'Failed to read Mercury', 500, error)
  }
})

export default router
