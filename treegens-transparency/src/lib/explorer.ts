import { config } from '../config'

export function txUrl(hash: string | null | undefined): string | null {
  if (!hash || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return null
  return `${config.explorerBaseUrl}/tx/${hash}`
}

export function addressUrl(address: string | null | undefined): string | null {
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null
  return `${config.explorerBaseUrl}/address/${address}`
}

export function tokenUrl(address: string): string {
  return `${config.explorerBaseUrl}/token/${address}`
}

export function tokenHoldersUrl(address: string): string {
  return `${config.explorerBaseUrl}/token/${address}#balances`
}
