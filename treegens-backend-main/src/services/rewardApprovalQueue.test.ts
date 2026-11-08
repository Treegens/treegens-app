import assert from 'node:assert/strict'
import test from 'node:test'
import RewardAllocation from '../models/RewardAllocation'
import { RewardService } from './rewardService'

function makeSubmission() {
  return {
    _id: '507f1f77bcf86cd799439011',
    status: 'approved',
  } as any
}

test('handleSubmissionApproved enqueues planter claim for new allocation', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission()

  service.ensureAllocationFromApprovedSubmission = async () => ({
    created: true,
  })
  let enqueueCalls = 0
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async () => {
      enqueueCalls += 1
      return { job: { jobId: 'job-1' } }
    },
  }

  const originalFindOne = RewardAllocation.findOne
  ;(RewardAllocation as any).findOne = async () => ({
    _id: 'alloc-1',
    planterWallet: '0xplanter',
  })

  try {
    const result = await service.handleSubmissionApproved(submission)
    assert.equal(result.allocationCreated, true)
    assert.equal(result.claimJobEnqueued, true)
    assert.equal(result.claimJobId, 'job-1')
    assert.equal(enqueueCalls, 1)
  } finally {
    ;(RewardAllocation as any).findOne = originalFindOne
  }
})

test('handleSubmissionApproved does not enqueue when allocation already exists', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission()

  service.ensureAllocationFromApprovedSubmission = async () => ({
    created: false,
  })
  let enqueueCalls = 0
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async () => {
      enqueueCalls += 1
      return { job: { jobId: 'job-1' } }
    },
  }

  const originalFindOne = RewardAllocation.findOne
  ;(RewardAllocation as any).findOne = async () => ({
    _id: 'alloc-1',
    planterWallet: '0xplanter',
  })

  try {
    const result = await service.handleSubmissionApproved(submission)
    assert.equal(result.allocationCreated, false)
    assert.equal(result.claimJobEnqueued, false)
    assert.equal(enqueueCalls, 0)
  } finally {
    ;(RewardAllocation as any).findOne = originalFindOne
  }
})

test('handleSubmissionApproved is non-blocking when enqueue fails', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission()

  service.ensureAllocationFromApprovedSubmission = async () => ({
    created: true,
  })
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async () => {
      throw new Error('queue unavailable')
    },
  }

  const originalFindOne = RewardAllocation.findOne
  ;(RewardAllocation as any).findOne = async () => ({
    _id: 'alloc-1',
    planterWallet: '0xplanter',
  })

  try {
    const result = await service.handleSubmissionApproved(submission)
    assert.equal(result.allocationCreated, true)
    assert.equal(result.claimJobEnqueued, false)
  } finally {
    ;(RewardAllocation as any).findOne = originalFindOne
  }
})

test('handleSubmissionApproved queues the OTC buyer mint next to the planter claim', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission()

  service.ensureAllocationFromApprovedSubmission = async () => ({
    created: true,
  })
  const calls: Array<{ walletAddress: string; claimType: string }> = []
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async (input: any) => {
      calls.push({
        walletAddress: input.walletAddress,
        claimType: input.claimType,
      })
      return { job: { jobId: `job-${calls.length}` } }
    },
  }

  const originalFindOne = RewardAllocation.findOne
  ;(RewardAllocation as any).findOne = async () => ({
    _id: 'alloc-1',
    planterWallet: '0xplanter',
    planterTotalWei: '570',
    otcPayouts: [
      {
        purchaseId: 'p1',
        buyerWallet: '0xBuyer',
        trees: 4,
        amountWei: '380',
        status: 'pending',
      },
    ],
  })

  try {
    const result = await service.handleSubmissionApproved(submission)
    assert.equal(result.claimJobEnqueued, true)
    assert.deepEqual(result.otcClaimJobIds, ['job-1'])
    assert.deepEqual(calls, [
      { walletAddress: '0xbuyer', claimType: 'otc' },
      { walletAddress: '0xplanter', claimType: 'planter' },
    ])
  } finally {
    ;(RewardAllocation as any).findOne = originalFindOne
  }
})

test('handleSubmissionApproved queues no planter claim when every tree was pre-sold OTC', async () => {
  const service = new RewardService() as any
  const submission = makeSubmission()

  service.ensureAllocationFromApprovedSubmission = async () => ({
    created: true,
  })
  const calls: Array<{ walletAddress: string; claimType: string }> = []
  service.rewardClaimQueueService = {
    enqueueOrReuseClaimJob: async (input: any) => {
      calls.push({
        walletAddress: input.walletAddress,
        claimType: input.claimType,
      })
      return { job: { jobId: `job-${calls.length}` } }
    },
  }

  const originalFindOne = RewardAllocation.findOne
  ;(RewardAllocation as any).findOne = async () => ({
    _id: 'alloc-1',
    planterWallet: '0xplanter',
    planterTotalWei: '0',
    tranches: [],
    otcPayouts: [
      {
        purchaseId: 'p1',
        buyerWallet: '0xa',
        trees: 3,
        amountWei: '285',
        status: 'pending',
      },
      {
        purchaseId: 'p2',
        buyerWallet: '0xb',
        trees: 7,
        amountWei: '665',
        status: 'paid',
      },
    ],
  })

  try {
    const result = await service.handleSubmissionApproved(submission)
    assert.equal(result.allocationCreated, true)
    assert.equal(result.claimJobEnqueued, false)
    assert.deepEqual(result.otcClaimJobIds, ['job-1'])
    // only the unpaid buyer is queued; the planter never is
    assert.deepEqual(calls, [{ walletAddress: '0xa', claimType: 'otc' }])
  } finally {
    ;(RewardAllocation as any).findOne = originalFindOne
  }
})
