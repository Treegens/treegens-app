import { Contract, JsonRpcProvider } from 'ethers'
import env from '../config/environment'

const REGISTRY_ABI = [
  'function delegatorsOf(address account) view returns (address[])',
  'function delegatedTo(address delegator) view returns (address)',
  'function getStakedBalance(address account) view returns (uint256)',
] as const

/**
 * Read-only client for TGNDelegationRegistry: who is backing whom with
 * staked TGN. Used by the slash worker to reach delegators (their stake is
 * slashable skin-in-the-game) and to report verifier weight.
 */
class DelegationRegistryService {
  private provider: JsonRpcProvider | null = null
  private contract: Contract | null = null

  private ensureReady(): Contract {
    const rpcUrl = env.BASE_RPC_URL
    if (!rpcUrl) {
      throw new Error(
        'BASE_RPC_URL (or RPC_URL) is required for delegation reads',
      )
    }
    if (!this.provider) {
      this.provider = new JsonRpcProvider(rpcUrl)
    }
    if (!this.contract) {
      this.contract = new Contract(
        env.TGN_DELEGATION_REGISTRY_ADDRESS,
        REGISTRY_ABI as unknown as [],
        this.provider,
      )
    }
    return this.contract
  }

  isConfigured(): boolean {
    return Boolean(
      env.BASE_RPC_URL?.trim() && env.TGN_DELEGATION_REGISTRY_ADDRESS,
    )
  }

  /** Everyone currently delegating their staked TGN to `account`. */
  async delegatorsOf(account: string): Promise<string[]> {
    const contract = this.ensureReady()
    const list: string[] = await contract.delegatorsOf(account)
    return list.map(a => a.toLowerCase())
  }

  /** Combined verifier weight (own + delegated-in live stake), in wei. */
  async weightOf(account: string): Promise<bigint> {
    const contract = this.ensureReady()
    return BigInt(await contract.getStakedBalance(account))
  }
}

export default DelegationRegistryService
