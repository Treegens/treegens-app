import { Contract, JsonRpcProvider, NonceManager, Wallet } from 'ethers'
import env from '../config/environment'

const VERIFIER_MINTER_ABI = [
  'function isMember(address account) view returns (bool)',
  'function hasWeight(address account) view returns (bool)',
  'function isEligible(address account) view returns (bool)',
  'function weightOf(address account) view returns (uint256)',
  'function minStake() view returns (uint256)',
  'function minVerifiers() view returns (uint256)',
  'function eligibleTotals() view returns (uint256 eligibleCount, uint256 totalWeight)',
  'function enroll()',
  'function evict(address verifier)',
  'function propose(address to, uint256 amount, string evidenceURI) returns (uint256)',
  'function execute(uint256 proposalId)',
  'function getProposal(uint256 proposalId) view returns ((address to, uint256 amount, string evidenceURI, uint64 createdAt, bool executed, bool cancelled, bool pending, uint256 approvedWeight, uint256 totalWeight, uint256 eligibleCount))',
  'event MintProposed(uint256 indexed proposalId, address indexed proposer, address indexed to, uint256 amount, string evidenceURI)',
  'event MintExecuted(uint256 indexed proposalId, address indexed to, uint256 amount, uint256 approvals)',
] as const

export type ProposalState = {
  to: string
  amount: bigint
  executed: boolean
  cancelled: boolean
  pending: boolean
  approvedWeight: bigint
  totalWeight: bigint
  eligibleCount: bigint
  minVerifiers: bigint
}

/**
 * Client for the VerifierMinter contract — since 2026-07-25 the only address
 * with MINTER_ROLE on canonical MGRO. Reward mints are proposed here by the
 * backend minter wallet (which must itself be an eligible verifier: enrolled
 * with ≥2000 TGN of stake or delegation) and land once a majority of live
 * verifier stake approves. `execute` is permissionless.
 */
class VerifierMinterService {
  private provider: JsonRpcProvider | null = null
  private minterWallet: Wallet | null = null
  private minterSigner: NonceManager | null = null

  private getProvider(): JsonRpcProvider {
    const rpcUrl = env.BASE_RPC_URL
    if (!rpcUrl) {
      throw new Error(
        'BASE_RPC_URL (or RPC_URL) is required for VerifierMinter',
      )
    }
    if (!this.provider) {
      this.provider = new JsonRpcProvider(rpcUrl)
    }
    return this.provider
  }

  private reader(): Contract {
    return new Contract(
      env.VERIFIER_MINTER_ADDRESS,
      VERIFIER_MINTER_ABI as unknown as [],
      this.getProvider(),
    )
  }

  private asMinter(): { contract: Contract; address: string } {
    const pk = env.MGRO_MINTER_PRIVATE_KEY?.trim()
    if (!pk) {
      throw new Error('MGRO_MINTER_PRIVATE_KEY is not configured')
    }
    if (!this.minterWallet) {
      this.minterWallet = new Wallet(pk, this.getProvider())
      this.minterSigner = new NonceManager(this.minterWallet)
    }
    return {
      contract: new Contract(
        env.VERIFIER_MINTER_ADDRESS,
        VERIFIER_MINTER_ABI as unknown as [],
        this.minterSigner as NonceManager,
      ),
      address: this.minterWallet.address,
    }
  }

  /** Evictions are housekeeping — use the slasher key, minter as fallback. */
  private asEvictor(): Contract {
    const pk =
      env.TGN_VAULT_SLASHER_PRIVATE_KEY?.trim() ||
      env.MGRO_MINTER_PRIVATE_KEY?.trim()
    if (!pk) {
      throw new Error('No slasher or minter key configured for evict')
    }
    const wallet = new Wallet(pk, this.getProvider())
    return new Contract(
      env.VERIFIER_MINTER_ADDRESS,
      VERIFIER_MINTER_ABI as unknown as [],
      wallet,
    )
  }

  isConfigured(): boolean {
    return Boolean(
      env.BASE_RPC_URL?.trim() &&
        env.VERIFIER_MINTER_ADDRESS &&
        env.MGRO_MINTER_PRIVATE_KEY?.trim(),
    )
  }

  async isMember(account: string): Promise<boolean> {
    return Boolean(await this.reader().isMember(account))
  }

  async hasWeight(account: string): Promise<boolean> {
    return Boolean(await this.reader().hasWeight(account))
  }

  async getProposalState(proposalId: number): Promise<ProposalState> {
    const reader = this.reader()
    const [p, minVerifiers] = await Promise.all([
      reader.getProposal(proposalId),
      reader.minVerifiers(),
    ])
    return {
      to: String(p.to),
      amount: BigInt(p.amount),
      executed: Boolean(p.executed),
      cancelled: Boolean(p.cancelled),
      pending: Boolean(p.pending),
      approvedWeight: BigInt(p.approvedWeight),
      totalWeight: BigInt(p.totalWeight),
      eligibleCount: BigInt(p.eligibleCount),
      minVerifiers: BigInt(minVerifiers),
    }
  }

  /**
   * Make sure the minter wallet is enrolled as a verifier. Self-activating:
   * the moment the wallet has 2000 TGN of stake/delegation, the next reward
   * mint enrolls it automatically. Throws a clear, actionable error while it
   * does not.
   */
  async ensureEnrolled(): Promise<void> {
    const { contract, address } = this.asMinter()
    if (await this.isMember(address)) return
    if (!(await this.hasWeight(address))) {
      throw new Error(
        `MGRO minter wallet ${address} is not an eligible verifier: it needs ` +
          `2000 TGN of stake or delegation before it can propose reward ` +
          `mints. Delegate to it at https://delegate.treegens.app — rewards ` +
          `stay queued until then.`,
      )
    }
    const tx = await contract.enroll()
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new Error('VerifierMinter enroll transaction failed')
    }
  }

  /** Propose a mint; the proposer's own approval is counted automatically. */
  async propose(
    to: string,
    amountWei: string,
    evidenceURI: string,
  ): Promise<{ proposalId: number; txHash: string }> {
    const { contract } = this.asMinter()
    const tx = await contract.propose(to, amountWei, evidenceURI)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new Error('VerifierMinter propose transaction failed')
    }
    for (const log of receipt.logs || []) {
      try {
        const parsed = contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        })
        if (parsed?.name === 'MintProposed') {
          return { proposalId: Number(parsed.args[0]), txHash: receipt.hash }
        }
      } catch {
        // not our event — keep scanning
      }
    }
    throw new Error('MintProposed event not found in propose receipt')
  }

  /** Execute a majority-approved proposal (permissionless on-chain). */
  async execute(proposalId: number): Promise<string> {
    const { contract } = this.asMinter()
    const tx = await contract.execute(proposalId)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new Error('VerifierMinter execute transaction failed')
    }
    return receipt.hash
  }

  /** Best-effort lookup of the tx that executed a proposal (for ledgers). */
  async findExecutionTx(proposalId: number): Promise<string | null> {
    try {
      const reader = this.reader()
      const filter = reader.filters.MintExecuted(proposalId)
      const events = await reader.queryFilter(filter, -450000) // ~10 days on Base
      const last = events[events.length - 1]
      return last ? last.transactionHash : null
    } catch {
      return null
    }
  }

  /**
   * Permissionless housekeeping after a slash: if the account is an enrolled
   * verifier whose weight fell below the floor, remove it from the set so the
   * majority denominator stays honest. No-op otherwise.
   */
  async evictIfBelowFloor(account: string): Promise<boolean> {
    const reader = this.reader()
    const [member, weighted] = await Promise.all([
      reader.isMember(account),
      reader.hasWeight(account),
    ])
    if (!member || weighted) return false
    const contract = this.asEvictor()
    const tx = await contract.evict(account)
    const receipt = await tx.wait()
    return Boolean(receipt && receipt.status === 1)
  }
}

export default VerifierMinterService
