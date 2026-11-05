import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canTransition,
  computeDealAmountKes,
  dealTreeCountFromAi,
  expectedPlanterMgroWei,
  generateInviteCode,
  INVITE_CODE_LENGTH,
  isOtcBuyerWallet,
  isTerminalStatus,
  isValidInviteCode,
  normalizeMpesaNumber,
  OTC_DEAL_STATUSES,
  totalMgroWeiForTrees,
} from './otcDealRules'
import { computeTotalMgroWei, RewardService } from './rewardService'

test('normalizeMpesaNumber handles Kenyan local formats', () => {
  const cases: Array<[string, string]> = [
    ['0712345678', '+254712345678'],
    ['0112345678', '+254112345678'],
    ['712345678', '+254712345678'],
    ['112345678', '+254112345678'],
    ['254712345678', '+254712345678'],
    ['+254712345678', '+254712345678'],
    ['+254 712 345 678', '+254712345678'],
    ['0712-345-678', '+254712345678'],
    ['(0712) 345 678', '+254712345678'],
    ['0712.345.678', '+254712345678'],
    ['+0712345678', '+254712345678'], // stray plus, still clearly Kenyan
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeMpesaNumber(input), expected, `input ${input}`)
  }
})

test('normalizeMpesaNumber accepts other E.164 numbers as-is', () => {
  assert.equal(normalizeMpesaNumber('+255712345678'), '+255712345678')
  assert.equal(normalizeMpesaNumber('255712345678'), '+255712345678')
  assert.equal(normalizeMpesaNumber('+233241234567'), '+233241234567')
})

test('normalizeMpesaNumber rejects garbage', () => {
  for (const bad of [
    '',
    '   ',
    'abc',
    '07123',
    '0812345678', // Kenyan 08 is not a mobile prefix
    '07123456789', // too long for KE local
    '+',
    '1234', // too short
    '0000000000',
    null,
    undefined,
    12345,
  ]) {
    assert.equal(normalizeMpesaNumber(bad), null, `input ${String(bad)}`)
  }
})

test('computeDealAmountKes rounds to whole shillings and never goes negative', () => {
  assert.equal(computeDealAmountKes(100, 10), 1000)
  assert.equal(computeDealAmountKes(143, 7.5), 1073) // 1072.5 rounds up
  assert.equal(computeDealAmountKes(3, 0.3), 1) // 0.9 -> 1
  assert.equal(computeDealAmountKes(0, 10), 0)
  assert.equal(computeDealAmountKes(10, 0), 0)
  assert.equal(computeDealAmountKes(-5, 10), 0)
  assert.equal(computeDealAmountKes(NaN, 10), 0)
  assert.equal(computeDealAmountKes(10, Infinity), 0)
})

test('expected MGRO matches the reward allocation planter share exactly', () => {
  const trees = 300
  assert.equal(totalMgroWeiForTrees(trees), computeTotalMgroWei(trees))

  const service = new RewardService()
  const fields = service.buildAllocationFields({
    _id: '507f1f77bcf86cd799439011' as any,
    userWalletAddress: '0xPlanter',
    treesPlanted: trees,
    votes: [],
  })
  assert.ok(fields)
  assert.equal(expectedPlanterMgroWei(trees), fields!.planterTotalWei)
})

test('transition matrix: only the documented moves are legal', () => {
  const legal: Array<[string, string]> = [
    ['awaiting_count', 'awaiting_payment'],
    ['awaiting_count', 'cancelled'],
    ['awaiting_payment', 'payment_sent'],
    ['awaiting_payment', 'cancelled'],
    ['payment_sent', 'payment_sent'],
    ['payment_sent', 'confirmed'],
    ['payment_sent', 'disputed'],
    ['payment_sent', 'cancelled'],
    ['disputed', 'payment_sent'],
    ['disputed', 'cancelled'],
  ]
  const legalSet = new Set(legal.map(([a, b]) => `${a}>${b}`))
  for (const from of OTC_DEAL_STATUSES) {
    for (const to of OTC_DEAL_STATUSES) {
      assert.equal(
        canTransition(from, to),
        legalSet.has(`${from}>${to}`),
        `${from} -> ${to}`,
      )
    }
  }
  // Terminal states never move; confirmed can never be cancelled.
  assert.equal(canTransition('confirmed', 'cancelled'), false)
  assert.equal(canTransition('cancelled', 'awaiting_payment'), false)
  assert.equal(canTransition('bogus', 'confirmed'), false)
  assert.equal(isTerminalStatus('confirmed'), true)
  assert.equal(isTerminalStatus('cancelled'), true)
  assert.equal(isTerminalStatus('payment_sent'), false)
})

test('invite codes use the unambiguous alphabet and validate', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateInviteCode()
    assert.equal(code.length, INVITE_CODE_LENGTH)
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/)
    assert.equal(isValidInviteCode(code), true)
  }
  assert.equal(isValidInviteCode('ABCDEFGHJ0'), false) // 0 not in alphabet
  assert.equal(isValidInviteCode('abcdefghjk'), false) // lowercase
  assert.equal(isValidInviteCode('SHORT'), false)
  assert.equal(isValidInviteCode(undefined), false)
})

test('isOtcBuyerWallet compares case-insensitively', () => {
  const allow = ['0xABCDEFabcdef0123456789abcdef0123456789AB']
  assert.equal(
    isOtcBuyerWallet('0xabcdefabcdef0123456789abcdef0123456789ab', allow),
    true,
  )
  assert.equal(
    isOtcBuyerWallet('0x0000000000000000000000000000000000000001', allow),
    false,
  )
  assert.equal(isOtcBuyerWallet('', allow), false)
  assert.equal(isOtcBuyerWallet(undefined, []), false)
})

test('dealTreeCountFromAi only trusts a completed AI count', () => {
  assert.equal(
    dealTreeCountFromAi({
      treeType: 'mangrove',
      aiVerification: { status: 'completed', countedMangroves: 200 },
    }),
    200,
  )
  assert.equal(
    dealTreeCountFromAi({
      treeType: 'mangrove',
      aiVerification: { status: 'completed', countedMangroves: 0 },
    }),
    0,
  )
  assert.equal(
    dealTreeCountFromAi({
      treeType: 'mangrove',
      aiVerification: { status: 'failed', countedMangroves: 200 },
    }),
    null,
  )
  assert.equal(
    dealTreeCountFromAi({
      treeType: 'mangrove',
      aiVerification: { status: 'skipped' },
    }),
    null,
  )
  assert.equal(dealTreeCountFromAi({ treeType: 'baobab' }), null)
})
