import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canTransition,
  computeDealAmountKes,
  dealTreeCountFromAi,
  expectedPlanterMgroWei,
  generateInviteCode,
  INVITE_CODE_LENGTH,
  isFundableCount,
  isOtcBuyerWallet,
  isTerminalStatus,
  isValidInviteCode,
  mpesaRefMatches,
  normalizeMpesaNumber,
  normalizeMpesaRef,
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
    ['disputed', 'confirmed'], // buyer resolve: release_to_buyer
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

test('isFundableCount follows the 100-tree batch gate', () => {
  const prev = process.env.ENFORCE_TREE_BATCHES
  try {
    delete process.env.ENFORCE_TREE_BATCHES
    assert.deepEqual(isFundableCount(100), { ok: true, reason: null })
    assert.deepEqual(isFundableCount(300), { ok: true, reason: null })
    const r143 = isFundableCount(143)
    assert.equal(r143.ok, false)
    assert.match(String(r143.reason), /143 trees/)
    const r50 = isFundableCount(50)
    assert.equal(r50.ok, false)
    assert.match(String(r50.reason), /batch minimum/)
    assert.equal(isFundableCount(0).ok, false)
    assert.equal(isFundableCount(NaN).ok, false)

    process.env.ENFORCE_TREE_BATCHES = 'false'
    assert.deepEqual(isFundableCount(143), { ok: true, reason: null })
    assert.equal(isFundableCount(0).ok, false)
  } finally {
    if (prev === undefined) delete process.env.ENFORCE_TREE_BATCHES
    else process.env.ENFORCE_TREE_BATCHES = prev
  }
})

test('normalizeMpesaRef accepts only 10 upper-case alphanumerics', () => {
  assert.equal(normalizeMpesaRef('qhx7k2m9pl'), 'QHX7K2M9PL')
  assert.equal(normalizeMpesaRef('  QHX7K2M9PL '), 'QHX7K2M9PL')
  assert.equal(normalizeMpesaRef('QHX7K2M9P'), null)
  assert.equal(normalizeMpesaRef('QHX7K2M9PLX'), null)
  assert.equal(normalizeMpesaRef('QHX7-K2M9P'), null)
  assert.equal(normalizeMpesaRef(''), null)
  assert.equal(normalizeMpesaRef(undefined), null)
  assert.equal(normalizeMpesaRef(1234567890), null)
})

test('mpesaRefMatches is case-insensitive and rejects invalid codes', () => {
  assert.equal(mpesaRefMatches('qhx7k2m9pl', 'QHX7K2M9PL'), true)
  assert.equal(mpesaRefMatches('QHX7K2M9PL', 'QHX7K2M9PX'), false)
  assert.equal(mpesaRefMatches('', ''), false)
  assert.equal(mpesaRefMatches(undefined, 'QHX7K2M9PL'), false)
})
