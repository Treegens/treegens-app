import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import {
  RewardService,
  calculateRewardStatusProjection,
  computeLatestDueCheckpointOneBased,
  computeSurvivalPlanterTargetCumulativeWei,
  getClaimScheduleConfig,
} from './rewardService'

function makeBaseAllocation() {
  const approvedAt = new Date('2026-01-01T00:00:00.000Z')
  return {
    _id: 'alloc-1',
    submissionId: '507f1f77bcf86cd799439011',
    approvedAt,
    planterWallet: '0xplanter',
    planterTotalWei: '600',
    verifierPoolWei: '0',
    verifierRewardWei: '0',
    yesVoterCount: 0,
    treesPlanted: 10,
    planterCumulativePaidWei: '0',
    verifierClaims: [],
    tranches: [
      {
        index: 0,
        amountWei: '100',
        unlockAt: new Date('2026-01-01T00:00:00.000Z'),
        status: 'paid',
      },
      {
        index: 1,
        amountWei: '100',
        unlockAt: new Date('2026-07-01T00:00:00.000Z'),
        status: 'pending',
      },
      {
        index: 2,
        amountWei: '100',
        unlockAt: new Date('2027-01-01T00:00:00.000Z'),
        status: 'pending',
      },
      {
        index: 3,
        amountWei: '100',
        unlockAt: new Date('2027-07-01T00:00:00.000Z'),
        status: 'pending',
      },
      {
        index: 4,
        amountWei: '100',
        unlockAt: new Date('2028-01-01T00:00:00.000Z'),
        status: 'pending',
      },
      {
        index: 5,
        amountWei: '100',
        unlockAt: new Date('2028-07-01T00:00:00.000Z'),
        status: 'pending',
      },
    ],
  }
}

test('returns NEXT_CLAIM when next tranche not yet due', () => {
  const allocation = makeBaseAllocation()
  const now = new Date('2026-02-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
  )

  assert.equal(status.displayState, 'NEXT_CLAIM')
  assert.equal(status.claimedAmountWei, '100')
  assert.equal(status.pendingClaimAmountWei, '0')
  assert.equal(status.nextClaimAmountWei, '100')
  assert.equal(status.canClaim, false)
})

test('returns one missed interval as pending claim', () => {
  const allocation = makeBaseAllocation()
  const now = new Date('2026-09-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
  )

  assert.equal(status.displayState, 'PENDING_CLAIM')
  assert.equal(status.pendingClaimAmountWei, '100')
  assert.equal(status.intervalsMissed, 1)
  assert.equal(status.nextClaimAmountWei, null)
  assert.equal(status.canClaim, true)
})

test('aggregates multiple missed intervals as pending claim', () => {
  const allocation = makeBaseAllocation()
  const now = new Date('2027-10-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
  )

  assert.equal(status.displayState, 'PENDING_CLAIM')
  assert.equal(status.pendingClaimAmountWei, '300')
  assert.equal(status.intervalsMissed, 3)
  assert.equal(status.canClaim, true)
})

test('returns COMPLETED when all tranches are paid', () => {
  const allocation = makeBaseAllocation()
  allocation.tranches.forEach((t: any) => {
    t.status = 'paid'
  })
  const now = new Date('2028-08-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
  )

  assert.equal(status.displayState, 'COMPLETED')
  assert.equal(status.scheduleCompleted, true)
  assert.equal(status.claimedAmountWei, '600')
  assert.equal(status.pendingClaimAmountWei, '0')
  assert.equal(status.canClaim, false)
})

test('returns verifier pending claim projection', () => {
  const allocation = makeBaseAllocation()
  allocation.verifierPoolWei = '100'
  allocation.yesVoterCount = 2
  allocation.verifierRewardWei = '50'
  const submission = {
    votes: [
      { voterWalletAddress: '0xaa', vote: 'yes' },
      { voterWalletAddress: '0xverifier', vote: 'yes' },
    ],
  }
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xverifier',
    new Date('2026-02-01T00:00:00.000Z'),
    submission as any,
  )

  assert.equal(status.role, 'verifier')
  assert.equal(status.displayState, 'PENDING_CLAIM')
  assert.equal(status.pendingClaimAmountWei, '50')
  assert.equal(status.nextClaimAmountWei, null)
  assert.equal(status.canClaim, true)
})

test('survival projection disables claim when due checkpoint payNow is zero', () => {
  const allocation = makeBaseAllocation()
  const { totalTranches } = getClaimScheduleConfig()
  allocation.treesPlanted = 10
  allocation.planterCumulativePaidWei =
    computeSurvivalPlanterTargetCumulativeWei({
      planterTotalWei: 600n,
      checkpointOneBased: 2,
      initialTrees: 10,
      treesAlive: 0,
      totalTranches,
    }).toString()
  const now = new Date('2026-09-01T00:00:00.000Z')
  const healthChecks = [
    {
      checkpointIndex: 2,
      status: 'approved',
      treesAlive: 0,
      distanceMeters: 0,
    },
  ]
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
    undefined,
    healthChecks as any,
  )

  assert.equal(status.pendingClaimAmountWei, '0')
  assert.equal(status.canClaim, false)
})

test('latest due checkpoint is capped by tranche count', () => {
  const k = computeLatestDueCheckpointOneBased({
    approvedAt: new Date('2026-01-01T00:00:00.000Z'),
    now: new Date('2028-12-01T00:00:00.000Z'),
    intervalSeconds: 60 * 60 * 24 * 30,
    totalTranches: 6,
  })
  assert.equal(k, 6)
})

test('survival projection allows catch-up claim from latest approved checkpoint', () => {
  const allocation = makeBaseAllocation()
  allocation.tranches[0].status = 'paid'
  allocation.tranches[1].status = 'pending'
  allocation.tranches[2].status = 'pending'
  allocation.tranches[3].status = 'pending'
  allocation.planterCumulativePaidWei = '100'
  allocation.treesPlanted = 10

  const now = new Date('2027-10-01T00:00:00.000Z')
  const healthChecks = [
    {
      checkpointIndex: 4,
      status: 'approved',
      treesAlive: 10,
      distanceMeters: 0,
    },
  ]

  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
    undefined,
    healthChecks as any,
  )

  assert.equal(status.nextPlanterAction, 'claim')
  assert.equal(status.canClaim, true)
  assert.equal(status.pendingClaimAmountWei, '300')
  assert.equal(status.intervalsMissed, 3)
})

test('survival projection requests a health check at latest due checkpoint', () => {
  const allocation = makeBaseAllocation()
  allocation.tranches[0].status = 'paid'
  allocation.tranches[1].status = 'pending'
  allocation.tranches[2].status = 'pending'
  allocation.planterCumulativePaidWei = '100'
  allocation.treesPlanted = 10

  const now = new Date('2027-02-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
    undefined,
    [] as any,
  )
  const { intervalSeconds, totalTranches } = getClaimScheduleConfig()
  const expectedCheckpoint = computeLatestDueCheckpointOneBased({
    approvedAt: allocation.approvedAt,
    now,
    intervalSeconds,
    totalTranches,
  })

  assert.equal(status.nextPlanterAction, 'health_check')
  assert.equal(status.healthCheckRequiredForNextClaim, true)
  assert.equal(status.pendingHealthCheckpointIndex, expectedCheckpoint)
})

test('survival projection keeps next countdown moving while health check is pending', () => {
  const allocation = makeBaseAllocation()
  allocation.tranches[0].status = 'paid'
  allocation.tranches[1].status = 'pending'
  allocation.tranches[2].status = 'pending'
  allocation.tranches[3].status = 'pending'
  allocation.planterCumulativePaidWei = '100'
  allocation.treesPlanted = 10

  const now = new Date('2027-02-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
    undefined,
    [] as any,
  )

  assert.equal(status.nextPlanterAction, 'health_check')
  assert.equal(status.displayState, 'NEXT_CLAIM')
  assert.notEqual(status.nextClaimAt, null)
  assert.ok((status.remainingMs ?? 0) > 0)
})

test('survival projection keeps health-check action visible after final round boundary', () => {
  const allocation = makeBaseAllocation()
  allocation.tranches[0].status = 'paid'
  allocation.tranches[1].status = 'paid'
  allocation.tranches[2].status = 'paid'
  allocation.tranches[3].status = 'paid'
  allocation.tranches[4].status = 'paid'
  allocation.tranches[5].status = 'pending'
  allocation.planterCumulativePaidWei = '500'
  allocation.treesPlanted = 10

  const now = new Date('2028-08-01T00:00:00.000Z')
  const status = calculateRewardStatusProjection(
    allocation as any,
    '0xplanter',
    now,
    undefined,
    [] as any,
  )

  assert.equal(status.nextPlanterAction, 'health_check')
  assert.equal(status.nextClaimAt, null)
  assert.equal(status.remainingMs, null)
  assert.equal(status.displayState, 'NEXT_CLAIM')
})

// ---------------------------------------------------------------- OTC ----

test('OTC-funded allocation routes the pre-paid trees to the buyer, rest to the planter', () => {
  const service = new RewardService()
  const purchaseId = new mongoose.Types.ObjectId()
  const fields = service.buildAllocationFields(
    {
      _id: new mongoose.Types.ObjectId(),
      userWalletAddress: '0xPlanter',
      treesPlanted: 10,
      votes: [{ voterWalletAddress: '0xv1', vote: 'yes' }],
    },
    [{ purchaseId, buyerWallet: '0xBuyer', trees: 4 }],
  ) as any
  const ONE = 10n ** 18n
  // 10 MGRO total: 0.5 verifier pool, 9.5 planter pool → 40% (3.8) to the buyer
  assert.equal(fields.totalMgroWei, (10n * ONE).toString())
  assert.equal(fields.verifierPoolWei, ((10n * ONE * 5n) / 100n).toString())
  assert.equal(fields.otcTreesCovered, 4)
  assert.equal(fields.otcPayouts.length, 1)
  assert.equal(fields.otcPayouts[0].buyerWallet, '0xBuyer')
  assert.equal(fields.otcPayouts[0].status, 'pending')
  assert.equal(
    fields.otcPayouts[0].amountWei,
    ((((95n * ONE) / 10n) * 4n) / 10n).toString(),
  )
  assert.equal(fields.otcTotalWei, fields.otcPayouts[0].amountWei)
  assert.equal(
    BigInt(fields.planterTotalWei) + BigInt(fields.otcTotalWei),
    BigInt(fields.totalMgroWei) - BigInt(fields.verifierPoolWei),
  )
  assert.ok(
    fields.tranches.length > 0,
    'planter keeps a schedule for the 6 uncovered trees',
  )
})

test('fully OTC-funded allocation gives the planter no schedule at all', () => {
  const service = new RewardService()
  const fields = service.buildAllocationFields(
    {
      _id: new mongoose.Types.ObjectId(),
      userWalletAddress: '0xplanter',
      treesPlanted: 5,
      votes: [],
    },
    [
      {
        purchaseId: new mongoose.Types.ObjectId(),
        buyerWallet: '0xbuyer',
        trees: 5,
      },
    ],
  ) as any
  assert.equal(fields.planterTotalWei, '0')
  assert.equal(fields.tranches.length, 0)
  assert.equal(fields.otcTreesCovered, 5)
  assert.equal(
    BigInt(fields.otcTotalWei),
    BigInt(fields.totalMgroWei) - BigInt(fields.verifierPoolWei),
  )
})

function makeOtcAllocation(status: 'pending' | 'paid' = 'pending') {
  const allocation: any = makeBaseAllocation()
  allocation.planterTotalWei = '0'
  allocation.tranches = []
  allocation.otcTreesCovered = 10
  allocation.otcTotalWei = '600'
  allocation.otcPayouts = [
    {
      purchaseId: '507f1f77bcf86cd799439099',
      buyerWallet: '0xbuyer',
      trees: 10,
      amountWei: '600',
      status,
      txHash: status === 'paid' ? '0xtx' : undefined,
    },
  ]
  return allocation
}

test('OTC buyer sees an otc_buyer projection with the pending payout', () => {
  const status = calculateRewardStatusProjection(
    makeOtcAllocation(),
    '0xBUYER',
    new Date('2026-02-01T00:00:00.000Z'),
    { votes: [] },
    [],
  )
  assert.equal(status.role, 'otc_buyer')
  assert.equal(status.totalRewardWei, '600')
  assert.equal(status.pendingClaimAmountWei, '600')
  assert.equal(status.canClaim, true)
  assert.equal(status.displayState, 'PENDING_CLAIM')
  assert.equal(status.otcBuyer?.trees, 10)
})

test('OTC buyer projection is COMPLETED once the mint landed', () => {
  const status = calculateRewardStatusProjection(
    makeOtcAllocation('paid'),
    '0xbuyer',
    new Date('2026-02-01T00:00:00.000Z'),
    { votes: [] },
    [],
  )
  assert.equal(status.role, 'otc_buyer')
  assert.equal(status.claimedAmountWei, '600')
  assert.equal(status.canClaim, false)
  assert.equal(status.displayState, 'COMPLETED')
  assert.deepEqual(status.otcBuyer?.txHashes, ['0xtx'])
})

test('planter of a fully pre-sold planting has nothing to claim and is not asked for health checks', () => {
  const status = calculateRewardStatusProjection(
    makeOtcAllocation(),
    '0xplanter',
    new Date('2027-10-01T00:00:00.000Z'), // several checkpoints due
    { votes: [] },
    [],
  )
  assert.equal(status.role, 'planter')
  assert.equal(status.totalRewardWei, '0')
  assert.equal(status.canClaim, false)
  assert.equal(status.scheduleCompleted, true)
  assert.equal(status.displayState, 'COMPLETED')
  assert.equal(status.healthCheckRequiredForNextClaim, false)
  assert.equal(status.nextPlanterAction, 'wait')
  assert.equal(status.otc?.treesCovered, 10)
  assert.equal(status.otc?.payouts[0].buyerWallet, '0xbuyer')
  assert.equal(status.otcBuyer, undefined)
})

test('a wallet with no part in the allocation is still rejected', () => {
  assert.throws(() =>
    calculateRewardStatusProjection(
      makeOtcAllocation(),
      '0xstranger',
      new Date('2026-02-01T00:00:00.000Z'),
      { votes: [] },
      [],
    ),
  )
})

test('getClaimEligibility flags OTC buyers', () => {
  const service = new RewardService()
  const allocation = makeOtcAllocation()
  const e = service.getClaimEligibility(
    { status: 'approved', votes: [] },
    allocation,
    '0xBuyer',
  )
  assert.deepEqual(e, { planter: false, verifier: false, otc: true })
  const p = service.getClaimEligibility(
    { status: 'approved', votes: [] },
    allocation,
    '0xplanter',
  )
  assert.deepEqual(p, { planter: true, verifier: false, otc: false })
})
