import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import OtcDeal from '../models/OtcDeal'
import OtcEnrollment from '../models/OtcEnrollment'
import OtcInvite from '../models/OtcInvite'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import User from '../models/User'
import {
  computeDealAmountKes,
  expectedPlanterMgroWei,
  generateInviteCode,
} from './otcDealRules'
import { OtcNotificationInput } from './otcNotifications'
import {
  __setNotifierForTests,
  confirmDeal,
  ensureDealForSubmission,
  joinWithInvite,
  onSubmissionRejected,
  OtcError,
} from './otcService'
import { RewardService } from './rewardService'

/**
 * OTC desk service (spec section 5 / 12). No MongoDB: model statics and
 * RewardService.prototype are monkeypatched and restored after each test;
 * the notifier is swapped so nothing reaches the inbox or Telegram.
 */

const PLANTER = `0x${'a'.repeat(40)}`
const BUYER = `0x${'b'.repeat(40)}`
const OTHER_BUYER = `0x${'c'.repeat(40)}`
const PHONE = '+254712345678'
const REF = 'QHX7K2M9PL'

const restores: Array<() => void> = []
function stub(target: any, key: string, impl: any) {
  const original = target[key]
  target[key] = impl
  restores.push(() => {
    target[key] = original
  })
}

const ENV_KEYS = [
  'OTC_BUYER_WALLETS',
  'OTC_PAY_ON',
  'OTC_CONFIRM_REQUIRES_REF',
  'ENFORCE_TREE_BATCHES',
  'OTC_RELEASE_MODE',
] as const
const envSnapshot: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) envSnapshot[k] = process.env[k]

let sent: OtcNotificationInput[] = []

beforeEach(() => {
  sent = []
  __setNotifierForTests(async input => {
    sent.push(input)
  })
  process.env.OTC_BUYER_WALLETS = BUYER
  delete process.env.OTC_PAY_ON
  delete process.env.OTC_CONFIRM_REQUIRES_REF
  delete process.env.ENFORCE_TREE_BATCHES
  // Any untouched model static must fail loudly instead of buffering on a
  // connection that never comes.
  for (const key of [
    'holdAllocationForDeal',
    'releaseAllocationToBuyer',
    'returnAllocationToPlanter',
  ]) {
    stub(RewardService.prototype, key, async () => {
      throw new Error(`${key} not stubbed`)
    })
  }
})

afterEach(() => {
  while (restores.length) {
    const r = restores.pop()
    if (r) r()
  }
  __setNotifierForTests(null)
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k]
    else process.env[k] = envSnapshot[k]
  }
})

/** A thenable that also supports the usual query chain (select/sort/lean). */
function chain<T>(value: T) {
  const c: any = {
    select: () => c,
    sort: () => c,
    limit: () => c,
    skip: () => c,
    lean: () => c,
    then: (res: any, rej: any) => Promise.resolve(value).then(res, rej),
    catch: (rej: any) => Promise.resolve(value).catch(rej),
  }
  return c
}

/** Applies a Mongo-style update ($set with dotted paths, $unset, $push) in memory. */
function applyUpdate(doc: any, update: any) {
  for (const [path, value] of Object.entries(update?.$set || {})) {
    const parts = path.split('.')
    let o = doc
    for (let i = 0; i < parts.length - 1; i++) {
      o[parts[i]] = o[parts[i]] ?? {}
      o = o[parts[i]]
    }
    o[parts[parts.length - 1]] = value
  }
  for (const path of Object.keys(update?.$unset || {})) {
    const parts = path.split('.')
    let o = doc
    for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]]
    if (o) delete o[parts[parts.length - 1]]
  }
  const pushed = update?.$push?.events
  if (pushed) {
    doc.events = doc.events || []
    if (pushed.$each) doc.events.push(...pushed.$each)
    else doc.events.push(pushed)
  }
  return doc
}

type DealStore = {
  doc: any
  transitions: Array<{ filter: any; update: any }>
  updates: Array<{ filter: any; update: any }>
}

/** In-memory OtcDeal: findById/findOne/findOneAndUpdate/updateOne over one deal. */
function useDealStore(initial: any): DealStore {
  const store: DealStore = { doc: initial, transitions: [], updates: [] }
  stub(OtcDeal, 'findById', () => chain(store.doc))
  stub(OtcDeal, 'findOne', () => chain(store.doc))
  stub(OtcDeal, 'findOneAndUpdate', (filter: any, update: any) => {
    store.transitions.push({ filter, update })
    const allowed =
      filter.status?.$in ?? (filter.status ? [filter.status] : null)
    if (allowed && !allowed.includes(store.doc.status)) return chain(null)
    const rel = filter['release.status']?.$in
    if (rel && !rel.includes(store.doc.release?.status)) return chain(null)
    applyUpdate(store.doc, update)
    return chain(store.doc)
  })
  stub(OtcDeal, 'updateOne', async (filter: any, update: any) => {
    store.updates.push({ filter, update })
    applyUpdate(store.doc, update)
    return { matchedCount: 1, modifiedCount: 1 }
  })
  return store
}

function makeSubmission(over: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    userWalletAddress: PLANTER.toUpperCase().replace('0X', '0x'),
    treeType: 'mangrove',
    status: 'pending_review',
    treesPlanted: 200,
    plant: { uploaded: true },
    aiVerification: {
      status: 'completed',
      countedMangroves: 200,
      confidence: 0.91,
      decision: 'pending_verifier',
    },
    ...over,
  } as any
}

function makeEnrollment(over: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    planterWallet: PLANTER,
    buyerWallet: BUYER,
    mpesaNumber: PHONE,
    mpesaName: 'Jane Doe',
    ratePerTreeKes: 10,
    status: 'active',
    ...over,
  } as any
}

function makeDeal(over: Record<string, unknown> = {}) {
  const dealId = new mongoose.Types.ObjectId()
  return {
    _id: dealId,
    submissionId: new mongoose.Types.ObjectId(),
    planterWallet: PLANTER,
    buyerWallet: BUYER,
    mpesaNumber: PHONE,
    mpesaName: 'Jane Doe',
    trees: 200,
    countSource: 'ai',
    verified: false,
    submissionStatus: 'pending_review',
    ratePerTreeKes: 10,
    amountKes: 2000,
    expectedMgroWei: expectedPlanterMgroWei(200),
    status: 'awaiting_payment',
    release: { status: 'n/a' },
    events: [{ type: 'created', by: 'system', at: new Date() }],
    ...over,
  } as any
}

async function rejectsOtc(
  fn: () => Promise<unknown>,
  code: string,
  status: number,
) {
  await assert.rejects(fn, (e: any) => {
    assert.ok(e instanceof OtcError, `expected OtcError, got ${e?.message}`)
    assert.equal(e.code, code)
    assert.equal(e.status, status)
    return true
  })
}

// --------------------------------------------------- ensureDealForSubmission

function setupEnsure(enrollment: any) {
  const created: any[] = []
  stub(OtcEnrollment, 'findOne', () => chain(enrollment))
  stub(OtcDeal, 'findOne', () => chain(null))
  stub(OtcDeal, 'create', async (doc: any) => {
    created.push(doc)
    return { ...doc }
  })
  return created
}

test('ensureDealForSubmission: AI completed + fundable -> awaiting_payment', async () => {
  const created = setupEnsure(makeEnrollment())
  const submission = makeSubmission()

  const result = await ensureDealForSubmission(submission)

  assert.ok(result)
  assert.equal(result.created, true)
  assert.equal(created.length, 1)
  const deal = created[0]
  assert.equal(deal.status, 'awaiting_payment')
  assert.equal(deal.trees, 200)
  assert.equal(deal.countSource, 'ai')
  assert.equal(deal.amountKes, computeDealAmountKes(200, 10))
  assert.equal(deal.expectedMgroWei, expectedPlanterMgroWei(200))
  assert.equal(deal.verified, false) // pending_verifier
  assert.equal(deal.countNote, undefined)
  assert.equal(deal.planterWallet, PLANTER) // lowercased
  assert.equal(deal.buyerWallet, BUYER)
  assert.equal(deal.mpesaNumber, PHONE)
  assert.equal(deal.mpesaName, 'Jane Doe')
  assert.equal(deal.ratePerTreeKes, 10)
  assert.equal(deal.submissionStatus, 'pending_review')
  assert.deepEqual(deal.release, { status: 'n/a' })
  assert.equal(deal.events[0].type, 'created')
  assert.equal(deal.events[0].by, 'system')
  assert.equal(String(deal.submissionId), String(submission._id))
  // DB only: no notifications from the upload path.
  assert.equal(sent.length, 0)
})

test('ensureDealForSubmission: auto-approved count marks the deal verified', async () => {
  const created = setupEnsure(makeEnrollment())
  const submission = makeSubmission({
    aiVerification: {
      status: 'completed',
      countedMangroves: 300,
      confidence: 0.97,
      decision: 'auto_approved',
    },
  })

  await ensureDealForSubmission(submission)

  assert.equal(created[0].verified, true)
  assert.equal(created[0].trees, 300)
  assert.equal(created[0].status, 'awaiting_payment')
})

test('ensureDealForSubmission: AI count 143 -> awaiting_count with the batch reason', async () => {
  const created = setupEnsure(makeEnrollment())
  const submission = makeSubmission({
    aiVerification: {
      status: 'completed',
      countedMangroves: 143,
      confidence: 0.95,
      decision: 'pending_verifier',
    },
  })

  const result = await ensureDealForSubmission(submission)

  assert.equal(result?.created, true)
  const deal = created[0]
  assert.equal(deal.status, 'awaiting_count')
  assert.equal(deal.trees, 143)
  assert.equal(deal.countSource, 'ai')
  assert.match(deal.countNote, /143 trees/)
  assert.match(deal.countNote, /100/)
  assert.equal(deal.amountKes, computeDealAmountKes(143, 10))
  assert.equal(deal.events[0].note, deal.countNote)
})

test('ensureDealForSubmission: batch gate off -> 143 is payable', async () => {
  process.env.ENFORCE_TREE_BATCHES = 'false'
  const created = setupEnsure(makeEnrollment())
  await ensureDealForSubmission(
    makeSubmission({
      aiVerification: { status: 'completed', countedMangroves: 143 },
    }),
  )
  assert.equal(created[0].status, 'awaiting_payment')
  assert.equal(created[0].countNote, undefined)
})

test('ensureDealForSubmission: AI failed -> awaiting_count with zero trees', async () => {
  const created = setupEnsure(makeEnrollment())
  const submission = makeSubmission({
    aiVerification: {
      status: 'failed',
      error: 'timeout',
      decision: 'ai_failed',
    },
  })

  await ensureDealForSubmission(submission)

  const deal = created[0]
  assert.equal(deal.status, 'awaiting_count')
  assert.equal(deal.trees, 0)
  assert.equal(deal.countSource, 'none')
  assert.equal(deal.amountKes, 0)
  assert.equal(deal.expectedMgroWei, '0')
  assert.match(deal.countNote, /AI could not count this clip \(timeout\)/)
})

test('ensureDealForSubmission: not enrolled -> null, nothing created', async () => {
  const created = setupEnsure(null)
  const result = await ensureDealForSubmission(makeSubmission())
  assert.equal(result, null)
  assert.equal(created.length, 0)
})

test('ensureDealForSubmission: paused enrollment is not matched (status filter)', async () => {
  let filter: any = null
  stub(OtcEnrollment, 'findOne', (f: any) => {
    filter = f
    return chain(null)
  })
  const result = await ensureDealForSubmission(makeSubmission())
  assert.equal(result, null)
  assert.deepEqual(filter, { planterWallet: PLANTER, status: 'active' })
})

test('ensureDealForSubmission: non-mangrove -> null without touching the DB', async () => {
  let lookups = 0
  stub(OtcEnrollment, 'findOne', () => {
    lookups += 1
    return chain(makeEnrollment())
  })
  stub(OtcDeal, 'create', async () => {
    throw new Error('must not create')
  })
  assert.equal(
    await ensureDealForSubmission(makeSubmission({ treeType: 'baobab' })),
    null,
  )
  assert.equal(
    await ensureDealForSubmission(makeSubmission({ treeType: undefined })),
    null,
  )
  assert.equal(lookups, 0)
})

test('ensureDealForSubmission: buyer not in OTC_BUYER_WALLETS -> null', async () => {
  process.env.OTC_BUYER_WALLETS = OTHER_BUYER
  const created = setupEnsure(makeEnrollment())
  const result = await ensureDealForSubmission(makeSubmission())
  assert.equal(result, null)
  assert.equal(created.length, 0)

  process.env.OTC_BUYER_WALLETS = ''
  assert.equal(await ensureDealForSubmission(makeSubmission()), null)
  assert.equal(created.length, 0)
})

test('ensureDealForSubmission: OTC_PAY_ON=approval -> awaiting_count for a pending_verifier count', async () => {
  process.env.OTC_PAY_ON = 'approval'
  const created = setupEnsure(makeEnrollment())

  await ensureDealForSubmission(makeSubmission())

  const deal = created[0]
  assert.equal(deal.status, 'awaiting_count')
  assert.equal(deal.trees, 200)
  assert.equal(deal.countNote, 'Payable once verifiers approve this planting')
})

test('ensureDealForSubmission: OTC_PAY_ON=approval but already approved -> payable', async () => {
  process.env.OTC_PAY_ON = 'approval'
  const created = setupEnsure(makeEnrollment())
  const holds: any[] = []
  stub(
    RewardService.prototype,
    'holdAllocationForDeal',
    async (...args: any[]) => {
      holds.push(args)
      return { held: true, exists: true, allocationId: 'alloc-1' }
    },
  )

  await ensureDealForSubmission(makeSubmission({ status: 'approved' }))

  assert.equal(created[0].status, 'awaiting_payment')
  assert.equal(created[0].verified, true)
  assert.equal(holds.length, 1)
})

test('ensureDealForSubmission: existing deal is returned, not recreated', async () => {
  const existing = makeDeal()
  stub(OtcEnrollment, 'findOne', () => chain(makeEnrollment()))
  stub(OtcDeal, 'findOne', () => chain(existing))
  stub(OtcDeal, 'create', async () => {
    throw new Error('must not create')
  })
  const result = await ensureDealForSubmission(makeSubmission())
  assert.deepEqual(result, { deal: existing, created: false })
})

test('ensureDealForSubmission: approved submission takes the hold first and records release.status=held', async () => {
  const created = setupEnsure(makeEnrollment())
  const submission = makeSubmission({ status: 'approved' })
  const holds: any[] = []
  stub(
    RewardService.prototype,
    'holdAllocationForDeal',
    async (...args: any[]) => {
      holds.push(args)
      return { held: true, exists: true, allocationId: 'alloc-1' }
    },
  )

  const result = await ensureDealForSubmission(submission)

  assert.equal(holds.length, 1)
  assert.equal(String(holds[0][0]), String(submission._id))
  assert.equal(holds[0][2], PLANTER)
  const deal = created[0]
  // The deal carries the id the hold was taken under.
  assert.equal(String(deal._id), String(holds[0][1]))
  assert.deepEqual(deal.release, { status: 'held', allocationId: 'alloc-1' })
  assert.equal(deal.verified, true)
  assert.equal(result?.created, true)
})

test('ensureDealForSubmission: approved and already paid to the planter -> PLANTER_ALREADY_PAID, no deal', async () => {
  const created = setupEnsure(makeEnrollment())
  stub(RewardService.prototype, 'holdAllocationForDeal', async () => ({
    held: false,
    exists: true,
    allocationId: 'alloc-1',
  }))

  await rejectsOtc(
    () => ensureDealForSubmission(makeSubmission({ status: 'approved' })),
    'PLANTER_ALREADY_PAID',
    409,
  )
  assert.equal(created.length, 0)
})

test('ensureDealForSubmission: duplicate-key race returns the other deal and reconciles it', async () => {
  const other = makeDeal()
  let findOneCalls = 0
  stub(OtcEnrollment, 'findOne', () => chain(makeEnrollment()))
  stub(OtcDeal, 'findOne', () => {
    findOneCalls += 1
    return chain(findOneCalls === 1 ? null : other)
  })
  stub(OtcDeal, 'create', async () => {
    const e: any = new Error('E11000 duplicate key')
    e.code = 11000
    throw e
  })
  // The fire-and-forget reconcile of the other deal: make it a no-op.
  stub(OtcDeal, 'findById', () => chain(null))

  const result = await ensureDealForSubmission(makeSubmission())
  assert.deepEqual(result, { deal: other, created: false })
})

// --------------------------------------------------------------- confirmDeal

function setupConfirmReconcile(deal: any, alloc: any) {
  const releases: any[] = []
  stub(Submission, 'findById', () => chain({ status: 'approved' }))
  stub(RewardAllocation, 'findOne', () => chain(alloc))
  stub(RewardAllocation, 'exists', () =>
    chain(alloc ? { _id: alloc._id } : null),
  )
  stub(
    RewardService.prototype,
    'releaseAllocationToBuyer',
    async (...args: any[]) => {
      releases.push(args)
      return {
        released: true,
        allocationId: String(alloc?._id),
        claimJobId: 'job-1',
      }
    },
  )
  return releases
}

function makeHeldAlloc(deal: any) {
  return {
    _id: new mongoose.Types.ObjectId(),
    submissionId: deal.submissionId,
    planterWallet: PLANTER,
    otc: { dealId: deal._id, hold: true, originalPlanterWallet: PLANTER },
  }
}

test('confirmDeal: wrong M-Pesa code -> 400 MPESA_REF_MISMATCH, no transition', async () => {
  const deal = makeDeal({
    status: 'payment_sent',
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  const store = useDealStore(deal)

  await rejectsOtc(
    () => confirmDeal(PLANTER, String(deal._id), 'QHX7K2M9PX'),
    'MPESA_REF_MISMATCH',
    400,
  )
  await rejectsOtc(
    () => confirmDeal(PLANTER, String(deal._id), undefined),
    'MPESA_REF_MISMATCH',
    400,
  )
  assert.equal(store.transitions.length, 0)
  assert.equal(store.doc.status, 'payment_sent')
  assert.equal(sent.length, 0)
})

test('confirmDeal: matching code (any case) -> confirmed, allocation released, buyer notified', async () => {
  const deal = makeDeal({
    status: 'payment_sent',
    release: { status: 'held' },
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  const store = useDealStore(deal)
  const alloc = makeHeldAlloc(deal)
  const releases = setupConfirmReconcile(deal, alloc)

  const result = await confirmDeal(
    PLANTER.toUpperCase().replace('0X', '0x'),
    String(deal._id),
    ' qhx7k2m9pl ',
  )

  // Atomic transition from payment_sent only.
  assert.equal(store.transitions.length, 1)
  assert.deepEqual(store.transitions[0].filter, {
    _id: deal._id,
    status: { $in: ['payment_sent'] },
  })
  assert.equal(store.transitions[0].update.$set.status, 'confirmed')
  assert.ok(store.transitions[0].update.$set.confirmedAt instanceof Date)
  assert.equal(store.transitions[0].update.$push.events.type, 'confirmed')
  assert.equal(store.transitions[0].update.$push.events.by, PLANTER)

  // reconcileDealAllocation ran: release to the buyer and record it.
  assert.equal(releases.length, 1)
  assert.equal(String(releases[0][0]), String(deal.submissionId))
  assert.equal(String(releases[0][1]), String(deal._id))
  assert.equal(releases[0][2], BUYER)
  assert.equal(result.status, 'confirmed')
  assert.equal(result.release.status, 'released')
  assert.equal(String(result.release.allocationId), String(alloc._id))
  assert.equal(result.release.claimJobId, 'job-1')
  assert.ok(result.release.releasedAt instanceof Date)
  assert.equal(result.submissionStatus, 'approved')
  assert.ok(result.events.some((e: any) => e.type === 'mgro_released'))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'otc_deal_confirmed')
  assert.equal(sent[0].recipientWalletAddress, BUYER)
  assert.equal(sent[0].telegram, true)
  assert.match(sent[0].body, /200 trees is being released/)
  assert.doesNotMatch(`${sent[0].title} ${sent[0].body}`, /254712345678/)
  assert.equal(sent[0].link, `/otc/deals/${String(deal._id)}`)
})

test('confirmDeal: no allocation yet -> confirmed with release n/a and "once approved" wording', async () => {
  const deal = makeDeal({
    status: 'payment_sent',
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  useDealStore(deal)
  const releases = setupConfirmReconcile(deal, null)
  stub(Submission, 'findById', () => chain({ status: 'pending_review' }))

  const result = await confirmDeal(PLANTER, String(deal._id), REF)

  assert.equal(result.status, 'confirmed')
  assert.equal(result.release.status, 'n/a')
  assert.equal(releases.length, 0)
  assert.match(sent[0].body, /once the planting is approved/)
})

test('confirmDeal: OTC_CONFIRM_REQUIRES_REF=false accepts a confirmation without a code', async () => {
  process.env.OTC_CONFIRM_REQUIRES_REF = 'false'
  const deal = makeDeal({
    status: 'payment_sent',
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  useDealStore(deal)
  setupConfirmReconcile(deal, null)

  const result = await confirmDeal(PLANTER, String(deal._id))
  assert.equal(result.status, 'confirmed')
})

test('confirmDeal: already confirmed -> idempotent 200 after reconcile, no new transition', async () => {
  const deal = makeDeal({
    status: 'confirmed',
    release: { status: 'held' },
    confirmedAt: new Date(),
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  const store = useDealStore(deal)
  const alloc = makeHeldAlloc(deal)
  const releases = setupConfirmReconcile(deal, alloc)

  const result = await confirmDeal(PLANTER, String(deal._id), 'WRONGCODE1')

  assert.equal(store.transitions.length, 0)
  assert.equal(releases.length, 1) // the reconciler fixed the stuck hold
  assert.equal(result.status, 'confirmed')
  assert.equal(result.release.status, 'released')
  assert.equal(sent.length, 0)
})

test('confirmDeal: only the planter may confirm; nothing to confirm before payment', async () => {
  const deal = makeDeal({
    status: 'payment_sent',
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  const store = useDealStore(deal)
  await rejectsOtc(
    () => confirmDeal(BUYER, String(deal._id), REF),
    'FORBIDDEN',
    403,
  )

  store.doc.status = 'awaiting_payment'
  await rejectsOtc(
    () => confirmDeal(PLANTER, String(deal._id), REF),
    'INVALID_TRANSITION',
    409,
  )
  assert.equal(store.transitions.length, 0)

  await rejectsOtc(() => confirmDeal(PLANTER, 'nope', REF), 'INVALID_ID', 400)
  stub(OtcDeal, 'findById', () => chain(null))
  await rejectsOtc(
    () => confirmDeal(PLANTER, String(new mongoose.Types.ObjectId()), REF),
    'DEAL_NOT_FOUND',
    404,
  )
})

test('confirmDeal: concurrent move -> 409 INVALID_TRANSITION with the current status', async () => {
  const deal = makeDeal({
    status: 'payment_sent',
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  useDealStore(deal)
  // The read says payment_sent, but the atomic update finds it disputed.
  stub(OtcDeal, 'findOneAndUpdate', () => {
    deal.status = 'disputed'
    return chain(null)
  })

  await assert.rejects(
    () => confirmDeal(PLANTER, String(deal._id), REF),
    (e: any) => {
      assert.equal(e.code, 'INVALID_TRANSITION')
      assert.equal(e.status, 409)
      assert.deepEqual(e.extra, { status: 'disputed' })
      return true
    },
  )
})

// ------------------------------------------------------- onSubmissionRejected

test('onSubmissionRejected: awaiting_payment -> cancelled (submission_rejected), both parties notified', async () => {
  const deal = makeDeal({ status: 'awaiting_payment' })
  const store = useDealStore(deal)
  stub(Submission, 'findById', () => chain({ status: 'rejected' }))
  stub(RewardAllocation, 'findOne', () => chain(null))

  await onSubmissionRejected({ _id: deal.submissionId, status: 'rejected' })

  assert.equal(store.transitions.length, 1)
  assert.deepEqual(store.transitions[0].filter, {
    _id: deal._id,
    status: { $in: ['awaiting_payment'] },
  })
  const set = store.transitions[0].update.$set
  assert.equal(set.status, 'cancelled')
  assert.equal(set.cancelReason, 'submission_rejected')
  assert.equal(set.cancelledBy, 'system')
  assert.equal(set.cancelledFromStatus, 'awaiting_payment')
  assert.ok(set.cancelledAt instanceof Date)
  assert.equal(store.doc.status, 'cancelled')
  assert.equal(store.doc.submissionStatus, 'rejected')

  const kinds = sent.map(n => `${n.kind}:${n.recipientWalletAddress}`).sort()
  assert.deepEqual(kinds, [
    `otc_deal_cancelled:${PLANTER}`,
    `otc_deal_cancelled:${BUYER}`,
  ])
  const toPlanter = sent.find(n => n.recipientWalletAddress === PLANTER)
  assert.match(toPlanter.body, /rejected/)
  assert.match(toPlanter.body, /paid to your wallet as usual/)
  assert.equal(toPlanter.link, `/submissions/${String(deal.submissionId)}`)
  const toBuyer = sent.find(n => n.recipientWalletAddress === BUYER)
  assert.equal(toBuyer.telegram, true)
  assert.match(toBuyer.title, /submission rejected/)
  assert.doesNotMatch(`${toBuyer.title} ${toBuyer.body}`, /254712345678/)
})

test('onSubmissionRejected: awaiting_count with a held allocation -> cancelled and the hold returned', async () => {
  const deal = makeDeal({
    status: 'awaiting_count',
    release: { status: 'held' },
  })
  const store = useDealStore(deal)
  const alloc = makeHeldAlloc(deal)
  stub(Submission, 'findById', () => chain({ status: 'rejected' }))
  stub(RewardAllocation, 'findOne', () => chain(alloc))
  const returns: any[] = []
  stub(
    RewardService.prototype,
    'returnAllocationToPlanter',
    async (...args: any[]) => {
      returns.push(args)
      return {
        returned: true,
        allocationId: String(alloc._id),
        claimJobId: 'job-2',
      }
    },
  )

  await onSubmissionRejected({ _id: deal.submissionId, status: 'rejected' })

  assert.equal(store.doc.status, 'cancelled')
  assert.equal(returns.length, 1)
  assert.equal(String(returns[0][0]), String(deal.submissionId))
  assert.equal(String(returns[0][1]), String(deal._id))
  assert.equal(store.doc.release.status, 'returned')
  assert.equal(store.doc.release.claimJobId, 'job-2')
  assert.ok(store.doc.events.some((e: any) => e.type === 'mgro_returned'))
})

test('onSubmissionRejected: payment_sent -> status kept, release.status=unfundable, buyer notified', async () => {
  const deal = makeDeal({
    status: 'payment_sent',
    release: { status: 'n/a' },
    payment: {
      mpesaRef: REF,
      amountKes: 1500,
      partial: true,
      sentAt: new Date(),
    },
  })
  const store = useDealStore(deal)

  await onSubmissionRejected({ _id: deal.submissionId, status: 'rejected' })

  assert.equal(store.transitions.length, 1)
  assert.deepEqual(store.transitions[0].filter.status, {
    $in: ['payment_sent', 'confirmed', 'disputed'],
  })
  assert.deepEqual(store.transitions[0].filter['release.status'], {
    $in: ['n/a', 'held'],
  })
  assert.equal(store.doc.status, 'payment_sent')
  assert.equal(store.doc.release.status, 'unfundable')
  assert.equal(store.doc.submissionStatus, 'rejected')
  assert.ok(store.doc.events.some((e: any) => e.type === 'submission_rejected'))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'otc_deal_unfundable')
  assert.equal(sent[0].recipientWalletAddress, BUYER)
  assert.equal(sent[0].telegram, true)
  assert.match(sent[0].body, /Jane Doe/)
  assert.match(sent[0].body, /KES 1,500/) // paidKes, not the deal amount
  assert.match(sent[0].body, /no MGRO will mint/)
})

test('onSubmissionRejected: confirmed with a held allocation -> unfundable too', async () => {
  const deal = makeDeal({
    status: 'confirmed',
    release: { status: 'held' },
    payment: { mpesaRef: REF, amountKes: 2000, sentAt: new Date() },
  })
  const store = useDealStore(deal)
  await onSubmissionRejected({ _id: deal.submissionId, status: 'rejected' })
  assert.equal(store.doc.status, 'confirmed')
  assert.equal(store.doc.release.status, 'unfundable')
  assert.equal(sent[0]?.kind, 'otc_deal_unfundable')
})

test('onSubmissionRejected: already released, already unfundable, cancelled or no deal -> no-op', async () => {
  for (const over of [
    { status: 'confirmed', release: { status: 'released' } },
    { status: 'payment_sent', release: { status: 'unfundable' } },
    { status: 'cancelled', release: { status: 'returned' } },
  ]) {
    sent = []
    const deal = makeDeal(over)
    const store = useDealStore(deal)
    await onSubmissionRejected({ _id: deal.submissionId, status: 'rejected' })
    assert.equal(store.transitions.length, 0, JSON.stringify(over))
    assert.equal(store.updates.length, 0, JSON.stringify(over))
    assert.equal(sent.length, 0, JSON.stringify(over))
  }
  stub(OtcDeal, 'findOne', () => chain(null))
  await onSubmissionRejected({ _id: new mongoose.Types.ObjectId() })
  assert.equal(sent.length, 0)
})

// ------------------------------------------------------------ joinWithInvite

function makeInvite(over: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    code: generateInviteCode(),
    buyerWallet: BUYER,
    label: 'Kilifi group',
    ratePerTreeKes: 12,
    maxUses: null,
    uses: 3,
    expiresAt: null,
    isActive: true,
    ...over,
  } as any
}

function setupJoinCounters() {
  const counters = { inviteInc: 0, inviteDec: 0, created: 0 }
  stub(OtcInvite, 'findOneAndUpdate', () => {
    counters.inviteInc += 1
    return chain(null)
  })
  stub(OtcInvite, 'updateOne', async () => {
    counters.inviteDec += 1
    return { modifiedCount: 1 }
  })
  stub(OtcEnrollment, 'create', async () => {
    counters.created += 1
    throw new Error('must not create')
  })
  return counters
}

test('joinWithInvite: same-buyer re-join updates details and never consumes a use', async () => {
  const invite = makeInvite()
  stub(OtcInvite, 'findOne', () => chain(invite))
  let saved = 0
  const existing = makeEnrollment({
    mpesaNumber: '+254700000000',
    mpesaName: 'Old Name',
    ratePerTreeKes: 10,
    status: 'paused',
    save: async () => {
      saved += 1
    },
  })
  stub(OtcEnrollment, 'findOne', () => chain(existing))
  const counters = setupJoinCounters()

  const result = await joinWithInvite(PLANTER, invite.code.toLowerCase(), {
    mpesaNumber: '0712 345 678',
    mpesaName: '  Jane Doe ',
  })

  assert.equal(result.alreadyEnrolled, true)
  assert.equal(result.backfilled, 0)
  assert.equal(result.enrollment, existing)
  assert.equal(existing.mpesaNumber, PHONE)
  assert.equal(existing.mpesaName, 'Jane Doe')
  assert.equal(existing.ratePerTreeKes, 12) // refreshed from the invite
  assert.equal(existing.status, 'active')
  assert.equal(saved, 1)
  assert.equal(counters.inviteInc, 0)
  assert.equal(counters.inviteDec, 0)
  assert.equal(counters.created, 0)
  assert.equal(sent.length, 0) // re-joins send nothing
})

test('joinWithInvite: enrolled with another buyer -> 409 ALREADY_ENROLLED', async () => {
  const invite = makeInvite()
  stub(OtcInvite, 'findOne', () => chain(invite))
  stub(OtcEnrollment, 'findOne', () =>
    chain(makeEnrollment({ buyerWallet: OTHER_BUYER, save: async () => {} })),
  )
  const counters = setupJoinCounters()

  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: PHONE,
        mpesaName: 'Jane Doe',
      }),
    'ALREADY_ENROLLED',
    409,
  )
  assert.equal(counters.inviteInc, 0)
  assert.equal(sent.length, 0)
})

test('joinWithInvite: new planter -> guarded $inc, enrollment created, buyer alerted once without the phone', async () => {
  const invite = makeInvite({ uses: 0 })
  stub(OtcInvite, 'findOne', () => chain(invite))
  stub(OtcEnrollment, 'findOne', () => chain(null))
  let incCall: any = null
  stub(OtcInvite, 'findOneAndUpdate', (filter: any, update: any) => {
    incCall = { filter, update }
    return chain({ ...invite, uses: 1 })
  })
  let createdDoc: any = null
  stub(OtcEnrollment, 'create', async (doc: any) => {
    createdDoc = doc
    return { _id: new mongoose.Types.ObjectId(), ...doc }
  })
  let userUpdate: any = null
  stub(User, 'updateOne', (filter: any, update: any) => {
    userUpdate = { filter, update }
    return Promise.resolve({ modifiedCount: 1 })
  })
  // D11 backfill: no earlier plantings.
  stub(Submission, 'find', () => chain([]))

  const result = await joinWithInvite(
    PLANTER.toUpperCase().replace('0X', '0x'),
    invite.code,
    { mpesaNumber: '0712345678', mpesaName: 'Jane Doe' },
  )

  assert.equal(result.alreadyEnrolled, false)
  assert.equal(result.backfilled, 0)
  assert.equal(incCall.filter._id, invite._id)
  assert.equal(incCall.filter.isActive, true)
  assert.deepEqual(incCall.update, { $inc: { uses: 1 } })
  assert.equal(createdDoc.planterWallet, PLANTER)
  assert.equal(createdDoc.buyerWallet, BUYER)
  assert.equal(createdDoc.inviteId, invite._id)
  assert.equal(createdDoc.inviteCode, invite.code)
  assert.equal(createdDoc.mpesaNumber, PHONE)
  assert.equal(createdDoc.mpesaName, 'Jane Doe')
  assert.equal(createdDoc.ratePerTreeKes, 12)
  assert.equal(createdDoc.status, 'active')
  assert.equal(userUpdate.filter.walletAddress, PLANTER)
  assert.deepEqual(userUpdate.update, { $set: { phone: PHONE } })

  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'otc_planter_joined')
  assert.equal(sent[0].recipientWalletAddress, BUYER)
  assert.equal(sent[0].telegram, true)
  assert.match(sent[0].title, /Jane Doe/)
  assert.match(sent[0].body, /Kilifi group/)
  assert.match(sent[0].body, /KES 12\/tree/)
  assert.doesNotMatch(sent[0].body, /existing planting/)
  assert.doesNotMatch(`${sent[0].title} ${sent[0].body}`, /254712345678/)
  assert.equal(sent[0].link, '/otc')
})

test('joinWithInvite: double tap (11000 on create) hands the use back and returns the existing enrollment', async () => {
  const invite = makeInvite()
  stub(OtcInvite, 'findOne', () => chain(invite))
  const existing = makeEnrollment()
  let enrollmentLookups = 0
  stub(OtcEnrollment, 'findOne', () => {
    enrollmentLookups += 1
    return chain(enrollmentLookups === 1 ? null : existing)
  })
  stub(OtcInvite, 'findOneAndUpdate', () => chain({ ...invite, uses: 4 }))
  let dec: any = null
  stub(OtcInvite, 'updateOne', async (filter: any, update: any) => {
    dec = { filter, update }
    return { modifiedCount: 1 }
  })
  stub(OtcEnrollment, 'create', async () => {
    const e: any = new Error('E11000 duplicate key')
    e.code = 11000
    throw e
  })

  const result = await joinWithInvite(PLANTER, invite.code, {
    mpesaNumber: PHONE,
    mpesaName: 'Jane Doe',
  })

  assert.equal(result.alreadyEnrolled, true)
  assert.equal(result.enrollment, existing)
  assert.deepEqual(dec.update, { $inc: { uses: -1 } })
  assert.equal(sent.length, 0)
})

test('joinWithInvite: validation and availability errors', async () => {
  const invite = makeInvite()
  stub(OtcInvite, 'findOne', () => chain(invite))
  stub(OtcEnrollment, 'findOne', () => chain(null))
  const counters = setupJoinCounters()

  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: '0812345678',
        mpesaName: 'Jane',
      }),
    'INVALID_PHONE',
    400,
  )
  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: PHONE,
        mpesaName: 'J',
      }),
    'INVALID_NAME',
    400,
  )
  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, 'not-a-code', {
        mpesaNumber: PHONE,
        mpesaName: 'Jane',
      }),
    'INVITE_NOT_FOUND',
    404,
  )

  stub(OtcInvite, 'findOne', () => chain(makeInvite({ maxUses: 3, uses: 3 })))
  await assert.rejects(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: PHONE,
        mpesaName: 'Jane',
      }),
    (e: any) => {
      assert.equal(e.code, 'INVITE_UNAVAILABLE')
      assert.equal(e.status, 410)
      assert.deepEqual(e.extra, { reason: 'exhausted' })
      return true
    },
  )
  stub(OtcInvite, 'findOne', () =>
    chain(makeInvite({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })),
  )
  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: PHONE,
        mpesaName: 'Jane',
      }),
    'INVITE_UNAVAILABLE',
    410,
  )
  stub(OtcInvite, 'findOne', () => chain(makeInvite({ isActive: false })))
  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: PHONE,
        mpesaName: 'Jane',
      }),
    'INVITE_UNAVAILABLE',
    410,
  )

  // The guarded $inc losing the race is also 410.
  stub(OtcInvite, 'findOne', () => chain(invite))
  await rejectsOtc(
    () =>
      joinWithInvite(PLANTER, invite.code, {
        mpesaNumber: PHONE,
        mpesaName: 'Jane',
      }),
    'INVITE_UNAVAILABLE',
    410,
  )
  assert.equal(counters.inviteInc, 1)
  assert.equal(counters.created, 0)
  assert.equal(sent.length, 0)
})
