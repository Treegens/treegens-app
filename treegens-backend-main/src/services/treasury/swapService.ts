import { ethers } from 'ethers'
import type { FetchLike } from './mercuryClient'
import {
  applySlippage,
  describePath,
  encodeV3Path,
  sameAddress,
  SwapRoute,
  why,
} from './treasuryMath'

/** Uniswap V3 on Base mainnet (developers.uniswap.org → Base deployments). */
export const BASE_UNISWAP_V3 = {
  factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
}
export const BASE_WETH = '0x4200000000000000000000000000000000000006'
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** Keyless aggregator world.treegens.app already buys through; routes Uniswap V2/V3/V4 and Aerodrome. */
export const OPENOCEAN_BASE = 'https://open-api.openocean.finance/v4/base'

const V3_FEE_TIERS = [100, 500, 3000, 10000]
const PATH_CACHE_MS = 10 * 60_000
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
const FACTORY_ABI = [
  'function getPool(address,address,uint24) view returns (address)',
]
const POOL_ABI = ['function liquidity() view returns (uint128)']
const QUOTER_ABI = [
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]
const ROUTER_ABI = [
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
]

export interface SwapQuote {
  kind: 'uniswap_v3' | 'openocean'
  /** Human-readable route, stored on the flow: `uniswap_v3:USDC-500-WETH-10000-MGRO`. */
  route: string
  amountIn: bigint
  amountOut: bigint
  minOut: bigint
  path?: string
}

export type SwapConfirmation =
  | { state: 'pending' }
  | { state: 'reverted'; hash: string }
  | { state: 'success'; hash: string; amountOut: bigint; blockNumber: number }

export interface SwapServiceDeps {
  provider: ethers.Provider
  /** Null for quote-only use (dry runs, status). */
  wallet: ethers.Wallet | null
  usdc: string
  weth: string
  mgro: string
  factory?: string
  quoter?: string
  router?: string
  openOceanBase?: string
  route: SwapRoute
  slippagePct: number
  fetchImpl?: FetchLike
}

/**
 * USDC → $MGRO on Base.
 *
 * Jimi's note: $MGRO trades against ETH on Uniswap, so the direct route is a
 * two-hop Uniswap V3 path USDC → WETH → MGRO (every fee tier with liquidity
 * is quoted and the best wins). When no V3 pool exists (the pool is V4, or
 * elsewhere) the OpenOcean aggregator finds the route; it is the same code
 * path the world site's mangrove rail already uses in production.
 *
 * Sends are two-phase: `send()` returns the hash the moment the transaction
 * is broadcast so the caller can record it, and `confirm()` reads the
 * receipt and measures the $MGRO that actually arrived from its Transfer
 * logs. A process that dies between the two never swaps twice.
 */
export class SwapService {
  private v3Paths: { path: string; label: string }[] | null = null
  private v3PathsAt = 0
  private readonly fetchImpl: FetchLike

  constructor(private readonly d: SwapServiceDeps) {
    this.fetchImpl = d.fetchImpl || ((input, init) => fetch(input, init))
  }

  get walletAddress(): string | null {
    return this.d.wallet?.address ?? null
  }

  /** Every Uniswap V3 route from USDC to $MGRO with liquidity: direct, and via WETH. */
  async discoverV3Paths(
    force = false,
  ): Promise<{ path: string; label: string }[]> {
    if (!force && this.v3Paths && Date.now() - this.v3PathsAt < PATH_CACHE_MS) {
      return this.v3Paths
    }
    const factory = new ethers.Contract(
      this.d.factory || BASE_UNISWAP_V3.factory,
      FACTORY_ABI,
      this.d.provider,
    )
    const hasLiquidity = async (a: string, b: string, fee: number) => {
      const pool: string = await factory.getPool(a, b, fee)
      if (!pool || pool === ethers.ZeroAddress) return false
      const liq: bigint = await new ethers.Contract(
        pool,
        POOL_ABI,
        this.d.provider,
      ).liquidity()
      return liq > 0n
    }
    const { usdc, weth, mgro } = this.d
    const paths: { path: string; label: string }[] = []
    for (const fee of V3_FEE_TIERS) {
      if (await hasLiquidity(usdc, mgro, fee)) {
        paths.push({
          path: encodeV3Path([usdc, mgro], [fee]),
          label: describePath(['USDC', 'MGRO'], [fee]),
        })
      }
    }
    const usdcWeth: number[] = []
    for (const fee of V3_FEE_TIERS)
      if (await hasLiquidity(usdc, weth, fee)) usdcWeth.push(fee)
    const wethMgro: number[] = []
    for (const fee of V3_FEE_TIERS)
      if (await hasLiquidity(weth, mgro, fee)) wethMgro.push(fee)
    for (const f1 of usdcWeth) {
      for (const f2 of wethMgro) {
        paths.push({
          path: encodeV3Path([usdc, weth, mgro], [f1, f2]),
          label: describePath(['USDC', 'WETH', 'MGRO'], [f1, f2]),
        })
      }
    }
    this.v3Paths = paths
    this.v3PathsAt = Date.now()
    return paths
  }

  async quoteV3(amountIn: bigint): Promise<SwapQuote | null> {
    const paths = await this.discoverV3Paths()
    if (!paths.length) return null
    const quoter = new ethers.Contract(
      this.d.quoter || BASE_UNISWAP_V3.quoterV2,
      QUOTER_ABI,
      this.d.provider,
    )
    let best: SwapQuote | null = null
    for (const p of paths) {
      try {
        const r = await quoter.quoteExactInput.staticCall(p.path, amountIn)
        const out = BigInt(r[0] ?? r.amountOut ?? 0)
        if (out > 0n && (!best || out > best.amountOut)) {
          best = {
            kind: 'uniswap_v3',
            route: `uniswap_v3:${p.label}`,
            amountIn,
            amountOut: out,
            minOut: applySlippage(out, this.d.slippagePct),
            path: p.path,
          }
        }
      } catch {
        // No route through this path at this size; the others may still quote.
      }
    }
    return best
  }

  async quoteOpenOcean(amountIn: bigint): Promise<SwapQuote | null> {
    const url =
      `${this.openOcean()}/quote?inTokenAddress=${this.d.usdc}` +
      `&outTokenAddress=${this.d.mgro}&amountDecimals=${amountIn.toString()}` +
      `&slippage=${this.d.slippagePct}&gasPriceDecimals=10000000`
    const json = await this.getJson(url)
    const data = json?.data ?? json
    const out = BigInt(String(data?.outAmount ?? '0').split('.')[0] || '0')
    if (out <= 0n) return null
    return {
      kind: 'openocean',
      route: 'openocean',
      amountIn,
      amountOut: out,
      minOut: applySlippage(out, this.d.slippagePct),
    }
  }

  /** Best quote under the configured route policy; null when nothing has liquidity. */
  async quote(amountIn: bigint): Promise<SwapQuote | null> {
    if (this.d.route === 'uniswap_v3') return this.quoteV3(amountIn)
    if (this.d.route === 'openocean') return this.quoteOpenOcean(amountIn)
    let v3: SwapQuote | null = null
    try {
      v3 = await this.quoteV3(amountIn)
    } catch (error) {
      console.warn(`[Treasury] Uniswap V3 quote failed: ${why(error)}`)
    }
    if (v3) return v3
    return this.quoteOpenOcean(amountIn)
  }

  /** Broadcast the swap. Returns as soon as the hash is known. */
  async send(q: SwapQuote): Promise<{ hash: string; to: string }> {
    const wallet = this.d.wallet
    if (!wallet) throw new Error('swap: no treasury wallet')
    if (q.kind === 'uniswap_v3') {
      if (!q.path) throw new Error('swap: V3 quote without a path')
      const router = this.d.router || BASE_UNISWAP_V3.swapRouter02
      await this.ensureAllowance(router, q.amountIn)
      const contract = new ethers.Contract(router, ROUTER_ABI, wallet)
      const tx = await contract.exactInput({
        path: q.path,
        recipient: wallet.address,
        amountIn: q.amountIn,
        amountOutMinimum: q.minOut,
      })
      return { hash: tx.hash, to: router }
    }
    const url =
      `${this.openOcean()}/swap?inTokenAddress=${this.d.usdc}` +
      `&outTokenAddress=${this.d.mgro}&amountDecimals=${q.amountIn.toString()}` +
      `&slippage=${this.d.slippagePct}&account=${wallet.address}` +
      `&gasPriceDecimals=10000000`
    const json = await this.getJson(url)
    const data = json?.data ?? json
    if (!data?.to || !data?.data) {
      throw new Error(
        'OpenOcean swap route failed: ' + JSON.stringify(json).slice(0, 200),
      )
    }
    await this.ensureAllowance(String(data.to), q.amountIn)
    const tx = await wallet.sendTransaction({
      to: String(data.to),
      data: String(data.data),
      value: BigInt(data.value || 0),
    })
    return { hash: tx.hash, to: String(data.to) }
  }

  /** Read the receipt; the $MGRO received is the sum of its Transfer logs to the wallet. */
  async confirm(hash: string): Promise<SwapConfirmation> {
    const receipt = await this.d.provider.getTransactionReceipt(hash)
    if (!receipt) return { state: 'pending' }
    if (receipt.status !== 1) return { state: 'reverted', hash }
    const to = this.walletAddress
    let amountOut = 0n
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, this.d.mgro)) continue
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue
      const recipient = ethers.dataSlice(log.topics[2], 12)
      if (to && sameAddress(recipient, to)) amountOut += BigInt(log.data)
    }
    return {
      state: 'success',
      hash,
      amountOut,
      blockNumber: receipt.blockNumber,
    }
  }

  async usdcBalance(address: string): Promise<bigint> {
    return new ethers.Contract(
      this.d.usdc,
      ERC20_ABI,
      this.d.provider,
    ).balanceOf(address)
  }

  async mgroBalance(address: string): Promise<bigint> {
    return new ethers.Contract(
      this.d.mgro,
      ERC20_ABI,
      this.d.provider,
    ).balanceOf(address)
  }

  /** Exact-amount approvals: the hot wallet never grants more than one flow's worth. */
  private async ensureAllowance(spender: string, amount: bigint) {
    const wallet = this.d.wallet
    if (!wallet) throw new Error('swap: no treasury wallet')
    const usdc = new ethers.Contract(this.d.usdc, ERC20_ABI, wallet)
    const current: bigint = await usdc.allowance(wallet.address, spender)
    if (current >= amount) return
    const tx = await usdc.approve(spender, amount)
    const receipt = await tx.wait()
    if (!receipt || receipt.status !== 1) {
      throw new Error(`USDC approve to ${spender} failed (${tx.hash})`)
    }
  }

  private openOcean(): string {
    return (this.d.openOceanBase || OPENOCEAN_BASE).replace(/\/+$/, '')
  }

  private async getJson(url: string): Promise<any> {
    const res = await this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`)
    }
    return res.json()
  }
}
