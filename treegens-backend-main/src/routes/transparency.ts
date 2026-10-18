import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'
import env from '../config/environment'
import { transparencyLimiter } from '../middleware/rateLimits'
import type TransparencyIndexerService from '../services/transparencyIndexerService'
import transparencyService from '../services/transparencyService'
import { sendError, sendNotFound, sendSuccess } from '../utils/responseHelpers'
import { clampInt, decodeCursor, parseKinds } from '../utils/transparencyFormat'

/**
 * Public, read-only transparency ledger.
 *
 *   GET /api/transparency/overview            totals + contract addresses
 *   GET /api/transparency/flows               newest-first money + impact feed
 *   GET /api/transparency/plantings           verified plantings with videos
 *   GET /api/transparency/plantings/:id       one planting's full timeline
 *   GET /api/transparency/map                 GPS points for every planting
 *   GET /api/transparency/onchain             live supply/balances from Base
 *   GET /api/transparency/contracts           what each address is
 *   GET /api/transparency/status              indexer progress
 *
 * No auth: everything here is already public (approved plantings are served
 * as NFT metadata, every amount is an on-chain event). Responses are cached
 * in memory for TRANSPARENCY_CACHE_TTL_MS and served with CORS `*` so the
 * transparency site can live on any origin.
 */
const router = express.Router()

/** Set by server.ts when the ledger indexer runs in this process. */
let indexer: TransparencyIndexerService | null = null
export function attachLedgerIndexer(
  instance: TransparencyIndexerService | null,
) {
  indexer = instance
}

const cache = new Map<string, { at: number; status: number; body: unknown }>()

/** Tiny TTL cache: public data, identical for every caller. */
function cached(ttlMs = env.TRANSPARENCY_CACHE_TTL_MS) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.originalUrl
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) {
      res.setHeader('X-Cache', 'HIT')
      res.setHeader(
        'Cache-Control',
        `public, max-age=${Math.floor(ttlMs / 1000)}`,
      )
      return res.status(hit.status).json(hit.body)
    }
    const original = res.json.bind(res)
    res.json = (body: unknown) => {
      if (res.statusCode === 200) {
        cache.set(key, { at: Date.now(), status: res.statusCode, body })
        if (cache.size > 500) {
          const oldest = [...cache.entries()].sort(
            (a, b) => a[1].at - b[1].at,
          )[0]
          if (oldest) cache.delete(oldest[0])
        }
      }
      res.setHeader('X-Cache', 'MISS')
      res.setHeader(
        'Cache-Control',
        `public, max-age=${Math.floor(ttlMs / 1000)}`,
      )
      return original(body)
    }
    return next()
  }
}

router.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }))
router.use(transparencyLimiter)

/**
 * @swagger
 * tags:
 *   name: Transparency
 *   description: Public open-ledger data behind transparency.treegens.org
 */

/**
 * @swagger
 * /api/transparency/overview:
 *   get:
 *     summary: Totals for funding in, rewards out, trees verified and updates
 *     tags: [Transparency]
 *     responses:
 *       200:
 *         description: Aggregates plus contract addresses and ledger status
 */
router.get('/overview', cached(), async (_req: Request, res: Response) => {
  try {
    return sendSuccess(
      res,
      'Transparency overview',
      await transparencyService.overview(),
    )
  } catch (error: any) {
    console.error('Transparency overview error:', error)
    return sendError(res, 'Failed to build overview')
  }
})

/**
 * @swagger
 * /api/transparency/flows:
 *   get:
 *     summary: Newest-first feed of funding, payouts, reward mints, retirements, verifications and growth updates
 *     tags: [Transparency]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 40, maximum: 100 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: nextCursor from the previous page
 *       - in: query
 *         name: kinds
 *         schema: { type: string }
 *         description: Comma list of funding,payout,reward,retire,verified,update,proposal
 *     responses:
 *       200:
 *         description: items + nextCursor
 */
router.get('/flows', cached(), async (req: Request, res: Response) => {
  try {
    const limit = clampInt(req.query.limit, 40, 1, 100)
    const cursor = decodeCursor(
      typeof req.query.cursor === 'string' ? req.query.cursor : null,
    )
    if (req.query.cursor && !cursor)
      return sendError(res, 'Invalid cursor', 400)
    const kinds = parseKinds(req.query.kinds)
    return sendSuccess(
      res,
      'Transparency flows',
      await transparencyService.flows({ limit, cursor, kinds }),
    )
  } catch (error: any) {
    console.error('Transparency flows error:', error)
    return sendError(res, 'Failed to load flows')
  }
})

/**
 * @swagger
 * /api/transparency/plantings:
 *   get:
 *     summary: Verified plantings with video, funding, reward and growth-update status
 *     tags: [Transparency]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 24, maximum: 60 }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [recent, trees, funded], default: recent }
 *     responses:
 *       200:
 *         description: Paginated plantings
 */
router.get('/plantings', cached(), async (req: Request, res: Response) => {
  try {
    const page = clampInt(req.query.page, 1, 1, 10000)
    const limit = clampInt(req.query.limit, 24, 1, 60)
    const sortRaw = String(req.query.sort || 'recent')
    const sort =
      sortRaw === 'trees' || sortRaw === 'funded' ? sortRaw : 'recent'
    return sendSuccess(
      res,
      'Verified plantings',
      await transparencyService.plantings({ page, limit, sort }),
    )
  } catch (error: any) {
    console.error('Transparency plantings error:', error)
    return sendError(res, 'Failed to load plantings')
  }
})

/**
 * @swagger
 * /api/transparency/plantings/{id}:
 *   get:
 *     summary: One planting's full chain of custody — videos, verifiers, funding, mints, growth updates
 *     tags: [Transparency]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Planting detail with timeline
 *       404:
 *         description: Not an approved planting
 */
router.get('/plantings/:id', cached(), async (req: Request, res: Response) => {
  try {
    const detail = await transparencyService.planting(
      String(req.params.id || ''),
    )
    if (!detail) return sendNotFound(res, 'Planting')
    return sendSuccess(res, 'Planting detail', detail)
  } catch (error: any) {
    console.error('Transparency planting error:', error)
    return sendError(res, 'Failed to load planting')
  }
})

/**
 * @swagger
 * /api/transparency/map:
 *   get:
 *     summary: GPS point for every verified planting
 *     tags: [Transparency]
 *     responses:
 *       200:
 *         description: points
 */
router.get('/map', cached(), async (_req: Request, res: Response) => {
  try {
    return sendSuccess(res, 'Planting map', await transparencyService.map())
  } catch (error: any) {
    console.error('Transparency map error:', error)
    return sendError(res, 'Failed to load map')
  }
})

/**
 * @swagger
 * /api/transparency/onchain:
 *   get:
 *     summary: Live token supply and treasury balances read from Base
 *     tags: [Transparency]
 *     responses:
 *       200:
 *         description: available=false when the RPC is unreachable
 */
router.get('/onchain', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=15')
    return sendSuccess(
      res,
      'Live on-chain reads',
      await transparencyService.onchain(),
    )
  } catch (error: any) {
    console.error('Transparency onchain error:', error)
    return sendError(res, 'Failed to read chain')
  }
})

/**
 * @swagger
 * /api/transparency/contracts:
 *   get:
 *     summary: Every contract and treasury address the protocol uses, with explorer links
 *     tags: [Transparency]
 *     responses:
 *       200:
 *         description: Contract directory
 */
router.get('/contracts', cached(), (_req: Request, res: Response) => {
  return sendSuccess(res, 'Protocol contracts', transparencyService.contracts())
})

/**
 * @swagger
 * /api/transparency/status:
 *   get:
 *     summary: Ledger indexer progress and event counts
 *     tags: [Transparency]
 *     responses:
 *       200:
 *         description: Indexer status
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const indexerStatus = indexer ? await indexer.getStatus() : null
    return sendSuccess(
      res,
      'Ledger status',
      await transparencyService.status(indexerStatus),
    )
  } catch (error: any) {
    console.error('Transparency status error:', error)
    return sendError(res, 'Failed to load status')
  }
})

export default router
