import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySlippage,
  batchKey,
  boolFromEnv,
  centsToDollars,
  centsToUsdcMicro,
  DEAD_ADDRESS,
  describePath,
  encodeV3Path,
  idempotencyKey,
  isDonationCredit,
  isTxHash,
  listFromEnv,
  matchUsdcArrival,
  numberFromEnv,
  parseEnum,
  pickWithinCap,
  postedTime,
  releaseTargetStatus,
  sameAddress,
  stageForStatus,
  stageFromHoldReason,
  stripeMinorToUsdcMicro,
  sweepAmountCents,
  usdcMicroToCents,
  usdToCents,
  why,
} from './treasuryMath'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const MGRO = '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568'

test('amounts convert between cents, dollars and USDC base units without floats', () => {
  assert.equal(usdToCents(19.99), 1999)
  assert.equal(usdToCents(0.1 + 0.2), 30)
  assert.equal(centsToDollars(1999), 19.99)
  assert.equal(centsToUsdcMicro(12345), 123_450_000n)
  assert.equal(usdcMicroToCents(123_456_789n), 12345)
  assert.equal(stripeMinorToUsdcMicro(250), 2_500_000n)
})

test('slippage is applied in basis points and clamped to a sane range', () => {
  assert.equal(applySlippage(1_000_000n, 3), 970_000n)
  assert.equal(applySlippage(1_000_000n, 0.5), 995_000n)
  assert.equal(applySlippage(1_000_000n, -5), 1_000_000n)
  assert.equal(applySlippage(1_000_000n, 80), 500_000n)
})

test('sweep amount keeps the reserve at the bank and respects the cap', () => {
  assert.equal(sweepAmountCents(10_000, 0, 1_000_000), 10_000)
  assert.equal(sweepAmountCents(10_000, 10, 1_000_000), 9_000)
  assert.equal(sweepAmountCents(10_000, 0, 2_500), 2_500)
  assert.equal(sweepAmountCents(999, 33, 1_000_000), 669)
  assert.equal(sweepAmountCents(100, 100, 1_000_000), 0)
})

test('donation credits: posted, positive, of a donation kind, not our own money coming back', () => {
  const filter = {
    kinds: new Set(['externalTransfer', 'incomingDomesticWire']),
    minCents: 100,
    excludeCounterpartyIds: new Set(['recp_stripe']),
  }
  const ok = {
    id: 't1',
    amount: 250,
    status: 'sent',
    kind: 'externalTransfer',
    counterpartyId: 'recp_donor',
  }
  assert.equal(isDonationCredit(ok, filter), true)
  assert.equal(isDonationCredit({ ...ok, amount: -250 }, filter), false)
  assert.equal(isDonationCredit({ ...ok, status: 'pending' }, filter), false)
  assert.equal(
    isDonationCredit({ ...ok, kind: 'internalTransfer' }, filter),
    false,
  )
  assert.equal(isDonationCredit({ ...ok, amount: 0.5 }, filter), false)
  assert.equal(
    isDonationCredit({ ...ok, counterpartyId: 'recp_stripe' }, filter),
    false,
  )
  assert.equal(
    isDonationCredit(
      { ...ok, kind: 'other' },
      { ...filter, kinds: new Set<string>() },
    ),
    true,
  )
})

test('postedTime prefers postedAt and tolerates garbage', () => {
  assert.equal(
    postedTime({
      id: 'a',
      amount: 1,
      postedAt: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
    }),
    Date.parse('2026-10-01T00:00:00.000Z'),
  )
  assert.equal(
    postedTime({ id: 'a', amount: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
    Date.parse('2026-09-01T00:00:00.000Z'),
  )
  assert.equal(postedTime({ id: 'a', amount: 1, postedAt: 'nope' }), 0)
})

test('idempotency keys are stable, and the batch key ignores member order', () => {
  assert.equal(idempotencyKey('abc', 'onramp'), 'tg-donation-abc-onramp')
  const a = batchKey(['f1:0', 'f2:0', 'f3:1'])
  const b = batchKey(['f3:1', 'f1:0', 'f2:0'])
  assert.equal(a, b)
  assert.match(a, /^tg-sweep-[0-9a-f]{24}$/)
  assert.notEqual(a, batchKey(['f1:0', 'f2:0', 'f3:2']))
})

test('pickWithinCap takes what fits, first come first served, and defers zero amounts', () => {
  const items = [
    { id: 'a', cents: 600 },
    { id: 'b', cents: 500 },
    { id: 'c', cents: 300 },
    { id: 'd', cents: 0 },
  ]
  const { picked, deferred } = pickWithinCap(items, i => i.cents, 1000)
  assert.deepEqual(
    picked.map(i => i.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    deferred.map(i => i.id),
    ['b', 'd'],
  )
})

test('stage bookkeeping maps statuses, hold reasons and release targets', () => {
  assert.equal(stageForStatus('detected'), 'sweep')
  assert.equal(stageForStatus('swept'), 'onramp')
  assert.equal(stageForStatus('onramped'), 'swap')
  assert.equal(stageForStatus('bought'), 'settle')
  assert.equal(stageForStatus('settled'), null)
  assert.equal(stageForStatus('held'), null)
  assert.equal(releaseTargetStatus('sweep'), 'detected')
  assert.equal(releaseTargetStatus('onramp'), 'swept')
  assert.equal(releaseTargetStatus('swap'), 'onramped')
  assert.equal(releaseTargetStatus('settle'), 'bought')
  assert.equal(releaseTargetStatus('anything else'), 'detected')
  assert.equal(stageFromHoldReason('swap: no liquidity'), 'swap')
  assert.equal(stageFromHoldReason('settle: admin hold: x'), 'settle')
  assert.equal(stageFromHoldReason('admin: x'), null)
  assert.equal(stageFromHoldReason(''), null)
})

test('matchUsdcArrival picks the earliest unclaimed transfer inside the fee window', () => {
  const expected = 100_000_000n // 100 USDC
  const candidates = [
    { txHash: '0xaa', value: 99_000_000n, blockNumber: 50 },
    { txHash: '0xbb', value: 98_500_000n, blockNumber: 40 },
    { txHash: '0xcc', value: 150_000_000n, blockNumber: 30 },
    { txHash: '0xdd', value: 80_000_000n, blockNumber: 20 },
  ]
  assert.equal(
    matchUsdcArrival(expected, candidates, new Set())?.txHash,
    '0xbb',
  )
  assert.equal(
    matchUsdcArrival(expected, candidates, new Set(['0xbb']))?.txHash,
    '0xaa',
  )
  assert.equal(matchUsdcArrival(expected, [], new Set()), null)
  assert.equal(matchUsdcArrival(0n, candidates, new Set()), null)
  // 102% is the ceiling: a slightly larger transfer still matches, a much larger one never does
  assert.equal(
    matchUsdcArrival(
      expected,
      [{ txHash: '0xee', value: 101_000_000n, blockNumber: 1 }],
      new Set(),
    )?.txHash,
    '0xee',
  )
})

test('encodeV3Path packs address/uint24 pairs the way the router reads them', () => {
  const single = encodeV3Path([USDC, MGRO], [500])
  assert.equal(single.length, 2 + (20 + 3 + 20) * 2)
  assert.equal(single.slice(2, 42).toLowerCase(), USDC.slice(2).toLowerCase())
  assert.equal(single.slice(42, 48), '0001f4')
  const double = encodeV3Path([USDC, WETH, MGRO], [500, 10000])
  assert.equal(double.length, 2 + (20 + 3 + 20 + 3 + 20) * 2)
  assert.equal(double.slice(88, 94), '002710')
  assert.throws(() => encodeV3Path([USDC, MGRO], [500, 3000]))
  assert.equal(
    describePath(['USDC', 'WETH', 'MGRO'], [500, 10000]),
    'USDC-500-WETH-10000-MGRO',
  )
})

test('env parsing helpers fall back safely', () => {
  assert.equal(
    parseEnum('LIVE', ['dry_run', 'live'] as const, 'dry_run'),
    'live',
  )
  assert.equal(
    parseEnum('yolo', ['dry_run', 'live'] as const, 'dry_run'),
    'dry_run',
  )
  assert.equal(parseEnum(undefined, ['a', 'b'] as const, 'b'), 'b')
  assert.equal(numberFromEnv('', 7), 7)
  assert.equal(numberFromEnv('12.5', 7), 12.5)
  assert.equal(numberFromEnv('-1', 7, 0), 7)
  assert.equal(numberFromEnv('abc', 7), 7)
  assert.equal(boolFromEnv('true'), true)
  assert.equal(boolFromEnv('1'), true)
  assert.equal(boolFromEnv('no'), false)
  assert.equal(boolFromEnv(undefined, true), true)
  assert.deepEqual(listFromEnv(' a, b ,,c ', ['x']), ['a', 'b', 'c'])
  assert.deepEqual(listFromEnv('', ['x']), ['x'])
})

test('address and hash helpers', () => {
  assert.equal(sameAddress(MGRO, MGRO.toLowerCase()), true)
  assert.equal(sameAddress(MGRO, USDC), false)
  assert.equal(sameAddress('nope', MGRO), false)
  assert.equal(DEAD_ADDRESS, '0x000000000000000000000000000000000000dEaD')
  assert.equal(isTxHash('0x' + 'ab'.repeat(32)), true)
  assert.equal(isTxHash('0x1234'), false)
  assert.equal(why(new Error('boom')), 'boom')
  assert.equal(why('plain'), 'plain')
  assert.equal(why({ a: 1 }), '{"a":1}')
})
