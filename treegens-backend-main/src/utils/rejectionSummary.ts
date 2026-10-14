/**
 * Planter-facing view of a rejected submission.
 *
 * Verifier "no" votes carry free-text reasons, but they are buried in
 * `votes[]` next to each voter's wallet. The planter only needs to know that
 * the submission was rejected, when, by how many verifiers, and exactly why.
 * Everything here is pure so it can be reused by the API responses and the
 * rejection notification alike.
 */

export type RejectionVoteLike = {
  vote: 'yes' | 'no'
  reasons?: string[] | null
}

export type RejectionSummarySource = {
  status?: string | null
  reviewedAt?: Date | string | null
  votes?: RejectionVoteLike[] | null
}

export type SubmissionRejectionSummary = {
  rejectedAt: Date | null
  /** Every distinct reason the "no" voters gave, in vote order. */
  reasons: string[]
  noVotes: number
  yesVotes: number
  totalVotes: number
}

/**
 * Checklist labels the verifier UI sends alongside a free-text note. On their
 * own they tell the planter nothing, so they are dropped whenever the same
 * vote carries a real reason. Kept when they are all the verifier left, so it
 * is still visible that a reason was intended.
 */
const PLACEHOLDER_REASONS = new Set(['another reason (noted below)'])

/** Longest notification body we send; the schema allows 2000. */
const MAX_NOTIFICATION_BODY_CHARS = 1500

function normalizeReason(reason: unknown): string {
  return String(reason ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function reasonKey(reason: string): string {
  return reason.toLowerCase()
}

function reasonsForVote(vote: RejectionVoteLike): string[] {
  const cleaned = (vote.reasons ?? []).map(normalizeReason).filter(Boolean)
  const real = cleaned.filter(r => !PLACEHOLDER_REASONS.has(reasonKey(r)))
  return real.length > 0 ? real : cleaned
}

/** Distinct reasons from every "no" vote, first occurrence wins. */
export function collectRejectionReasons(
  votes: RejectionVoteLike[] | null | undefined,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const vote of votes ?? []) {
    if (vote?.vote !== 'no') continue
    for (const reason of reasonsForVote(vote)) {
      const key = reasonKey(reason)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(reason)
    }
  }
  return out
}

/** Null unless the submission is actually rejected. */
export function buildRejectionSummary(
  submission: RejectionSummarySource | null | undefined,
): SubmissionRejectionSummary | null {
  if (!submission || submission.status !== 'rejected') return null
  const votes = submission.votes ?? []
  const noVotes = votes.filter(v => v?.vote === 'no').length
  const yesVotes = votes.filter(v => v?.vote === 'yes').length
  const reviewedAt = submission.reviewedAt
    ? new Date(submission.reviewedAt)
    : null
  return {
    rejectedAt:
      reviewedAt && !Number.isNaN(reviewedAt.getTime()) ? reviewedAt : null,
    reasons: collectRejectionReasons(votes),
    noVotes,
    yesVotes,
    totalVotes: votes.length,
  }
}

/**
 * Attaches `rejection` to a plain submission object when it is rejected.
 * Non-rejected submissions are returned untouched so the field is simply
 * absent instead of null.
 */
export function withRejectionSummary<T extends RejectionSummarySource>(
  submission: T,
): T & { rejection?: SubmissionRejectionSummary } {
  const rejection = buildRejectionSummary(submission)
  return rejection ? { ...submission, rejection } : submission
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * The in-app + push notification sent to the planter when verifiers reject.
 * The body carries the actual reasons so the planter knows why without
 * opening the app, and the link lands on the submission where the full
 * explanation is shown.
 */
export function buildRejectionNotification(
  submissionId: string,
  summary: Pick<
    SubmissionRejectionSummary,
    'reasons' | 'noVotes' | 'totalVotes'
  >,
): {
  title: string
  body: string
  link: string
  payload: Record<string, unknown>
} {
  const reasons = summary.reasons
  const intro = 'Verifiers rejected your planting submission.'
  let body: string
  if (reasons.length === 0) {
    body = `${intro} No written reason was left. Open the submission to see the vote and ask the verifiers.`
  } else if (reasons.length === 1) {
    body = `${intro} Reason: ${reasons[0]}`
  } else {
    body = `${intro} Reasons: ${reasons.join('; ')}`
  }
  return {
    title: 'Submission rejected',
    body: truncate(body, MAX_NOTIFICATION_BODY_CHARS),
    link: `/submissions/${submissionId}`,
    payload: {
      submissionId,
      status: 'rejected',
      reasons,
      noVotes: summary.noVotes,
      totalVotes: summary.totalVotes,
    },
  }
}
