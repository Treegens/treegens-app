import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hideVoterIdentities,
  hideVoterIdentitiesOnOwnRows,
} from './planterSubmissionView'

const when = new Date('2026-10-01T10:00:00.000Z')

test('hideVoterIdentities keeps the verdict and reasons, drops who voted', () => {
  const out = hideVoterIdentities({
    status: 'rejected',
    rejection: { reasons: ['Filmed same trees twice'] },
    votes: [
      {
        voterWalletAddress: '0xabc',
        vote: 'no' as const,
        reasons: ['Filmed same trees twice'],
        delegatedFor: ['0xdef'],
        createdAt: when,
      },
      { voterWalletAddress: '0x123', vote: 'yes' as const, reasons: [] },
    ],
  })
  assert.deepEqual(out.votes, [
    { vote: 'no', reasons: ['Filmed same trees twice'], createdAt: when },
    { vote: 'yes', reasons: [] },
  ])
  assert.equal('voterWalletAddress' in out.votes[0], false)
  assert.equal('delegatedFor' in out.votes[0], false)
  assert.equal(out.status, 'rejected')
  assert.deepEqual(out.rejection, { reasons: ['Filmed same trees twice'] })
})

test('hideVoterIdentities tolerates missing votes and reasons', () => {
  const draft = { status: 'draft', votes: undefined }
  assert.deepEqual(hideVoterIdentities(draft).votes, [])
  assert.deepEqual(
    hideVoterIdentities({ votes: [{ vote: 'no' as const, reasons: null }] })
      .votes,
    [{ vote: 'no', reasons: [] }],
  )
})

test('hideVoterIdentities does not mutate the input', () => {
  const input = {
    votes: [{ voterWalletAddress: '0xabc', vote: 'yes' as const, reasons: [] }],
  }
  hideVoterIdentities(input)
  assert.equal(input.votes[0].voterWalletAddress, '0xabc')
})

test('hideVoterIdentitiesOnOwnRows only reduces rows the viewer planted', () => {
  const rows = [
    {
      userWalletAddress: '0xPLANTER',
      votes: [{ voterWalletAddress: '0xv1', vote: 'no' as const, reasons: [] }],
    },
    {
      userWalletAddress: '0xother',
      votes: [{ voterWalletAddress: '0xv2', vote: 'no' as const, reasons: [] }],
    },
  ]
  const out = hideVoterIdentitiesOnOwnRows(rows, '0xplanter')
  assert.equal('voterWalletAddress' in out[0].votes[0], false)
  assert.equal(
    (out[1].votes[0] as { voterWalletAddress?: string }).voterWalletAddress,
    '0xv2',
  )
})

test('hideVoterIdentitiesOnOwnRows is a no-op without a viewer', () => {
  const rows = [
    {
      userWalletAddress: '0xplanter',
      votes: [{ voterWalletAddress: '0xv1', vote: 'no' as const, reasons: [] }],
    },
  ]
  assert.equal(hideVoterIdentitiesOnOwnRows(rows, ''), rows)
})
