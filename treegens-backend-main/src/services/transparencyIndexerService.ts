import { ethers } from 'ethers'
import env from '../config/environment'
import OnchainEvent, { type OnchainEventMeta } from '../models/OnchainEvent'
import OnchainIndexerState from '../models/OnchainIndexerState'
import OnchainTxIngest from '../models/OnchainTxIngest'
import RewardAllocation from '../models/RewardAllocation'
import TgnDistribution from '../models/TgnDistribution'

/**
 * Public-ledger indexer.
 *
 * Reads Base once and writes one OnchainEvent per fact the transparency page
 * shows, so every figure on it is a sum over rows that each carry a tx hash:
 *
 *   • $MGRO Transfer from 0x0  → `mgro_mint`  (reward paid to planter/verifier)
 *   • $MGRO Transfer to 0x0    → `mgro_burn`  (funder retired MGRO for trees)
 *   • VerifierMinter.MintProposed / MintExecuted → `mint_proposed` /
 *     `mint_executed`. The proposal's evidenceURI
 *     (`treegens://submission/<id>/planter/tranche/<n>` or
 *     `treegens://submission/<id>/verifier/<wallet>`) is how the chain itself
 *     names the planting a mint pays for, so mints are linked to plantings
 *     from on-chain data, not from our database.
 *   • $TGN Transfer logs inside each completed TgnDistribution's payout
 *     receipts → `tgn_payout` (planter 95% / verifier 5%). Amounts come from
 *     the receipt, not from what the relayer told us it sent.
 *
 * Idempotent: rows are upserted on (txHash, logIndex); receipts are tracked in
 * OnchainTxIngest so a missing receipt is retried a bounded number of times.
 */

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')
const ZERO = ethers.ZeroAddress.toLowerCase()
const ZERO_TOPIC = ethers.zeroPadValue(ethers.ZeroAddress, 32)

const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]

const VERIFIER_MINTER_EVENTS_ABI = [
  'event MintProposed(uint256 indexed proposalId, address indexed proposer, address indexed to, uint256 amount, string evidenceURI)',
  'event MintExecuted(uint256 indexed proposalId, address indexed to, uint256 amount, uint256 approvals)',
]

const erc20Iface = new ethers.Interface(ERC20_TRANSFER_ABI)
const minterIface = new ethers.Interface(VERIFIER_MINTER_EVENTS_ABI)
const MINT_PROPOSED_TOPIC = minterIface.getEvent('MintProposed')!.topicHash
const MINT_EXECUTED_TOPIC = minterIface.getEvent('MintExecuted')!.topicHash

const MAX_RECEIPT_ATTEMPTS = 6
const MIN_CHUNK = 100

export type EvidenceRef = {
  submissionId: string
  role: 'planter' | 'verifier'
  trancheIndex?: number
  wallet?: string
}

/**
 * Parse the evidenceURI the reward service writes into MintProposed.
 *   treegens://submission/<objectId>/planter/tranche/<index>
 *   treegens://submission/<objectId>/verifier/<wallet>
 * Returns null for anything else (legacy `treegens://reward/...` included).
 */
export function parseEvidenceURI(
  uri: string | null | undefined,
): EvidenceRef | null {
  if (!uri) return null
  const m = String(uri)
    .trim()
    .match(
      /^treegens:\/\/submission\/([a-fA-F0-9]{24})\/(planter|verifier)(?:\/(.*))?$/,
    )
  if (!m) return null
  const submissionId = m[1].toLowerCase()
  if (m[2] === 'planter') {
    const t = (m[3] || '').match(/^tranche\/(\d+)$/)
    return {
      submissionId,
      role: 'planter',
      ...(t ? { trancheIndex: Number(t[1]) } : {}),
    }
  }
  const wallet = (m[3] || '').trim().toLowerCase()
  return {
    submissionId,
    role: 'verifier',
    ...(/^0x[a-f0-9]{40}$/.test(wallet) ? { wallet } : {}),
  }
}

/** Mint, burn, or a plain transfer the ledger does not keep. */
export function classifyMgroTransfer(
  from: string,
  to: string,
): 'mgro_mint' | 'mgro_burn' | null {
  const f = String(from).toLowerCase()
  const t = String(to).toLowerCase()
  if (f === ZERO && t !== ZERO) return 'mgro_mint'
  if (t === ZERO && f !== ZERO) return 'mgro_burn'
  return null
}

/** True when an RPC error means "ask for a smaller block range". */
export function isRangeTooLargeError(error: unknown): boolean {
  const msg = String(
    (error as { message?: string })?.message || error || '',
  ).toLowerCase()
  return (
    msg.includes('more than') ||
    msg.includes('too many') ||
    msg.includes('block range') ||
    msg.includes('limit exceeded') ||
    msg.includes('query returned') ||
    msg.includes('response size') ||
    msg.includes('timeout')
  )
}

/**
 * Which role a TGN transfer inside a payout tx plays, judged against the
 * distribution record it belongs to. `null` = an intermediate leg (swap
 * output to the relayer, fees) the ledger does not show.
 */
export function payoutRoleFor(
  to: string,
  distribution: { planterWallet?: string; verifiers?: { wallet: string }[] },
): 'planter' | 'verifier' | null {
  const t = String(to).toLowerCase()
  if (
    distribution.planterWallet &&
    t === distribution.planterWallet.toLowerCase()
  ) {
    return 'planter'
  }
  if (
    (distribution.verifiers || []).some(
      v => String(v.wallet).toLowerCase() === t,
    )
  ) {
    return 'verifier'
  }
  return null
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    },
  )
  await Promise.all(workers)
  return out
}

type EventRow = {
  chainId: number
  txHash: string
  logIndex: number
  blockNumber: number
  blockTime: Date
  contract: string
  kind: string
  token: 'MGRO' | 'TGN' | ''
  from: string
  to: string
  amountWei: string
  meta: OnchainEventMeta
}

export default class TransparencyIndexerService {
  private provider: ethers.JsonRpcProvider

  private readonly mgro: string

  private readonly tgn: string

  private readonly minters: string[]

  private readonly chainId = 8453

  private readonly confirmations: number

  private chunkSize: number

  private readonly pollMs: number

  private readonly startBlock: number

  private readonly cursorKey: string

  private timer: NodeJS.Timeout | null = null

  private syncInProgress = false

  private lastSyncAt: Date | null = null

  private lastError = ''

  private lastHead = 0

  private readonly blockTimes = new Map<number, Date>()

  constructor() {
    const rpcUrl = env.BASE_RPC_URL
    if (!rpcUrl) {
      throw new Error('BASE_RPC_URL is required for the ledger indexer')
    }
    this.provider = new ethers.JsonRpcProvider(rpcUrl)
    this.mgro = env.MGRO_TOKEN_ADDRESS.toLowerCase()
    this.tgn = env.TGN_TOKEN_ADDRESS.toLowerCase()
    this.minters = env.TRANSPARENCY_MINTER_ADDRESSES.map(a => a.toLowerCase())
    this.confirmations = env.LEDGER_INDEXER_CONFIRMATIONS
    this.chunkSize = env.LEDGER_INDEXER_CHUNK_SIZE
    this.pollMs = env.LEDGER_INDEXER_POLL_MS
    this.startBlock = env.LEDGER_INDEXER_START_BLOCK
    this.cursorKey = `ledger:${this.chainId}:${this.mgro}`
  }

  start() {
    if (this.timer) return
    const tick = async () => {
      try {
        await this.syncOnce()
      } catch (error: any) {
        this.lastError = error?.message || String(error)
        console.error('[LedgerIndexer] tick failed', {
          message: this.lastError,
        })
      } finally {
        this.timer = setTimeout(tick, this.pollMs)
      }
    }
    void tick()
  }

  stop() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /** One full pass: log scan to the confirmed head, then payout receipts. */
  async syncOnce() {
    if (this.syncInProgress) return
    this.syncInProgress = true
    try {
      await this.syncLogs()
      await this.syncPayoutReceipts()
      this.lastSyncAt = new Date()
      this.lastError = ''
    } catch (error: any) {
      this.lastError = error?.message || String(error)
      throw error
    } finally {
      this.syncInProgress = false
    }
  }

  async getStatus() {
    const state = await OnchainIndexerState.findOne({
      key: this.cursorKey,
    }).lean()
    const lastProcessedBlock = Number(state?.lastProcessedBlock || 0)
    return {
      enabled: true,
      cursorKey: this.cursorKey,
      startBlock: this.startBlock,
      lastProcessedBlock,
      head: this.lastHead,
      lagBlocks: this.lastHead
        ? Math.max(0, this.lastHead - lastProcessedBlock)
        : null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError || null,
      contracts: { mgro: this.mgro, tgn: this.tgn, minters: this.minters },
    }
  }

  // ------------------------------------------------------------ log scan --

  private async syncLogs() {
    const head = await this.provider.getBlockNumber()
    this.lastHead = head
    const confirmedHead = Math.max(0, head - this.confirmations)
    let current = await this.nextFromBlock()
    while (current <= confirmedHead) {
      const toBlock = Math.min(confirmedHead, current + this.chunkSize - 1)
      try {
        await this.processRange(current, toBlock)
      } catch (error) {
        if (isRangeTooLargeError(error) && this.chunkSize > MIN_CHUNK) {
          this.chunkSize = Math.max(MIN_CHUNK, Math.floor(this.chunkSize / 2))
          console.warn('[LedgerIndexer] shrinking chunk size', {
            chunkSize: this.chunkSize,
          })
          continue
        }
        throw error
      }
      current = toBlock + 1
    }
  }

  private async nextFromBlock() {
    const state = await OnchainIndexerState.findOne({
      key: this.cursorKey,
    }).lean()
    if (!state) return this.startBlock
    return Math.max(this.startBlock, Number(state.lastProcessedBlock || 0) + 1)
  }

  private async processRange(fromBlock: number, toBlock: number) {
    // Mints and burns only: filtering on the zero-address topic keeps a busy
    // token's ordinary transfers out of the response entirely.
    const [mintLogs, burnLogs, minterLogs] = await Promise.all([
      this.provider.getLogs({
        address: this.mgro,
        fromBlock,
        toBlock,
        topics: [TRANSFER_TOPIC, ZERO_TOPIC],
      }),
      this.provider.getLogs({
        address: this.mgro,
        fromBlock,
        toBlock,
        topics: [TRANSFER_TOPIC, null, ZERO_TOPIC],
      }),
      this.minters.length
        ? this.provider.getLogs({
            address: this.minters,
            fromBlock,
            toBlock,
            topics: [[MINT_PROPOSED_TOPIC, MINT_EXECUTED_TOPIC]],
          })
        : Promise.resolve([] as ethers.Log[]),
    ])

    const rows: EventRow[] = []
    const blocks = new Set<number>()
    const transferLogs = [...mintLogs, ...burnLogs]

    for (const log of transferLogs) {
      const parsed = this.safeParse(erc20Iface, log)
      if (!parsed) continue
      const from = String(parsed.args.from).toLowerCase()
      const to = String(parsed.args.to).toLowerCase()
      const kind = classifyMgroTransfer(from, to)
      if (!kind) continue
      const value = BigInt(parsed.args.value.toString())
      if (value <= 0n) continue
      blocks.add(log.blockNumber)
      rows.push({
        chainId: this.chainId,
        txHash: log.transactionHash.toLowerCase(),
        logIndex: log.index,
        blockNumber: log.blockNumber,
        blockTime: new Date(0),
        contract: this.mgro,
        kind,
        token: 'MGRO',
        from,
        to,
        amountWei: value.toString(),
        meta: kind === 'mgro_burn' ? { role: 'funder' } : {},
      })
    }

    for (const log of minterLogs) {
      const parsed = this.safeParse(minterIface, log)
      if (!parsed) continue
      blocks.add(log.blockNumber)
      const base = {
        chainId: this.chainId,
        txHash: log.transactionHash.toLowerCase(),
        logIndex: log.index,
        blockNumber: log.blockNumber,
        blockTime: new Date(0),
        contract: String(log.address).toLowerCase(),
        token: '' as const,
      }
      if (parsed.name === 'MintProposed') {
        const evidenceURI = String(parsed.args.evidenceURI || '')
        const ref = parseEvidenceURI(evidenceURI)
        rows.push({
          ...base,
          kind: 'mint_proposed',
          from: String(parsed.args.proposer).toLowerCase(),
          to: String(parsed.args.to).toLowerCase(),
          amountWei: BigInt(parsed.args.amount.toString()).toString(),
          meta: {
            proposalId: Number(parsed.args.proposalId),
            evidenceURI,
            ...(ref
              ? {
                  submissionId: ref.submissionId,
                  role: ref.role,
                  ...(ref.trancheIndex !== undefined
                    ? { trancheIndex: ref.trancheIndex }
                    : {}),
                }
              : {}),
          },
        })
      } else if (parsed.name === 'MintExecuted') {
        rows.push({
          ...base,
          kind: 'mint_executed',
          from: '',
          to: String(parsed.args.to).toLowerCase(),
          amountWei: BigInt(parsed.args.amount.toString()).toString(),
          meta: {
            proposalId: Number(parsed.args.proposalId),
            approvals: BigInt(parsed.args.approvals.toString()).toString(),
          },
        })
      }
    }

    if (rows.length) {
      await this.fillBlockTimes(blocks)
      for (const row of rows) {
        row.blockTime = this.blockTimes.get(row.blockNumber) || new Date(0)
      }
      await this.upsertRows(rows)
      await this.linkMintsToPlantings([...new Set(rows.map(r => r.txHash))])
    }

    await OnchainIndexerState.updateOne(
      { key: this.cursorKey },
      {
        $set: {
          key: this.cursorKey,
          lastProcessedBlock: toBlock,
          'meta.lastRangeRows': rows.length,
          'meta.lastRangeAt': new Date(),
        },
      },
      { upsert: true },
    )
  }

  private safeParse(iface: ethers.Interface, log: ethers.Log) {
    try {
      return iface.parseLog({ topics: [...log.topics], data: log.data })
    } catch {
      return null
    }
  }

  private async fillBlockTimes(blocks: Set<number>) {
    const missing = [...blocks].filter(b => !this.blockTimes.has(b))
    await mapLimit(missing, 4, async blockNumber => {
      const block = await this.provider.getBlock(blockNumber)
      if (block) {
        this.blockTimes.set(
          blockNumber,
          new Date(Number(block.timestamp) * 1000),
        )
      }
    })
    // Keep the cache bounded; the scan only moves forward.
    if (this.blockTimes.size > 5000) {
      const keys = [...this.blockTimes.keys()].sort((a, b) => a - b)
      for (const k of keys.slice(0, keys.length - 2000))
        this.blockTimes.delete(k)
    }
  }

  private async upsertRows(rows: EventRow[]) {
    if (!rows.length) return
    await OnchainEvent.bulkWrite(
      rows.map(row => ({
        updateOne: {
          filter: { txHash: row.txHash, logIndex: row.logIndex },
          update: { $setOnInsert: row },
          upsert: true,
        },
      })),
      { ordered: false },
    )
  }

  /**
   * Give each `mgro_mint` the planting it pays for, in this order of trust:
   *   1. the MintExecuted in the same tx → its proposal's on-chain evidenceURI
   *   2. our RewardAllocation ledger (tranche / verifier claim tx hashes),
   *      which also covers legacy direct mints that never had a proposal.
   */
  async linkMintsToPlantings(txHashes: string[]) {
    if (!txHashes.length) return
    const mints = await OnchainEvent.find({
      kind: 'mgro_mint',
      txHash: { $in: txHashes },
      'meta.submissionId': { $exists: false },
    }).lean()
    if (!mints.length) return

    const executed = await OnchainEvent.find({
      kind: 'mint_executed',
      txHash: { $in: mints.map(m => m.txHash) },
    }).lean()
    const proposalIds = [
      ...new Set(
        executed
          .map(e => Number(e.meta?.proposalId))
          .filter(n => Number.isFinite(n)),
      ),
    ]
    const proposals = proposalIds.length
      ? await OnchainEvent.find({
          kind: 'mint_proposed',
          'meta.proposalId': { $in: proposalIds },
          'meta.submissionId': { $exists: true },
        }).lean()
      : []
    const proposalByKey = new Map<string, OnchainEventMeta>()
    for (const p of proposals) {
      proposalByKey.set(`${p.contract}:${p.meta.proposalId}`, p.meta)
    }
    const executedByTx = new Map<string, OnchainEventMeta>()
    for (const e of executed) {
      const meta = proposalByKey.get(`${e.contract}:${e.meta?.proposalId}`)
      if (meta) {
        executedByTx.set(`${e.txHash}:${String(e.to).toLowerCase()}`, {
          ...meta,
          approvals: e.meta?.approvals,
        })
      }
    }

    const unresolved: typeof mints = []
    const ops: any[] = []
    for (const mint of mints) {
      const meta = executedByTx.get(
        `${mint.txHash}:${String(mint.to).toLowerCase()}`,
      )
      if (meta) {
        ops.push({
          updateOne: {
            filter: { _id: mint._id },
            update: {
              $set: {
                'meta.submissionId': meta.submissionId,
                'meta.role': meta.role,
                'meta.proposalId': meta.proposalId,
                'meta.evidenceURI': meta.evidenceURI,
                ...(meta.trancheIndex !== undefined
                  ? { 'meta.trancheIndex': meta.trancheIndex }
                  : {}),
                ...(meta.approvals ? { 'meta.approvals': meta.approvals } : {}),
              },
            },
          },
        })
      } else {
        unresolved.push(mint)
      }
    }

    if (unresolved.length) {
      const hashes = [...new Set(unresolved.map(m => m.txHash))]
      const allocations = await RewardAllocation.find(
        {
          $or: [
            { 'tranches.txHash': { $in: hashes } },
            { 'verifierClaims.txHash': { $in: hashes } },
          ],
        },
        { submissionId: 1, tranches: 1, verifierClaims: 1 },
      ).lean()
      for (const mint of unresolved) {
        for (const alloc of allocations) {
          const tranche = (alloc.tranches || []).find(
            (t: any) => String(t.txHash || '').toLowerCase() === mint.txHash,
          )
          const claim = (alloc.verifierClaims || []).find(
            (c: any) => String(c.txHash || '').toLowerCase() === mint.txHash,
          )
          if (!tranche && !claim) continue
          ops.push({
            updateOne: {
              filter: { _id: mint._id },
              update: {
                $set: {
                  'meta.submissionId': String(alloc.submissionId),
                  'meta.role': tranche ? 'planter' : 'verifier',
                  ...(tranche ? { 'meta.trancheIndex': tranche.index } : {}),
                },
              },
            },
          })
          break
        }
      }
    }

    if (ops.length) await OnchainEvent.bulkWrite(ops, { ordered: false })
  }

  // ------------------------------------------------------- payout receipts --

  /**
   * Read the receipts of completed TgnDistribution payouts and record the
   * $TGN legs that reached the planter and the verifiers. Also stamps the
   * funder's `mgro_burn` row (MGRO rail) with the planting it retired MGRO for.
   */
  async syncPayoutReceipts(limit = 40) {
    const completed = await TgnDistribution.find(
      { planterTx: { $nin: ['', null] } },
      {
        submissionId: 1,
        grossUsd: 1,
        planterWallet: 1,
        planterTx: 1,
        verifiers: 1,
        rail: 1,
      },
    )
      .sort({ distributedAt: -1 })
      .limit(500)
      .lean()
    if (!completed.length) return

    const byTx = new Map<string, (typeof completed)[number]>()
    for (const d of completed) {
      const hashes = [d.planterTx, ...(d.verifiers || []).map(v => v.tx)]
      for (const raw of hashes) {
        const h = String(raw || '')
          .trim()
          .toLowerCase()
        if (/^0x[a-f0-9]{64}$/.test(h) && !byTx.has(h)) byTx.set(h, d)
      }
    }
    if (!byTx.size) return

    const done = await OnchainTxIngest.find(
      {
        txHash: { $in: [...byTx.keys()] },
        $or: [
          { status: { $in: ['ingested', 'invalid'] } },
          { attempts: { $gte: MAX_RECEIPT_ATTEMPTS } },
        ],
      },
      { txHash: 1 },
    ).lean()
    const skip = new Set(done.map(d => d.txHash))
    const pending = [...byTx.keys()].filter(h => !skip.has(h)).slice(0, limit)

    await mapLimit(pending, 3, async txHash => {
      const distribution = byTx.get(txHash)!
      try {
        const receipt = await this.provider.getTransactionReceipt(txHash)
        if (!receipt) {
          await this.markIngest(
            txHash,
            distribution,
            'not_found',
            0,
            'receipt not found',
          )
          return
        }
        const written = await this.ingestPayoutReceipt(receipt, distribution)
        await this.markIngest(txHash, distribution, 'ingested', written, '')
      } catch (error: any) {
        await this.markIngest(
          txHash,
          distribution,
          'failed',
          0,
          error?.message || String(error),
        )
      }
    })
  }

  private async markIngest(
    txHash: string,
    distribution: { submissionId: unknown },
    status: 'ingested' | 'not_found' | 'failed' | 'invalid',
    eventsWritten: number,
    lastError: string,
  ) {
    await OnchainTxIngest.updateOne(
      { txHash },
      {
        $set: {
          txHash,
          source: 'tgn_distribution',
          submissionId: String(distribution.submissionId),
          status,
          eventsWritten,
          lastError: lastError.slice(0, 500),
        },
        $inc: { attempts: 1 },
      },
      { upsert: true },
    )
  }

  private async ingestPayoutReceipt(
    receipt: ethers.TransactionReceipt,
    distribution: {
      submissionId: unknown
      grossUsd?: number
      planterWallet?: string
      verifiers?: { wallet: string }[]
    },
  ): Promise<number> {
    if (receipt.status !== 1) return 0
    await this.fillBlockTimes(new Set([receipt.blockNumber]))
    const blockTime = this.blockTimes.get(receipt.blockNumber) || new Date(0)
    const submissionId = String(distribution.submissionId)
    const rows: EventRow[] = []
    const burnStamps: any[] = []

    for (const log of receipt.logs) {
      const address = String(log.address).toLowerCase()
      if (log.topics[0] !== TRANSFER_TOPIC) continue
      const parsed = this.safeParse(erc20Iface, log as unknown as ethers.Log)
      if (!parsed) continue
      const from = String(parsed.args.from).toLowerCase()
      const to = String(parsed.args.to).toLowerCase()
      const value = BigInt(parsed.args.value.toString())
      if (value <= 0n) continue

      if (address === this.tgn) {
        const role = payoutRoleFor(to, distribution)
        if (!role) continue
        rows.push({
          chainId: this.chainId,
          txHash: receipt.hash.toLowerCase(),
          logIndex: log.index,
          blockNumber: receipt.blockNumber,
          blockTime,
          contract: this.tgn,
          kind: 'tgn_payout',
          token: 'TGN',
          from,
          to,
          amountWei: value.toString(),
          meta: {
            submissionId,
            role,
            ...(typeof distribution.grossUsd === 'number'
              ? { grossUsd: distribution.grossUsd }
              : {}),
          },
        })
      } else if (address === this.mgro && to === ZERO) {
        // MGRO rail: the funder's burn is the payment. The log scan already
        // stores the burn row; here we only attach the planting it retired.
        burnStamps.push({
          updateOne: {
            filter: { txHash: receipt.hash.toLowerCase(), logIndex: log.index },
            update: {
              $set: {
                'meta.submissionId': submissionId,
                'meta.role': 'funder',
                ...(typeof distribution.grossUsd === 'number'
                  ? { 'meta.grossUsd': distribution.grossUsd }
                  : {}),
              },
            },
          },
        })
      }
    }

    await this.upsertRows(rows)
    if (burnStamps.length) {
      await OnchainEvent.bulkWrite(burnStamps, { ordered: false })
    }
    return rows.length
  }
}
