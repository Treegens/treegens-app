import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { splitPlanterPoolForOtc } from './otcPurchaseService'

const ONE = 10n ** 18n
const pid = () => new mongoose.Types.ObjectId()

test('no OTC coverage leaves the whole planter pool with the planter', () => {
  const r = splitPlanterPoolForOtc({
    planterPoolWei: 95n * ONE,
    treesPlanted: 100,
    coverages: [],
  })
  assert.equal(r.planterWei, 95n * ONE)
  assert.equal(r.payouts.length, 0)
  assert.equal(r.treesCovered, 0)
})

test('partial coverage splits the planter pool per tree', () => {
  const buyer = pid()
  const r = splitPlanterPoolForOtc({
    planterPoolWei: 95n * ONE,
    treesPlanted: 100,
    coverages: [{ purchaseId: buyer, buyerWallet: '0xbuyer', trees: 40 }],
  })
  // 40 of 100 trees → 40% of the planter pool goes to the buyer
  assert.equal(r.payouts[0].amountWei, 38n * ONE)
  assert.equal(r.planterWei, 57n * ONE)
  assert.equal(r.treesCovered, 40)
})

test('full coverage leaves the planter with exactly zero, dust included', () => {
  const r = splitPlanterPoolForOtc({
    planterPoolWei: 95n * ONE + 7n, // dust that does not divide evenly
    treesPlanted: 3,
    coverages: [
      { purchaseId: pid(), buyerWallet: '0xa', trees: 2 },
      { purchaseId: pid(), buyerWallet: '0xb', trees: 1 },
    ],
  })
  assert.equal(r.planterWei, 0n)
  assert.equal(r.treesCovered, 3)
  assert.equal(r.payouts.length, 2)
  assert.ok(r.payouts[0].amountWei > r.payouts[1].amountWei)
})

test('coverage beyond the trees planted is rejected', () => {
  assert.throws(() =>
    splitPlanterPoolForOtc({
      planterPoolWei: 95n * ONE,
      treesPlanted: 10,
      coverages: [{ purchaseId: pid(), buyerWallet: '0xa', trees: 11 }],
    }),
  )
})
