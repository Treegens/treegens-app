import { Contract, JsonRpcProvider, NonceManager, Wallet } from 'ethers'
import { MGRO_ABI } from '../abis/mgro'
import env from '../config/environment'

export type MintResult = {
  txHash: string
  blockNumber?: number
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
 * Signs and sends MGRO mint txs using MGRO_MINTER_PRIVATE_KEY.
 */
class RewardMintService {
  private provider: JsonRpcProvider | null = null
  private wallet: Wallet | null = null
  private nonceManager: NonceManager | null = null

  private ensureReady(): {
    provider: JsonRpcProvider
    wallet: Wallet
    nonceManager: NonceManager
  } {
    const rpcUrl = env.BASE_RPC_URL
    if (!rpcUrl) {
      throw new Error(
        'BASE_RPC_URL (or RPC_URL) is required for MGRO minting',
      )
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

  async mintTo(toAddress: string, amountWei: string): Promise<MintResult> {
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
        const tx = typeof contract.mint === 'function'
          ? await contract.mint(toAddress, amountWei)
          : await contract.mintTokens(toAddress, amountWei)
        const receipt = await tx.wait()
        if (!receipt) {
          throw new Error('MGRO mint transaction was not mined')
        }
        return {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
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
