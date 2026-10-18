import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyMgroTransfer,
  isRangeTooLargeError,
  parseEvidenceURI,
  payoutRoleFor,
} from './transparencyIndexerService'

const ZERO = '0x0000000000000000000000000000000000000000'
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('parseEvidenceURI reads planter tranche and verifier evidence', () => {
  assert.deepEqual(
    parseEvidenceURI(
      'treegens://submission/66a1b2c3d4e5f60718293a4b/planter/tranche/2',
    ),
    {
      submissionId: '66a1b2c3d4e5f60718293a4b',
      role: 'planter',
      trancheIndex: 2,
    },
  )
  assert.deepEqual(
    parseEvidenceURI(
      `treegens://submission/66A1B2C3D4E5F60718293A4B/verifier/${A}`,
    ),
    { submissionId: '66a1b2c3d4e5f60718293a4b', role: 'verifier', wallet: A },
  )
  assert.equal(parseEvidenceURI('treegens://reward/0xabc/1000'), null)
  assert.equal(parseEvidenceURI(''), null)
  assert.equal(parseEvidenceURI(undefined), null)
})

test('classifyMgroTransfer separates mints, burns and plain transfers', () => {
  assert.equal(classifyMgroTransfer(ZERO, A), 'mgro_mint')
  assert.equal(classifyMgroTransfer(A, ZERO), 'mgro_burn')
  assert.equal(classifyMgroTransfer(A, B), null)
  assert.equal(classifyMgroTransfer(ZERO, ZERO), null)
})

test('payoutRoleFor matches planter and verifier wallets case-insensitively', () => {
  const d = { planterWallet: A, verifiers: [{ wallet: B.toUpperCase() }] }
  assert.equal(payoutRoleFor(A.toUpperCase(), d), 'planter')
  assert.equal(payoutRoleFor(B, d), 'verifier')
  assert.equal(
    payoutRoleFor('0xcccccccccccccccccccccccccccccccccccccccc', d),
    null,
  )
})

test('isRangeTooLargeError recognises provider range complaints', () => {
  assert.equal(
    isRangeTooLargeError(new Error('query returned more than 10000 results')),
    true,
  )
  assert.equal(
    isRangeTooLargeError({ message: 'block range is too wide' }),
    true,
  )
  assert.equal(isRangeTooLargeError(new Error('execution reverted')), false)
})
