import { ethers } from 'ethers'
import {
  DEAD_ADDRESS,
  isAddress,
  LockMethod,
  sameAddress,
  why,
} from './treasuryMath'

const MGRO_ABI = [
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function burn(uint256)',
]
const RETIREMENT_ABI = [
  'function mgro() view returns (address)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function retire(address,uint256,string,bytes32) returns (uint256)',
  'event MangrovesRetired(uint256 indexed tokenId, address indexed beneficiary, uint256 mgroAmount, string metadataURI, bytes32 indexed sourceRef)',
]
export const RETIRER_ROLE = ethers.id('RETIRER_ROLE')

export interface LockDeps {
  provider: ethers.Provider
  wallet: ethers.Wallet | null
  mgro: string
  method: LockMethod
  /** Destination for `forward`. */
  forwardTo: string
  /** MangroveRetirement for `retire`. */
  retirementAddress: string
  /** Who the soulbound retirement proof is minted to (the Safe). */
  beneficiary: string
}

export type LockConfirmation =
  | { state: 'pending' }
  | { state: 'reverted'; hash: string }
  | { state: 'success'; hash: string; blockNumber: number; tokenId?: number }

/**
 * Takes the bought $MGRO out of circulation (see LockMethod). Like the swap,
 * `send()` returns the hash at broadcast and `confirm()` reads the receipt,
 * so a crash in between can never lock the same flow twice.
 */
export class LockService {
  constructor(private readonly d: LockDeps) {}

  get method(): LockMethod {
    return this.d.method
  }

  /** Where the tokens go, for dry-run records and the status page. */
  describe(): { method: LockMethod; to: string; retired: boolean } {
    switch (this.d.method) {
      case 'forward':
        return { method: 'forward', to: this.d.forwardTo, retired: false }
      case 'retire':
        return {
          method: 'retire',
          to: this.d.retirementAddress,
          retired: true,
        }
      case 'burn':
        return { method: 'burn', to: ethers.ZeroAddress, retired: true }
      default:
        return { method: 'dead', to: DEAD_ADDRESS, retired: true }
    }
  }

  /** Everything that must hold before a live lock is sent; empty when it may go. */
  async preflight(): Promise<string[]> {
    const problems: string[] = []
    const wallet = this.d.wallet
    if (!isAddress(this.d.mgro)) problems.push('MGRO address is invalid')
    switch (this.d.method) {
      case 'forward':
        if (
          !isAddress(this.d.forwardTo) ||
          this.d.forwardTo === ethers.ZeroAddress
        )
          problems.push('TREASURY_FORWARD_TO is not a usable address')
        else if (wallet && sameAddress(this.d.forwardTo, wallet.address))
          problems.push('TREASURY_FORWARD_TO is the hot wallet itself')
        break
      case 'retire': {
        if (!isAddress(this.d.retirementAddress)) {
          problems.push('TREASURY_RETIREMENT_ADDRESS is not an address')
          break
        }
        if (!isAddress(this.d.beneficiary))
          problems.push('retirement beneficiary (the Safe) is not an address')
        try {
          const code = await this.d.provider.getCode(this.d.retirementAddress)
          if (!code || code === '0x') {
            problems.push('no contract at TREASURY_RETIREMENT_ADDRESS')
            break
          }
          const retirement = new ethers.Contract(
            this.d.retirementAddress,
            RETIREMENT_ABI,
            this.d.provider,
          )
          const token: string = await retirement.mgro()
          if (!sameAddress(token, this.d.mgro)) {
            problems.push(
              `MangroveRetirement retires ${token}, not the canonical $MGRO; refusing`,
            )
          }
          if (wallet) {
            const ok: boolean = await retirement.hasRole(
              RETIRER_ROLE,
              wallet.address,
            )
            if (!ok)
              problems.push(
                `treasury wallet ${wallet.address} lacks RETIRER_ROLE on the retirement contract`,
              )
          }
        } catch (error) {
          problems.push(`retirement preflight failed: ${why(error)}`)
        }
        break
      }
      case 'burn':
        if (wallet) {
          try {
            // burn(0) is a no-op on an ERC20Burnable token and reverts on one without burn().
            await new ethers.Contract(
              this.d.mgro,
              MGRO_ABI,
              wallet,
            ).burn.staticCall(0n)
          } catch (error) {
            problems.push(
              `$MGRO does not expose burn(): ${why(error)}; use TREASURY_LOCK_METHOD=dead`,
            )
          }
        }
        break
      default:
        break
    }
    return problems
  }

  /** Broadcast the lock transaction for `amountWei`; `ref` names the donation on-chain. */
  async send(
    amountWei: bigint,
    ref: string,
  ): Promise<{ hash: string; to: string; method: LockMethod }> {
    const wallet = this.d.wallet
    if (!wallet) throw new Error('lock: no treasury wallet')
    if (amountWei <= 0n) throw new Error('lock: nothing to lock')
    const mgro = new ethers.Contract(this.d.mgro, MGRO_ABI, wallet)
    switch (this.d.method) {
      case 'forward': {
        const tx = await mgro.transfer(this.d.forwardTo, amountWei)
        return { hash: tx.hash, to: this.d.forwardTo, method: 'forward' }
      }
      case 'burn': {
        const tx = await mgro.burn(amountWei)
        return { hash: tx.hash, to: ethers.ZeroAddress, method: 'burn' }
      }
      case 'retire': {
        const allowance: bigint = await mgro.allowance(
          wallet.address,
          this.d.retirementAddress,
        )
        if (allowance < amountWei) {
          const approval = await mgro.approve(
            this.d.retirementAddress,
            amountWei,
          )
          const receipt = await approval.wait()
          if (!receipt || receipt.status !== 1)
            throw new Error(`$MGRO approve failed (${approval.hash})`)
        }
        const retirement = new ethers.Contract(
          this.d.retirementAddress,
          RETIREMENT_ABI,
          wallet,
        )
        const tx = await retirement.retire(
          this.d.beneficiary,
          amountWei,
          `treegens://donation/${ref}`,
          ethers.id(`donation:${ref}`),
        )
        return { hash: tx.hash, to: this.d.retirementAddress, method: 'retire' }
      }
      default: {
        const tx = await mgro.transfer(DEAD_ADDRESS, amountWei)
        return { hash: tx.hash, to: DEAD_ADDRESS, method: 'dead' }
      }
    }
  }

  async confirm(hash: string): Promise<LockConfirmation> {
    const receipt = await this.d.provider.getTransactionReceipt(hash)
    if (!receipt) return { state: 'pending' }
    if (receipt.status !== 1) return { state: 'reverted', hash }
    let tokenId: number | undefined
    if (this.d.method === 'retire') {
      const iface = new ethers.Interface(RETIREMENT_ABI)
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, this.d.retirementAddress)) continue
        try {
          const parsed = iface.parseLog({
            topics: [...log.topics],
            data: log.data,
          })
          if (parsed?.name === 'MangrovesRetired') {
            tokenId = Number(parsed.args.tokenId)
            break
          }
        } catch {
          // another event of the contract
        }
      }
    }
    return { state: 'success', hash, blockNumber: receipt.blockNumber, tokenId }
  }
}
