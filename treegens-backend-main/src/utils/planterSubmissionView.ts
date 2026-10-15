/**
 * What a planter may see of the verifier votes on their own submission.
 *
 * Verifier identities stay hidden from the planter: knowing who voted "no"
 * invites retaliation, through the submission DM thread or by voting against
 * that verifier's own plantings. The planter still gets every vote with its
 * reasons and time, which is all the rejection feedback needs. `delegatedFor`
 * goes too, since it names other wallets.
 */

type VoteLike = {
  vote: 'yes' | 'no'
  reasons?: string[] | null
  createdAt?: Date | null
}

export type PlanterVisibleVote = {
  vote: 'yes' | 'no'
  reasons: string[]
  createdAt?: Date
}

type WithVotes = { votes?: VoteLike[] | null }

function toPlanterVisibleVote(vote: VoteLike): PlanterVisibleVote {
  const visible: PlanterVisibleVote = {
    vote: vote.vote,
    reasons: Array.isArray(vote.reasons) ? [...vote.reasons] : [],
  }
  if (vote.createdAt) visible.createdAt = vote.createdAt
  return visible
}

/** The same submission with every vote reduced to what its planter may see. */
export function hideVoterIdentities<T extends WithVotes>(
  submission: T,
): Omit<T, 'votes'> & { votes: PlanterVisibleVote[] } {
  const votes = (submission.votes ?? []).map(toPlanterVisibleVote)
  return { ...submission, votes }
}

/**
 * For lists a verifier reads: a verifier who is also a planter must not learn
 * who voted on their own plantings, so only the rows they own are reduced.
 */
export function hideVoterIdentitiesOnOwnRows<
  T extends WithVotes & { userWalletAddress?: string | null },
>(
  rows: T[],
  viewerWalletAddress: string,
): Array<T | ReturnType<typeof hideVoterIdentities<T>>> {
  const viewer = String(viewerWalletAddress || '').toLowerCase()
  if (!viewer) return rows
  return rows.map(row =>
    String(row.userWalletAddress || '').toLowerCase() === viewer
      ? hideVoterIdentities(row)
      : row,
  )
}
