import type { FlowKind } from './api'

export type KindMeta = {
  key: FlowKind
  label: string
  short: string
  /** CSS variable carrying the series color (identity never rides on color alone). */
  color: string
  icon: 'in' | 'out' | 'sprout' | 'flame' | 'shield' | 'camera' | 'vote'
  blurb: string
}

export const KINDS: Record<FlowKind, KindMeta> = {
  funding: {
    key: 'funding',
    label: 'Funding in',
    short: 'Funded',
    color: 'var(--s-funding)',
    icon: 'in',
    blurb: 'A funder paid for verified trees on world.treegens.app.',
  },
  payout: {
    key: 'payout',
    label: '$TGN payouts',
    short: 'Payout',
    color: 'var(--s-payout)',
    icon: 'out',
    blurb: 'The funding, swapped to $TGN: 95% to the planter, 5% to the verifiers who approved the planting.',
  },
  reward: {
    key: 'reward',
    label: '$MGRO rewards',
    short: 'Reward',
    color: 'var(--s-reward)',
    icon: 'sprout',
    blurb: 'One $MGRO per verified tree, minted by the VerifierMinter once a majority of staked verifiers approve. Planter rewards vest over six survival checkpoints.',
  },
  retire: {
    key: 'retire',
    label: '$MGRO retired',
    short: 'Retired',
    color: 'var(--s-retire)',
    icon: 'flame',
    blurb: 'A funder burned $MGRO forever to retire verified trees.',
  },
  verified: {
    key: 'verified',
    label: 'Planting verified',
    short: 'Verified',
    color: 'var(--s-update)',
    icon: 'shield',
    blurb: 'GPS-tagged before/after video, AI seedling count and staked-verifier votes.',
  },
  update: {
    key: 'update',
    label: 'Growth update',
    short: 'Update',
    color: 'var(--s-update)',
    icon: 'camera',
    blurb: 'A follow-up video filmed at the planting site, counting the trees still alive. It unlocks the next reward tranche.',
  },
  donation: {
    key: 'donation',
    label: 'Donations',
    short: 'Donation',
    color: 'var(--s-funding)',
    icon: 'in',
    blurb: 'A gift to treegensfoundation.org on its way from the bank, through Stripe as USDC, to $MGRO on Base.',
  },
  proposal: {
    key: 'proposal',
    label: 'Mint proposal',
    short: 'Proposal',
    color: 'var(--s-reward)',
    icon: 'vote',
    blurb: 'A reward mint waiting for verifier approval on-chain.',
  },
}

export const LEDGER_FILTERS: { key: 'all' | FlowKind; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'funding', label: 'Funding in' },
  { key: 'donation', label: 'Donations' },
  { key: 'payout', label: '$TGN payouts' },
  { key: 'reward', label: '$MGRO rewards' },
  { key: 'retire', label: 'Retired' },
  { key: 'verified', label: 'Verified plantings' },
  { key: 'update', label: 'Growth updates' },
]
