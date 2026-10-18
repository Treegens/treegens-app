/**
 * Runtime configuration. `public/config.js` sets `window.TREEGENS_LEDGER_CONFIG`
 * before the bundle loads so a deployed site can be re-pointed without a
 * rebuild. Build-time `VITE_*` values are the fallback, then sane defaults.
 */
type RuntimeConfig = {
  apiBaseUrl?: string
  rpcUrl?: string
  explorerBaseUrl?: string
  refreshMs?: number
  /** Path/URL of a demo bundle (see scripts/mock-api.mjs --dump). Empty = live API. */
  demoDataUrl?: string
}

declare global {
  interface Window {
    TREEGENS_LEDGER_CONFIG?: RuntimeConfig
  }
}

const runtime: RuntimeConfig =
  (typeof window !== 'undefined' && window.TREEGENS_LEDGER_CONFIG) || {}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

export const config = {
  apiBaseUrl: trimSlash(
    runtime.apiBaseUrl ||
      import.meta.env.VITE_API_BASE_URL ||
      'https://treegens-api.onrender.com',
  ),
  rpcUrl: runtime.rpcUrl || import.meta.env.VITE_RPC_URL || 'https://mainnet.base.org',
  explorerBaseUrl: trimSlash(
    runtime.explorerBaseUrl || import.meta.env.VITE_EXPLORER_BASE_URL || 'https://basescan.org',
  ),
  refreshMs: Math.max(10000, Number(runtime.refreshMs) || 45000),
  demoDataUrl: String(runtime.demoDataUrl || import.meta.env.VITE_DEMO_DATA_URL || '').trim(),
} as const

export const isDemo = Boolean(config.demoDataUrl)

/** Base mainnet addresses (fallbacks until /overview supplies them). */
export const CONTRACTS = {
  chainId: 8453,
  mgro: '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568',
  tgn: '0xD75dfa972C6136f1c594Fec1945302f885E1ab29',
  tgnVault: '0x82a54F550131140Cc08Cf2b10Aa3a44fFDDa582C',
  verifierMinter: '0xE73941B1Ae8f630b6Ab2FDd73041bc92B13e397E',
  delegationRegistry: '0x9f122be6c32fdabe344e195d854a497353f3d162',
  treasurySafe: '0x64b05503c6F2233d279E6B8B8f2Da6936dEd584C',
} as const

export const SITES = {
  foundation: { label: 'treegensfoundation.org', url: 'https://treegensfoundation.org' },
  world: { label: 'world.treegens.app', url: 'https://world.treegens.app' },
  burn: { label: 'burn.treegens.app', url: 'https://burn.treegens.app' },
  app: { label: 'treegens.app', url: 'https://treegens.app' },
  delegate: { label: 'delegate.treegens.app', url: 'https://delegate.treegens.app' },
} as const
