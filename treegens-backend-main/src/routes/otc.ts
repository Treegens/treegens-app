import express, { Request, Response } from 'express'
import env from '../config/environment'
import { authenticate, optionalAuth } from '../middleware/auth'
import { requireOtcBuyer } from '../middleware/otcAuth'
import {
  validateOtcCancel,
  validateOtcConfirm,
  validateOtcCountPatch,
  validateOtcDealCreate,
  validateOtcDispute,
  validateOtcEnrollmentPatch,
  validateOtcInviteCreate,
  validateOtcInvitePatch,
  validateOtcJoin,
  validateOtcMePatch,
  validateOtcPaymentFields,
  validateOtcResolve,
} from '../middleware/otcValidation'
import {
  otcBuyerLimiter,
  otcJoinLimiter,
  otcPlanterLimiter,
  otcPreviewLimiter,
  otcUploadLimiter,
} from '../middleware/rateLimits'
import { imageUpload } from '../middleware/upload'
import * as otcService from '../services/otcService'
import { OtcError } from '../services/otcService'
import { sendCreated, sendError, sendSuccess } from '../utils/responseHelpers'

const router = express.Router()

/**
 * @swagger
 * tags:
 *   name: OTC
 *   description: M-Pesa payouts — the buyer pays planters in KES and keeps the MGRO
 */

function wallet(req: Request): string {
  return String(req.user?.walletAddress || '').toLowerCase()
}

function handleOtcError(res: Response, error: any) {
  if (error instanceof OtcError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.extra || {}),
    })
  }
  // Same contract as middleware/errorHandler: log everything, never leak
  // internals in production.
  const message = error?.message || String(error)
  console.error('[OTC] unhandled error', {
    path: res.req?.originalUrl || res.req?.path,
    message,
  })
  return sendError(
    res,
    env.isProduction ? 'Something went wrong' : message,
    500,
  )
}

// ------------------------------------------------------------ public ----

/**
 * @swagger
 * /api/otc/invites/{code}/preview:
 *   get:
 *     summary: Preview an invite link before signing in
 *     tags: [OTC]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Invite preview (label, rate, acceptable, releaseMode) }
 *       404: { description: Unknown code }
 */
router.get(
  '/invites/:code/preview',
  optionalAuth,
  otcPreviewLimiter,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.previewInvite(String(req.params.code))
      return sendSuccess(res, 'Invite preview', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

// ----------------------------------------------------------- planter ----

/**
 * @swagger
 * /api/otc/join:
 *   post:
 *     summary: Join the M-Pesa program with an invite code
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, mpesaNumber, mpesaName]
 *             properties:
 *               code: { type: string }
 *               mpesaNumber: { type: string, example: "0712 345 678" }
 *               mpesaName: { type: string }
 *     responses:
 *       201: { description: Enrolled }
 *       200: { description: Already enrolled with this buyer; details updated }
 *       409: { description: Enrolled with another buyer }
 *       410: { description: Invite inactive, expired or used up }
 */
router.post(
  '/join',
  authenticate,
  otcJoinLimiter,
  validateOtcJoin,
  async (req: Request, res: Response) => {
    try {
      const { code, mpesaNumber, mpesaName } = req.body
      const result = await otcService.joinWithInvite(wallet(req), code, {
        mpesaNumber,
        mpesaName,
      })
      return result.alreadyEnrolled
        ? sendSuccess(res, 'Already enrolled; details updated', result)
        : sendCreated(res, 'Enrolled in M-Pesa payouts', result)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/me:
 *   get:
 *     summary: My enrollment, buyer and deals
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ isBuyer, enrollment, buyer, deals }" }
 *   patch:
 *     summary: Update my M-Pesa number / name, or pause and resume
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated enrollment }
 *       404: { description: Not enrolled }
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    return sendSuccess(res, 'OTC profile', await otcService.getMe(wallet(req)))
  } catch (error) {
    return handleOtcError(res, error)
  }
})

router.patch(
  '/me',
  authenticate,
  otcPlanterLimiter,
  validateOtcMePatch,
  async (req: Request, res: Response) => {
    try {
      const enrollment = await otcService.updateMyEnrollment(
        wallet(req),
        req.body,
      )
      return sendSuccess(res, 'Enrollment updated', enrollment)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/by-submission/{submissionId}:
 *   get:
 *     summary: Deal for a planting (buyer or planter)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deal detail }
 *       403: { description: Not a party to the deal }
 *       404: { description: No deal }
 */
router.get(
  '/deals/by-submission/:submissionId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.getDealBySubmission(
        String(req.params.submissionId),
        wallet(req),
      )
      return sendSuccess(res, 'Deal retrieved', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

// --------------------------------------------------- buyer: summary etc ----

/**
 * @swagger
 * /api/otc/summary:
 *   get:
 *     summary: Desk summary (counts, KES to pay, MGRO released)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Summary }
 *       403: { description: Not an OTC buyer }
 */
router.get(
  '/summary',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  async (req: Request, res: Response) => {
    try {
      return sendSuccess(
        res,
        'OTC summary',
        await otcService.summary(wallet(req)),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/invites:
 *   post:
 *     summary: Create an invite link
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: "{ invite, url }" }
 *   get:
 *     summary: List my invite links
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ items }" }
 */
router.post(
  '/invites',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcInviteCreate,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.createInvite(wallet(req), req.body)
      return sendCreated(res, 'Invite created', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

router.get(
  '/invites',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  async (req: Request, res: Response) => {
    try {
      return sendSuccess(
        res,
        'Invites',
        await otcService.listInvites(wallet(req)),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

router.patch(
  '/invites/:code',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcInvitePatch,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.updateInvite(
        wallet(req),
        String(req.params.code),
        req.body,
      )
      return sendSuccess(res, 'Invite updated', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/enrollments:
 *   get:
 *     summary: Planters enrolled with me (paginated, with deal counts)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ items, total, page, limit }" }
 */
router.get(
  '/enrollments',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.listEnrollments(wallet(req), {
        page: Number(req.query.page),
        limit: Number(req.query.limit),
      })
      return sendSuccess(res, 'Enrollments', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

router.patch(
  '/enrollments/:planterWallet',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcEnrollmentPatch,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.updateEnrollment(
        wallet(req),
        String(req.params.planterWallet),
        req.body,
      )
      return sendSuccess(res, 'Enrollment updated', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/enrollments/{planterWallet}/submissions:
 *   get:
 *     summary: A planter's mangrove plantings for the "Add planting" picker
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ items: [{ submissionId, status, aiCount, eligible, ineligibleReason }] }" }
 */
router.get(
  '/enrollments/:planterWallet/submissions',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.listEligibleSubmissionsForPlanter(
        wallet(req),
        String(req.params.planterWallet),
      )
      return sendSuccess(res, 'Eligible plantings', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

// -------------------------------------------------------- buyer: deals ----

function dealFilters(req: Request) {
  return {
    status: req.query.status ? String(req.query.status) : undefined,
    q: req.query.q ? String(req.query.q) : undefined,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    page: Number(req.query.page),
    limit: Number(req.query.limit),
  }
}

/**
 * @swagger
 * /api/otc/deals:
 *   get:
 *     summary: List deals (status, q, from, to, page, limit)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ items, total, page, limit }" }
 *   post:
 *     summary: Add a planting filmed before the planter joined
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Deal }
 *       409: { description: NOT_ENROLLED, DEAL_EXISTS or PLANTER_ALREADY_PAID }
 */
router.get(
  '/deals',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.listDeals(wallet(req), dealFilters(req))
      return sendSuccess(res, 'Deals', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

router.post(
  '/deals',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcDealCreate,
  async (req: Request, res: Response) => {
    try {
      const deal = await otcService.createDealForSubmission(
        wallet(req),
        String(req.body.submissionId),
      )
      return sendCreated(
        res,
        'Deal created',
        await otcService.toDealDetail(deal),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/export.csv:
 *   get:
 *     summary: Export deals as CSV (same filters as the list, max 5000 rows)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: text/csv }
 */
router.get(
  '/deals/export.csv',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  async (req: Request, res: Response) => {
    try {
      const csv = await otcService.exportDealsCsv(wallet(req), dealFilters(req))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="otc-deals-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).send(csv)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/{dealId}:
 *   get:
 *     summary: Deal detail (buyer or planter)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deal detail with submission, enrollment, allocation }
 *       403: { description: Not a party to the deal }
 */
router.get(
  '/deals/:dealId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const data = await otcService.getDeal(
        String(req.params.dealId),
        wallet(req),
      )
      return sendSuccess(res, 'Deal retrieved', data)
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/{dealId}/payment:
 *   post:
 *     summary: Upload the M-Pesa screenshot and transaction code
 *     description: multipart/form-data with `screenshot` (image), `mpesaRef` (10 chars), optional `amountKes`, `partial` ('true' when the amount differs), `note`.
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deal now payment_sent }
 *       400: { description: Missing file, INVALID_IMAGE, INVALID_MPESA_REF or PARTIAL_FLAG_REQUIRED }
 *       409: { description: INVALID_TRANSITION }
 */
router.post(
  '/deals/:dealId/payment',
  authenticate,
  requireOtcBuyer,
  otcUploadLimiter,
  imageUpload.single('screenshot'),
  validateOtcPaymentFields,
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        throw new OtcError(
          'NO_FILE',
          400,
          'Attach the M-Pesa screenshot (screenshot)',
        )
      }
      const { mpesaRef, amountKes, partial, note } = req.body
      const deal = await otcService.recordPayment(
        wallet(req),
        String(req.params.dealId),
        {
          file: req.file,
          mpesaRef: String(mpesaRef || ''),
          amountKes:
            amountKes === undefined || amountKes === '' ? undefined : amountKes,
          partial: partial === 'true' || partial === true,
          note,
        },
      )
      return sendSuccess(
        res,
        'Payment recorded',
        await otcService.toDealDetail(deal),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/{dealId}/count:
 *   patch:
 *     summary: Set the tree count by hand (before payment)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deal }
 *       409: { description: INVALID_TRANSITION }
 */
router.patch(
  '/deals/:dealId/count',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcCountPatch,
  async (req: Request, res: Response) => {
    try {
      const deal = await otcService.patchDealCount(
        wallet(req),
        String(req.params.dealId),
        Number(req.body.trees),
      )
      return sendSuccess(
        res,
        'Count updated',
        await otcService.toDealDetail(deal),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/{dealId}/cancel:
 *   post:
 *     summary: Cancel a deal (reason required once proof was uploaded)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deal cancelled; MGRO returns to the planter }
 *       400: { description: REASON_REQUIRED }
 *       409: { description: INVALID_TRANSITION }
 */
router.post(
  '/deals/:dealId/cancel',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcCancel,
  async (req: Request, res: Response) => {
    try {
      const deal = await otcService.cancelDeal(
        wallet(req),
        String(req.params.dealId),
        req.body?.reason,
      )
      return sendSuccess(
        res,
        'Deal cancelled',
        await otcService.toDealDetail(deal),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/{dealId}/resolve:
 *   post:
 *     summary: Resolve a dispute with written evidence
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [outcome, evidence]
 *             properties:
 *               outcome: { type: string, enum: [release_to_buyer, return_to_planter] }
 *               evidence: { type: string }
 *     responses:
 *       200: { description: Deal confirmed or cancelled }
 *       409: { description: INVALID_TRANSITION }
 */
router.post(
  '/deals/:dealId/resolve',
  authenticate,
  requireOtcBuyer,
  otcBuyerLimiter,
  validateOtcResolve,
  async (req: Request, res: Response) => {
    try {
      const deal = await otcService.resolveDeal(
        wallet(req),
        String(req.params.dealId),
        req.body,
      )
      return sendSuccess(
        res,
        'Dispute resolved',
        await otcService.toDealDetail(deal),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

// ------------------------------------------------------ planter: deals ----

/**
 * @swagger
 * /api/otc/deals/{dealId}/confirm:
 *   post:
 *     summary: Planter confirms the M-Pesa arrived (with the SMS code)
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mpesaRef: { type: string, example: QHX7K2M9PL }
 *     responses:
 *       200: { description: Deal confirmed; MGRO released to the buyer }
 *       400: { description: MPESA_REF_MISMATCH }
 *       409: { description: INVALID_TRANSITION }
 */
router.post(
  '/deals/:dealId/confirm',
  authenticate,
  otcPlanterLimiter,
  validateOtcConfirm,
  async (req: Request, res: Response) => {
    try {
      const deal = await otcService.confirmDeal(
        wallet(req),
        String(req.params.dealId),
        req.body?.mpesaRef,
      )
      return sendSuccess(
        res,
        'Payment confirmed',
        await otcService.toDealDetail(deal, wallet(req)),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

/**
 * @swagger
 * /api/otc/deals/{dealId}/dispute:
 *   post:
 *     summary: Planter reports the payment did not arrive
 *     tags: [OTC]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reasonCode]
 *             properties:
 *               reasonCode: { type: string, enum: [nothing_arrived, wrong_amount, wrong_number, other] }
 *               reason: { type: string, description: Required for `other` }
 *     responses:
 *       200: { description: Deal disputed }
 *       409: { description: INVALID_TRANSITION }
 */
router.post(
  '/deals/:dealId/dispute',
  authenticate,
  otcPlanterLimiter,
  validateOtcDispute,
  async (req: Request, res: Response) => {
    try {
      const deal = await otcService.disputeDeal(
        wallet(req),
        String(req.params.dealId),
        req.body,
      )
      return sendSuccess(
        res,
        'Dispute recorded',
        await otcService.toDealDetail(deal, wallet(req)),
      )
    } catch (error) {
      return handleOtcError(res, error)
    }
  },
)

export default router
