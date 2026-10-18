import { config, CONTRACTS } from '../config'

/**
 * Minimal Base JSON-RPC client — no SDK, just the few calls the page needs
 * to cross-check the API against the chain itself. All reads are public.
 */

type RpcResponse<T> = { result?: T; error?: { message: string } }

async function rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  const res = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  })
  if (!res.ok) throw new Error(`rpc ${res.status}`)
  const json = (await res.json()) as RpcResponse<T>
  if (json.error) throw new Error(json.error.message)
  return json.result as T
}

const SELECTOR = {
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
}

function pad32(hexNo0x: string): string {
  return hexNo0x.toLowerCase().padStart(64, '0')
}

function hexToBigInt(hex: string | null | undefined): bigint {
  if (!hex || hex === '0x') return 0n
  return BigInt(hex)
}

export async function getBlockNumber(signal?: AbortSignal): Promise<number> {
  return Number(hexToBigInt(await rpc<string>('eth_blockNumber', [], signal)))
}

export async function totalSupply(token: string, signal?: AbortSignal): Promise<bigint> {
  return hexToBigInt(
    await rpc<string>('eth_call', [{ to: token, data: SELECTOR.totalSupply }, 'latest'], signal),
  )
}

export async function balanceOf(token: string, owner: string, signal?: AbortSignal): Promise<bigint> {
  const data = SELECTOR.balanceOf + pad32(owner.replace(/^0x/, ''))
  return hexToBigInt(await rpc<string>('eth_call', [{ to: token, data }, 'latest'], signal))
}

export type ChainSnapshot = {
  blockNumber: number
  mgroSupplyWei: string
  tgnSupplyWei: string
  vaultStakedWei: string
  treasuryTgnWei: string
  fetchedAt: string
}

/** Everything the hero cross-checks, in one round of calls. */
export async function readChainSnapshot(signal?: AbortSignal): Promise<ChainSnapshot> {
  const [blockNumber, mgroSupply, tgnSupply, vaultStaked, treasuryTgn] = await Promise.all([
    getBlockNumber(signal),
    totalSupply(CONTRACTS.mgro, signal),
    totalSupply(CONTRACTS.tgn, signal),
    balanceOf(CONTRACTS.tgn, CONTRACTS.tgnVault, signal),
    balanceOf(CONTRACTS.tgn, CONTRACTS.treasurySafe, signal),
  ])
  return {
    blockNumber,
    mgroSupplyWei: mgroSupply.toString(),
    tgnSupplyWei: tgnSupply.toString(),
    vaultStakedWei: vaultStaked.toString(),
    treasuryTgnWei: treasuryTgn.toString(),
    fetchedAt: new Date().toISOString(),
  }
}
