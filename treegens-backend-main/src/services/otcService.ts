import mongoose from 'mongoose'
import { v4 as uuidv4 } from 'uuid'
import env from '../config/environment'
import { deleteFromStorage, uploadToStorage } from '../config/gcs'
import OtcDeal from '../models/OtcDeal'
import OtcEnrollment from '../models/OtcEnrollment'
import OtcInvite from '../models/OtcInvite'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import User from '../models/User'
import { approvedTreeCount } from '../utils/treeBatch'
import {
  buildInviteUrl,
  CANCEL_FROM,
  computeDealAmountKes,
  dealTreeCountFromAi,
  expectedPlanterMgroWei,
  formatKes,
  generateInviteCode,
  isFundableCount,
  isOtcBuyerWallet,
  isTerminalStatus,
  isValidInviteCode,
  mpesaRefMatches,
  normalizeMpesaNumber,
  normalizeMpesaRef,
  normalizeWallet,
  OPEN_STATUSES,
  OTC_DEAL_STATUSES,
  OtcDealStatus,
  PAYMENT_UPLOAD_FROM,
} from './otcDealRules'
import {
  notifyOtc,
  OtcNotificationInput,
  telegramConfigured,
} from './otcNotifications'
import RewardService from './rewardService'

/**
 * OTC (M-Pesa) desk.
 *
 * A buyer pays an enrolled planter in KES over M-Pesa for the trees the AI
 * counted and receives the planter's MGRO for that planting once the planter
 * confirms the money arrived. Until then the planter's MGRO is held on the
 * RewardAllocation (never minted, never claimable).
 *
 * A module of exported functions (not a class) so tests can monkeypatch the
 * model statics and RewardService.prototype.
 */

export class OtcError extends Error {
  code: string
  status: number
  extra?: Record<string, unknown>

  constructor(
    code: string,
    status: number,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'OtcError'
    this.code = code
    this.status = status
    this.extra = extra
  }
}

type Notifier = (input: OtcNotificationInput) => Promise<void>
let notifier: Notifier = notifyOtc

/** Tests swap the notifier so no inbox rows or Telegram calls happen. */
export function __setNotifierForTests(fn: Notifier | null): void {
  notifier = fn || notifyOtc
}

function notify(input: OtcNotificationInput): Promise<void> {
  return notifier(input).catch((error: any) => {
    console.warn('[OTC] notification failed', {
      kind: input.kind,
      message: error?.message || String(error),
    })
  })
}

const rewardService = new RewardService()

const MANGROVE = /^mangrove$/i
const SYSTEM = 'system'
const EXPIRY_SWEEP_LOOKBACK_DAYS = 30
const REMINDER_AFTER_MS = 2 * 60 * 60 * 1000
const RECONCILER_INTERVAL_MS = 5 * 60_000

type AnyDeal = any
type AnySubmission = any
type AnyEnrollment = any

function oid(value: unknown, what = 'id'): mongoose.Types.ObjectId {
  const s = String(value ?? '')
  if (!mongoose.Types.ObjectId.isValid(s)) {
    throw new OtcError('INVALID_ID', 400, `Invalid ${what}`)
  }
  return new mongoose.Types.ObjectId(s)
}

function buyerLabel(): string {
  return env.OTC_BUYER_DISPLAY_NAME
}

function dealLink(deal: { _id: unknown }): string {
  return `/otc/deals/${String(deal._id)}`
}

function paidKes(deal: AnyDeal): number {
  const paid = deal?.payment?.amountKes
  return typeof paid === 'number' && Number.isFinite(paid)
    ? paid
    : Number(deal?.amountKes || 0)
}

function isMangrove(submission: { treeType?: string | null }): boolean {
  return MANGROVE.test(String(submission?.treeType ?? '').trim())
}

function maskPhone(phone: string): string {
  const p = String(phone || '')
  if (p.length <= 7) return '•••'
  return `${p.slice(0, 4)}•••••${p.slice(-3)}`
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isBuyerActive(buyerWallet: string): boolean {
  return isOtcBuyerWallet(buyerWallet, env.OTC_BUYER_WALLETS)
}

// ------------------------------------------------------------- transitions --

/**
 * One atomic state change. A null result means someone else moved the deal
 * first; the caller gets a 409 with the status the deal is in now.
 */
async function transitionDeal(
  dealId: mongoose.Types.ObjectId,
  allowedFrom: readonly string[],
  set: Record<string, unknown>,
  event: { type: string; by: string; note?: string },
  unset?: Record<string, 1>,
): Promise<AnyDeal> {
  const update: Record<string, unknown> = {
    $set: set,
    $push: {
      events: {
        type: event.type,
        by: normalizeWallet(event.by) || SYSTEM,
        at: new Date(),
        ...(event.note ? { note: String(event.note).slice(0, 500) } : {}),
      },
    },
  }
  if (unset && Object.keys(unset).length) update.$unset = unset
  const updated = await OtcDeal.findOneAndUpdate(
    { _id: dealId, status: { $in: allowedFrom } },
    update,
    { new: true },
  )
  if (updated) return updated
  const current = await OtcDeal.findById(dealId).select('status').lean()
  if (!current) throw new OtcError('DEAL_NOT_FOUND', 404, 'Deal not found')
  throw new OtcError(
    'INVALID_TRANSITION',
    409,
    `This deal is ${String(current.status).replace(/_/g, ' ')}`,
    { status: current.status },
  )
}

async function loadDeal(dealId: unknown): Promise<AnyDeal> {
  const deal = await OtcDeal.findById(oid(dealId, 'dealId'))
  if (!deal) throw new OtcError('DEAL_NOT_FOUND', 404, 'Deal not found')
  return deal
}

async function loadDealForBuyer(
  buyerWallet: string,
  dealId: unknown,
): Promise<AnyDeal> {
  const deal = await loadDeal(dealId)
  if (normalizeWallet(deal.buyerWallet) !== normalizeWallet(buyerWallet)) {
    throw new OtcError('FORBIDDEN', 403, 'This deal belongs to another buyer')
  }
  return deal
}

async function loadDealForPlanter(
  planterWallet: string,
  dealId: unknown,
): Promise<AnyDeal> {
  const deal = await loadDeal(dealId)
  if (normalizeWallet(deal.planterWallet) !== normalizeWallet(planterWallet)) {
    throw new OtcError('FORBIDDEN', 403, 'This deal is not yours')
  }
  return deal
}

// ----------------------------------------------------------------- invites --

function inviteState(invite: AnyEnrollment, now = new Date()) {
  const expired = Boolean(invite.expiresAt && new Date(invite.expiresAt) < now)
  const exhausted =
    invite.maxUses !== null &&
    invite.maxUses !== undefined &&
    Number(invite.uses || 0) >= Number(invite.maxUses)
  const isActive = Boolean(invite.isActive)
  const reason: 'inactive' | 'expired' | 'exhausted' | null = !isActive
    ? 'inactive'
    : expired
      ? 'expired'
      : exhausted
        ? 'exhausted'
        : null
  return { isActive, expired, exhausted, acceptable: reason === null, reason }
}

function inviteJson(invite: AnyEnrollment) {
  const plain =
    typeof invite.toObject === 'function' ? invite.toObject() : { ...invite }
  return { ...plain, url: buildInviteUrl(plain.code) }
}

export async function createInvite(
  buyerWallet: string,
  input: {
    label?: string
    ratePerTreeKes: number
    maxUses?: number | null
    expiresAt?: Date | string | null
  },
) {
  const buyer = normalizeWallet(buyerWallet)
  let invite: AnyEnrollment = null
  for (let attempt = 0; attempt < 5 && !invite; attempt++) {
    try {
      invite = await OtcInvite.create({
        code: generateInviteCode(),
        buyerWallet: buyer,
        label: String(input.label || '').trim() || undefined,
        ratePerTreeKes: Number(input.ratePerTreeKes),
        maxUses: input.maxUses ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        isActive: true,
      })
    } catch (e: any) {
      if (e?.code !== 11000) throw e
    }
  }
  if (!invite) {
    throw new OtcError(
      'INVITE_CODE_COLLISION',
      500,
      'Could not allocate a code',
    )
  }
  return { invite: inviteJson(invite), url: buildInviteUrl(invite.code) }
}

export async function listInvites(buyerWallet: string) {
  const items = await OtcInvite.find({
    buyerWallet: normalizeWallet(buyerWallet),
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean()
  return { items: items.map(inviteJson) }
}

export async function updateInvite(
  buyerWallet: string,
  code: string,
  patch: {
    isActive?: boolean
    ratePerTreeKes?: number
    label?: string
    maxUses?: number | null
    expiresAt?: Date | string | null
  },
) {
  const set: Record<string, unknown> = {}
  if (patch.isActive !== undefined) set.isActive = Boolean(patch.isActive)
  if (patch.ratePerTreeKes !== undefined)
    set.ratePerTreeKes = Number(patch.ratePerTreeKes)
  if (patch.label !== undefined) set.label = String(patch.label).trim()
  if (patch.maxUses !== undefined) set.maxUses = patch.maxUses
  if (patch.expiresAt !== undefined)
    set.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null
  const invite = await OtcInvite.findOneAndUpdate(
    {
      code: String(code || '')
        .trim()
        .toUpperCase(),
      buyerWallet: normalizeWallet(buyerWallet),
    },
    { $set: set },
    { new: true },
  )
  if (!invite) throw new OtcError('INVITE_NOT_FOUND', 404, 'Invite not found')
  return inviteJson(invite)
}

export async function previewInvite(code: string) {
  const c = String(code || '')
    .trim()
    .toUpperCase()
  if (!isValidInviteCode(c)) {
    throw new OtcError('INVITE_NOT_FOUND', 404, 'Invite not found')
  }
  const invite = await OtcInvite.findOne({ code: c }).lean()
  if (!invite) throw new OtcError('INVITE_NOT_FOUND', 404, 'Invite not found')
  const state = inviteState(invite)
  return {
    code: invite.code,
    label: invite.label || '',
    // D9: planters see the configured buyer name; invite.label is desk-only.
    buyerLabel: buyerLabel(),
    buyerWallet: invite.buyerWallet,
    ratePerTreeKes: invite.ratePerTreeKes,
    releaseMode: env.OTC_RELEASE_MODE,
    ...state,
  }
}

// ------------------------------------------------------------- enrollments --

export async function getMyEnrollment(planterWallet: string) {
  return OtcEnrollment.findOne({
    planterWallet: normalizeWallet(planterWallet),
  }).lean()
}

async function buyerLabelForEnrollment(
  enrollment: AnyEnrollment | null,
): Promise<string> {
  if (!enrollment) return 'TreeGens buyer'
  if (enrollment.inviteId) {
    const invite = await OtcInvite.findById(enrollment.inviteId)
      .select('label')
      .lean()
    if (invite?.label) return invite.label
  }
  return 'TreeGens buyer'
}

export async function joinWithInvite(
  planterWallet: string,
  code: string,
  input: { mpesaNumber: string; mpesaName: string },
): Promise<{
  enrollment: AnyEnrollment
  alreadyEnrolled: boolean
  backfilled: number
}> {
  const planter = normalizeWallet(planterWallet)
  const phone = normalizeMpesaNumber(input.mpesaNumber)
  if (!phone) {
    throw new OtcError(
      'INVALID_PHONE',
      400,
      'Enter a valid M-Pesa number, e.g. 07XX XXX XXX',
    )
  }
  const name = String(input.mpesaName || '').trim()
  if (name.length < 2) {
    throw new OtcError('INVALID_NAME', 400, 'Enter the name on your M-Pesa')
  }

  const c = String(code || '')
    .trim()
    .toUpperCase()
  if (!isValidInviteCode(c)) {
    throw new OtcError('INVITE_NOT_FOUND', 404, 'Invite not found')
  }
  const invite = await OtcInvite.findOne({ code: c })
  if (!invite) throw new OtcError('INVITE_NOT_FOUND', 404, 'Invite not found')
  const state = inviteState(invite)
  if (!state.acceptable) {
    throw new OtcError(
      'INVITE_UNAVAILABLE',
      410,
      state.reason === 'expired'
        ? 'This invite link has expired'
        : state.reason === 'exhausted'
          ? 'This invite link has been used up'
          : 'This invite link is no longer active',
      { reason: state.reason },
    )
  }
  const buyer = normalizeWallet(invite.buyerWallet)

  const existing = await OtcEnrollment.findOne({ planterWallet: planter })
  if (existing) {
    if (normalizeWallet(existing.buyerWallet) !== buyer) {
      throw new OtcError(
        'ALREADY_ENROLLED',
        409,
        'You are already enrolled with another buyer',
      )
    }
    // Same buyer: refresh details, never consume another use.
    existing.mpesaNumber = phone
    existing.mpesaName = name
    existing.ratePerTreeKes = invite.ratePerTreeKes
    existing.status = 'active'
    await existing.save()
    return { enrollment: existing, alreadyEnrolled: true, backfilled: 0 }
  }

  const now = new Date()
  const claimed = await OtcInvite.findOneAndUpdate(
    {
      _id: invite._id,
      isActive: true,
      $and: [
        {
          $or: [
            { maxUses: null },
            { maxUses: { $exists: false } },
            { $expr: { $lt: ['$uses', '$maxUses'] } },
          ],
        },
        {
          $or: [
            { expiresAt: null },
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: now } },
          ],
        },
      ],
    },
    { $inc: { uses: 1 } },
    { new: true },
  )
  if (!claimed) {
    throw new OtcError(
      'INVITE_UNAVAILABLE',
      410,
      'This invite link is no longer available',
    )
  }

  let enrollment: AnyEnrollment
  try {
    enrollment = await OtcEnrollment.create({
      planterWallet: planter,
      buyerWallet: buyer,
      inviteId: invite._id,
      inviteCode: invite.code,
      mpesaNumber: phone,
      mpesaName: name,
      ratePerTreeKes: invite.ratePerTreeKes,
      status: 'active',
      joinedAt: now,
    })
  } catch (e: any) {
    if (e?.code !== 11000) throw e
    // Raced with ourselves (double tap): hand the use back.
    await OtcInvite.updateOne({ _id: invite._id }, { $inc: { uses: -1 } })
    const again = await OtcEnrollment.findOne({ planterWallet: planter })
    if (!again) throw e
    if (normalizeWallet(again.buyerWallet) !== buyer) {
      throw new OtcError(
        'ALREADY_ENROLLED',
        409,
        'You are already enrolled with another buyer',
      )
    }
    return { enrollment: again, alreadyEnrolled: true, backfilled: 0 }
  }

  // Best effort: the profile phone is handy elsewhere; never fail the join.
  User.updateOne(
    {
      walletAddress: planter,
      $or: [{ phone: { $exists: false } }, { phone: null }, { phone: '' }],
    },
    { $set: { phone } },
  ).catch(() => {})

  // D11: plantings filmed before the link.
  let backfilled = 0
  try {
    backfilled = await backfillDealsForPlanter(enrollment)
  } catch (error: any) {
    console.error('[OTC] backfill after join failed', {
      planter,
      message: error?.message || String(error),
    })
  }

  void notify({
    recipientWalletAddress: buyer,
    kind: 'otc_planter_joined',
    title: `New M-Pesa planter: ${name}`,
    body:
      `${name} joined via invite ${invite.label || invite.code}. ` +
      `Rate KES ${invite.ratePerTreeKes}/tree.` +
      (backfilled > 0
        ? ` ${backfilled} existing planting(s) added to the desk.`
        : ''),
    link: '/otc',
    payload: { planterWallet: planter, inviteCode: invite.code, backfilled },
    telegram: true,
  })

  return { enrollment, alreadyEnrolled: false, backfilled }
}

export async function updateMyEnrollment(
  planterWallet: string,
  patch: { mpesaNumber?: string; mpesaName?: string; status?: string },
) {
  const planter = normalizeWallet(planterWallet)
  const enrollment = await OtcEnrollment.findOne({ planterWallet: planter })
  if (!enrollment) {
    throw new OtcError('NOT_ENROLLED', 404, 'You are not enrolled')
  }
  let contactChanged = false
  if (patch.mpesaNumber !== undefined) {
    const phone = normalizeMpesaNumber(patch.mpesaNumber)
    if (!phone) {
      throw new OtcError('INVALID_PHONE', 400, 'Enter a valid M-Pesa number')
    }
    if (phone !== enrollment.mpesaNumber) contactChanged = true
    enrollment.mpesaNumber = phone
  }
  if (patch.mpesaName !== undefined) {
    const name = String(patch.mpesaName).trim()
    if (name.length < 2) {
      throw new OtcError('INVALID_NAME', 400, 'Enter the name on your M-Pesa')
    }
    if (name !== enrollment.mpesaName) contactChanged = true
    enrollment.mpesaName = name
  }
  if (patch.status === 'active' || patch.status === 'paused') {
    enrollment.status = patch.status
  }
  await enrollment.save()

  if (contactChanged) {
    void notify({
      recipientWalletAddress: planter,
      kind: 'otc_profile_changed',
      title: 'M-Pesa payout details changed',
      body:
        `Your M-Pesa payout number was changed to ${maskPhone(enrollment.mpesaNumber)}` +
        ` (${enrollment.mpesaName}). If this wasn't you, contact support.`,
      link: '/otc/me',
    })
    await OtcDeal.updateMany(
      { planterWallet: planter, status: { $in: OPEN_STATUSES } },
      {
        $push: {
          events: {
            type: 'planter_phone_changed',
            by: planter,
            at: new Date(),
            note: 'Planter changed their M-Pesa details after this deal was created',
          },
        },
      },
    ).catch(() => {})
  }
  return enrollment
}

export async function listEnrollments(
  buyerWallet: string,
  opts: { page?: number; limit?: number },
) {
  const buyer = normalizeWallet(buyerWallet)
  const page = Math.max(1, Number(opts.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 25))
  const [rows, total] = await Promise.all([
    OtcEnrollment.find({ buyerWallet: buyer })
      .sort({ joinedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    OtcEnrollment.countDocuments({ buyerWallet: buyer }),
  ])
  const wallets = rows.map(r => r.planterWallet)
  const [users, counts] = await Promise.all([
    User.find({ walletAddress: { $in: wallets } })
      .select('walletAddress name')
      .lean(),
    OtcDeal.aggregate<{ _id: { w: string; s: string }; n: number }>([
      { $match: { buyerWallet: buyer, planterWallet: { $in: wallets } } },
      {
        $group: {
          _id: { w: '$planterWallet', s: '$status' },
          n: { $sum: 1 },
        },
      },
    ]),
  ])
  const nameByWallet = new Map(
    users.map(u => [normalizeWallet(u.walletAddress), u.name || '']),
  )
  const emptyCounts = () => {
    const c: Record<string, number> = { total: 0 }
    for (const s of OTC_DEAL_STATUSES) c[s] = 0
    return c
  }
  const countsByWallet = new Map<string, Record<string, number>>()
  for (const row of counts) {
    const c = countsByWallet.get(row._id.w) || emptyCounts()
    c[row._id.s] = row.n
    c.total += row.n
    countsByWallet.set(row._id.w, c)
  }
  return {
    items: rows.map(r => ({
      ...r,
      planterName: nameByWallet.get(normalizeWallet(r.planterWallet)) || '',
      dealCounts: countsByWallet.get(r.planterWallet) || emptyCounts(),
    })),
    total,
    page,
    limit,
  }
}

export async function updateEnrollment(
  buyerWallet: string,
  planterWallet: string,
  patch: { ratePerTreeKes?: number; status?: string },
) {
  const buyer = normalizeWallet(buyerWallet)
  const planter = normalizeWallet(planterWallet)
  const enrollment = await OtcEnrollment.findOne({
    planterWallet: planter,
    buyerWallet: buyer,
  })
  if (!enrollment) {
    throw new OtcError('ENROLLMENT_NOT_FOUND', 404, 'Planter not enrolled')
  }
  const rateChanged =
    patch.ratePerTreeKes !== undefined &&
    Number(patch.ratePerTreeKes) !== Number(enrollment.ratePerTreeKes)
  const statusChanged =
    (patch.status === 'active' || patch.status === 'paused') &&
    patch.status !== enrollment.status
  if (rateChanged) enrollment.ratePerTreeKes = Number(patch.ratePerTreeKes)
  if (statusChanged) enrollment.status = patch.status as 'active' | 'paused'
  await enrollment.save()

  if (rateChanged) {
    void notify({
      recipientWalletAddress: planter,
      kind: 'otc_rate_changed',
      title: 'Your M-Pesa rate changed',
      body: `Your rate is now KES ${enrollment.ratePerTreeKes} per tree. Applies to new plantings.`,
      link: '/otc/me',
    })
  }
  if (statusChanged) {
    const paused = enrollment.status === 'paused'
    void notify({
      recipientWalletAddress: planter,
      kind: paused ? 'otc_enrollment_paused' : 'otc_enrollment_resumed',
      title: paused ? 'M-Pesa payouts paused' : 'M-Pesa payouts resumed',
      body: paused
        ? `${buyerLabel()} paused your M-Pesa payouts. New plantings earn MGRO as usual until resumed.`
        : `${buyerLabel()} resumed your M-Pesa payouts. New plantings are paid by M-Pesa again.`,
      link: '/otc/me',
    })
  }
  return enrollment
}

// ------------------------------------------------------------------ counts --

type DealCount = {
  trees: number
  countSource: 'ai' | 'approved' | 'manual' | 'none'
  verified: boolean
  status: 'awaiting_count' | 'awaiting_payment'
  countNote?: string
}

/**
 * The count a deal pays for, and whether it is payable yet (D3).
 * `manual` is the desk's "Add planting" path: an approved submission uses the
 * approved count; everything else uses the AI count.
 */
function computeDealCount(
  submission: AnySubmission,
  opts: { manual?: boolean } = {},
): DealCount {
  const approved = submission.status === 'approved'
  const verified =
    submission.aiVerification?.decision === 'auto_approved' || approved

  let trees: number
  let countSource: DealCount['countSource']
  if (opts.manual && approved) {
    const c = approvedTreeCount(submission)
    trees = c > 0 ? c : Math.floor(Number(submission.treesPlanted || 0))
    countSource = 'approved'
  } else {
    const aiCount = dealTreeCountFromAi(submission)
    if (aiCount === null) {
      const ai = submission.aiVerification || {}
      const why = ai.skipReason || ai.error || 'no result'
      return {
        trees: 0,
        countSource: 'none',
        verified,
        status: 'awaiting_count',
        countNote: `AI could not count this clip (${why}). A verifier count or a manual count is needed.`,
      }
    }
    trees = aiCount
    countSource = 'ai'
  }

  const fundable = isFundableCount(trees)
  const payable = fundable.ok && (env.OTC_PAY_ON === 'ai_count' || approved)
  return {
    trees,
    countSource,
    verified,
    status: payable ? 'awaiting_payment' : 'awaiting_count',
    countNote: fundable.ok
      ? payable
        ? undefined
        : 'Payable once verifiers approve this planting'
      : fundable.reason || undefined,
  }
}

function moneyFields(trees: number, rate: number) {
  return {
    trees,
    amountKes: computeDealAmountKes(trees, rate),
    expectedMgroWei: expectedPlanterMgroWei(trees),
  }
}

/**
 * Shared creation path. Hold FIRST when the submission is already approved:
 * once any planter MGRO was minted or proposed the deal must not exist
 * (PLANTER_ALREADY_PAID). The deal id is allocated up front so the hold and
 * the deal reference each other without a second write.
 */
async function createDealWithHold(
  submission: AnySubmission,
  enrollment: AnyEnrollment,
  opts: { by: string; manual?: boolean },
): Promise<{ deal: AnyDeal; created: boolean }> {
  const planter = normalizeWallet(submission.userWalletAddress)
  const buyer = normalizeWallet(enrollment.buyerWallet)
  const dealId = new mongoose.Types.ObjectId()

  let held: { held: boolean; exists: boolean; allocationId?: string } = {
    held: false,
    exists: false,
  }
  if (submission.status === 'approved') {
    held = await rewardService.holdAllocationForDeal(
      submission._id,
      dealId,
      planter,
    )
    if (held.exists && !held.held) {
      throw new OtcError(
        'PLANTER_ALREADY_PAID',
        409,
        'MGRO for this planting was already minted or proposed to the planter',
      )
    }
  }

  const count = computeDealCount(submission, { manual: opts.manual })
  const rate = Number(enrollment.ratePerTreeKes)
  try {
    const deal = await OtcDeal.create({
      _id: dealId,
      submissionId: submission._id,
      planterWallet: planter,
      buyerWallet: buyer,
      enrollmentId: enrollment._id,
      mpesaNumber: enrollment.mpesaNumber,
      mpesaName: enrollment.mpesaName,
      ...moneyFields(count.trees, rate),
      countSource: count.countSource,
      ratePerTreeKes: rate,
      status: count.status,
      countNote: count.countNote,
      verified: count.verified,
      submissionStatus: submission.status,
      release: held.held
        ? { status: 'held', allocationId: held.allocationId }
        : { status: 'n/a' },
      events: [
        {
          type: 'created',
          by: normalizeWallet(opts.by) || SYSTEM,
          at: new Date(),
          ...(count.countNote ? { note: count.countNote } : {}),
        },
      ],
    })
    return { deal, created: true }
  } catch (e: any) {
    if (held.held) {
      await RewardAllocation.updateOne(
        { submissionId: submission._id, 'otc.dealId': dealId },
        { $unset: { otc: 1 } },
      ).catch(() => {})
    }
    if (e?.code === 11000) {
      const existing = await OtcDeal.findOne({ submissionId: submission._id })
      if (existing) {
        // Someone created the deal first: let it take the hold.
        void reconcileDealAllocation(String(existing._id))
        return { deal: existing, created: false }
      }
    }
    throw e
  }
}

/**
 * Called by submissionService right after the plant clip is saved. DB only,
 * no notifications (the upload response must not wait on them).
 */
export async function ensureDealForSubmission(
  submission: AnySubmission,
): Promise<{ deal: AnyDeal; created: boolean } | null> {
  if (!submission || !isMangrove(submission)) return null
  const planter = normalizeWallet(submission.userWalletAddress)
  if (!planter) return null

  const enrollment = await OtcEnrollment.findOne({
    planterWallet: planter,
    status: 'active',
  }).lean()
  if (!enrollment) return null
  if (!isBuyerActive(enrollment.buyerWallet)) {
    console.warn(
      '[OTC] enrollment buyer is not in OTC_BUYER_WALLETS; no deal',
      {
        planter,
        buyer: enrollment.buyerWallet,
      },
    )
    return null
  }

  const existing = await OtcDeal.findOne({ submissionId: submission._id })
  if (existing) return { deal: existing, created: false }

  return createDealWithHold(submission, enrollment, { by: SYSTEM })
}

/** Fire-and-forget after a deal was created at upload time. */
export async function notifyDealCreated(
  deal: AnyDeal,
  submission?: AnySubmission | null,
): Promise<void> {
  const link = dealLink(deal)
  const name = deal.mpesaName
  const trees = Number(deal.trees || 0)
  const amount = formatKes(deal.amountKes)
  const verified = Boolean(deal.verified)
  if (deal.status === 'awaiting_payment') {
    await notify({
      recipientWalletAddress: deal.buyerWallet,
      kind: 'otc_deal_ready',
      title: `Pay ${amount} to ${name}${verified ? ' (auto-approved)' : ''}`,
      body:
        `AI counted ${trees} trees` +
        (verified
          ? ''
          : '. Not yet verified by verifiers: pay now at your own risk or wait') +
        '. Open the deal for the M-Pesa number.',
      link,
      payload: {
        dealId: String(deal._id),
        submissionId: String(deal.submissionId),
      },
      telegram: true,
    })
  } else {
    await notify({
      recipientWalletAddress: deal.buyerWallet,
      kind: 'otc_deal_awaiting_count',
      title: `New planting from ${name}: not payable yet`,
      body: deal.countNote || 'Waiting for a usable tree count.',
      link,
      payload: {
        dealId: String(deal._id),
        submissionId: String(deal.submissionId),
      },
      telegram: true,
    })
  }
  if (trees > 0) {
    await notify({
      recipientWalletAddress: deal.planterWallet,
      kind: 'otc_deal_created',
      title: 'Planting added to M-Pesa payouts',
      body: `You will be paid ${amount} by M-Pesa for ${trees} trees instead of MGRO once ${buyerLabel()} sends it.`,
      link,
      payload: {
        dealId: String(deal._id),
        submissionId: String(submission?._id ?? deal.submissionId),
      },
    })
  }
}

/** D11: deals for the planter's existing plantings when they join. */
async function backfillDealsForPlanter(
  enrollment: AnyEnrollment,
): Promise<number> {
  const planter = normalizeWallet(enrollment.planterWallet)
  if (!isBuyerActive(enrollment.buyerWallet)) return 0
  const submissions = await Submission.find({
    userWalletAddress: planter,
    treeType: MANGROVE,
    'plant.uploaded': true,
    status: { $in: ['pending_review', 'approved'] },
  })
    .sort({ createdAt: -1 })
    .limit(50)
  if (submissions.length === 0) return 0
  const existing = await OtcDeal.find({
    submissionId: { $in: submissions.map(s => s._id) },
  })
    .select('submissionId')
    .lean()
  const withDeal = new Set(existing.map(d => String(d.submissionId)))

  let n = 0
  for (const submission of submissions) {
    if (withDeal.has(String(submission._id))) continue
    try {
      const { deal, created } = await createDealWithHold(
        submission,
        enrollment,
        { by: SYSTEM, manual: true },
      )
      if (created) {
        n += 1
        if (Number(deal.trees || 0) > 0) {
          void notify({
            recipientWalletAddress: planter,
            kind: 'otc_deal_created',
            title: 'Planting added to M-Pesa payouts',
            body: `You will be paid ${formatKes(deal.amountKes)} by M-Pesa for ${deal.trees} trees instead of MGRO once ${buyerLabel()} sends it.`,
            link: dealLink(deal),
            payload: { dealId: String(deal._id) },
          })
        }
      }
    } catch (error: any) {
      if (error instanceof OtcError && error.code === 'PLANTER_ALREADY_PAID') {
        console.log('[OTC] backfill skipped: planter already paid', {
          submissionId: String(submission._id),
        })
        continue
      }
      console.error('[OTC] backfill deal failed', {
        submissionId: String(submission._id),
        message: error?.message || String(error),
      })
    }
  }
  return n
}

/**
 * Awaited by applyApprovalSideEffects BEFORE the allocation is created, so
 * the allocation reads the final count from the deal (D2).
 */
export async function onSubmissionApproved(
  submission: AnySubmission,
): Promise<AnyDeal | null> {
  const deal = await OtcDeal.findOne({ submissionId: submission._id })
  if (!deal || isTerminalStatus(deal.status)) return deal
  const now = new Date()
  const c = approvedTreeCount(submission)
  const trees =
    c > 0
      ? c
      : Number(deal.trees) > 0
        ? Number(deal.trees)
        : Math.floor(Number(submission.treesPlanted || 0))

  if (trees <= 0) {
    const updated = await OtcDeal.findOneAndUpdate(
      { _id: deal._id, status: { $in: OPEN_STATUSES } },
      {
        $set: {
          verified: true,
          submissionStatus: 'approved',
          countNote:
            'Approved without a usable tree count. Set the count manually.',
        },
        $push: {
          events: {
            type: 'approved_without_count',
            by: SYSTEM,
            at: now,
            note: 'Verifiers approved the planting but no count is available',
          },
        },
      },
      { new: true },
    )
    void notify({
      recipientWalletAddress: deal.buyerWallet,
      kind: 'otc_deal_awaiting_count',
      title: `${deal.mpesaName}: planting approved, count needed`,
      body: 'Verifiers approved this planting but no tree count is available. Set the count manually on the deal.',
      link: dealLink(deal),
      payload: { dealId: String(deal._id) },
      telegram: true,
    })
    return updated || deal
  }

  const rate = Number(deal.ratePerTreeKes)
  const money = moneyFields(trees, rate)
  const set: Record<string, unknown> = {
    ...money,
    countSource: c > 0 ? 'approved' : deal.countSource,
    verified: true,
    submissionStatus: 'approved',
  }
  const fundable = isFundableCount(trees)
  const countChanged = Number(deal.trees) !== trees
  const changeNote = countChanged
    ? `Count updated ${deal.trees} -> ${trees} at approval; ${formatKes(deal.amountKes)} -> ${formatKes(money.amountKes)}`
    : undefined

  if (deal.status === 'awaiting_count' && fundable.ok) {
    const updated = await OtcDeal.findOneAndUpdate(
      { _id: deal._id, status: 'awaiting_count' },
      {
        $set: { ...set, status: 'awaiting_payment' },
        $unset: { countNote: 1 },
        $push: {
          events: {
            type: 'count_approved',
            by: SYSTEM,
            at: now,
            note: changeNote || `Verifiers approved ${trees} trees`,
          },
        },
      },
      { new: true },
    )
    if (updated) {
      void notify({
        recipientWalletAddress: updated.buyerWallet,
        kind: 'otc_deal_count_ready',
        title: `Pay ${formatKes(updated.amountKes)} to ${updated.mpesaName}`,
        body: `Verifiers approved ${trees} trees.`,
        link: dealLink(updated),
        payload: { dealId: String(updated._id) },
        telegram: true,
      })
      return updated
    }
  }

  const update: Record<string, unknown> = { $set: set }
  if (!fundable.ok) {
    set.countNote = fundable.reason
  } else if (deal.countNote) {
    update.$unset = { countNote: 1 }
  }
  if (changeNote) {
    update.$push = {
      events: { type: 'count_updated', by: SYSTEM, at: now, note: changeNote },
    }
  }
  const updated = await OtcDeal.findOneAndUpdate(
    { _id: deal._id, status: { $in: OPEN_STATUSES } },
    update,
    { new: true },
  )
  return updated || deal
}

/** D4: verifiers rejected the submission. */
export async function onSubmissionRejected(
  submission: AnySubmission,
): Promise<void> {
  const deal = await OtcDeal.findOne({ submissionId: submission._id })
  if (!deal || deal.status === 'cancelled') return
  if (deal.status === 'awaiting_count' || deal.status === 'awaiting_payment') {
    await cancelDealInternal(deal, {
      by: SYSTEM,
      reason: 'submission_rejected',
      planterBody: `Verifiers rejected this planting. ${buyerLabel()} will not pay for it.`,
    })
    return
  }
  if (deal.release?.status === 'unfundable') return
  if (deal.release?.status !== 'n/a' && deal.release?.status !== 'held') {
    // MGRO already moved: nothing to mark.
    return
  }
  const updated = await OtcDeal.findOneAndUpdate(
    {
      _id: deal._id,
      status: { $in: ['payment_sent', 'confirmed', 'disputed'] },
      'release.status': { $in: ['n/a', 'held'] },
    },
    {
      $set: { 'release.status': 'unfundable', submissionStatus: 'rejected' },
      $push: {
        events: {
          type: 'submission_rejected',
          by: SYSTEM,
          at: new Date(),
          note: 'Verifiers rejected the planting after payment: no MGRO will mint',
        },
      },
    },
    { new: true },
  )
  if (!updated) return
  void notify({
    recipientWalletAddress: updated.buyerWallet,
    kind: 'otc_deal_unfundable',
    title: 'Planting rejected after payment',
    body: `Verifiers rejected ${updated.mpesaName}'s planting. ${formatKes(paidKes(updated))} was sent but no MGRO will mint for it.`,
    link: dealLink(updated),
    payload: { dealId: String(updated._id) },
    telegram: true,
  })
}

/** Desk: "Add planting" for a planter who filmed before joining. */
export async function createDealForSubmission(
  buyerWallet: string,
  submissionId: string,
): Promise<AnyDeal> {
  const buyer = normalizeWallet(buyerWallet)
  const sid = oid(submissionId, 'submissionId')
  const submission = await Submission.findById(sid)
  if (!submission) {
    throw new OtcError('SUBMISSION_NOT_FOUND', 404, 'Submission not found')
  }
  const planter = normalizeWallet(submission.userWalletAddress)
  const enrollment = await OtcEnrollment.findOne({
    planterWallet: planter,
    buyerWallet: buyer,
  }).lean()
  if (!enrollment) {
    throw new OtcError(
      'NOT_ENROLLED',
      409,
      'This planter is not enrolled with you',
    )
  }
  if (!isMangrove(submission)) {
    throw new OtcError(
      'NOT_MANGROVE',
      409,
      'Only mangrove plantings can be paid by M-Pesa',
    )
  }
  if (!submission.plant?.uploaded) {
    throw new OtcError(
      'NO_PLANT_CLIP',
      409,
      'The planting clip has not been uploaded yet',
    )
  }
  if (submission.status === 'rejected') {
    throw new OtcError('SUBMISSION_REJECTED', 409, 'This planting was rejected')
  }
  const existing = await OtcDeal.findOne({ submissionId: sid })
    .select('_id')
    .lean()
  if (existing) {
    throw new OtcError('DEAL_EXISTS', 409, 'A deal already exists', {
      dealId: String(existing._id),
    })
  }
  const { deal, created } = await createDealWithHold(submission, enrollment, {
    by: buyer,
    manual: true,
  })
  if (!created) {
    throw new OtcError('DEAL_EXISTS', 409, 'A deal already exists', {
      dealId: String(deal._id),
    })
  }
  if (Number(deal.trees || 0) > 0) {
    void notify({
      recipientWalletAddress: planter,
      kind: 'otc_deal_created',
      title: 'Planting added to M-Pesa payouts',
      body: `You will be paid ${formatKes(deal.amountKes)} by M-Pesa for ${deal.trees} trees instead of MGRO once ${buyerLabel()} sends it.`,
      link: dealLink(deal),
      payload: { dealId: String(deal._id) },
    })
  }
  return deal
}

/** Buyer sets the count by hand (AI failed, or a verifier count differs). */
export async function patchDealCount(
  buyerWallet: string,
  dealId: string,
  treesInput: number,
): Promise<AnyDeal> {
  const deal = await loadDealForBuyer(buyerWallet, dealId)
  const trees = Math.floor(Number(treesInput))
  if (!Number.isFinite(trees) || trees <= 0) {
    throw new OtcError('INVALID_COUNT', 400, 'trees must be a positive number')
  }
  const allowed = ['awaiting_count', 'awaiting_payment']
  if (!allowed.includes(deal.status)) {
    throw new OtcError(
      'INVALID_TRANSITION',
      409,
      'The count can only change before payment',
      { status: deal.status },
    )
  }
  const submission = await Submission.findById(deal.submissionId)
    .select('status')
    .lean()
  const approved = (submission?.status ?? deal.submissionStatus) === 'approved'
  const fundable = isFundableCount(trees)
  const payable = fundable.ok && (env.OTC_PAY_ON === 'ai_count' || approved)
  const set: Record<string, unknown> = {
    ...moneyFields(trees, Number(deal.ratePerTreeKes)),
    countSource: 'manual',
    status: payable ? 'awaiting_payment' : 'awaiting_count',
    ...(submission?.status ? { submissionStatus: submission.status } : {}),
  }
  const unset: Record<string, 1> = {}
  if (!fundable.ok) set.countNote = fundable.reason
  else if (!payable)
    set.countNote = 'Payable once verifiers approve this planting'
  else unset.countNote = 1
  return transitionDeal(
    deal._id,
    allowed,
    set,
    {
      type: 'count_set_manually',
      by: buyerWallet,
      note: `Count set to ${trees} (was ${deal.trees})`,
    },
    unset,
  )
}

// ---------------------------------------------------------------- payments --

function sniffImage(buf: Buffer): { ext: string; contentType: string } | null {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return { ext: '.png', contentType: 'image/png' }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { ext: '.jpg', contentType: 'image/jpeg' }
  const head4 = buf.toString('ascii', 0, 4)
  if (head4 === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return { ext: '.webp', contentType: 'image/webp' }
  if (head4 === 'GIF8') return { ext: '.gif', contentType: 'image/gif' }
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase()
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand))
      return { ext: '.heic', contentType: 'image/heic' }
  }
  return null
}

export async function recordPayment(
  buyerWallet: string,
  dealId: string,
  input: {
    file: { buffer: Buffer; mimetype?: string; originalname?: string }
    mpesaRef: string
    amountKes?: number | null
    partial?: boolean
    note?: string
  },
): Promise<AnyDeal> {
  const buyer = normalizeWallet(buyerWallet)
  const deal = await loadDealForBuyer(buyer, dealId)
  if (!PAYMENT_UPLOAD_FROM.includes(deal.status as OtcDealStatus)) {
    throw new OtcError(
      'INVALID_TRANSITION',
      409,
      `This deal is ${String(deal.status).replace(/_/g, ' ')}`,
      { status: deal.status },
    )
  }
  const ref = normalizeMpesaRef(input.mpesaRef)
  if (!ref) {
    throw new OtcError(
      'INVALID_MPESA_REF',
      400,
      'Enter the 10-character M-Pesa transaction code',
    )
  }
  const amount =
    input.amountKes === undefined || input.amountKes === null
      ? Number(deal.amountKes)
      : Math.round(Number(input.amountKes))
  if (!Number.isFinite(amount) || amount < 0) {
    throw new OtcError('INVALID_AMOUNT', 400, 'Invalid amount')
  }
  const differs = amount !== Number(deal.amountKes)
  if (differs && input.partial !== true) {
    throw new OtcError(
      'PARTIAL_FLAG_REQUIRED',
      400,
      `The amount differs from the deal (${formatKes(deal.amountKes)}). Tick "partial payment" to continue.`,
      { amountKes: deal.amountKes },
    )
  }
  if (!input.file?.buffer?.length) {
    throw new OtcError('NO_FILE', 400, 'Attach the M-Pesa screenshot')
  }
  const sniffed = sniffImage(input.file.buffer)
  if (!sniffed) {
    throw new OtcError(
      'INVALID_IMAGE',
      400,
      'The screenshot must be a PNG, JPEG, WebP, HEIC or GIF image',
    )
  }

  const uploaded = await uploadToStorage(
    input.file.buffer,
    `${uuidv4()}${sniffed.ext}`,
    sniffed.contentType,
    'otc',
  )
  const previousPath: string | undefined = deal.payment?.screenshotPath
  const sentAt = new Date()
  const payment = {
    screenshotUrl: uploaded.publicUrl,
    screenshotPath: uploaded.videoCID,
    mimeType: sniffed.contentType,
    mpesaRef: ref,
    amountKes: amount,
    partial: differs,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    sentAt,
  }

  let updated: AnyDeal
  try {
    updated = await transitionDeal(
      deal._id,
      PAYMENT_UPLOAD_FROM,
      { status: 'payment_sent', payment },
      {
        type: 'payment_uploaded',
        by: buyer,
        note: `${formatKes(amount)}${differs ? ' (partial)' : ''} · ${ref}`,
      },
    )
  } catch (error) {
    void deleteFromStorage(uploaded.videoCID)
    throw error
  }
  if (previousPath && previousPath !== uploaded.videoCID) {
    void deleteFromStorage(previousPath)
  }

  void notify({
    recipientWalletAddress: updated.planterWallet,
    kind: 'otc_payment_sent',
    title: `${formatKes(amount)} sent to your M-Pesa`,
    body:
      `${buyerLabel()} says they sent ${formatKes(amount)}` +
      (differs
        ? ` (partial payment; deal is ${formatKes(deal.amountKes)})`
        : '') +
      ` (M-Pesa code ${ref}). Check your M-Pesa SMS and confirm in the app.`,
    link: dealLink(updated),
    payload: { dealId: String(updated._id), mpesaRef: ref, amountKes: amount },
  })
  return updated
}

export async function confirmDeal(
  planterWallet: string,
  dealId: string,
  mpesaRef?: string,
): Promise<AnyDeal> {
  const planter = normalizeWallet(planterWallet)
  const deal = await loadDealForPlanter(planter, dealId)
  if (deal.status === 'confirmed') {
    await reconcileDealAllocation(String(deal._id))
    return (await OtcDeal.findById(deal._id)) || deal
  }
  if (deal.status !== 'payment_sent') {
    throw new OtcError(
      'INVALID_TRANSITION',
      409,
      deal.status === 'cancelled'
        ? 'This deal was cancelled'
        : 'There is no payment to confirm yet',
      { status: deal.status },
    )
  }
  if (env.OTC_CONFIRM_REQUIRES_REF) {
    if (!mpesaRefMatches(mpesaRef, deal.payment?.mpesaRef)) {
      throw new OtcError(
        'MPESA_REF_MISMATCH',
        400,
        'The code does not match the payment. Check your M-Pesa SMS.',
      )
    }
  }
  const updated = await transitionDeal(
    deal._id,
    ['payment_sent'],
    { status: 'confirmed', confirmedAt: new Date() },
    {
      type: 'confirmed',
      by: planter,
      note: `${formatKes(paidKes(deal))} received`,
    },
  )
  await reconcileDealAllocation(String(updated._id))

  const hasAllocation = await RewardAllocation.exists({
    submissionId: updated.submissionId,
  })
  void notify({
    recipientWalletAddress: updated.buyerWallet,
    kind: 'otc_deal_confirmed',
    title: `${updated.mpesaName} confirmed ${formatKes(paidKes(updated))}`,
    body: hasAllocation
      ? `MGRO for ${updated.trees} trees is being released to your wallet.`
      : `MGRO for ${updated.trees} trees will be released once the planting is approved.`,
    link: dealLink(updated),
    payload: { dealId: String(updated._id) },
    telegram: true,
  })
  return (await OtcDeal.findById(updated._id)) || updated
}

export async function disputeDeal(
  planterWallet: string,
  dealId: string,
  input: { reasonCode: string; reason?: string },
): Promise<AnyDeal> {
  const planter = normalizeWallet(planterWallet)
  const deal = await loadDealForPlanter(planter, dealId)
  const text = String(input.reason || '').trim()
  const disputeReason = `${input.reasonCode}${text ? `: ${text}` : ''}`.slice(
    0,
    500,
  )
  const updated = await transitionDeal(
    deal._id,
    ['payment_sent'],
    { status: 'disputed', disputedAt: new Date(), disputeReason },
    { type: 'disputed', by: planter, note: disputeReason },
  )
  void notify({
    recipientWalletAddress: updated.buyerWallet,
    kind: 'otc_deal_disputed',
    title: `${updated.mpesaName} did not receive ${formatKes(paidKes(updated))}`,
    body: `Reason: ${disputeReason}. Re-upload proof, resolve with evidence, or cancel.`,
    link: dealLink(updated),
    payload: { dealId: String(updated._id), reasonCode: input.reasonCode },
    telegram: true,
  })
  return updated
}

async function cancelDealInternal(
  deal: AnyDeal,
  opts: { by: string; reason: string; planterBody?: string },
): Promise<AnyDeal> {
  const fromStatus = String(deal.status)
  const by = normalizeWallet(opts.by) || SYSTEM
  const updated = await transitionDeal(
    deal._id,
    // Exactly the status we saw, so a concurrent move is a clean 409.
    [fromStatus],
    {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelReason: opts.reason,
      cancelledBy: by,
      cancelledFromStatus: fromStatus,
    },
    { type: 'cancelled', by, note: opts.reason },
  )
  await reconcileDealAllocation(String(updated._id))

  const humanReason = opts.reason.replace(/_/g, ' ')
  void notify({
    recipientWalletAddress: updated.planterWallet,
    kind: 'otc_deal_cancelled',
    title: 'M-Pesa deal cancelled',
    body:
      (opts.planterBody || `${humanReason}.`) +
      ' Your MGRO for this planting will be paid to your wallet as usual.',
    link: `/submissions/${String(updated.submissionId)}`,
    payload: { dealId: String(updated._id), reason: opts.reason },
  })
  if (by === SYSTEM) {
    void notify({
      recipientWalletAddress: updated.buyerWallet,
      kind: 'otc_deal_cancelled',
      title: `Deal cancelled: ${humanReason}`,
      body: `${updated.mpesaName}, ${updated.trees} trees, ${formatKes(updated.amountKes)}.`,
      link: dealLink(updated),
      payload: { dealId: String(updated._id), reason: opts.reason },
      telegram: true,
    })
  }
  return (await OtcDeal.findById(updated._id)) || updated
}

export async function cancelDeal(
  buyerWallet: string,
  dealId: string,
  reason?: string,
  by: string = buyerWallet,
): Promise<AnyDeal> {
  const deal =
    normalizeWallet(by) === SYSTEM
      ? await loadDeal(dealId)
      : await loadDealForBuyer(buyerWallet, dealId)
  if (!CANCEL_FROM.includes(deal.status as OtcDealStatus)) {
    throw new OtcError(
      'INVALID_TRANSITION',
      409,
      deal.status === 'confirmed'
        ? 'A confirmed deal cannot be cancelled'
        : 'This deal is already cancelled',
      { status: deal.status },
    )
  }
  const text = String(reason || '').trim()
  if ((deal.status === 'payment_sent' || deal.status === 'disputed') && !text) {
    throw new OtcError(
      'REASON_REQUIRED',
      400,
      'A reason is required when proof of payment was already uploaded',
    )
  }
  return cancelDealInternal(deal, {
    by,
    reason: text || 'cancelled_by_buyer',
  })
}

/** D8: the buyer settles a dispute, with written evidence on the record. */
export async function resolveDeal(
  buyerWallet: string,
  dealId: string,
  input: {
    outcome: 'release_to_buyer' | 'return_to_planter'
    evidence: string
  },
): Promise<AnyDeal> {
  const buyer = normalizeWallet(buyerWallet)
  const deal = await loadDealForBuyer(buyer, dealId)
  if (deal.status !== 'disputed') {
    throw new OtcError(
      'INVALID_TRANSITION',
      409,
      'Only a disputed deal can be resolved',
      { status: deal.status },
    )
  }
  const evidence = String(input.evidence || '')
    .trim()
    .slice(0, 1000)
  if (evidence.length < 5) {
    throw new OtcError('EVIDENCE_REQUIRED', 400, 'Describe your evidence')
  }
  const now = new Date()
  const resolution = { outcome: input.outcome, evidence, by: buyer, at: now }

  if (input.outcome === 'release_to_buyer') {
    const updated = await transitionDeal(
      deal._id,
      ['disputed'],
      { status: 'confirmed', confirmedAt: now, resolution },
      { type: 'resolved_release_to_buyer', by: buyer, note: evidence },
    )
    await reconcileDealAllocation(String(updated._id))
    void notify({
      recipientWalletAddress: updated.planterWallet,
      kind: 'otc_deal_resolved',
      title: 'M-Pesa dispute resolved',
      body: 'The buyer provided evidence of payment; the MGRO for this planting goes to the buyer. Contact support if you disagree.',
      link: dealLink(updated),
      payload: { dealId: String(updated._id), outcome: input.outcome },
    })
    return (await OtcDeal.findById(updated._id)) || updated
  }

  const updated = await transitionDeal(
    deal._id,
    ['disputed'],
    {
      status: 'cancelled',
      cancelledAt: now,
      cancelReason: evidence,
      cancelledBy: buyer,
      cancelledFromStatus: 'disputed',
      resolution,
    },
    { type: 'resolved_return_to_planter', by: buyer, note: evidence },
  )
  await reconcileDealAllocation(String(updated._id))
  void notify({
    recipientWalletAddress: updated.planterWallet,
    kind: 'otc_deal_cancelled',
    title: 'M-Pesa deal cancelled',
    body: 'The buyer withdrew the payment claim. Your MGRO for this planting will be paid to your wallet as usual.',
    link: `/submissions/${String(updated.submissionId)}`,
    payload: { dealId: String(updated._id), outcome: input.outcome },
  })
  return (await OtcDeal.findById(updated._id)) || updated
}

// ------------------------------------------------------------- reconcile ---

/**
 * Make the allocation agree with the deal. Idempotent and never throws:
 * runs after every transition, after allocation creation, on reads and in
 * the 5-minute sweep (D6).
 */
export async function reconcileDealAllocation(
  dealId: mongoose.Types.ObjectId | string,
): Promise<void> {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(dealId))) return
    const deal = await OtcDeal.findById(dealId)
    if (!deal) return
    const sid = deal.submissionId
    const now = new Date()
    const set: Record<string, unknown> = {}
    const events: Array<Record<string, unknown>> = []
    const hasEvent = (type: string) =>
      (deal.events || []).some((e: any) => e.type === type)

    const submission = await Submission.findById(sid).select('status').lean()
    if (submission && submission.status !== deal.submissionStatus) {
      set.submissionStatus = submission.status
    }

    let alloc = await RewardAllocation.findOne({ submissionId: sid })
    if (alloc) {
      if (!alloc.otc && deal.status !== 'cancelled') {
        const held = await rewardService.holdAllocationForDeal(
          sid,
          deal._id,
          deal.planterWallet,
        )
        if (!held.held) {
          if (deal.release?.status !== 'n/a') set['release.status'] = 'n/a'
          if (!hasEvent('allocation_already_paid')) {
            events.push({
              type: 'allocation_already_paid',
              by: SYSTEM,
              at: now,
              note: 'Planter MGRO was already minted or proposed; nothing to hold',
            })
          }
          alloc = null
        } else {
          alloc = await RewardAllocation.findOne({ submissionId: sid })
        }
      }
    }

    if (alloc?.otc && String(alloc.otc.dealId) !== String(deal._id)) {
      console.warn('[OTC] allocation bound to another deal', {
        dealId: String(deal._id),
        boundTo: String(alloc.otc.dealId),
      })
      alloc = null
    }

    if (alloc) {
      const buyer = normalizeWallet(deal.buyerWallet)
      if (deal.status === 'confirmed') {
        const r = await rewardService.releaseAllocationToBuyer(
          sid,
          deal._id,
          buyer,
        )
        if (r.released) {
          set['release.status'] = 'released'
          set['release.allocationId'] = alloc._id
          set['release.releasedAt'] = now
          if (r.claimJobId) set['release.claimJobId'] = r.claimJobId
          events.push({
            type: 'mgro_released',
            by: SYSTEM,
            at: now,
            note: `Planter share reassigned to the buyer${r.claimJobId ? '; claim queued' : ''}`,
          })
        } else {
          const fresh = await RewardAllocation.findOne({ submissionId: sid })
            .select('planterWallet otc')
            .lean()
          if (
            fresh &&
            normalizeWallet(fresh.planterWallet) === buyer &&
            !fresh.otc?.hold &&
            deal.release?.status !== 'released'
          ) {
            set['release.status'] = 'released'
            set['release.allocationId'] = fresh._id
            set['release.releasedAt'] = fresh.otc?.releasedToBuyerAt || now
          }
        }
      } else if (deal.status === 'cancelled') {
        const r = await rewardService.returnAllocationToPlanter(sid, deal._id)
        const alreadyFree = Boolean(alloc.otc && !alloc.otc.hold)
        if (
          (r.returned || alreadyFree) &&
          deal.release?.status !== 'returned' &&
          deal.release?.status !== 'released'
        ) {
          set['release.status'] = 'returned'
          set['release.allocationId'] = alloc._id
          set['release.returnedAt'] = now
          if (r.claimJobId) set['release.claimJobId'] = r.claimJobId
          events.push({
            type: 'mgro_returned',
            by: SYSTEM,
            at: now,
            note: `Hold lifted; MGRO stays with the planter${r.claimJobId ? '; claim queued' : ''}`,
          })
        }
      } else if (
        alloc.otc?.hold &&
        deal.release?.status !== 'held' &&
        deal.release?.status !== 'unfundable'
      ) {
        set['release.status'] = 'held'
        set['release.allocationId'] = alloc._id
      }
    }

    if (Object.keys(set).length === 0 && events.length === 0) return
    const update: Record<string, unknown> = {}
    if (Object.keys(set).length) update.$set = set
    if (events.length) update.$push = { events: { $each: events } }
    await OtcDeal.updateOne({ _id: deal._id }, update)
  } catch (error: any) {
    console.error('[OTC] reconcile failed', {
      dealId: String(dealId),
      message: error?.message || String(error),
    })
  }
}

let sweeping = false

async function sweepOtc(): Promise<void> {
  const now = new Date()
  // (a) terminal deals whose allocation did not follow yet.
  const lookback = new Date(
    now.getTime() - EXPIRY_SWEEP_LOOKBACK_DAYS * 86400_000,
  )
  const stale = await OtcDeal.find({
    status: { $in: ['confirmed', 'cancelled'] },
    'release.status': { $in: ['held', 'n/a'] },
    updatedAt: { $gte: lookback },
  })
    .select('_id')
    .limit(200)
    .lean()
  for (const d of stale) await reconcileDealAllocation(String(d._id))

  // (b) unpaid deals past expiry.
  const expiryCutoff = new Date(
    now.getTime() - env.OTC_DEAL_EXPIRY_DAYS * 86400_000,
  )
  const expired = await OtcDeal.find({
    status: { $in: ['awaiting_count', 'awaiting_payment'] },
    createdAt: { $lt: expiryCutoff },
  }).limit(200)
  for (const deal of expired) {
    try {
      await cancelDealInternal(deal, {
        by: SYSTEM,
        reason: 'expired',
        planterBody: `${buyerLabel()} did not pay within ${env.OTC_DEAL_EXPIRY_DAYS} days.`,
      })
    } catch (error: any) {
      if (!(error instanceof OtcError && error.code === 'INVALID_TRANSITION')) {
        console.error('[OTC] expire failed', {
          dealId: String(deal._id),
          message: error?.message || String(error),
        })
      }
    }
  }

  // (c) open (or paid-but-unapproved) deals whose submission was rejected.
  const candidates = await OtcDeal.find({
    $or: [
      { status: { $in: OPEN_STATUSES } },
      { status: 'confirmed', 'release.status': { $in: ['n/a', 'held'] } },
    ],
  })
    .select('submissionId')
    .limit(500)
    .lean()
  if (candidates.length) {
    const rejected = await Submission.find({
      _id: { $in: candidates.map(c => c.submissionId) },
      status: 'rejected',
    })
      .select('_id status')
      .lean()
    for (const sub of rejected) {
      await onSubmissionRejected(sub).catch((error: any) =>
        console.error('[OTC] rejected sweep failed', {
          submissionId: String(sub._id),
          message: error?.message || String(error),
        }),
      )
    }
  }

  // (d) nudge planters who have not confirmed after two hours.
  const remindBefore = new Date(now.getTime() - REMINDER_AFTER_MS)
  const toRemind = await OtcDeal.find({
    status: 'payment_sent',
    'payment.sentAt': { $lt: remindBefore },
    reminderSentAt: { $exists: false },
  })
    .limit(200)
    .lean()
  for (const deal of toRemind) {
    const marked = await OtcDeal.updateOne(
      { _id: deal._id, reminderSentAt: { $exists: false } },
      { $set: { reminderSentAt: now } },
    )
    if (marked.modifiedCount === 0) continue
    void notify({
      recipientWalletAddress: deal.planterWallet,
      kind: 'otc_payment_reminder',
      title: `Did ${formatKes(paidKes(deal))} arrive?`,
      body: 'Open the deal to confirm with the M-Pesa code.',
      link: dealLink(deal),
      payload: { dealId: String(deal._id) },
    })
  }
}

/** Five-minute sweep (D6). API process only; see ENABLE_OTC_RECONCILER. */
export function startOtcReconciler(
  intervalMs = RECONCILER_INTERVAL_MS,
): NodeJS.Timeout {
  const run = () => {
    if (sweeping) return
    sweeping = true
    void sweepOtc()
      .catch((error: any) =>
        console.error('[OTC] sweep failed', error?.message || String(error)),
      )
      .finally(() => {
        sweeping = false
      })
  }
  const timer = setInterval(run, intervalMs)
  timer.unref()
  // One early pass so a redeploy does not leave a confirmed deal held for 5 minutes.
  const first = setTimeout(run, 30_000)
  first.unref()
  return timer
}

// ------------------------------------------------------------------ reads ---

type DealFilters = {
  status?: string
  q?: string
  from?: string | Date
  to?: string | Date
  page?: number
  limit?: number
}

function buildDealQuery(
  buyer: string,
  f: DealFilters,
): Record<string, unknown> {
  const query: Record<string, unknown> = { buyerWallet: buyer }
  if (f.status) {
    const statuses = String(f.status)
      .split(',')
      .map(s => s.trim())
      .filter(s => (OTC_DEAL_STATUSES as readonly string[]).includes(s))
    if (statuses.length) query.status = { $in: statuses }
  }
  const q = String(f.q || '').trim()
  if (q) {
    if (/^[a-fA-F0-9]{24}$/.test(q)) {
      query.submissionId = new mongoose.Types.ObjectId(q)
    } else {
      const rx = new RegExp(escapeRegex(q), 'i')
      query.$or = [
        { mpesaName: rx },
        { mpesaNumber: rx },
        { 'payment.mpesaRef': rx },
      ]
    }
  }
  const created: Record<string, Date> = {}
  if (f.from) {
    const d = new Date(f.from)
    if (!Number.isNaN(d.getTime())) created.$gte = d
  }
  if (f.to) {
    const d = new Date(f.to)
    if (!Number.isNaN(d.getTime())) created.$lte = d
  }
  if (Object.keys(created).length) query.createdAt = created
  return query
}

/** Batch-hydrate deals into the detail shape the web app renders. */
async function hydrateDeals(deals: AnyDeal[]): Promise<any[]> {
  if (deals.length === 0) return []
  const plain = deals.map(d =>
    typeof d.toObject === 'function' ? d.toObject() : { ...d },
  )
  const sids = plain.map(d => d.submissionId)
  const planters = [
    ...new Set(plain.map(d => normalizeWallet(d.planterWallet))),
  ]
  const enrollmentIds = plain.map(d => d.enrollmentId).filter(Boolean)
  const [submissions, users, enrollments, allocations] = await Promise.all([
    Submission.find({ _id: { $in: sids } })
      .select(
        'status treesPlanted treeType reviewedAt aiVerification.status aiVerification.countedMangroves aiVerification.confidence aiVerification.decision aiVerification.error aiVerification.skipReason plant.publicUrl plant.rawPublicUrl plant.reverseGeocode plant.gpsCoordinates plant.uploadedAt',
      )
      .lean(),
    User.find({ walletAddress: { $in: planters } })
      .select('walletAddress name')
      .lean(),
    OtcEnrollment.find({
      $or: [
        { _id: { $in: enrollmentIds } },
        { planterWallet: { $in: planters } },
      ],
    }).lean(),
    RewardAllocation.find({ submissionId: { $in: sids } })
      .select(
        'submissionId planterWallet planterCumulativePaidWei planterTotalWei otc tranches.index tranches.status tranches.txHash tranches.amountWei tranches.unlockAt',
      )
      .lean(),
  ])
  const inviteIds = enrollments.map(e => e.inviteId).filter(Boolean)
  const invites = inviteIds.length
    ? await OtcInvite.find({ _id: { $in: inviteIds } })
        .select('label')
        .lean()
    : []
  const subById = new Map(submissions.map(s => [String(s._id), s]))
  const userByWallet = new Map(
    users.map(u => [normalizeWallet(u.walletAddress), u]),
  )
  const enrollmentByPlanter = new Map(
    enrollments.map(e => [normalizeWallet(e.planterWallet), e]),
  )
  const inviteLabel = new Map(invites.map(i => [String(i._id), i.label || '']))
  const allocBySid = new Map(allocations.map(a => [String(a.submissionId), a]))

  return plain.map(d => {
    const sub: any = subById.get(String(d.submissionId))
    const planter = normalizeWallet(d.planterWallet)
    const user = userByWallet.get(planter)
    const enrollment: any = enrollmentByPlanter.get(planter)
    const alloc: any = allocBySid.get(String(d.submissionId))
    const label =
      (enrollment?.inviteId && inviteLabel.get(String(enrollment.inviteId))) ||
      'TreeGens buyer'
    return {
      ...d,
      paidKes: paidKes(d),
      submission: sub
        ? {
            _id: sub._id,
            status: sub.status,
            treesPlanted: sub.treesPlanted,
            treeType: sub.treeType,
            reviewedAt: sub.reviewedAt,
            aiVerification: sub.aiVerification
              ? {
                  status: sub.aiVerification.status,
                  countedMangroves: sub.aiVerification.countedMangroves,
                  confidence: sub.aiVerification.confidence,
                  decision: sub.aiVerification.decision,
                  error: sub.aiVerification.error,
                  skipReason: sub.aiVerification.skipReason,
                }
              : undefined,
            plant: sub.plant
              ? {
                  publicUrl: sub.plant.publicUrl,
                  rawPublicUrl: sub.plant.rawPublicUrl,
                  reverseGeocode: sub.plant.reverseGeocode,
                  gpsCoordinates: sub.plant.gpsCoordinates,
                  uploadedAt: sub.plant.uploadedAt,
                }
              : undefined,
          }
        : null,
      planter: { walletAddress: planter, name: user?.name || '' },
      enrollment: enrollment
        ? {
            mpesaNumber: enrollment.mpesaNumber,
            mpesaName: enrollment.mpesaName,
            ratePerTreeKes: enrollment.ratePerTreeKes,
            status: enrollment.status,
          }
        : null,
      buyer: { walletAddress: normalizeWallet(d.buyerWallet), label },
      buyerLabel: buyerLabel(),
      allocation: alloc
        ? {
            exists: true,
            hold: Boolean(alloc.otc?.hold),
            planterWallet: alloc.planterWallet,
            planterCumulativePaidWei: alloc.planterCumulativePaidWei,
            planterTotalWei: alloc.planterTotalWei,
            tranches: (alloc.tranches || []).map((t: any) => ({
              index: t.index,
              status: t.status,
              txHash: t.txHash,
              amountWei: t.amountWei,
              unlockAt: t.unlockAt,
            })),
          }
        : { exists: false, hold: false },
      releaseMode: env.OTC_RELEASE_MODE,
      confirmRequiresRef: env.OTC_CONFIRM_REQUIRES_REF,
    }
  })
}

export async function toDealDetail(deal: AnyDeal) {
  const [detail] = await hydrateDeals([deal])
  return detail
}

export async function listDeals(buyerWallet: string, filters: DealFilters) {
  const buyer = normalizeWallet(buyerWallet)
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))
  const query = buildDealQuery(buyer, filters)
  const [rows, total] = await Promise.all([
    OtcDeal.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    OtcDeal.countDocuments(query),
  ])
  return { items: await hydrateDeals(rows), total, page, limit }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = value instanceof Date ? value.toISOString() : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function exportDealsCsv(
  buyerWallet: string,
  filters: DealFilters,
): Promise<string> {
  const rows = await OtcDeal.find(
    buildDealQuery(normalizeWallet(buyerWallet), filters),
  )
    .sort({ createdAt: -1 })
    .limit(5000)
    .lean()
  const header = [
    'createdAt',
    'status',
    'mpesaName',
    'mpesaNumber',
    'trees',
    'countSource',
    'verified',
    'amountKes',
    'paidKes',
    'mpesaRef',
    'paymentSentAt',
    'confirmedAt',
    'submissionId',
    'submissionStatus',
    'releaseStatus',
    'expectedMgroWei',
  ]
  const lines = [header.join(',')]
  for (const d of rows as any[]) {
    lines.push(
      [
        d.createdAt,
        d.status,
        d.mpesaName,
        d.mpesaNumber,
        d.trees,
        d.countSource,
        d.verified ? 'true' : 'false',
        d.amountKes,
        d.payment?.sentAt ? paidKes(d) : '',
        d.payment?.mpesaRef,
        d.payment?.sentAt,
        d.confirmedAt,
        String(d.submissionId),
        d.submissionStatus,
        d.release?.status,
        d.expectedMgroWei,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Desk picker: the planter's mangrove plantings that could become deals. */
export async function listEligibleSubmissionsForPlanter(
  buyerWallet: string,
  planterWallet: string,
) {
  const buyer = normalizeWallet(buyerWallet)
  const planter = normalizeWallet(planterWallet)
  const enrollment = await OtcEnrollment.exists({
    planterWallet: planter,
    buyerWallet: buyer,
  })
  if (!enrollment) {
    throw new OtcError(
      'NOT_ENROLLED',
      404,
      'This planter is not enrolled with you',
    )
  }
  const submissions = await Submission.find({
    userWalletAddress: planter,
    treeType: MANGROVE,
    'plant.uploaded': true,
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .select(
      'status treesPlanted treeType aiVerification.countedMangroves aiVerification.status plant.uploadedAt plant.reverseGeocode createdAt',
    )
    .lean()
  const sids = submissions.map(s => s._id)
  const [deals, allocations] = await Promise.all([
    OtcDeal.find({ submissionId: { $in: sids } })
      .select('submissionId status')
      .lean(),
    RewardAllocation.find({ submissionId: { $in: sids } })
      .select(
        'submissionId planterCumulativePaidWei otc tranches.status tranches.proposalId',
      )
      .lean(),
  ])
  const dealBySid = new Map(deals.map(d => [String(d.submissionId), d]))
  const allocBySid = new Map(allocations.map(a => [String(a.submissionId), a]))

  const items = submissions.map((s: any) => {
    const deal = dealBySid.get(String(s._id))
    const alloc: any = allocBySid.get(String(s._id))
    const paidOut =
      alloc &&
      (BigInt(String(alloc.planterCumulativePaidWei || '0')) > 0n ||
        (alloc.tranches || []).some(
          (t: any) =>
            t.status === 'paid' ||
            t.status === 'processing' ||
            t.proposalId !== undefined,
        ))
    let ineligibleReason: string | null = null
    if (deal) ineligibleReason = 'deal_exists'
    else if (s.status === 'rejected') ineligibleReason = 'rejected'
    else if (s.status !== 'pending_review' && s.status !== 'approved')
      ineligibleReason = 'not_reviewable'
    else if (paidOut) ineligibleReason = 'planter_already_paid'
    else if (alloc?.otc) ineligibleReason = 'bound_to_other_deal'
    const aiCount = dealTreeCountFromAi(s)
    return {
      submissionId: String(s._id),
      status: s.status,
      treesPlanted: s.treesPlanted,
      aiCount,
      treeType: s.treeType,
      uploadedAt: s.plant?.uploadedAt || s.createdAt,
      location: s.plant?.reverseGeocode || '',
      hasDeal: Boolean(deal),
      dealId: deal ? String(deal._id) : undefined,
      dealStatus: deal?.status,
      eligible: ineligibleReason === null,
      ineligibleReason,
    }
  })
  return { items }
}

export async function listPlanterDeals(planterWallet: string) {
  return OtcDeal.find({ planterWallet: normalizeWallet(planterWallet) })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean()
}

function assertParty(deal: AnyDeal, callerWallet: string) {
  const w = normalizeWallet(callerWallet)
  if (
    normalizeWallet(deal.buyerWallet) !== w &&
    normalizeWallet(deal.planterWallet) !== w
  ) {
    throw new OtcError('FORBIDDEN', 403, 'You are not part of this deal')
  }
}

export async function getDeal(dealId: string, callerWallet: string) {
  const deal = await loadDeal(dealId)
  assertParty(deal, callerWallet)
  await reconcileDealAllocation(String(deal._id))
  const fresh = (await OtcDeal.findById(deal._id).lean()) || deal
  return toDealDetail(fresh)
}

export async function getDealBySubmission(
  submissionId: string,
  callerWallet: string,
) {
  const deal = await OtcDeal.findOne({
    submissionId: oid(submissionId, 'submissionId'),
  })
  if (!deal)
    throw new OtcError('DEAL_NOT_FOUND', 404, 'No deal for this planting')
  assertParty(deal, callerWallet)
  await reconcileDealAllocation(String(deal._id))
  const fresh = (await OtcDeal.findById(deal._id).lean()) || deal
  return toDealDetail(fresh)
}

/** GET /api/otc/me */
export async function getMe(wallet: string) {
  const w = normalizeWallet(wallet)
  const enrollment = await getMyEnrollment(w)
  const [deals, label] = await Promise.all([
    listPlanterDeals(w),
    buyerLabelForEnrollment(enrollment),
  ])
  return {
    isBuyer: isBuyerActive(w),
    enrollment,
    buyer: enrollment
      ? {
          walletAddress: enrollment.buyerWallet,
          label,
          displayName: buyerLabel(),
        }
      : null,
    deals,
    releaseMode: env.OTC_RELEASE_MODE,
    confirmRequiresRef: env.OTC_CONFIRM_REQUIRES_REF,
  }
}

export async function summary(buyerWallet: string) {
  const buyer = normalizeWallet(buyerWallet)
  const [byStatus, sent, released, unfundable, enrollmentCount] =
    await Promise.all([
      OtcDeal.aggregate<{
        _id: string
        n: number
        amountKes: number
        paidKes: number
        trees: number
        expected: string[]
      }>([
        { $match: { buyerWallet: buyer } },
        {
          $group: {
            _id: '$status',
            n: { $sum: 1 },
            amountKes: { $sum: '$amountKes' },
            paidKes: {
              $sum: { $ifNull: ['$payment.amountKes', '$amountKes'] },
            },
            trees: { $sum: '$trees' },
            expected: { $push: '$expectedMgroWei' },
          },
        },
      ]),
      OtcDeal.aggregate<{ _id: null; kes: number }>([
        { $match: { buyerWallet: buyer, 'payment.sentAt': { $exists: true } } },
        { $group: { _id: null, kes: { $sum: '$payment.amountKes' } } },
      ]),
      OtcDeal.countDocuments({
        buyerWallet: buyer,
        'release.status': 'released',
      }),
      OtcDeal.countDocuments({
        buyerWallet: buyer,
        'release.status': 'unfundable',
      }),
      OtcEnrollment.countDocuments({ buyerWallet: buyer }),
    ])
  const counts: Record<string, number> = {}
  for (const s of OTC_DEAL_STATUSES) counts[s] = 0
  let kesToPay = 0
  let kesAwaitingConfirmation = 0
  let kesConfirmed = 0
  let treesConfirmed = 0
  let expectedMgroWeiConfirmed = 0n
  for (const row of byStatus) {
    counts[row._id] = row.n
    if (row._id === 'awaiting_payment') kesToPay = row.amountKes
    if (row._id === 'payment_sent') kesAwaitingConfirmation = row.paidKes
    if (row._id === 'confirmed') {
      kesConfirmed = row.paidKes
      treesConfirmed = row.trees
      for (const w of row.expected || []) {
        if (/^\d+$/.test(String(w))) expectedMgroWeiConfirmed += BigInt(w)
      }
    }
  }
  return {
    counts,
    kesToPay,
    kesAwaitingConfirmation,
    kesConfirmed,
    kesSent: sent[0]?.kes || 0,
    treesConfirmed,
    expectedMgroWeiConfirmed: expectedMgroWeiConfirmed.toString(),
    releasedCount: released,
    unfundableCount: unfundable,
    enrollmentCount,
    defaults: { ratePerTreeKes: env.OTC_DEFAULT_RATE_KES || null },
    telegram: telegramConfigured(),
    releaseMode: env.OTC_RELEASE_MODE,
    payOn: env.OTC_PAY_ON,
    confirmRequiresRef: env.OTC_CONFIRM_REQUIRES_REF,
    buyerLabel: buyerLabel(),
  }
}
