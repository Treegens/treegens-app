import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRejectionNotification,
  buildRejectionSummary,
  collectRejectionReasons,
  withRejectionSummary,
} from './rejectionSummary'

const PLACEHOLDER = 'Another reason (noted below)'

test('collectRejectionReasons ignores yes votes and empty reasons', () => {
  const reasons = collectRejectionReasons([
    { vote: 'yes', reasons: ['Looks great'] },
    { vote: 'no', reasons: ['', '   ', 'Filmed same trees twice'] },
    { vote: 'no', reasons: null },
  ])
  assert.deepEqual(reasons, ['Filmed same trees twice'])
})

test('collectRejectionReasons dedupes across voters, keeps first wording', () => {
  const reasons = collectRejectionReasons([
    { vote: 'no', reasons: ['Not planted approx. 30cm apart'] },
    {
      vote: 'no',
      reasons: ['not planted approx. 30CM apart', 'Dead propagules'],
    },
  ])
  assert.deepEqual(reasons, [
    'Not planted approx. 30cm apart',
    'Dead propagules',
  ])
})

test('collectRejectionReasons collapses whitespace inside a reason', () => {
  const reasons = collectRejectionReasons([
    { vote: 'no', reasons: ['Propagules were not old enough\n  and/or dead'] },
  ])
  assert.deepEqual(reasons, ['Propagules were not old enough and/or dead'])
})

test('collectRejectionReasons drops the "another reason" placeholder when a note is present', () => {
  const reasons = collectRejectionReasons([
    { vote: 'no', reasons: [PLACEHOLDER, 'Land video is a different plot'] },
  ])
  assert.deepEqual(reasons, ['Land video is a different plot'])
})

test('collectRejectionReasons keeps the placeholder when it is all the verifier left', () => {
  const reasons = collectRejectionReasons([
    { vote: 'no', reasons: [PLACEHOLDER] },
  ])
  assert.deepEqual(reasons, [PLACEHOLDER])
})

test('buildRejectionSummary is null unless the submission is rejected', () => {
  assert.equal(buildRejectionSummary(null), null)
  assert.equal(
    buildRejectionSummary({
      status: 'pending_review',
      votes: [{ vote: 'no', reasons: ['x'] }],
    }),
    null,
  )
  assert.equal(buildRejectionSummary({ status: 'approved', votes: [] }), null)
})

test('buildRejectionSummary reports counts, reasons and the review date', () => {
  const reviewedAt = new Date('2026-10-01T10:00:00.000Z')
  const summary = buildRejectionSummary({
    status: 'rejected',
    reviewedAt,
    votes: [
      { vote: 'yes', reasons: [] },
      { vote: 'no', reasons: ['Filmed same trees twice'] },
      { vote: 'no', reasons: ['Filmed same trees twice', 'Dead propagules'] },
    ],
  })
  assert.ok(summary)
  assert.equal(summary.rejectedAt?.toISOString(), reviewedAt.toISOString())
  assert.deepEqual(summary.reasons, [
    'Filmed same trees twice',
    'Dead propagules',
  ])
  assert.equal(summary.noVotes, 2)
  assert.equal(summary.yesVotes, 1)
  assert.equal(summary.totalVotes, 3)
})

test('buildRejectionSummary accepts ISO strings and tolerates missing dates', () => {
  const fromString = buildRejectionSummary({
    status: 'rejected',
    reviewedAt: '2026-10-02T00:00:00.000Z',
    votes: [],
  })
  assert.equal(
    fromString?.rejectedAt?.toISOString(),
    '2026-10-02T00:00:00.000Z',
  )
  const noDate = buildRejectionSummary({ status: 'rejected', votes: [] })
  assert.equal(noDate?.rejectedAt, null)
  assert.deepEqual(noDate?.reasons, [])
})

test('withRejectionSummary only adds the field to rejected submissions', () => {
  const pending = withRejectionSummary({ status: 'pending_review', votes: [] })
  assert.equal('rejection' in pending, false)

  const rejected = withRejectionSummary({
    status: 'rejected',
    votes: [{ vote: 'no', reasons: ['Filmed same trees twice'] }],
  })
  assert.deepEqual(rejected.rejection?.reasons, ['Filmed same trees twice'])
  assert.equal(rejected.rejection?.noVotes, 1)
})

test('buildRejectionNotification says rejected and lists one reason', () => {
  const n = buildRejectionNotification('abc123', {
    reasons: ['Filmed same trees twice'],
    noVotes: 3,
    totalVotes: 4,
  })
  assert.equal(n.title, 'Submission rejected')
  assert.equal(
    n.body,
    'Verifiers rejected your planting submission. Reason: Filmed same trees twice',
  )
  assert.equal(n.link, '/submissions/abc123')
  assert.deepEqual(n.payload, {
    submissionId: 'abc123',
    status: 'rejected',
    reasons: ['Filmed same trees twice'],
    noVotes: 3,
    totalVotes: 4,
  })
})

test('buildRejectionNotification joins several reasons', () => {
  const n = buildRejectionNotification('abc123', {
    reasons: ['A', 'B'],
    noVotes: 2,
    totalVotes: 3,
  })
  assert.equal(
    n.body,
    'Verifiers rejected your planting submission. Reasons: A; B',
  )
})

test('buildRejectionNotification explains when no reason was written', () => {
  const n = buildRejectionNotification('abc123', {
    reasons: [],
    noVotes: 2,
    totalVotes: 3,
  })
  assert.match(n.body, /^Verifiers rejected your planting submission\./)
  assert.match(n.body, /No written reason was left/)
})

test('buildRejectionNotification keeps the body under the notification limit', () => {
  const n = buildRejectionNotification('abc123', {
    reasons: Array.from({ length: 10 }, (_, i) => `${i}-${'x'.repeat(500)}`),
    noVotes: 10,
    totalVotes: 10,
  })
  assert.ok(n.body.length <= 1500)
  assert.ok(n.body.endsWith('…'))
})
