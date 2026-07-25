import { Contract, JsonRpcProvider, NonceManager, Wallet } from 'ethers'
import { MGRO_ABI } from '../abis/mgro'
import env from '../config/environment'
import VerifierMinterService from './verifierMinterService'

export type MintResult = {
  txHash: string
  blockNumber?: number
  /** 'direct' token mint, or a mint that landed via a VerifierMinter proposal. */
  mode?: 'direct' | 'proposal'
  proposalId?: number
}

export type MintOptions = {
  /** Public record of what this mint pays for (ipfs://…, treegens://…). */
  evidenceURI?: string
  /** Resume an earlier proposal instead of opening a duplicate. */
  existingProposalId?: number
}

/**
 * Thrown when a reward mint has been proposed on-chain but still needs a
 * majority of verifier stake. Callers should record `proposalId` so the next
 * claim attempt resumes the same proposal instead of opening a new one.
 */
export class PendingVerifierApprovalError extends Error {
  readonly proposalId: number
  readonly proposeTxHash?: string

  constructor(proposalId: number, proposeTxHash?: string) {
    super(
      `Awaiting verifier approval: mint proposal #${proposalId} needs a ` +
        `majority of live verifier stake. Verifiers approve at ` +
        `https://delegate.treegens.app/verify.html — claiming again after ` +
        `approval completes the payout.`,
    )
    this.name = 'PendingVerifierApprovalError'
    this.proposalId = proposalId
    this.proposeTxHash = proposeTxHash
  }
}

export function isRetryableNonceError(error: any): boolean {
  const code = String(error?.code || '')
  const msg = String(error?.message || '').toLowerCase()
  return (
    code === 'NONCE_EXPIRED' ||
    msg.includes('nonce too low') ||
    msg.includes('already known') ||
    msg.includes('replacement transaction underpriced')
  )
}

/**
 * Mints MGRO rewards.
 *
 * Since 2026-07-25 the canonical token mints ONLY through the VerifierMinter
 * contract (the hot wallet's MINTER_ROLE was revoked), so the default path
 * (`MGRO_MINT_MODE=verifier`) proposes there from the minter wallet and
 * finishes when a majority of verifier stake approves. `MGRO_MINT_MODE=direct`
 * keeps the legacy direct mint for emergencies.
 */
class RewardMintService {
  private provider: JsonRpcProvider | null = null
  private wallet: Wallet | null = null
  private nonceManager: NonceManager | null = null
  private verifierMinter = new VerifierMinterService()

  private ensureReady(): {
    provider: JsonRpcProvider
    wallet: Wallet
    nonceManager: NonceManager
  } {
    const rpcUrl = env.BASE_RPC_URL
    if (!rpcUrl) {
      throw new Error('BASE_RPC_URL (or RPC_URL) is required for MGRO minting')
    }
    const pk = env.MGRO_MINTER_PRIVATE_KEY?.trim()
    if (!pk) {
      throw new Error('MGRO_MINTER_PRIVATE_KEY is not configured')
    }
    if (!this.provider) {
      this.provider = new JsonRpcProvider(rpcUrl)
    }
    if (!this.wallet) {
      this.wallet = new Wallet(pk, this.provider)
    }
    if (!this.nonceManager) {
      this.nonceManager = new NonceManager(this.wallet)
    }
    return {
      provider: this.provider,
      wallet: this.wallet,
      nonceManager: this.nonceManager,
    }
  }

  isConfigured(): boolean {
    return Boolean(
      env.BASE_RPC_URL?.trim() && env.MGRO_MINTER_PRIVATE_KEY?.trim(),
    )
  }

  async mintTo(
    toAddress: string,
    amountWei: string,
    opts?: MintOptions,
  ): Promise<MintResult> {
    if (env.MGRO_MINT_MODE === 'verifier') {
      return this.mintViaVerifiers(toAddress, amountWei, opts)
    }
    return this.mintDirect(toAddress, amountWei)
  }

  /**
   * Default path: propose on VerifierMinter and execute if majority is
   * already met (single-verifier bootstrap, or a resumed approved proposal).
   * Otherwise throws PendingVerifierApprovalError carrying the proposal id.
   */
  private async mintViaVerifiers(
    toAddress: string,
    amountWei: string,
    opts?: MintOptions,
  ): Promise<MintResult> {
    const vm = this.verifierMinter

    const existing = opts?.existingProposalId
    if (existing !== undefined && existing !== null) {
      const state = await vm.getProposalState(existing)
      if (state.executed) {
        const execTx = await vm.findExecutionTx(existing)
        return {
          txHash: execTx || `verifier-proposal-${existing}`,
          mode: 'proposal',
          proposalId: existing,
        }
      }
      if (state.pending) {
        const hasMajority = state.approvedWeight * 2n > state.totalWeight
        const hasQuorum = state.eligibleCount >= state.minVerifiers
        if (hasMajority && hasQuorum) {
          try {
            const txHash = await vm.execute(existing)
            return { txHash, mode: 'proposal', proposalId: existing }
          } catch {
            // fall through — approvals may have shifted under us
          }
        }
        throw new PendingVerifierApprovalError(existing)
      }
      // cancelled or expired — open a fresh proposal below
    }

    await vm.ensureEnrolled()
    const evidenceURI =
      opts?.evidenceURI ||
      `treegens://reward/${toAddress.toLowerCase()}/${amountWei}`
    const { proposalId, txHash: proposeTx } = await vm.propose(
      toAddress,
      amountWei,
      evidenceURI,
    )
    try {
      const txHash = await vm.execute(proposalId)
      return { txHash, mode: 'proposal', proposalId }
    } catch {
      throw new PendingVerifierApprovalError(proposalId, proposeTx)
    }
  }

  /** Legacy direct mint (requires MINTER_ROLE on the token). */
  private async mintDirect(
    toAddress: string,
    amountWei: string,
  ): Promise<MintResult> {
    const { nonceManager } = this.ensureReady()
    const tokenAddress = env.MGRO_TOKEN_ADDRESS
    const contract = new Contract(
      tokenAddress,
      MGRO_ABI as unknown as [],
      nonceManager,
    )

    let lastErr: any
    const maxAttempts = 2
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          this.nonceManager?.reset()
        }
        // Base mainnet MGRO exposes mint(); older deployments used
        // mintTokens(). Prefer mint and fall back if the token lacks it.
        const tx =
          typeof contract.mint === 'function'
            ? await contract.mint(toAddress, amountWei)
            : await contract.mintTokens(toAddress, amountWei)
        const receipt = await tx.wait()
        if (!receipt) {
          throw new Error('MGRO mint transaction was not mined')
        }
        return {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          mode: 'direct',
        }
      } catch (error: any) {
        lastErr = error
        if (attempt >= maxAttempts || !isRetryableNonceError(error)) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    throw lastErr
  }
}

export default RewardMintService
