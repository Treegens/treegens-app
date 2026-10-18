import { Contract, JsonRpcProvider } from 'ethers'
import mongoose from 'mongoose'
import env from '../config/environment'
import DonationFlow from '../models/DonationFlow'
import HealthCheck from '../models/HealthCheck'
import OnchainEvent from '../models/OnchainEvent'
import OnchainIndexerState from '../models/OnchainIndexerState'
import RewardAllocation from '../models/RewardAllocation'
import Submission from '../models/Submission'
import TgnDistribution from '../models/TgnDistribution'
import User from '../models/User'
import {
  afterCursor,
  compareFlowDesc,
  decimalToWeiString,
  encodeCursor,
  explorerAddressUrl,
  explorerTokenUrl,
  explorerTxUrl,
  isMangrove,
  isTxHash,
  labelAddress,
  publicGps,
  sumWei,
  type Cursor,
  type FlowItem,
  type FlowKind,
  type KnownAddresses,
} from '../utils/transparencyFormat'
import { approvedTreeCount } from '../utils/treeBatch'
import { getClaimScheduleConfig } from './rewardService'

/**
 * Read model for the public transparency ledger.
 *
 * Everything here is public-by-design data: approved plantings and their
 * videos (already served as NFT metadata by world.treegens.app), on-chain
 * events, and the payout records that reference them. No auth, no PII beyond
 * wallet addresses and the display names planters chose for the leaderboard.
 */

const ZERO = '0x0000000000000000000000000000000000000000'
const DEFAULT_FLOW_KINDS: FlowKind[] = [
  'funding',
  'payout',
  'reward',
  'retire',
  'verified',
  'update',
  'donation',
]

const ERC20_READ_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]

type SubmissionLean = {
  _id: mongoose.Types.ObjectId
  userWalletAddress?: string
  status?: string
  reviewedAt?: Date
  createdAt?: Date
  treesPlanted?: number
  treeType?: string
  votes?: { voterWalletAddress: string; vote: string; createdAt?: Date }[]
  aiVerification?: {
    status?: string
    countedMangroves?: number
    confidence?: number
    decision?: string
    verifiedAt?: Date
  }
  land?: { publicUrl?: string; uploadedAt?: Date; reverseGeocode?: string }
  plant?: {
    publicUrl?: string
    rawPublicUrl?: string
    stitchedPublicUrl?: string
    stitchStatus?: string
    uploadedAt?: Date
    gpsCoordinates?: { latitude: number; longitude: number }
    reverseGeocode?: string
  }
}

const SUBMISSION_PROJECTION = {
  userWalletAddress: 1,
  status: 1,
  reviewedAt: 1,
  createdAt: 1,
  treesPlanted: 1,
  treeType: 1,
  'votes.voterWalletAddress': 1,
  'votes.vote': 1,
  'votes.createdAt': 1,
  'aiVerification.status': 1,
  'aiVerification.countedMangroves': 1,
  'aiVerification.confidence': 1,
  'aiVerification.decision': 1,
  'aiVerification.verifiedAt': 1,
  'land.publicUrl': 1,
  'land.uploadedAt': 1,
  'plant.publicUrl': 1,
  'plant.rawPublicUrl': 1,
  'plant.stitchedPublicUrl': 1,
  'plant.stitchStatus': 1,
  'plant.uploadedAt': 1,
  'plant.gpsCoordinates': 1,
  'plant.reverseGeocode': 1,
} as const

function yesVoters(sub: SubmissionLean): string[] {
  return [
    ...new Set(
      (sub.votes || [])
        .filter(v => v.vote === 'yes' && v.voterWalletAddress)
        .map(v => String(v.voterWalletAddress).toLowerCase()),
    ),
  ]
}

function countryOf(location: string): string {
  const parts = String(location || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function isoOrNull(d: unknown): string | null {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(String(d))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function plantingVideoUrl(sub: SubmissionLean): string | null {
  return sub.plant?.stitchedPublicUrl || sub.plant?.publicUrl || null
}

function plantingSnippet(sub: SubmissionLean | undefined) {
  if (!sub) return undefined
  return {
    trees: approvedTreeCount(sub),
    species: sub.treeType || '',
    location: sub.plant?.reverseGeocode || sub.land?.reverseGeocode || '',
    videoUrl: plantingVideoUrl(sub),
  }
}

/** `$toDecimal` throws on a malformed string; only ever feed it digits. */
function safeDecimal(field: string) {
  return {
    $toDecimal: {
      $cond: [
        {
          $regexMatch: {
            input: { $toString: { $ifNull: [field, '0'] } },
            regex: /^[0-9]+$/,
          },
        },
        { $toString: { $ifNull: [field, '0'] } },
        '0',
      ],
    },
  }
}

export class TransparencyService {
  private provider: JsonRpcProvider | null = null

  private onchainCache: { at: number; value: unknown } | null = null

  get known(): KnownAddresses {
    return {
      mgro: env.MGRO_TOKEN_ADDRESS,
      tgn: env.TGN_TOKEN_ADDRESS,
      tgnVault: env.TGN_VAULT_ADDRESS,
      verifierMinter: env.VERIFIER_MINTER_ADDRESS,
      delegationRegistry: env.TGN_DELEGATION_REGISTRY_ADDRESS,
      treasurySafe: env.TREASURY_SAFE_ADDRESS,
      minters: env.TRANSPARENCY_MINTER_ADDRESSES,
    }
  }

  get explorer(): string {
    return env.EXPLORER_BASE_URL
  }

  contracts() {
    const k = this.known
    const explorer = this.explorer
    const entry = (
      key: string,
      address: string,
      label: string,
      role: string,
      kind: 'token' | 'contract' | 'safe',
    ) => ({
      key,
      address,
      label,
      role,
      kind,
      explorerUrl:
        kind === 'token'
          ? explorerTokenUrl(explorer, address)
          : explorerAddressUrl(explorer, address),
    })
    return {
      chain: { id: 8453, name: 'Base', explorer },
      items: [
        entry(
          'mgro',
          k.mgro,
          '$MGRO',
          'Reward token. Minted 1 per verified tree (95% planter, 5% verifiers) and burned by funders to retire trees.',
          'token',
        ),
        entry(
          'tgn',
          k.tgn,
          '$TGN',
          'Governance and staking token. Fiat purchases are swapped to TGN and paid out 95/5 to planters and verifiers.',
          'token',
        ),
        entry(
          'verifierMinter',
          k.verifierMinter,
          'VerifierMinter',
          'The only address allowed to mint $MGRO. Every reward is a proposal that a majority of staked verifiers must approve.',
          'contract',
        ),
        entry(
          'tgnVault',
          k.tgnVault,
          'TGN vault',
          'Where verifiers stake TGN. Dishonest verifiers are slashed here.',
          'contract',
        ),
        entry(
          'delegationRegistry',
          k.delegationRegistry,
          'Delegation registry',
          'Lets TGN holders delegate verification weight to a verifier.',
          'contract',
        ),
        entry(
          'treasurySafe',
          k.treasurySafe,
          'Treegens treasury',
          '2-of-4 multisig Safe that receives slashed stake and holds protocol funds.',
          'safe',
        ),
      ],
      historicMinters: k.minters
        .filter(m => m.toLowerCase() !== k.verifierMinter.toLowerCase())
        .map(address => ({
          address,
          explorerUrl: explorerAddressUrl(explorer, address),
        })),
    }
  }

  // --------------------------------------------------------------- overview --

  async overview() {
    const [
      approvedSubs,
      pendingReview,
      distributions,
      holds,
      eventAgg,
      allocationAgg,
      hcAgg,
      ledgerState,
      eventCount,
      proposalStats,
    ] = await Promise.all([
      Submission.find({ status: 'approved' }, SUBMISSION_PROJECTION).lean<
        SubmissionLean[]
      >(),
      Submission.countDocuments({ status: 'pending_review' }),
      TgnDistribution.find(
        { planterTx: { $nin: ['', null] } },
        {
          grossUsd: 1,
          planterTgnWei: 1,
          verifiers: 1,
          rail: 1,
          planterWallet: 1,
        },
      ).lean(),
      TgnDistribution.countDocuments({
        planterTx: { $in: ['', null] },
        holdExpiresAt: { $gt: new Date() },
      }),
      OnchainEvent.aggregate([
        { $match: { kind: { $in: ['mgro_mint', 'mgro_burn', 'tgn_payout'] } } },
        {
          $group: {
            _id: {
              kind: '$kind',
              role: { $ifNull: ['$meta.role', 'unknown'] },
            },
            count: { $sum: 1 },
            wei: { $sum: safeDecimal('$amountWei') },
            wallets: {
              $addToSet: {
                $cond: [{ $eq: ['$kind', 'mgro_burn'] }, '$from', '$to'],
              },
            },
          },
        },
      ]),
      RewardAllocation.aggregate([
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            allocatedWei: { $sum: safeDecimal('$totalMgroWei') },
            planterPaidWei: { $sum: safeDecimal('$planterCumulativePaidWei') },
            tranchesPaid: {
              $sum: {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$tranches', []] },
                    as: 't',
                    cond: { $eq: ['$$t.status', 'paid'] },
                  },
                },
              },
            },
            tranchesTotal: { $sum: { $size: { $ifNull: ['$tranches', []] } } },
          },
        },
      ]),
      HealthCheck.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            treesAlive: { $sum: { $ifNull: ['$treesAlive', 0] } },
            withVideo: {
              $sum: {
                $cond: [
                  { $gt: [{ $strLenCP: { $ifNull: ['$publicUrl', ''] } }, 0] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      OnchainIndexerState.findOne({ key: new RegExp(`^ledger:8453:`) }).lean(),
      OnchainEvent.estimatedDocumentCount(),
      this.proposalStats(),
    ])

    const planters = new Set<string>()
    const verifiers = new Set<string>()
    const locations = new Set<string>()
    const countries = new Set<string>()
    let trees = 0
    let mangroveTrees = 0
    let plantVideos = 0
    let landVideos = 0
    let withGps = 0
    for (const sub of approvedSubs) {
      const n = approvedTreeCount(sub)
      trees += n
      if (isMangrove(sub.treeType)) mangroveTrees += n
      if (sub.userWalletAddress)
        planters.add(sub.userWalletAddress.toLowerCase())
      for (const v of yesVoters(sub)) verifiers.add(v)
      const loc = sub.plant?.reverseGeocode || sub.land?.reverseGeocode || ''
      if (loc) {
        locations.add(loc)
        const c = countryOf(loc)
        if (c) countries.add(c)
      }
      if (plantingVideoUrl(sub)) plantVideos += 1
      if (sub.land?.publicUrl) landVideos += 1
      if (sub.plant?.gpsCoordinates) withGps += 1
    }

    const byKindRole = new Map<
      string,
      { count: number; wei: string; wallets: string[] }
    >()
    for (const row of eventAgg as any[]) {
      byKindRole.set(`${row._id.kind}:${row._id.role}`, {
        count: row.count,
        wei: decimalToWeiString(row.wei),
        wallets: row.wallets || [],
      })
    }
    const kindTotal = (kind: string) => {
      let count = 0
      const weis: string[] = []
      const wallets = new Set<string>()
      for (const [key, v] of byKindRole) {
        if (!key.startsWith(`${kind}:`)) continue
        count += v.count
        weis.push(v.wei)
        for (const w of v.wallets) wallets.add(String(w).toLowerCase())
      }
      return { count, wei: sumWei(weis), wallets: wallets.size }
    }
    const roleWei = (kind: string, role: string) =>
      byKindRole.get(`${kind}:${role}`)?.wei || '0'

    const mints = kindTotal('mgro_mint')
    const burns = kindTotal('mgro_burn')
    const payouts = kindTotal('tgn_payout')

    let grossUsd = 0
    const byRail: Record<string, number> = {}
    const planterTgnWei: string[] = []
    const verifierTgnWei: string[] = []
    const funders = new Set<string>()
    for (const d of distributions as any[]) {
      grossUsd += Number(d.grossUsd) || 0
      const rail = d.rail || 'card'
      byRail[rail] = (byRail[rail] || 0) + 1
      planterTgnWei.push(d.planterTgnWei)
      for (const v of d.verifiers || []) verifierTgnWei.push(v.tgnWei)
    }
    for (const w of byKindRole.get('mgro_burn:funder')?.wallets || [])
      funders.add(String(w))

    const alloc = (allocationAgg as any[])[0] || {}
    const hc: Record<
      string,
      { count: number; treesAlive: number; withVideo: number }
    > = {}
    for (const row of hcAgg as any[]) {
      hc[row._id] = {
        count: row.count,
        treesAlive: row.treesAlive,
        withVideo: row.withVideo,
      }
    }
    const schedule = getClaimScheduleConfig()
    const donations = await this.donationTotals()

    return {
      generatedAt: new Date().toISOString(),
      chain: { id: 8453, name: 'Base', explorer: this.explorer },
      contracts: this.known,
      totals: {
        /** treegensfoundation.org donations on their way to locked $MGRO. */
        donations,
        plantings: {
          approved: approvedSubs.length,
          pendingReview,
          trees,
          mangroveTrees,
          planters: planters.size,
          verifiers: verifiers.size,
          locations: locations.size,
          countries: countries.size,
          withGps,
        },
        funding: {
          count: distributions.length,
          activeHolds: holds,
          grossUsd: Math.round(grossUsd * 100) / 100,
          byRail,
          /** What the relayer recorded it sent (ledger-side). */
          recordedTgnToPlantersWei: sumWei(planterTgnWei),
          recordedTgnToVerifiersWei: sumWei(verifierTgnWei),
          /** What the chain says actually arrived (receipt-side). */
          onchainTgnToPlantersWei: roleWei('tgn_payout', 'planter'),
          onchainTgnToVerifiersWei: roleWei('tgn_payout', 'verifier'),
          onchainPayoutCount: payouts.count,
          planterShareBps: 9500,
          verifierShareBps: 500,
        },
        rewards: {
          mintCount: mints.count,
          mgroMintedWei: mints.wei,
          toPlantersWei: roleWei('mgro_mint', 'planter'),
          toVerifiersWei: roleWei('mgro_mint', 'verifier'),
          unattributedWei: roleWei('mgro_mint', 'unknown'),
          recipients: mints.wallets,
          allocatedWei: decimalToWeiString(alloc.allocatedWei),
          allocations: alloc.count || 0,
          planterPaidRecordedWei: decimalToWeiString(alloc.planterPaidWei),
          tranchesPaid: alloc.tranchesPaid || 0,
          tranchesTotal: alloc.tranchesTotal || 0,
          proposals: proposalStats,
          mgroPerTree: '1',
          schedule: {
            tranches: schedule.totalTranches,
            intervalSeconds: schedule.intervalSeconds,
            durationSeconds: schedule.durationSeconds,
          },
        },
        retired: {
          burnCount: burns.count,
          mgroBurnedWei: burns.wei,
          funders: burns.wallets,
          linkedToPlantings: byKindRole.get('mgro_burn:funder')?.count || 0,
        },
        updates: {
          healthChecksApproved: hc.approved?.count || 0,
          healthChecksPending: hc.pending_review?.count || 0,
          healthChecksRejected: hc.rejected?.count || 0,
          treesAliveReported: hc.approved?.treesAlive || 0,
          videos: {
            plantings: plantVideos,
            land: landVideos,
            healthChecks: hc.approved?.withVideo || 0,
            total: plantVideos + landVideos + (hc.approved?.withVideo || 0),
          },
        },
      },
      ledger: {
        indexerEnabled: env.ENABLE_LEDGER_INDEXER === 'true',
        lastProcessedBlock: ledgerState
          ? Number(ledgerState.lastProcessedBlock || 0)
          : null,
        lastSyncAt: isoOrNull((ledgerState as any)?.updatedAt),
        startBlock: env.LEDGER_INDEXER_START_BLOCK,
        eventCount,
      },
    }
  }

  private async proposalStats() {
    const rows = await OnchainEvent.aggregate([
      { $match: { kind: { $in: ['mint_proposed', 'mint_executed'] } } },
      {
        $group: {
          _id: { contract: '$contract', proposalId: '$meta.proposalId' },
          proposed: {
            $sum: { $cond: [{ $eq: ['$kind', 'mint_proposed'] }, 1, 0] },
          },
          executed: {
            $sum: { $cond: [{ $eq: ['$kind', 'mint_executed'] }, 1, 0] },
          },
        },
      },
    ])
    let total = 0
    let executed = 0
    for (const r of rows as any[]) {
      if (r.proposed > 0) total += 1
      if (r.executed > 0) executed += 1
    }
    return { total, executed, pending: Math.max(0, total - executed) }
  }

  // ------------------------------------------------------------------ flows --

  async flows(opts: {
    limit: number
    cursor: Cursor | null
    kinds: FlowKind[] | null
    submissionId?: string
  }) {
    const kinds = opts.kinds || DEFAULT_FLOW_KINDS
    const wanted = new Set(kinds)
    const limit = opts.limit
    const fetchN = limit + 1
    const cursorDate = opts.cursor ? new Date(opts.cursor.at) : null
    const sid = opts.submissionId
    const sidFilter = sid ? new mongoose.Types.ObjectId(sid) : null

    const eventKinds: string[] = []
    if (wanted.has('reward')) eventKinds.push('mgro_mint')
    if (wanted.has('retire')) eventKinds.push('mgro_burn')
    if (wanted.has('payout')) eventKinds.push('tgn_payout')
    if (wanted.has('proposal')) eventKinds.push('mint_proposed')

    const [events, distributions, approved, updates, donations] =
      await Promise.all([
        eventKinds.length
          ? OnchainEvent.find({
              kind: { $in: eventKinds },
              ...(cursorDate ? { blockTime: { $lte: cursorDate } } : {}),
              ...(sid ? { 'meta.submissionId': sid } : {}),
            })
              .sort({ blockTime: -1, logIndex: -1 })
              .limit(fetchN)
              .lean()
          : Promise.resolve([] as any[]),
        wanted.has('funding')
          ? TgnDistribution.find({
              planterTx: { $nin: ['', null] },
              ...(cursorDate ? { distributedAt: { $lte: cursorDate } } : {}),
              ...(sidFilter ? { submissionId: sidFilter } : {}),
            })
              .sort({ distributedAt: -1 })
              .limit(fetchN)
              .lean()
          : Promise.resolve([] as any[]),
        wanted.has('verified')
          ? Submission.find(
              {
                status: 'approved',
                reviewedAt: {
                  $ne: null,
                  ...(cursorDate ? { $lte: cursorDate } : {}),
                },
                ...(sidFilter ? { _id: sidFilter } : {}),
              },
              SUBMISSION_PROJECTION,
            )
              .sort({ reviewedAt: -1 })
              .limit(fetchN)
              .lean<SubmissionLean[]>()
          : Promise.resolve([] as SubmissionLean[]),
        wanted.has('update')
          ? HealthCheck.find({
              status: 'approved',
              reviewedAt: {
                $ne: null,
                ...(cursorDate ? { $lte: cursorDate } : {}),
              },
              ...(sidFilter ? { submissionId: sidFilter } : {}),
            })
              .sort({ reviewedAt: -1 })
              .limit(fetchN)
              .lean()
          : Promise.resolve([] as any[]),
        wanted.has('donation') && !sid
          ? DonationFlow.find({
              mode: 'live',
              ...(cursorDate ? { updatedAt: { $lte: cursorDate } } : {}),
            })
              .sort({ updatedAt: -1 })
              .limit(fetchN)
              .lean()
          : Promise.resolve([] as any[]),
      ])

    const submissionIds = new Set<string>()
    for (const e of events)
      if (e.meta?.submissionId) submissionIds.add(String(e.meta.submissionId))
    for (const d of distributions) submissionIds.add(String(d.submissionId))
    for (const h of updates) submissionIds.add(String(h.submissionId))
    for (const s of approved) submissionIds.add(String(s._id))
    const subs = await this.loadSubmissions([...submissionIds])
    const roles = this.rolesFrom([...subs.values()], events)

    const items: FlowItem[] = []
    for (const e of events) items.push(this.eventToFlow(e, subs, roles))
    for (const d of distributions)
      items.push(this.distributionToFlow(d, subs, roles))
    for (const s of approved) items.push(this.approvalToFlow(s, roles))
    for (const h of updates) items.push(this.healthCheckToFlow(h, subs))
    for (const f of donations) items.push(this.donationToFlow(f))

    items.sort(compareFlowDesc)
    const page = afterCursor(items, opts.cursor).slice(0, limit)
    const exhausted =
      events.length < fetchN &&
      distributions.length < fetchN &&
      approved.length < fetchN &&
      updates.length < fetchN &&
      donations.length < fetchN &&
      afterCursor(items, opts.cursor).length <= limit
    const last = page[page.length - 1]
    return {
      items: page,
      nextCursor: !exhausted && last ? encodeCursor(last) : null,
      kinds,
    }
  }

  /** Aggregates of the treasury pipeline's donation flows (amounts only, live mode). */
  private async donationTotals() {
    const rows = await DonationFlow.aggregate([
      { $match: { mode: 'live' } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          cents: { $sum: '$amountCents' },
          usdcMicro: { $sum: safeDecimal('$onramp.usdcMicro') },
          mgroBoughtWei: { $sum: safeDecimal('$swap.mgroWei') },
          mgroSettledWei: { $sum: safeDecimal('$settle.mgroWei') },
        },
      },
    ])
    const byStatus: Record<string, any> = {}
    let count = 0
    let cents = 0
    const usdc: string[] = []
    const bought: string[] = []
    const settled: string[] = []
    for (const r of rows as any[]) {
      byStatus[r._id] = { count: r.count, usd: Math.round(r.cents) / 100 }
      count += r.count
      cents += r.cents
      usdc.push(decimalToWeiString(r.usdcMicro))
      bought.push(decimalToWeiString(r.mgroBoughtWei))
      settled.push(decimalToWeiString(r.mgroSettledWei))
    }
    return {
      count,
      usd: Math.round(cents) / 100,
      usdcMicro: sumWei(usdc),
      mgroBoughtWei: sumWei(bought),
      mgroSettledWei: sumWei(settled),
      byStatus,
    }
  }

  /** A donation's journey, amounts and transactions only: never the donor. */
  private donationToFlow(f: any): FlowItem {
    const usd = Math.round(Number(f.amountCents) || 0) / 100
    const stage =
      f.status === 'settled'
        ? f.settle?.retired
          ? '$MGRO bought and locked for good'
          : '$MGRO delivered to the treasury Safe'
        : f.status === 'bought'
          ? '$MGRO bought on Base'
          : f.status === 'onramped'
            ? 'converted to USDC on Base'
            : f.status === 'swept'
              ? 'on its way from the bank to Stripe'
              : f.status === 'held'
                ? 'waiting for release'
                : f.status === 'failed'
                  ? 'needs attention'
                  : 'received at the bank'
    const tx = isTxHash(f.settle?.txHash)
      ? f.settle.txHash
      : isTxHash(f.swap?.txHash)
        ? f.swap.txHash
        : isTxHash(f.onramp?.txHash)
          ? f.onramp.txHash
          : undefined
    return {
      id: `donation:${String(f._id)}`,
      kind: 'donation',
      at: new Date(f.updatedAt || f.createdAt).toISOString(),
      title: `$${usd.toFixed(2)} donation · ${stage}`,
      detail:
        'treegensfoundation.org → Mercury → Stripe (USDC) → $MGRO on Base',
      amount: { token: 'USD', value: usd },
      verified: Boolean(tx),
      txHash: tx,
      explorerUrl: tx ? explorerTxUrl(this.explorer, tx) : undefined,
      meta: {
        status: f.status,
        usdcMicro: f.onramp?.usdcMicro || '0',
        mgroWei: f.swap?.mgroWei || '0',
        onrampTx: isTxHash(f.onramp?.txHash) ? f.onramp.txHash : null,
        swapTx: isTxHash(f.swap?.txHash) ? f.swap.txHash : null,
        settleTx: isTxHash(f.settle?.txHash) ? f.settle.txHash : null,
        retired: Boolean(f.settle?.retired),
        lock: f.settle?.method || null,
      },
    }
  }

  private async loadSubmissions(
    ids: string[],
  ): Promise<Map<string, SubmissionLean>> {
    const valid = ids.filter(id => mongoose.Types.ObjectId.isValid(id))
    if (!valid.length) return new Map()
    const docs = await Submission.find(
      { _id: { $in: valid.map(id => new mongoose.Types.ObjectId(id)) } },
      SUBMISSION_PROJECTION,
    ).lean<SubmissionLean[]>()
    return new Map(docs.map(d => [String(d._id), d]))
  }

  private rolesFrom(subs: SubmissionLean[], events: any[]) {
    const planters = new Set<string>()
    const verifiers = new Set<string>()
    const funders = new Set<string>()
    for (const s of subs) {
      if (s.userWalletAddress) planters.add(s.userWalletAddress.toLowerCase())
      for (const v of yesVoters(s)) verifiers.add(v)
    }
    for (const e of events) {
      if (e.kind === 'mgro_burn' && e.from)
        funders.add(String(e.from).toLowerCase())
      if (e.meta?.role === 'planter' && e.to)
        planters.add(String(e.to).toLowerCase())
      if (e.meta?.role === 'verifier' && e.to)
        verifiers.add(String(e.to).toLowerCase())
    }
    return { planters, verifiers, funders }
  }

  private party(
    address: string | undefined,
    roles: ReturnType<TransparencyService['rolesFrom']>,
  ) {
    if (!address) return undefined
    const a = String(address).toLowerCase()
    return { address: a, label: labelAddress(a, this.known, roles) }
  }

  private eventToFlow(
    e: any,
    subs: Map<string, SubmissionLean>,
    roles: ReturnType<TransparencyService['rolesFrom']>,
  ): FlowItem {
    const sub = e.meta?.submissionId
      ? subs.get(String(e.meta.submissionId))
      : undefined
    const base = {
      at: new Date(e.blockTime).toISOString(),
      txHash: e.txHash,
      explorerUrl: explorerTxUrl(this.explorer, e.txHash),
      verified: true,
      submissionId: e.meta?.submissionId
        ? String(e.meta.submissionId)
        : undefined,
      planting: plantingSnippet(sub),
    }
    const id = `${e.kind}:${e.txHash}:${e.logIndex}`
    switch (e.kind) {
      case 'mgro_mint': {
        const role = e.meta?.role
        const tranche =
          typeof e.meta?.trancheIndex === 'number'
            ? e.meta.trancheIndex
            : undefined
        return {
          ...base,
          id,
          kind: 'reward',
          title:
            role === 'planter'
              ? `$MGRO reward minted to planter${tranche !== undefined ? ` · tranche ${tranche + 1}` : ''}`
              : role === 'verifier'
                ? '$MGRO reward minted to verifier'
                : '$MGRO minted',
          detail:
            e.meta?.proposalId !== undefined
              ? `Released by VerifierMinter proposal #${e.meta.proposalId}`
              : undefined,
          amount: { token: 'MGRO', wei: e.amountWei },
          from: { address: ZERO, label: 'Minted by VerifierMinter' },
          to: this.party(e.to, roles),
          meta: {
            role,
            trancheIndex: tranche,
            proposalId: e.meta?.proposalId,
            approvals: e.meta?.approvals,
          },
        }
      }
      case 'mgro_burn':
        return {
          ...base,
          id,
          kind: 'retire',
          title: sub
            ? `$MGRO retired against ${approvedTreeCount(sub)} verified trees`
            : '$MGRO burned to retire trees',
          amount: { token: 'MGRO', wei: e.amountWei },
          from: this.party(e.from, roles),
          to: { address: ZERO, label: 'Burned (0x0)' },
          meta:
            typeof e.meta?.grossUsd === 'number'
              ? { grossUsd: e.meta.grossUsd }
              : undefined,
        }
      case 'tgn_payout':
        return {
          ...base,
          id,
          kind: 'payout',
          title:
            e.meta?.role === 'planter'
              ? '$TGN paid to planter (95% share)'
              : '$TGN paid to verifier (5% pool)',
          amount: { token: 'TGN', wei: e.amountWei },
          from: this.party(e.from, roles),
          to: this.party(e.to, roles),
          meta: { role: e.meta?.role, grossUsd: e.meta?.grossUsd },
        }
      default:
        return {
          ...base,
          id,
          kind: 'proposal',
          title: `Reward mint proposed to verifiers · proposal #${e.meta?.proposalId}`,
          detail: e.meta?.evidenceURI,
          amount: { token: 'MGRO', wei: e.amountWei },
          to: this.party(e.to, roles),
          meta: { proposalId: e.meta?.proposalId, role: e.meta?.role },
        }
    }
  }

  private distributionToFlow(
    d: any,
    subs: Map<string, SubmissionLean>,
    roles: ReturnType<TransparencyService['rolesFrom']>,
  ): FlowItem {
    const sub = subs.get(String(d.submissionId))
    const rail = d.rail === 'mgro' ? 'direct $MGRO' : 'card'
    const trees = sub ? approvedTreeCount(sub) : undefined
    return {
      id: `funding:${String(d._id)}`,
      kind: 'funding',
      at: new Date(d.distributedAt || d.updatedAt || d.createdAt).toISOString(),
      title: trees
        ? `${trees} verified trees funded${d.grossUsd ? ` for $${Number(d.grossUsd).toFixed(2)}` : ''}`
        : `Planting funded${d.grossUsd ? ` for $${Number(d.grossUsd).toFixed(2)}` : ''}`,
      detail: `Paid via ${rail} on world.treegens.app · 95% to the planter, 5% to ${(d.verifiers || []).length || 'the'} verifiers`,
      amount: d.grossUsd
        ? { token: 'USD', value: Number(d.grossUsd) }
        : undefined,
      to: this.party(d.planterWallet, roles),
      txHash: isTxHash(d.planterTx) ? d.planterTx : undefined,
      explorerUrl: explorerTxUrl(this.explorer, d.planterTx),
      verified: false,
      submissionId: String(d.submissionId),
      planting: plantingSnippet(sub),
      meta: {
        rail: d.rail || 'card',
        recordedPlanterTgnWei: d.planterTgnWei,
        recordedVerifierTgnWei: sumWei(
          (d.verifiers || []).map((v: any) => v.tgnWei),
        ),
        verifierCount: (d.verifiers || []).length,
      },
    }
  }

  private approvalToFlow(
    s: SubmissionLean,
    roles: ReturnType<TransparencyService['rolesFrom']>,
  ): FlowItem {
    const trees = approvedTreeCount(s)
    const voters = yesVoters(s)
    const location = s.plant?.reverseGeocode || s.land?.reverseGeocode || ''
    const video = plantingVideoUrl(s)
    return {
      id: `verified:${String(s._id)}`,
      kind: 'verified',
      at: new Date(s.reviewedAt as Date).toISOString(),
      title: `${trees} ${isMangrove(s.treeType) ? 'mangroves' : 'trees'} verified${location ? ` in ${location}` : ''}`,
      detail:
        s.aiVerification?.decision === 'auto_approved'
          ? `AI counted ${s.aiVerification?.countedMangroves ?? trees} seedlings at ${Math.round((s.aiVerification?.confidence || 0) * 100)}% confidence`
          : voters.length
            ? `Approved by ${voters.length} staked verifier${voters.length === 1 ? '' : 's'}`
            : undefined,
      from: this.party(s.userWalletAddress, roles),
      verified: false,
      submissionId: String(s._id),
      planting: plantingSnippet(s),
      video: video ? { url: video, kind: 'plant' } : undefined,
      meta: {
        verifiers: voters.length,
        species: s.treeType || '',
        gps: publicGps(s.plant?.gpsCoordinates),
      },
    }
  }

  private healthCheckToFlow(
    h: any,
    subs: Map<string, SubmissionLean>,
  ): FlowItem {
    const sub = subs.get(String(h.submissionId))
    const voters = [
      ...new Set(
        (h.votes || [])
          .filter((v: any) => v.vote === 'yes')
          .map((v: any) => String(v.voterWalletAddress).toLowerCase()),
      ),
    ]
    return {
      id: `update:${String(h._id)}`,
      kind: 'update',
      at: new Date(h.reviewedAt || h.updatedAt).toISOString(),
      title: `Growth update · checkpoint ${h.checkpointIndex}: ${h.treesAlive} trees alive`,
      detail: voters.length
        ? `Verified by ${voters.length} verifier${voters.length === 1 ? '' : 's'} · filmed ${Math.round(h.distanceMeters || 0)} m from the planting`
        : undefined,
      verified: false,
      submissionId: String(h.submissionId),
      planting: plantingSnippet(sub),
      video: h.publicUrl
        ? { url: h.publicUrl, kind: 'health_check' }
        : undefined,
      meta: {
        checkpointIndex: h.checkpointIndex,
        treesAlive: h.treesAlive,
        gps: publicGps(h.gpsCoordinates),
      },
    }
  }

  // -------------------------------------------------------------- plantings --

  async plantings(opts: {
    page: number
    limit: number
    sort: 'recent' | 'trees' | 'funded'
  }) {
    const sort: Record<string, 1 | -1> =
      opts.sort === 'trees'
        ? { treesPlanted: -1, reviewedAt: -1 }
        : { reviewedAt: -1, _id: -1 }
    const filter = { status: 'approved' }
    const [total, subs] = await Promise.all([
      Submission.countDocuments(filter),
      Submission.find(filter, SUBMISSION_PROJECTION)
        .sort(sort)
        .skip((opts.page - 1) * opts.limit)
        .limit(opts.limit)
        .lean<SubmissionLean[]>(),
    ])
    const items = await this.decoratePlantings(subs)
    if (opts.sort === 'funded') {
      items.sort(
        (a, b) => Number(Boolean(b.funding)) - Number(Boolean(a.funding)),
      )
    }
    return { items, page: opts.page, limit: opts.limit, total }
  }

  async planting(id: string) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null
    const sub = await Submission.findOne(
      { _id: id, status: 'approved' },
      SUBMISSION_PROJECTION,
    ).lean<SubmissionLean | null>()
    if (!sub) return null
    const [summary] = await this.decoratePlantings([sub])
    const [allocation, healthChecks, timeline, planterUser] = await Promise.all(
      [
        RewardAllocation.findOne({ submissionId: sub._id }).lean(),
        HealthCheck.find({ submissionId: sub._id })
          .sort({ checkpointIndex: 1, createdAt: -1 })
          .lean(),
        this.flows({
          limit: 200,
          cursor: null,
          kinds: [...DEFAULT_FLOW_KINDS, 'proposal'],
          submissionId: String(sub._id),
        }),
        sub.userWalletAddress
          ? User.findOne(
              { walletAddress: sub.userWalletAddress.toLowerCase() },
              { name: 1 },
            ).lean()
          : null,
      ],
    )
    const votes = (sub.votes || []).map(v => ({
      wallet: String(v.voterWalletAddress).toLowerCase(),
      vote: v.vote,
      at: isoOrNull(v.createdAt),
      explorerUrl: explorerAddressUrl(
        this.explorer,
        String(v.voterWalletAddress).toLowerCase(),
      ),
    }))
    return {
      ...summary,
      planter: {
        ...summary.planter,
        name: (planterUser as any)?.name || undefined,
      },
      votes,
      ai: sub.aiVerification
        ? {
            status: sub.aiVerification.status,
            counted: sub.aiVerification.countedMangroves ?? null,
            confidence: sub.aiVerification.confidence ?? null,
            decision: sub.aiVerification.decision || null,
            at: isoOrNull(sub.aiVerification.verifiedAt),
          }
        : null,
      videos: {
        land: sub.land?.publicUrl || null,
        plant: plantingVideoUrl(sub),
        plantRaw: sub.plant?.rawPublicUrl || null,
        stitched: Boolean(sub.plant?.stitchedPublicUrl),
      },
      tranches: ((allocation as any)?.tranches || [])
        .slice()
        .sort((a: any, b: any) => a.index - b.index)
        .map((t: any) => ({
          index: t.index,
          unlockAt: isoOrNull(t.unlockAt),
          status: t.status,
          amountWei: t.amountWei,
          txHash: isTxHash(t.txHash) ? t.txHash : null,
          explorerUrl: isTxHash(t.txHash)
            ? explorerTxUrl(this.explorer, t.txHash)
            : undefined,
          proposalId: typeof t.proposalId === 'number' ? t.proposalId : null,
          requiresHealthCheck: t.index > 0,
        })),
      verifierClaims: ((allocation as any)?.verifierClaims || []).map(
        (c: any) => ({
          wallet: c.wallet,
          status: c.status,
          txHash: isTxHash(c.txHash) ? c.txHash : null,
          explorerUrl: isTxHash(c.txHash)
            ? explorerTxUrl(this.explorer, c.txHash)
            : undefined,
          proposalId: typeof c.proposalId === 'number' ? c.proposalId : null,
        }),
      ),
      healthChecks: (healthChecks as any[]).map(h => ({
        id: String(h._id),
        checkpointIndex: h.checkpointIndex,
        status: h.status,
        treesAlive: h.treesAlive,
        distanceMeters: h.distanceMeters,
        videoUrl: h.status === 'approved' ? h.publicUrl || null : null,
        location: h.reverseGeocode || '',
        gps: publicGps(h.gpsCoordinates),
        submittedAt: isoOrNull(h.createdAt),
        reviewedAt: isoOrNull(h.reviewedAt),
        votes: {
          yes: (h.votes || []).filter((v: any) => v.vote === 'yes').length,
          no: (h.votes || []).filter((v: any) => v.vote === 'no').length,
        },
      })),
      timeline: timeline.items.slice().reverse(),
      submittedAt: isoOrNull(sub.createdAt),
      landFilmedAt: isoOrNull(sub.land?.uploadedAt),
      plantFilmedAt: isoOrNull(sub.plant?.uploadedAt),
    }
  }

  private async decoratePlantings(subs: SubmissionLean[]) {
    const ids = subs.map(s => s._id)
    const idStrings = ids.map(String)
    const [distributions, allocations, hcAgg, eventAgg] = await Promise.all([
      TgnDistribution.find({ submissionId: { $in: ids } }).lean(),
      RewardAllocation.find(
        { submissionId: { $in: ids } },
        {
          submissionId: 1,
          totalMgroWei: 1,
          planterTotalWei: 1,
          verifierPoolWei: 1,
          planterCumulativePaidWei: 1,
          tranches: 1,
          verifierClaims: 1,
        },
      ).lean(),
      HealthCheck.aggregate([
        { $match: { submissionId: { $in: ids } } },
        { $sort: { reviewedAt: -1, createdAt: -1 } },
        {
          $group: {
            _id: '$submissionId',
            approved: {
              $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] },
            },
            pending: {
              $sum: { $cond: [{ $eq: ['$status', 'pending_review'] }, 1, 0] },
            },
            latest: {
              $first: {
                $cond: [
                  { $eq: ['$status', 'approved'] },
                  {
                    checkpointIndex: '$checkpointIndex',
                    treesAlive: '$treesAlive',
                    at: '$reviewedAt',
                    videoUrl: '$publicUrl',
                  },
                  null,
                ],
              },
            },
            latestApproved: {
              $push: {
                $cond: [
                  { $eq: ['$status', 'approved'] },
                  {
                    checkpointIndex: '$checkpointIndex',
                    treesAlive: '$treesAlive',
                    at: '$reviewedAt',
                    videoUrl: '$publicUrl',
                  },
                  '$$REMOVE',
                ],
              },
            },
          },
        },
      ]),
      OnchainEvent.aggregate([
        {
          $match: {
            'meta.submissionId': { $in: idStrings },
            kind: { $in: ['mgro_mint', 'tgn_payout', 'mgro_burn'] },
          },
        },
        {
          $group: {
            _id: {
              submissionId: '$meta.submissionId',
              kind: '$kind',
              role: { $ifNull: ['$meta.role', 'unknown'] },
            },
            count: { $sum: 1 },
            wei: { $sum: safeDecimal('$amountWei') },
          },
        },
      ]),
    ])
    const distBySub = new Map<string, any>()
    for (const d of distributions as any[])
      distBySub.set(String(d.submissionId), d)
    const allocBySub = new Map<string, any>()
    for (const a of allocations as any[])
      allocBySub.set(String(a.submissionId), a)
    const hcBySub = new Map<string, any>()
    for (const h of hcAgg as any[]) hcBySub.set(String(h._id), h)
    const chainBySub = new Map<
      string,
      Record<string, { count: number; wei: string }>
    >()
    for (const row of eventAgg as any[]) {
      const key = String(row._id.submissionId)
      const m = chainBySub.get(key) || {}
      m[`${row._id.kind}:${row._id.role}`] = {
        count: row.count,
        wei: decimalToWeiString(row.wei),
      }
      chainBySub.set(key, m)
    }
    const now = new Date()
    const roles = this.rolesFrom(subs, [])

    return subs.map(sub => {
      const id = String(sub._id)
      const d = distBySub.get(id)
      const a = allocBySub.get(id)
      const h = hcBySub.get(id)
      const chain = chainBySub.get(id) || {}
      const trees = approvedTreeCount(sub)
      const voters = yesVoters(sub)
      const planter = String(sub.userWalletAddress || '').toLowerCase()
      const completed = Boolean(d && d.planterTx)
      const reserved = Boolean(
        d && !d.planterTx && d.holdExpiresAt && new Date(d.holdExpiresAt) > now,
      )
      const tranches: any[] = (a?.tranches || [])
        .slice()
        .sort((x: any, y: any) => x.index - y.index)
      const nextTranche = tranches.find(t => t.status !== 'paid')
      const pendingProposals = tranches.filter(
        t => t.status !== 'paid' && typeof t.proposalId === 'number',
      ).length
      const latestUpdate = h?.latestApproved?.[0] || null
      return {
        id,
        approvedAt: isoOrNull(sub.reviewedAt),
        submittedAt: isoOrNull(sub.createdAt),
        trees,
        declaredTrees: sub.treesPlanted ?? null,
        species: sub.treeType || '',
        isMangrove: isMangrove(sub.treeType),
        location: sub.plant?.reverseGeocode || sub.land?.reverseGeocode || '',
        country: countryOf(
          sub.plant?.reverseGeocode || sub.land?.reverseGeocode || '',
        ),
        gps: publicGps(sub.plant?.gpsCoordinates),
        planter: {
          address: planter,
          label: labelAddress(planter, this.known, roles),
          explorerUrl: planter
            ? explorerAddressUrl(this.explorer, planter)
            : undefined,
        },
        verifiers: { count: voters.length, addresses: voters },
        ai: sub.aiVerification
          ? {
              counted: sub.aiVerification.countedMangroves ?? null,
              confidence: sub.aiVerification.confidence ?? null,
              decision: sub.aiVerification.decision || null,
            }
          : null,
        video: {
          url: plantingVideoUrl(sub),
          landUrl: sub.land?.publicUrl || null,
          stitched: Boolean(sub.plant?.stitchedPublicUrl),
        },
        funding: completed
          ? {
              status: 'funded' as const,
              grossUsd: Number(d.grossUsd) || 0,
              rail: d.rail || 'card',
              distributedAt: isoOrNull(d.distributedAt),
              planterTx: isTxHash(d.planterTx) ? d.planterTx : null,
              planterTxUrl: explorerTxUrl(this.explorer, d.planterTx),
              verifierPayouts: (d.verifiers || []).map((v: any) => ({
                wallet: v.wallet,
                tgnWei: v.tgnWei,
                txHash: isTxHash(v.tx) ? v.tx : null,
                explorerUrl: explorerTxUrl(this.explorer, v.tx),
              })),
              recordedPlanterTgnWei: d.planterTgnWei || '0',
              recordedVerifierTgnWei: sumWei(
                (d.verifiers || []).map((v: any) => v.tgnWei),
              ),
              onchainPlanterTgnWei: chain['tgn_payout:planter']?.wei || '0',
              onchainVerifierTgnWei: chain['tgn_payout:verifier']?.wei || '0',
              onchainVerified: Boolean(
                chain['tgn_payout:planter'] ||
                  chain['tgn_payout:verifier'] ||
                  chain['mgro_burn:funder'],
              ),
              mgroBurnedWei: chain['mgro_burn:funder']?.wei || '0',
            }
          : reserved
            ? {
                status: 'reserved' as const,
                rail: d.rail || 'card',
                holdExpiresAt: isoOrNull(d.holdExpiresAt),
              }
            : { status: 'open' as const },
        rewards: a
          ? {
              allocatedWei: a.totalMgroWei,
              planterTotalWei: a.planterTotalWei,
              verifierPoolWei: a.verifierPoolWei,
              planterPaidRecordedWei: a.planterCumulativePaidWei || '0',
              onchainPlanterMintedWei: chain['mgro_mint:planter']?.wei || '0',
              onchainVerifierMintedWei: chain['mgro_mint:verifier']?.wei || '0',
              onchainMintCount:
                (chain['mgro_mint:planter']?.count || 0) +
                (chain['mgro_mint:verifier']?.count || 0) +
                (chain['mgro_mint:unknown']?.count || 0),
              tranchesPaid: tranches.filter(t => t.status === 'paid').length,
              tranchesTotal: tranches.length,
              nextUnlockAt: nextTranche
                ? isoOrNull(nextTranche.unlockAt)
                : null,
              nextTrancheIndex: nextTranche ? nextTranche.index : null,
              pendingProposals,
              verifierClaimsPaid: (a.verifierClaims || []).filter(
                (c: any) => c.status === 'paid',
              ).length,
            }
          : null,
        updates: {
          approved: h?.approved || 0,
          pending: h?.pending || 0,
          latest: latestUpdate
            ? {
                checkpointIndex: latestUpdate.checkpointIndex,
                treesAlive: latestUpdate.treesAlive,
                at: isoOrNull(latestUpdate.at),
                videoUrl: latestUpdate.videoUrl || null,
              }
            : null,
        },
      }
    })
  }

  // -------------------------------------------------------------------- map --

  async map(limit = 5000) {
    const subs = await Submission.find(
      { status: 'approved', 'plant.gpsCoordinates': { $exists: true } },
      SUBMISSION_PROJECTION,
    )
      .sort({ reviewedAt: -1 })
      .limit(limit)
      .lean<SubmissionLean[]>()
    const funded = new Set(
      (
        await TgnDistribution.find(
          {
            submissionId: { $in: subs.map(s => s._id) },
            planterTx: { $nin: ['', null] },
          },
          { submissionId: 1 },
        ).lean()
      ).map((d: any) => String(d.submissionId)),
    )
    const points = subs
      .map(s => {
        const gps = publicGps(s.plant?.gpsCoordinates)
        if (!gps) return null
        return {
          id: String(s._id),
          lat: gps.lat,
          lng: gps.lng,
          trees: approvedTreeCount(s),
          species: s.treeType || '',
          location: s.plant?.reverseGeocode || '',
          approvedAt: isoOrNull(s.reviewedAt),
          funded: funded.has(String(s._id)),
          videoUrl: plantingVideoUrl(s),
        }
      })
      .filter(Boolean)
    return { points, total: points.length }
  }

  // ---------------------------------------------------------------- onchain --

  /** Live reads straight from Base, cached briefly. Null fields when RPC is off. */
  async onchain() {
    const ttl = Math.max(15000, env.TRANSPARENCY_CACHE_TTL_MS)
    if (this.onchainCache && Date.now() - this.onchainCache.at < ttl) {
      return this.onchainCache.value
    }
    const rpcUrl = env.BASE_RPC_URL
    if (!rpcUrl) {
      const value = { available: false, reason: 'BASE_RPC_URL not configured' }
      this.onchainCache = { at: Date.now(), value }
      return value
    }
    if (!this.provider) this.provider = new JsonRpcProvider(rpcUrl)
    const k = this.known
    const mgro = new Contract(k.mgro, ERC20_READ_ABI, this.provider)
    const tgn = new Contract(k.tgn, ERC20_READ_ABI, this.provider)
    const withTimeout = <T>(p: Promise<T>, ms = 8000): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error('rpc timeout')), ms),
        ),
      ])
    try {
      const [
        blockNumber,
        mgroSupply,
        tgnSupply,
        treasuryTgn,
        vaultTgn,
        treasuryEth,
      ] = await withTimeout(
        Promise.all([
          this.provider.getBlockNumber(),
          mgro.totalSupply(),
          tgn.totalSupply(),
          tgn.balanceOf(k.treasurySafe),
          tgn.balanceOf(k.tgnVault),
          this.provider.getBalance(k.treasurySafe),
        ]),
      )
      const value = {
        available: true,
        fetchedAt: new Date().toISOString(),
        blockNumber,
        mgro: { totalSupplyWei: mgroSupply.toString() },
        tgn: {
          totalSupplyWei: tgnSupply.toString(),
          treasuryBalanceWei: treasuryTgn.toString(),
          vaultStakedWei: vaultTgn.toString(),
        },
        treasury: { address: k.treasurySafe, ethWei: treasuryEth.toString() },
      }
      this.onchainCache = { at: Date.now(), value }
      return value
    } catch (error: any) {
      const value = {
        available: false,
        reason: error?.message || String(error),
      }
      this.onchainCache = { at: Date.now(), value }
      return value
    }
  }

  // ----------------------------------------------------------------- status --

  async status(indexerStatus: unknown) {
    const [counts, state] = await Promise.all([
      OnchainEvent.aggregate([
        {
          $group: {
            _id: '$kind',
            count: { $sum: 1 },
            latest: { $max: '$blockTime' },
          },
        },
      ]),
      OnchainIndexerState.find().lean(),
    ])
    return {
      indexer: indexerStatus || {
        enabled: env.ENABLE_LEDGER_INDEXER === 'true',
      },
      cursors: (state as any[]).map(s => ({
        key: s.key,
        lastProcessedBlock: s.lastProcessedBlock,
        updatedAt: isoOrNull(s.updatedAt),
      })),
      events: Object.fromEntries(
        (counts as any[]).map(c => [
          c._id,
          { count: c.count, latest: isoOrNull(c.latest) },
        ]),
      ),
    }
  }
}

export default new TransparencyService()
