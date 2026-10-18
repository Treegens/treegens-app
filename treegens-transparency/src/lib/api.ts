import { config } from '../config'

/** Shapes mirror treegens-backend-main/src/services/transparencyService.ts. */

export type FlowKind = 'funding' | 'payout' | 'reward' | 'retire' | 'verified' | 'update' | 'proposal'

export type FlowParty = { address: string; label: string; name?: string }

export type FlowItem = {
  id: string
  kind: FlowKind
  at: string
  title: string
  detail?: string
  amount?: { token: 'USD' | 'TGN' | 'MGRO'; wei?: string; value?: number }
  from?: FlowParty
  to?: FlowParty
  txHash?: string
  explorerUrl?: string
  verified: boolean
  submissionId?: string
  planting?: { trees: number; species: string; location: string; videoUrl: string | null }
  video?: { url: string; kind: 'plant' | 'land' | 'health_check' }
  meta?: Record<string, unknown>
}

export type Overview = {
  generatedAt: string
  chain: { id: number; name: string; explorer: string }
  contracts: {
    mgro: string
    tgn: string
    tgnVault: string
    verifierMinter: string
    delegationRegistry: string
    treasurySafe: string
    minters: string[]
  }
  totals: {
    plantings: {
      approved: number
      pendingReview: number
      trees: number
      mangroveTrees: number
      planters: number
      verifiers: number
      locations: number
      countries: number
      withGps: number
    }
    funding: {
      count: number
      activeHolds: number
      grossUsd: number
      byRail: Record<string, number>
      recordedTgnToPlantersWei: string
      recordedTgnToVerifiersWei: string
      onchainTgnToPlantersWei: string
      onchainTgnToVerifiersWei: string
      onchainPayoutCount: number
      planterShareBps: number
      verifierShareBps: number
    }
    rewards: {
      mintCount: number
      mgroMintedWei: string
      toPlantersWei: string
      toVerifiersWei: string
      unattributedWei: string
      recipients: number
      allocatedWei: string
      allocations: number
      planterPaidRecordedWei: string
      tranchesPaid: number
      tranchesTotal: number
      proposals: { total: number; executed: number; pending: number }
      mgroPerTree: string
      schedule: { tranches: number; intervalSeconds: number; durationSeconds: number }
    }
    retired: { burnCount: number; mgroBurnedWei: string; funders: number; linkedToPlantings: number }
    updates: {
      healthChecksApproved: number
      healthChecksPending: number
      healthChecksRejected: number
      treesAliveReported: number
      videos: { plantings: number; land: number; healthChecks: number; total: number }
    }
  }
  ledger: {
    indexerEnabled: boolean
    lastProcessedBlock: number | null
    lastSyncAt: string | null
    startBlock: number
    eventCount: number
  }
}

export type PlantingFunding =
  | {
      status: 'funded'
      grossUsd: number
      rail: string
      distributedAt: string | null
      planterTx: string | null
      planterTxUrl?: string
      verifierPayouts: { wallet: string; tgnWei: string; txHash: string | null; explorerUrl?: string }[]
      recordedPlanterTgnWei: string
      recordedVerifierTgnWei: string
      onchainPlanterTgnWei: string
      onchainVerifierTgnWei: string
      onchainVerified: boolean
      mgroBurnedWei: string
    }
  | { status: 'reserved'; rail: string; holdExpiresAt: string | null }
  | { status: 'open' }

export type PlantingSummary = {
  id: string
  approvedAt: string | null
  submittedAt: string | null
  trees: number
  declaredTrees: number | null
  species: string
  isMangrove: boolean
  location: string
  country: string
  gps: { lat: number; lng: number } | null
  planter: { address: string; label: string; explorerUrl?: string; name?: string }
  verifiers: { count: number; addresses: string[] }
  ai: { counted: number | null; confidence: number | null; decision: string | null } | null
  video: { url: string | null; landUrl: string | null; stitched: boolean }
  funding: PlantingFunding
  rewards: {
    allocatedWei: string
    planterTotalWei: string
    verifierPoolWei: string
    planterPaidRecordedWei: string
    onchainPlanterMintedWei: string
    onchainVerifierMintedWei: string
    onchainMintCount: number
    tranchesPaid: number
    tranchesTotal: number
    nextUnlockAt: string | null
    nextTrancheIndex: number | null
    pendingProposals: number
    verifierClaimsPaid: number
  } | null
  updates: {
    approved: number
    pending: number
    latest: { checkpointIndex: number; treesAlive: number; at: string | null; videoUrl: string | null } | null
  }
}

export type PlantingDetail = PlantingSummary & {
  votes: { wallet: string; vote: 'yes' | 'no'; at: string | null; explorerUrl: string }[]
  ai: {
    status?: string
    counted: number | null
    confidence: number | null
    decision: string | null
    at?: string | null
  } | null
  videos: { land: string | null; plant: string | null; plantRaw: string | null; stitched: boolean }
  tranches: {
    index: number
    unlockAt: string | null
    status: 'pending' | 'processing' | 'paid' | 'failed'
    amountWei: string
    txHash: string | null
    explorerUrl?: string
    proposalId: number | null
    requiresHealthCheck: boolean
  }[]
  verifierClaims: { wallet: string; status: string; txHash: string | null; explorerUrl?: string; proposalId: number | null }[]
  healthChecks: {
    id: string
    checkpointIndex: number
    status: 'pending_review' | 'approved' | 'rejected'
    treesAlive: number
    distanceMeters: number
    videoUrl: string | null
    location: string
    gps: { lat: number; lng: number } | null
    submittedAt: string | null
    reviewedAt: string | null
    votes: { yes: number; no: number }
  }[]
  timeline: FlowItem[]
  submittedAt: string | null
  landFilmedAt: string | null
  plantFilmedAt: string | null
}

export type MapPoint = {
  id: string
  lat: number
  lng: number
  trees: number
  species: string
  location: string
  approvedAt: string | null
  funded: boolean
  videoUrl: string | null
}

export type OnchainLive =
  | {
      available: true
      fetchedAt: string
      blockNumber: number
      mgro: { totalSupplyWei: string }
      tgn: { totalSupplyWei: string; treasuryBalanceWei: string; vaultStakedWei: string }
      treasury: { address: string; ethWei: string }
    }
  | { available: false; reason: string }

export type ContractDirectory = {
  chain: { id: number; name: string; explorer: string }
  items: {
    key: string
    address: string
    label: string
    role: string
    kind: 'token' | 'contract' | 'safe'
    explorerUrl: string
  }[]
  historicMinters: { address: string; explorerUrl: string }[]
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${config.apiBaseUrl}${path}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status)
  const json = (await res.json()) as { data: T }
  return json.data
}

export type DemoBundle = {
  overview: Overview
  flows: FlowItem[]
  plantings: PlantingSummary[]
  details: Record<string, PlantingDetail>
  map: { points: MapPoint[]; total: number }
  onchain: OnchainLive
  contracts: ContractDirectory
}

let demoBundle: Promise<DemoBundle> | null = null
function loadDemo(): Promise<DemoBundle> {
  if (!demoBundle) {
    demoBundle = fetch(config.demoDataUrl, { headers: { accept: 'application/json' } }).then(async res => {
      if (!res.ok) throw new ApiError(`demo bundle ${res.status}`, res.status)
      return (await res.json()) as DemoBundle
    })
  }
  return demoBundle
}

const DEFAULT_KINDS: FlowKind[] = ['funding', 'payout', 'reward', 'retire', 'verified', 'update']

/** Same surface as `liveApi`, served from a static JSON bundle (previews, demos). */
const demoApi: typeof liveApi = {
  overview: () => loadDemo().then(d => d.overview),
  flows: async (params = {}) => {
    const d = await loadDemo()
    const kinds = params.kinds?.length ? params.kinds : DEFAULT_KINDS
    const all = d.flows.filter(i => kinds.includes(i.kind))
    const limit = params.limit || 40
    const start = params.cursor ? Math.max(0, all.findIndex(i => i.id === params.cursor) + 1) : 0
    const items = all.slice(start, start + limit)
    const last = items[items.length - 1]
    return { items, nextCursor: start + limit < all.length && last ? last.id : null, kinds }
  },
  plantings: async (params = {}) => {
    const d = await loadDemo()
    const list = d.plantings.slice()
    if (params.sort === 'trees') list.sort((x, y) => y.trees - x.trees)
    else if (params.sort === 'funded') list.sort((x, y) => Number(y.funding.status === 'funded') - Number(x.funding.status === 'funded'))
    const page = params.page || 1
    const limit = params.limit || 24
    return { items: list.slice((page - 1) * limit, page * limit), page, limit, total: list.length }
  },
  planting: async id => {
    const d = await loadDemo()
    const detail = d.details[id]
    if (!detail) throw new ApiError('Planting not found', 404)
    return detail
  },
  map: () => loadDemo().then(d => d.map),
  onchain: () => loadDemo().then(d => d.onchain),
  contracts: () => loadDemo().then(d => d.contracts),
}

const liveApi = {
  overview: (signal?: AbortSignal) => get<Overview>('/api/transparency/overview', signal),
  flows: (params: { limit?: number; cursor?: string | null; kinds?: FlowKind[] } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    if (params.limit) q.set('limit', String(params.limit))
    if (params.cursor) q.set('cursor', params.cursor)
    if (params.kinds?.length) q.set('kinds', params.kinds.join(','))
    const qs = q.toString()
    return get<{ items: FlowItem[]; nextCursor: string | null; kinds: FlowKind[] }>(
      `/api/transparency/flows${qs ? `?${qs}` : ''}`,
      signal,
    )
  },
  plantings: (params: { page?: number; limit?: number; sort?: 'recent' | 'trees' | 'funded' } = {}, signal?: AbortSignal) => {
    const q = new URLSearchParams()
    if (params.page) q.set('page', String(params.page))
    if (params.limit) q.set('limit', String(params.limit))
    if (params.sort) q.set('sort', params.sort)
    const qs = q.toString()
    return get<{ items: PlantingSummary[]; page: number; limit: number; total: number }>(
      `/api/transparency/plantings${qs ? `?${qs}` : ''}`,
      signal,
    )
  },
  planting: (id: string, signal?: AbortSignal) =>
    get<PlantingDetail>(`/api/transparency/plantings/${encodeURIComponent(id)}`, signal),
  map: (signal?: AbortSignal) => get<{ points: MapPoint[]; total: number }>('/api/transparency/map', signal),
  onchain: (signal?: AbortSignal) => get<OnchainLive>('/api/transparency/onchain', signal),
  contracts: (signal?: AbortSignal) => get<ContractDirectory>('/api/transparency/contracts', signal),
}

export const api: typeof liveApi = config.demoDataUrl ? demoApi : liveApi
