import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSubmissionVote } from './validation'

type Outcome = {
  status: number | null
  payload: { error?: string; details?: string[] } | null
  nextCalled: boolean
}

function runVoteValidation(body: unknown): Outcome {
  const outcome: Outcome = { status: null, payload: null, nextCalled: false }
  const res = {
    status(code: number) {
      outcome.status = code
      return this
    },
    json(payload: Outcome['payload']) {
      outcome.payload = payload
      return this
    },
  }
  validateSubmissionVote({ body } as any, res as any, () => {
    outcome.nextCalled = true
  })
  return outcome
}

test('yes vote needs no reasons', () => {
  const r = runVoteValidation({ vote: 'yes' })
  assert.equal(r.nextCalled, true)
  assert.equal(r.status, null)
})

test('no vote with a written reason passes', () => {
  const r = runVoteValidation({
    vote: 'no',
    reasons: ['Filmed same trees twice'],
  })
  assert.equal(r.nextCalled, true)
})

test('no vote without reasons is rejected with a clear message', () => {
  const r = runVoteValidation({ vote: 'no' })
  assert.equal(r.nextCalled, false)
  assert.equal(r.status, 400)
  assert.deepEqual(r.payload?.details, [
    'At least one reason is required when rejecting a submission',
  ])
})

test('no vote with only blank reasons is rejected', () => {
  const r = runVoteValidation({ vote: 'no', reasons: ['   ', ''] })
  assert.equal(r.nextCalled, false)
  assert.equal(r.status, 400)
})

test('invalid vote value is rejected', () => {
  const r = runVoteValidation({ vote: 'maybe', reasons: ['x'] })
  assert.equal(r.nextCalled, false)
  assert.equal(r.status, 400)
})

test('reason list is capped at ten entries of 500 chars', () => {
  const tooMany = runVoteValidation({
    vote: 'no',
    reasons: Array.from({ length: 11 }, () => 'x'),
  })
  assert.equal(tooMany.status, 400)
  const tooLong = runVoteValidation({
    vote: 'no',
    reasons: ['y'.repeat(501)],
  })
  assert.equal(tooLong.status, 400)
})
