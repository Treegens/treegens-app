import assert from 'node:assert/strict'
import test from 'node:test'
import {
  afterCursor,
  clampInt,
  compareFlowDesc,
  decimalToWeiString,
  decodeCursor,
  encodeCursor,
  explorerTxUrl,
  isMangrove,
  labelAddress,
  parseKinds,
  publicGps,
  shortAddress,
  sumWei,
} from './transparencyFormat'

const known = {
  mgro: '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568',
  tgn: '0xD75dfa972C6136f1c594Fec1945302f885E1ab29',
  tgnVault: '0x82a54F550131140Cc08Cf2b10Aa3a44fFDDa582C',
  verifierMinter: '0xE73941B1Ae8f630b6Ab2FDd73041bc92B13e397E',
  delegationRegistry: '0x9f122be6c32fdabe344e195d854a497353f3d162',
  treasurySafe: '0x64b05503c6F2233d279E6B8B8f2Da6936dEd584C',
  minters: ['0xE73941B1Ae8f630b6Ab2FDd73041bc92B13e397E'],
}

test('compareFlowDesc orders newest first and breaks ties by id', () => {
  const a = { at: '2026-01-01T00:00:00.000Z', id: 'reward:a' }
  const b = { at: '2026-01-02T00:00:00.000Z', id: 'reward:b' }
  const c = { at: '2026-01-01T00:00:00.000Z', id: 'reward:c' }
  const sorted = [a, b, c].sort(compareFlowDesc)
  assert.deepEqual(
    sorted.map(x => x.id),
    ['reward:b', 'reward:c', 'reward:a'],
  )
})

test('cursor round-trips and afterCursor skips everything up to the cursor item', () => {
  const items = [
    { at: '2026-01-03T00:00:00.000Z', id: 'x:3' },
    { at: '2026-01-02T00:00:00.000Z', id: 'x:2b' },
    { at: '2026-01-02T00:00:00.000Z', id: 'x:2a' },
    { at: '2026-01-01T00:00:00.000Z', id: 'x:1' },
  ]
  const cursor = decodeCursor(encodeCursor(items[1]))
  assert.ok(cursor)
  const rest = afterCursor(items, cursor)
  assert.deepEqual(
    rest.map(i => i.id),
    ['x:2a', 'x:1'],
  )
  assert.equal(decodeCursor('not-a-cursor'), null)
  assert.equal(decodeCursor(''), null)
})

test('parseKinds keeps only known kinds and dedupes', () => {
  assert.deepEqual(parseKinds('funding,reward,reward,bogus'), [
    'funding',
    'reward',
  ])
  assert.equal(parseKinds(''), null)
  assert.equal(parseKinds('bogus'), null)
})

test('clampInt and sumWei are defensive', () => {
  assert.equal(clampInt('500', 50, 1, 200), 200)
  assert.equal(clampInt('abc', 50, 1, 200), 50)
  assert.equal(clampInt('0', 50, 1, 200), 1)
  assert.equal(sumWei(['1', '2', null, 'x', '3']), '6')
  assert.equal(sumWei([]), '0')
})

test('address and tx helpers', () => {
  assert.equal(shortAddress(known.mgro), '0x46e5…8568')
  assert.equal(shortAddress('nope'), 'nope')
  assert.equal(
    explorerTxUrl('https://basescan.org', '0x' + 'ab'.repeat(32)),
    'https://basescan.org/tx/0x' + 'ab'.repeat(32),
  )
  assert.equal(
    explorerTxUrl('https://basescan.org', 'verifier-proposal-3'),
    undefined,
  )
})

test('labelAddress names system contracts and wallet roles', () => {
  assert.equal(labelAddress(known.mgro.toLowerCase(), known), '$MGRO token')
  assert.equal(
    labelAddress(known.treasurySafe, known),
    'Treegens treasury (Safe 2-of-4)',
  )
  assert.equal(labelAddress(known.verifierMinter, known), 'VerifierMinter')
  assert.equal(
    labelAddress('0x0000000000000000000000000000000000000000', known),
    'Mint / burn (0x0)',
  )
  const wallet = '0x1111111111111111111111111111111111111111'
  assert.equal(
    labelAddress(wallet, known, { planters: new Set([wallet]) }),
    'Planter',
  )
  assert.equal(
    labelAddress(wallet, known, { verifiers: new Set([wallet]) }),
    'Verifier',
  )
  assert.equal(labelAddress(wallet, known), 'Wallet')
})

test('isMangrove and publicGps', () => {
  assert.equal(isMangrove('Mangrove'), true)
  assert.equal(isMangrove('red mangrove'), true)
  assert.equal(isMangrove('acacia'), false)
  assert.deepEqual(
    publicGps({ latitude: -4.123456789, longitude: 39.98765432 }),
    {
      lat: -4.1235,
      lng: 39.9877,
    },
  )
  assert.equal(publicGps(null), null)
  assert.equal(publicGps({ latitude: Number.NaN, longitude: 1 }), null)
})

test('decimalToWeiString handles plain, scientific and Decimal128-like values', () => {
  assert.equal(decimalToWeiString('123'), '123')
  assert.equal(decimalToWeiString('1.5E+21'), '1500000000000000000000')
  assert.equal(decimalToWeiString('1E+21'), '1000000000000000000000')
  assert.equal(
    decimalToWeiString({ toString: () => '95000000000000000000' }),
    '95000000000000000000',
  )
  assert.equal(decimalToWeiString('0.5'), '0')
  assert.equal(decimalToWeiString(null), '0')
  assert.equal(decimalToWeiString('garbage'), '0')
})
