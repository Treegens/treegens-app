import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import mongoose from 'mongoose'
import HealthCheck from '../models/HealthCheck'
import OtcDeal from '../models/OtcDeal'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import User from '../models/User'
import { expectedPlanterMgroWei } from './otcDealRules'
import {
  calculateRewardStatusProjection,
  computeSurvivalPlanterPayNow,
  getClaimScheduleConfig,
  RewardService,
} from './rewardService'

/**
 * OTC (M-Pesa) hold integration in rewardService (spec section 4 / 12).
 * No MongoDB: model statics are monkeypatched and restored after each test.
 */

const PLANTER = `0x${'a'.repeat(40)}`
const BUYER = `0x${'b'.repeat(40)}`
const VERIFIER = `0x${'c'.repeat(40)}`

const restores: Array<() => void> = []
function stub(target: any, key: string, impl: any) {
  const original = target[key]
  target[key] = impl
  restores.push(() => {
    target[key] = original
  })
}

const ENV_KEYS = ['OTC_RELEASE_MODE'] as const
const envSnapshot: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) envSnapshot[k] = process.env[k]

afterEach(() => {
  while (restores.length) {
    const r = restores.pop()
    if (r) r()
  }
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

function makeSubmission(over: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    status: 'approved',
    userWalletAddress: PLANTER,
    treesPlanted: 250,
    votes: [
      { voterWalletAddress: BUYER, vote: 'yes' },
      { voterWalletAddress: VERIFIER, vote: 'yes' },
      { voterWalletAddress: PLANTER, vote: 'yes' }, // self-vote must never count
      { voterWalletAddress: `0x${'d'.repeat(40)}`, vote: 'no' },
    ],
    ...over,
  } as any
}

function makeOtc(status: string, trees = 200) {
  return {
    dealId: new mongoose.Types.ObjectId(),
    buyerWallet: BUYER.toUpperCase().replace('0X', '0x'),
    status: status as any,
    trees,
  }
}

function makeAllocation(over: Record<string, unknown> = {}) {
  const approvedAt = new Date('2026-01-01T00:00:00.000Z')
  const tranches = Array.from({ length: 6 }, (_, index) => ({
    index,
    amountWei: '0',
    unlockAt: new Date(approvedAt.getTime() + index * 180 * 86400_000),
    status: 'pending',
  }))
  return {
    _id: new mongoose.Types.ObjectId(),
    submissionId: new mongoose.Types.ObjectId(),
    approvedAt,
    planterWallet: PLANTER,
    planterTotalWei: '950',
    totalMgroWei: '1000',
    verifierPoolWei: '50',
    verifierRewardWei: '25',
    yesVoterCount: 2,
    treesPlanted: 200,
    planterCumulativePaidWei: '0',
    verifierClaims: [],
    tranches,
    ...over,
  } as any
}

// ------------------------------------------------------ buildAllocationFields

test('buildAllocationFields: open deal puts the planter share on hold', () => {
  const service = new RewardService()
  const otc = makeOtc('awaiting_payment')
  const fields = service.buildAllocationFields(makeSubmission(), otc) as any

  assert.ok(fields)
  assert.equal(fields.planterWallet, PLANTER)
  assert.deepEqual(fields.otc, {
    dealId: otc.dealId,
    hold: true,
    originalPlanterWallet: PLANTER,
  })
  assert.equal(fields.treesPlanted, 200)
})

test('buildAllocationFields: confirmed deal makes the buyer the recipient', () => {
  const service = new RewardService()
  const otc = makeOtc('confirmed')
  const before = Date.now()
  const fields = service.buildAllocationFields(makeSubmission(), otc) as any

  assert.ok(fields)
  assert.equal(fields.planterWallet, BUYER)
  assert.equal(fields.otc.dealId, otc.dealId)
  assert.equal(fields.otc.hold, false)
  assert.equal(fields.otc.originalPlanterWallet, PLANTER)
  assert.ok(fields.otc.releasedToBuyerAt instanceof Date)
  assert.ok(fields.otc.releasedToBuyerAt.getTime() >= before)
})

test('buildAllocationFields: cancelled deal leaves no otc fields but keeps the deal count', () => {
  const service = new RewardService()
  const fields = service.buildAllocationFields(
    makeSubmission(),
    makeOtc('cancelled'),
  ) as any

  assert.ok(fields)
  assert.equal(fields.planterWallet, PLANTER)
  assert.equal('otc' in fields, false)
  assert.equal(fields.treesPlanted, 200)
})

test('buildAllocationFields: yes-voter filter uses the original planter (buyer who voted yes keeps the slice)', () => {
  const service = new RewardService()
  const plain = service.buildAllocationFields(makeSubmission()) as any
  const held = service.buildAllocationFields(
    makeSubmission(),
    makeOtc('awaiting_payment', 250),
  ) as any
  const released = service.buildAllocationFields(
    makeSubmission(),
    makeOtc('confirmed', 250),
  ) as any

  // buyer + verifier; the planter's self-vote is dropped in every case.
  assert.equal(plain.yesVoterCount, 2)
  assert.equal(held.yesVoterCount, 2)
  assert.equal(released.yesVoterCount, 2)
  assert.equal(released.verifierRewardWei, plain.verifierRewardWei)
  assert.equal(released.verifierPoolWei, plain.verifierPoolWei)
  // Same tree count -> identical MGRO split regardless of recipient.
  assert.equal(released.planterTotalWei, plain.planterTotalWei)
})

test('buildAllocationFields: treesPlanted comes from the deal, not the declared count (D2)', () => {
  const service = new RewardService()
  const submission = makeSubmission({ treesPlanted: 250 })
  const fields = service.buildAllocationFields(
    submission,
    makeOtc('awaiting_payment', 200),
  ) as any

  assert.equal(fields.treesPlanted, 200)
  assert.equal(fields.planterTotalWei, expectedPlanterMgroWei(200))
  assert.notEqual(fields.planterTotalWei, expectedPlanterMgroWei(250))

  // No deal: today's behaviour (declared count).
  const plain = service.buildAllocationFields(submission) as any
  assert.equal(plain.treesPlanted, 250)

  // A deal with no usable count yields no allocation.
  assert.equal(
    service.buildAllocationFields(submission, makeOtc('awaiting_count', 0)),
    null,
  )
})

// --------------------------------------------------------- getClaimEligibility

test('getClaimEligibility: hold blocks the planter, verifier path unaffected', () => {
  const service = new RewardService()
  const submission = {
    status: 'approved',
    votes: [{ voterWalletAddress: VERIFIER, vote: 'yes' }],
  }
  const base = {
    planterWallet: PLANTER,
    yesVoterCount: 1,
    verifierPoolWei: '50',
  }

  const held = service.getClaimEligibility(
    submission,
    { ...base, otc: { hold: true } },
    PLANTER.toUpperCase().replace('0X', '0x'),
  )
  assert.equal(held.planter, false)
  assert.equal(held.verifier, false)

  const free = service.getClaimEligibility(
    submission,
    { ...base, otc: { hold: false } },
    PLANTER,
  )
  assert.equal(free.planter, true)

  const none = service.getClaimEligibility(submission, base, PLANTER)
  assert.equal(none.planter, true)

  const verifier = service.getClaimEligibility(
    submission,
    { ...base, otc: { hold: true } },
    VERIFIER,
  )
  assert.equal(verifier.planter, false)
  assert.equal(verifier.verifier, true)
})

// ----------------------------------------------------- handleSubmissionApproved

test('handleSubmissionApproved: open deal -> allocation held from the deal count, no planter claim job', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission({ treesPlanted: 250 })
  const dealId = new mongoose.Types.ObjectId()
  const deal = {
    _id: dealId,
    submissionId: submission._id,
    buyerWallet: BUYER,
    planterWallet: PLANTER,
    status: 'awaiting_payment',
    trees: 200,
  }

  let created: any = null
  let findOneCalls = 0
  stub(RewardAllocation, 'findOne', () => {
    findOneCalls += 1
    // 1st: "does an allocation exist?" -> no. 2nd: re-read after create.
    return chain(
      findOneCalls === 1
        ? null
        : { _id: 'alloc-1', ...created, planterWallet: created.planterWallet },
    )
  })
  stub(RewardAllocation, 'create', async (fields: any) => {
    created = fields
    return { _id: 'alloc-1', ...fields }
  })
  let otcDealFilter: any = null
  stub(OtcDeal, 'findOne', (filter: any) => {
    otcDealFilter = filter
    return chain(deal)
  })
  // The post-create reconcile re-reads the deal; make that a no-op.
  stub(OtcDeal, 'findById', () => chain(null))

  let enqueueCalls = 0
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async () => {
      enqueueCalls += 1
      return { job: { jobId: 'job-1' } }
    },
  }

  const result = await service.handleSubmissionApproved(submission)

  assert.deepEqual(otcDealFilter, {
    submissionId: submission._id,
    status: { $ne: 'cancelled' },
  })
  assert.ok(created)
  assert.equal(created.treesPlanted, 200)
  assert.equal(created.planterWallet, PLANTER)
  assert.equal(created.otc.hold, true)
  assert.equal(String(created.otc.dealId), String(dealId))
  assert.equal(created.otc.originalPlanterWallet, PLANTER)
  assert.equal(result.allocationCreated, true)
  assert.equal(result.claimJobEnqueued, false)
  assert.equal(result.claimJobId, undefined)
  assert.equal(enqueueCalls, 0)
})

test('handleSubmissionApproved: confirmed deal -> allocation to the buyer and the claim job targets the buyer', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission()
  const deal = {
    _id: new mongoose.Types.ObjectId(),
    submissionId: submission._id,
    buyerWallet: BUYER,
    planterWallet: PLANTER,
    status: 'confirmed',
    trees: 300,
  }

  let created: any = null
  let findOneCalls = 0
  stub(RewardAllocation, 'findOne', () => {
    findOneCalls += 1
    return chain(findOneCalls === 1 ? null : { _id: 'alloc-2', ...created })
  })
  stub(RewardAllocation, 'create', async (fields: any) => {
    created = fields
    return { _id: 'alloc-2', ...fields }
  })
  stub(OtcDeal, 'findOne', () => chain(deal))
  stub(OtcDeal, 'findById', () => chain(null))

  const enqueued: any[] = []
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async (input: any) => {
      enqueued.push(input)
      return { job: { jobId: 'job-buyer' } }
    },
  }

  const result = await service.handleSubmissionApproved(submission)

  assert.equal(created.planterWallet, BUYER)
  assert.equal(created.otc.hold, false)
  assert.equal(created.treesPlanted, 300)
  assert.equal(result.claimJobEnqueued, true)
  assert.equal(result.claimJobId, 'job-buyer')
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].walletAddress, BUYER)
  assert.equal(enqueued[0].claimType, 'planter')
})

test("handleSubmissionApproved: no deal -> today's behaviour (declared count, planter claim job)", async () => {
  const service = new RewardService() as any
  const submission = makeSubmission({ treesPlanted: 250 })

  let created: any = null
  let findOneCalls = 0
  stub(RewardAllocation, 'findOne', () => {
    findOneCalls += 1
    return chain(findOneCalls === 1 ? null : { _id: 'alloc-3', ...created })
  })
  stub(RewardAllocation, 'create', async (fields: any) => {
    created = fields
    return { _id: 'alloc-3', ...fields }
  })
  stub(OtcDeal, 'findOne', () => chain(null))

  const enqueued: any[] = []
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async (input: any) => {
      enqueued.push(input)
      return { job: { jobId: 'job-planter' } }
    },
  }

  const result = await service.handleSubmissionApproved(submission)

  assert.equal(created.treesPlanted, 250)
  assert.equal('otc' in created, false)
  assert.equal(result.claimJobEnqueued, true)
  assert.equal(enqueued[0].walletAddress, PLANTER)
})

// -------------------------------------------- calculateRewardStatusProjection

test('projection: hold -> planter cannot claim, otcHold true, no health-check nag', () => {
  const dealId = new mongoose.Types.ObjectId()
  const allocation = makeAllocation({
    otc: { dealId, hold: true, originalPlanterWallet: PLANTER },
  })
  // Long after approval: every tranche would be "due" without the hold.
  const now = new Date('2029-01-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation,
    PLANTER,
    now,
    undefined,
    [],
  )

  assert.equal(status.role, 'planter')
  assert.equal(status.otcHold, true)
  assert.equal(status.otcDealId, String(dealId))
  assert.equal(status.canClaim, false)
  assert.equal(status.pendingClaimAmountWei, '0')
  assert.equal(status.nextPlanterAction, 'wait')
  assert.equal(status.healthCheckRequiredForNextClaim, false)
  assert.equal(status.pendingHealthCheckpointIndex, null)
  assert.notEqual(status.displayState, 'PENDING_CLAIM')
  assert.equal(status.otcReleased, undefined)
})

test('projection: released in full mode -> buyer sees the whole planter share claimable', () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const dealId = new mongoose.Types.ObjectId()
  const allocation = makeAllocation({
    planterWallet: BUYER,
    otc: {
      dealId,
      hold: false,
      originalPlanterWallet: PLANTER,
      releasedToBuyerAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  })
  // One day after approval: nothing is due under the normal schedule.
  const now = new Date('2026-01-02T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation,
    BUYER,
    now,
    undefined,
    [],
  )

  assert.equal(status.role, 'planter')
  assert.equal(status.otcReleased, true)
  assert.equal(status.otcDealId, String(dealId))
  assert.equal(status.pendingClaimAmountWei, allocation.planterTotalWei)
  assert.equal(status.canClaim, true)
  assert.equal(status.displayState, 'PENDING_CLAIM')
  assert.equal(status.nextPlanterAction, 'claim')
  assert.equal(status.healthCheckRequiredForNextClaim, false)
  assert.equal(status.pendingHealthCheckpointIndex, null)
  assert.equal(status.nextClaimAt, null)
})

test('projection: released in full mode and fully minted -> COMPLETED', () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeAllocation({
    planterWallet: BUYER,
    planterCumulativePaidWei: '950',
    otc: {
      dealId: new mongoose.Types.ObjectId(),
      hold: false,
      originalPlanterWallet: PLANTER,
      releasedToBuyerAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  })
  allocation.tranches[0].status = 'paid'
  allocation.tranches[0].amountWei = '950'
  for (const t of allocation.tranches.slice(1)) t.status = 'paid'
  const status = calculateRewardStatusProjection(
    allocation,
    BUYER,
    new Date('2026-01-03T00:00:00.000Z'),
    undefined,
    [],
  )

  assert.equal(status.otcReleased, true)
  assert.equal(status.pendingClaimAmountWei, '0')
  assert.equal(status.canClaim, false)
  assert.equal(status.displayState, 'COMPLETED')
  assert.equal(status.scheduleCompleted, true)
})

test('projection: released in vesting mode keeps the schedule for the buyer', () => {
  process.env.OTC_RELEASE_MODE = 'vesting'
  const allocation = makeAllocation({
    planterWallet: BUYER,
    otc: {
      dealId: new mongoose.Types.ObjectId(),
      hold: false,
      originalPlanterWallet: PLANTER,
      releasedToBuyerAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  })
  const status = calculateRewardStatusProjection(
    allocation,
    BUYER,
    new Date('2026-01-02T00:00:00.000Z'),
    undefined,
    [],
  )

  assert.equal(status.otcReleased, true)
  // Only tranche 0 is due one day after approval under the schedule.
  assert.notEqual(status.pendingClaimAmountWei, allocation.planterTotalWei)
})

test('projection: original planter after release gets a planter-shaped answer, no throw', () => {
  const dealId = new mongoose.Types.ObjectId()
  const allocation = makeAllocation({
    planterWallet: BUYER,
    otc: {
      dealId,
      hold: false,
      originalPlanterWallet: PLANTER,
      releasedToBuyerAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  })
  // No submission context: the verifier fallback would throw here.
  const status = calculateRewardStatusProjection(
    allocation,
    PLANTER.toUpperCase().replace('0X', '0x'),
    new Date('2027-01-01T00:00:00.000Z'),
    undefined,
    [],
  )

  assert.equal(status.role, 'planter')
  assert.equal(status.walletAddress, PLANTER)
  assert.equal(status.otcReleased, true)
  assert.equal(status.otcDealId, String(dealId))
  assert.equal(status.totalRewardWei, allocation.planterTotalWei)
  assert.equal(status.claimedAmountWei, '0')
  assert.equal(status.pendingClaimAmountWei, '0')
  assert.equal(status.canClaim, false)
  assert.equal(status.displayState, 'NONE')
  assert.equal(status.nextPlanterAction, 'wait')
  assert.equal(status.healthCheckRequiredForNextClaim, false)
})

test('projection: unrelated wallet still gets the verifier 403 path (throws)', () => {
  const allocation = makeAllocation({
    planterWallet: BUYER,
    otc: {
      dealId: new mongoose.Types.ObjectId(),
      hold: false,
      originalPlanterWallet: PLANTER,
      releasedToBuyerAt: new Date(),
    },
  })
  assert.throws(() =>
    calculateRewardStatusProjection(
      allocation,
      `0x${'e'.repeat(40)}`,
      new Date(),
      { votes: [] },
      [],
    ),
  )
})

test('projection: otcDealId is set for a verifier when the allocation is bound to a deal', () => {
  const dealId = new mongoose.Types.ObjectId()
  const allocation = makeAllocation({
    otc: { dealId, hold: true, originalPlanterWallet: PLANTER },
  })
  const status = calculateRewardStatusProjection(
    allocation,
    VERIFIER,
    new Date('2026-02-01T00:00:00.000Z'),
    {
      votes: [
        { voterWalletAddress: VERIFIER, vote: 'yes' },
        { voterWalletAddress: BUYER, vote: 'yes' },
      ],
    },
    [],
  )
  assert.equal(status.role, 'verifier')
  assert.equal(status.otcDealId, String(dealId))
  assert.equal(status.otcHold, undefined)
})

// ---------------------------------------------------- tryMintPlanterTranches

type UpdateCall = { filter: any; update: any; options: any }

function setupMintFixture(allocation: any) {
  const updates: UpdateCall[] = []
  const mints: Array<{ wallet: string; amountWei: string; options: any }> = []
  const submissionUpdates: any[] = []

  stub(RewardAllocation, 'findById', () => chain(allocation))
  stub(
    RewardAllocation,
    'updateOne',
    async (filter: any, update: any, options: any) => {
      updates.push({ filter, update, options })
      return { matchedCount: 1, modifiedCount: 1 }
    },
  )
  stub(User, 'findOne', () => chain(null))
  stub(Submission, 'updateOne', async (...args: any[]) => {
    submissionUpdates.push(args)
    return { matchedCount: 1, modifiedCount: 1 }
  })
  stub(HealthCheck, 'findOne', () => chain(null))

  const service = new RewardService() as any
  service.mintService = {
    isConfigured: () => true,
    mintTo: async (wallet: string, amountWei: string, options: any) => {
      mints.push({ wallet, amountWei, options })
      return { txHash: `0xtx${mints.length}` }
    },
  }
  return { service, updates, mints, submissionUpdates }
}

function makeReleasedAllocation(cumulative = '0') {
  const dealId = new mongoose.Types.ObjectId()
  return makeAllocation({
    planterWallet: BUYER,
    planterCumulativePaidWei: cumulative,
    otc: {
      dealId,
      hold: false,
      originalPlanterWallet: PLANTER,
      releasedToBuyerAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  })
}

test('tryMintPlanterTranches: full mode mints the whole remaining share once and zeroes the rest', async () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeReleasedAllocation('0')
  const { service, updates, mints, submissionUpdates } =
    setupMintFixture(allocation)

  const result = await service.tryMintPlanterTranches(allocation._id, BUYER)

  assert.equal(mints.length, 1)
  assert.equal(mints[0].wallet, BUYER)
  assert.equal(mints[0].amountWei, '950')
  assert.equal(
    mints[0].options.evidenceURI,
    `treegens://submission/${String(allocation.submissionId)}/otc/${String(allocation.otc.dealId)}/full`,
  )
  assert.deepEqual(result.txHashes, ['0xtx1'])
  assert.deepEqual(result.amountsWei, ['950'])
  assert.equal(result.pendingVerifierProposalId, undefined)

  // Every tranche lock refuses to run under a hold.
  const locks = updates.filter(
    u => u.update?.$set?.['tranches.$[tr].status'] === 'processing',
  )
  assert.equal(locks.length, 6)
  for (const l of locks) {
    assert.deepEqual(l.filter['otc.hold'], { $ne: true })
  }

  const paid = updates.filter(
    u => u.update?.$set?.['tranches.$[tr].status'] === 'paid',
  )
  assert.equal(paid.length, 6)
  const full = paid.filter(
    u => u.update.$set['tranches.$[tr].amountWei'] === '950',
  )
  assert.equal(full.length, 1)
  assert.equal(full[0].update.$set.planterCumulativePaidWei, '950')
  assert.equal(full[0].update.$set['tranches.$[tr].txHash'], '0xtx1')
  assert.deepEqual(full[0].options.arrayFilters[0]['tr.index'], 0)
  const zeroed = paid.filter(
    u => u.update.$set['tranches.$[tr].amountWei'] === '0',
  )
  assert.deepEqual(
    zeroed.map(u => u.options.arrayFilters[0]['tr.index']).sort(),
    [1, 2, 3, 4, 5],
  )
  // Submission.planterRewardClaimedWei means "minted to the planter": untouched.
  assert.equal(submissionUpdates.length, 0)
})

test('tryMintPlanterTranches: full mode pays planterTotal minus what was already minted', async () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeReleasedAllocation('100')
  allocation.tranches[0].status = 'paid'
  allocation.tranches[0].amountWei = '100'
  const { service, updates, mints } = setupMintFixture(allocation)

  const result = await service.tryMintPlanterTranches(allocation._id, BUYER)

  assert.equal(mints.length, 1)
  assert.equal(mints[0].amountWei, '850')
  assert.deepEqual(result.amountsWei, ['850'])
  const full = updates.find(
    u => u.update?.$set?.['tranches.$[tr].amountWei'] === '850',
  )
  assert.ok(full)
  assert.equal(full.update.$set.planterCumulativePaidWei, '950')
  assert.equal(full.options.arrayFilters[0]['tr.index'], 1)
  const zeroed = updates.filter(
    u => u.update?.$set?.['tranches.$[tr].amountWei'] === '0',
  )
  assert.deepEqual(
    zeroed.map(u => u.options.arrayFilters[0]['tr.index']).sort(),
    [2, 3, 4, 5],
  )
})

test('tryMintPlanterTranches: full mode with nothing left mints nothing', async () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeReleasedAllocation('950')
  for (const t of allocation.tranches) t.status = 'paid'
  const { service, mints, updates } = setupMintFixture(allocation)

  const result = await service.tryMintPlanterTranches(allocation._id, BUYER)

  assert.equal(mints.length, 0)
  assert.equal(updates.length, 0)
  assert.deepEqual(result, { txHashes: [], amountsWei: [] })
})

test('tryMintPlanterTranches: full mode stops when the lock is refused (hold landed / in flight)', async () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeReleasedAllocation('0')
  const { service, mints } = setupMintFixture(allocation)
  stub(RewardAllocation, 'updateOne', async () => ({
    matchedCount: 0,
    modifiedCount: 0,
  }))

  const result = await service.tryMintPlanterTranches(allocation._id, BUYER)

  assert.equal(mints.length, 0)
  assert.deepEqual(result, { txHashes: [], amountsWei: [] })
})

test('tryMintPlanterTranches: vesting mode after release keeps the schedule and never touches the submission', async () => {
  process.env.OTC_RELEASE_MODE = 'vesting'
  const allocation = makeReleasedAllocation('0')
  const { service, mints, submissionUpdates } = setupMintFixture(allocation)

  const result = await service.tryMintPlanterTranches(allocation._id, BUYER)

  // Only tranche 0 is due; no approved health check -> nothing else pays.
  const { totalTranches } = getClaimScheduleConfig()
  const expected = computeSurvivalPlanterPayNow({
    planterTotalWei: 950n,
    checkpointOneBased: 1,
    initialTrees: 200,
    treesAlive: 200,
    totalTranches,
    planterCumulativePaidWei: 0n,
  }).toString()
  assert.equal(mints.length, 1)
  assert.equal(mints[0].wallet, BUYER)
  assert.equal(mints[0].amountWei, expected)
  assert.notEqual(expected, '950')
  assert.match(mints[0].options.evidenceURI, /\/planter\/tranche\/0$/)
  assert.deepEqual(result.amountsWei, [expected])
  assert.equal(submissionUpdates.length, 0)
})

test('tryMintPlanterTranches: refuses to mint while the planter share is held', async () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeAllocation({
    otc: {
      dealId: new mongoose.Types.ObjectId(),
      hold: true,
      originalPlanterWallet: PLANTER,
    },
  })
  const { service, mints, updates } = setupMintFixture(allocation)

  await assert.rejects(
    () => service.tryMintPlanterTranches(allocation._id, PLANTER),
    /held pending OTC confirmation/,
  )
  assert.equal(mints.length, 0)
  assert.equal(updates.length, 0)
})

test('tryMintPlanterTranches: the original planter cannot mint a released allocation', async () => {
  process.env.OTC_RELEASE_MODE = 'full'
  const allocation = makeReleasedAllocation('0')
  const { service, mints } = setupMintFixture(allocation)

  await assert.rejects(
    () => service.tryMintPlanterTranches(allocation._id, PLANTER),
    /Planter wallet mismatch/,
  )
  assert.equal(mints.length, 0)
})

// ---------------------------------------- release / return / hold primitives

test('releaseAllocationToBuyer: reassigns, clears the hold, drops proposal ids and enqueues the buyer claim', async () => {
  const service = new RewardService() as any
  const sid = new mongoose.Types.ObjectId()
  const dealId = new mongoose.Types.ObjectId()
  let captured: any = null
  stub(
    RewardAllocation,
    'findOneAndUpdate',
    (filter: any, update: any, options: any) => {
      captured = { filter, update, options }
      return chain({ _id: 'alloc-9', planterWallet: BUYER })
    },
  )
  const enqueued: any[] = []
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async (input: any) => {
      enqueued.push(input)
      return { job: { jobId: 'job-9' } }
    },
  }

  const r = await service.releaseAllocationToBuyer(
    sid,
    dealId,
    BUYER.toUpperCase().replace('0X', '0x'),
  )

  assert.deepEqual(r, {
    released: true,
    allocationId: 'alloc-9',
    claimJobId: 'job-9',
  })
  assert.equal(String(captured.filter.submissionId), String(sid))
  assert.equal(String(captured.filter['otc.dealId']), String(dealId))
  assert.deepEqual(captured.filter.$or, [
    { 'otc.hold': true },
    { planterWallet: { $ne: BUYER } },
  ])
  assert.equal(captured.update.$set.planterWallet, BUYER)
  assert.equal(captured.update.$set['otc.hold'], false)
  assert.ok(captured.update.$set['otc.releasedToBuyerAt'] instanceof Date)
  assert.deepEqual(captured.update.$unset, { 'tranches.$[].proposalId': 1 })
  assert.deepEqual(enqueued, [
    { submissionId: String(sid), walletAddress: BUYER, claimType: 'planter' },
  ])
})

test('releaseAllocationToBuyer: second call reports already_released; missing allocation reports no_allocation', async () => {
  const service = new RewardService() as any
  const sid = new mongoose.Types.ObjectId()
  const dealId = new mongoose.Types.ObjectId()
  stub(RewardAllocation, 'findOneAndUpdate', () => chain(null))
  stub(RewardAllocation, 'findOne', () => chain({ _id: 'alloc-9' }))
  let enqueueCalls = 0
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async () => {
      enqueueCalls += 1
      return { job: { jobId: 'x' } }
    },
  }

  assert.deepEqual(await service.releaseAllocationToBuyer(sid, dealId, BUYER), {
    released: false,
    allocationId: 'alloc-9',
    reason: 'already_released',
  })
  stub(RewardAllocation, 'findOne', () => chain(null))
  assert.deepEqual(await service.releaseAllocationToBuyer(sid, dealId, BUYER), {
    released: false,
    reason: 'no_allocation',
  })
  assert.equal(enqueueCalls, 0)
})

test('returnAllocationToPlanter: lifts the hold and enqueues the planter claim', async () => {
  const service = new RewardService() as any
  const sid = new mongoose.Types.ObjectId()
  const dealId = new mongoose.Types.ObjectId()
  let captured: any = null
  stub(RewardAllocation, 'findOneAndUpdate', (filter: any, update: any) => {
    captured = { filter, update }
    return chain({ _id: 'alloc-7', planterWallet: PLANTER })
  })
  const enqueued: any[] = []
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async (input: any) => {
      enqueued.push(input)
      return { job: { jobId: 'job-7' } }
    },
  }

  const r = await service.returnAllocationToPlanter(sid, dealId)

  assert.deepEqual(r, {
    returned: true,
    allocationId: 'alloc-7',
    claimJobId: 'job-7',
  })
  assert.equal(captured.filter['otc.hold'], true)
  assert.equal(captured.update.$set['otc.hold'], false)
  assert.ok(captured.update.$set['otc.returnedToPlanterAt'] instanceof Date)
  assert.equal(captured.update.$set.planterWallet, undefined)
  assert.equal(enqueued[0].walletAddress, PLANTER)
})

test('holdAllocationForDeal: only an untouched allocation can be held; exists tells "already paid" from "none yet"', async () => {
  const service = new RewardService() as any
  const sid = new mongoose.Types.ObjectId()
  const dealId = new mongoose.Types.ObjectId()

  let captured: any = null
  stub(RewardAllocation, 'findOneAndUpdate', (filter: any, update: any) => {
    captured = { filter, update }
    return chain({ _id: 'alloc-5' })
  })
  assert.deepEqual(await service.holdAllocationForDeal(sid, dealId, PLANTER), {
    held: true,
    exists: true,
    allocationId: 'alloc-5',
  })
  assert.deepEqual(captured.filter.otc, { $exists: false })
  assert.equal(captured.filter.planterCumulativePaidWei, '0')
  assert.deepEqual(captured.filter.tranches, {
    $not: {
      $elemMatch: {
        $or: [
          { status: { $in: ['paid', 'processing'] } },
          { proposalId: { $exists: true } },
        ],
      },
    },
  })
  assert.equal(captured.update.$set.otc.hold, true)
  assert.equal(captured.update.$set.otc.originalPlanterWallet, PLANTER)
  assert.equal(String(captured.update.$set.otc.dealId), String(dealId))

  // Already paid: exists but not held.
  stub(RewardAllocation, 'findOneAndUpdate', () => chain(null))
  stub(RewardAllocation, 'findOne', () => chain({ _id: 'alloc-5' }))
  assert.deepEqual(await service.holdAllocationForDeal(sid, dealId, PLANTER), {
    held: false,
    exists: true,
    allocationId: 'alloc-5',
  })

  // Re-run for the same deal is idempotent: counts as held.
  stub(RewardAllocation, 'findOne', () =>
    chain({ _id: 'alloc-5', otc: { dealId, hold: true } }),
  )
  assert.deepEqual(await service.holdAllocationForDeal(sid, dealId, PLANTER), {
    held: true,
    exists: true,
    allocationId: 'alloc-5',
  })

  // No allocation yet (submission not approved).
  stub(RewardAllocation, 'findOne', () => chain(null))
  assert.deepEqual(await service.holdAllocationForDeal(sid, dealId, PLANTER), {
    held: false,
    exists: false,
  })
})
