import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TREE_BATCH_SIZE,
  approvedTreeCount,
  batchRejectionReason,
  isFullBatch,
} from './treeBatch'

test('a whole multiple of 100 is a full batch', () => {
  for (const n of [100, 200, 1000, 12_300]) {
    assert.equal(isFullBatch(n), true, `${n} should pass`)
    assert.equal(batchRejectionReason(n), null)
  }
})

test('anything under the batch size is refused', () => {
  for (const n of [0, 1, 99]) {
    assert.equal(isFullBatch(n), false, `${n} should fail`)
    assert.match(String(batchRejectionReason(n)), /under the 100-tree batch/)
  }
})

test('a partial batch says how many trees short it is', () => {
  assert.equal(isFullBatch(143), false)
  assert.match(String(batchRejectionReason(143)), /57 short of 200/)
  assert.match(String(batchRejectionReason(101)), /99 short of 200/)
})

test('the batch size is Jimi’s 100 and the rails agree on it', () => {
  assert.equal(TREE_BATCH_SIZE, 100)
})

test('mangroves are counted by AI, not by what the planter declared', () => {
  // The whole point: a planter claiming 200 with an AI count of 143 must be
  // gated on 143, or the batch rule is trivially bypassed.
  assert.equal(
    approvedTreeCount({
      treeType: 'Mangrove',
      treesPlanted: 200,
      aiVerification: { countedMangroves: 143 },
    }),
    143,
  )
})

test('non-mangroves fall back to the declared count', () => {
  assert.equal(
    approvedTreeCount({ treeType: 'acacia', treesPlanted: 300 }),
    300,
  )
})

test('a missing count is zero, never NaN', () => {
  assert.equal(approvedTreeCount({ treeType: 'mangrove' }), 0)
  assert.equal(approvedTreeCount({}), 0)
  assert.equal(
    approvedTreeCount({ treeType: 'mangrove', aiVerification: null }),
    0,
  )
  assert.equal(isFullBatch(approvedTreeCount({})), false)
})
