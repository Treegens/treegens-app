import type { Vote } from '@/types'
import type { PlanterSubmissionGroup } from '@/utils/submissionPlanterGroup'

export type RejectionReasonDetail = {
  /** The verifier's wording, shown to the planter verbatim. */
  reason: string
  /** Plain-language explanation for checklist reasons we recognise. */
  meaning?: string
  /** What to do differently next time. */
  fix?: string
}

export type RejectionDetails = {
  reasons: RejectionReasonDetail[]
  rejectedAt: string | null
  noVotes: number
  yesVotes: number
  totalVotes: number
}

type RejectionSource = Pick<
  PlanterSubmissionGroup,
  'submissionStatus' | 'votes' | 'reviewedAt' | 'rejection'
>

/**
 * Checklist labels the verifier modal sends next to a free-text note. On their
 * own they tell the planter nothing, so they are dropped when the same vote
 * carries a real reason and explained when they are all the verifier left.
 */
const OTHER_REASON_LABEL = 'another reason (noted below)'

/**
 * Explanations for the verifier checklist (see RejectSubmissionModal), written
 * from the planting rules in the tutorial so the planter knows what the
 * verifier saw and how to pass next time. Keyed by normalised label.
 */
const REASON_GUIDE: Record<string, { meaning: string; fix: string }> = {
  'not planted approx. 30cm apart': {
    meaning:
      'The verifiers saw propagules planted much closer together or further apart than the guideline.',
    fix: 'Space each propagule about 30 cm from the next. Nursery seedlings go 1 metre apart.',
  },
  'not planted within 2m of the same tree species': {
    meaning:
      'The propagules were planted too far from an existing tree of the same species.',
    fix: 'Plant only within 2 metres of the same mangrove species and keep that neighbouring tree in frame.',
  },
  'filmed same trees twice': {
    meaning:
      'The after video showed the same trees more than once, so they would be counted twice.',
    fix: 'Pan in one continuous direction only. If a propagule leaves the frame and comes back, record the clip again.',
  },
  'propagules were not old enough and/or dead': {
    meaning: 'The propagules in the video looked unripe or no longer alive.',
    fix: 'Ceriops propagules need 2 to 3 cm of yellow at the tip and Rhizophora should be about 20 to 60 cm long. Skip any that are dark brown or black from sun damage.',
  },
}

function normalize(reason: unknown): string {
  return String(reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function reasonsForVote(vote: Vote): string[] {
  const cleaned = (vote.reasons ?? []).map(normalize).filter(Boolean)
  const real = cleaned.filter(r => r.toLowerCase() !== OTHER_REASON_LABEL)
  return real.length > 0 ? real : cleaned
}

/**
 * Distinct reasons from the "no" votes, first wording wins. Mirrors the API's
 * `rejection.reasons` for payloads that predate it.
 */
export function collectRejectionReasons(votes: Vote[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const vote of votes ?? []) {
    if (vote?.vote !== 'no') continue
    for (const reason of reasonsForVote(vote)) {
      const key = reason.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(reason)
    }
  }
  return out
}

export function describeReason(reason: string): RejectionReasonDetail {
  const clean = normalize(reason)
  const key = clean.toLowerCase()
  if (key === OTHER_REASON_LABEL) {
    return {
      reason: 'Another reason, but no note was added',
      meaning:
        'The verifier chose "another reason" without writing what it was. Ask them in the message thread on this submission.',
    }
  }
  const guide = REASON_GUIDE[key]
  return guide ? { reason: clean, ...guide } : { reason: clean }
}

/** Null unless the submission is rejected. */
export function getRejectionDetails(
  group: RejectionSource | null | undefined,
): RejectionDetails | null {
  if (!group || group.submissionStatus !== 'rejected') return null
  const api = group.rejection
  const votes = group.votes ?? []
  const reasons = api ? api.reasons : collectRejectionReasons(votes)
  const noVotes = api ? api.noVotes : votes.filter(v => v.vote === 'no').length
  const yesVotes = api
    ? api.yesVotes
    : votes.filter(v => v.vote === 'yes').length
  const totalVotes = api ? api.totalVotes : votes.length
  return {
    reasons: (reasons ?? []).map(describeReason),
    rejectedAt: api?.rejectedAt ?? group.reviewedAt ?? null,
    noVotes,
    yesVotes,
    totalVotes,
  }
}

/** One line for list cards: the first reason, with a count of any others. */
export function rejectionHeadline(
  details: RejectionDetails | null,
): string | null {
  if (!details) return null
  const first = details.reasons[0]
  if (!first) return 'Verifiers did not leave a written reason'
  const extra = details.reasons.length - 1
  return extra > 0 ? `${first.reason} (+${extra} more)` : first.reason
}
