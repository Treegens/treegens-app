import { ethers } from 'ethers'
import env from '../../config/environment'
import { BASE_USDC, BASE_WETH, OPENOCEAN_BASE } from './swapService'
import {
  boolFromEnv,
  isAddress,
  listFromEnv,
  LOCK_METHODS,
  LockMethod,
  MERCURY_SEND_MODES,
  MercurySendMode,
  numberFromEnv,
  parseEnum,
  PIPELINE_MODES,
  PipelineMode,
  sameAddress,
  SWAP_ROUTES,
  SwapRoute,
  usdToCents,
} from './treasuryMath'

/** NOT the token (CLAUDE.md, Jimi 2026-07-24). The pipeline refuses to run against it. */
export const RETIRED_MGRO = '0xe84613C7220F2cD92fD1551256f74c21e49e2283'

export const DEFAULT_DONATION_KINDS = [
  'externalTransfer',
  'incomingDomesticWire',
  'incomingInternationalWire',
  'checkDeposit',
]

export interface TreasuryConfig {
  disabled: boolean
  /** dry_run records what every stage would send and moves nothing. */
  mode: PipelineMode
  pollMs: number
  /** New donations wait as `held` until an admin releases them. */
  requireApproval: boolean
  lookbackDays: number
  minDonationCents: number
  donationKinds: string[]
  sweepReservePct: number
  /** Most USD one Mercury payment may move (also the per-tick sweep total). */
  maxSweepCents: number
  /** Most USD one Stripe outbound payment may move. */
  maxOnrampCents: number
  /** Most new USD one tick may set in motion; the rest is held for release. */
  maxTickCents: number
  maxSwapMicro: bigint
  minSwapMicro: bigint
  slippagePct: number
  swapRoute: SwapRoute
  lockMethod: LockMethod
  forwardTo: string
  retirementAddress: string
  safe: string
  /** Retries per stage before a flow is parked as failed. */
  maxAttempts: number
  /** Ticks to wait for Stripe's USDC to show on-chain before the Stripe amount is trusted. */
  arrivalWaitTicks: number
  mercury: {
    apiBase: string
    token: string
    accountId: string
    stripeRecipientId: string
    sendMode: MercurySendMode
  }
  stripe: {
    secretKey: string
    financialAccountId: string
    payoutMethodId: string
    apiVersion: string
  }
  chain: {
    rpcUrl: string
    mgro: string
    usdc: string
    weth: string
    walletKey: string
    walletAddress: string
    openOceanBase: string
    uniswap: { factory?: string; quoter?: string; router?: string }
  }
}

export interface ConfigDefaults {
  mgro: string
  rpcUrl: string
  safe: string
  retirementAddress: string
}

/**
 * Reads the TREASURY_* / MERCURY_* / STRIPE_* variables (documented in
 * .env.example and docs/TREASURY_PIPELINE.md). Pure given `source`, so the
 * parsing is testable; the app-level defaults come from the shared env.
 */
export function loadTreasuryConfig(
  source: Record<string, string | undefined> = process.env,
  defaults: Partial<ConfigDefaults> = {},
): TreasuryConfig {
  const d: ConfigDefaults = {
    mgro: env.MGRO_TOKEN_ADDRESS,
    rpcUrl: env.BASE_RPC_URL || '',
    safe: env.TREASURY_SAFE_ADDRESS,
    retirementAddress: source.RETIREMENT_ADDR || '',
    ...defaults,
  }
  const safe = (source.TREASURY_SAFE_ADDRESS || d.safe || '').trim()
  const str = (key: string, fallback = '') => (source[key] ?? fallback).trim()
  const usdCents = (key: string, fallbackUsd: number) =>
    usdToCents(numberFromEnv(source[key], fallbackUsd))
  const usdcMicro = (key: string, fallbackUsdc: number) =>
    BigInt(Math.round(numberFromEnv(source[key], fallbackUsdc) * 1e6))

  return {
    disabled: boolFromEnv(source.DISABLE_TREASURY_PIPELINE, false),
    mode: parseEnum(source.TREASURY_PIPELINE_MODE, PIPELINE_MODES, 'dry_run'),
    pollMs: Math.max(60_000, numberFromEnv(source.TREASURY_POLL_MS, 300_000)),
    requireApproval: boolFromEnv(source.TREASURY_REQUIRE_APPROVAL, false),
    lookbackDays: numberFromEnv(source.TREASURY_LOOKBACK_DAYS, 30, 1),
    minDonationCents: usdCents('TREASURY_MIN_DONATION_USD', 1),
    donationKinds: listFromEnv(
      source.TREASURY_DONATION_KINDS,
      DEFAULT_DONATION_KINDS,
    ),
    sweepReservePct: numberFromEnv(source.TREASURY_SWEEP_RESERVE_PCT, 0),
    maxSweepCents: usdCents('TREASURY_MAX_SWEEP_USD', 10_000),
    maxOnrampCents: usdCents('TREASURY_MAX_ONRAMP_USD', 10_000),
    maxTickCents: usdCents('TREASURY_MAX_TICK_USD', 25_000),
    maxSwapMicro: usdcMicro('TREASURY_MAX_SWAP_USDC', 10_000),
    minSwapMicro: usdcMicro('TREASURY_MIN_SWAP_USDC', 1),
    slippagePct: Math.min(
      10,
      numberFromEnv(source.TREASURY_SWAP_SLIPPAGE_PCT, 3),
    ),
    swapRoute: parseEnum(source.TREASURY_SWAP_ROUTE, SWAP_ROUTES, 'auto'),
    lockMethod: parseEnum(source.TREASURY_LOCK_METHOD, LOCK_METHODS, 'dead'),
    forwardTo: str('TREASURY_FORWARD_TO', safe),
    retirementAddress: str('TREASURY_RETIREMENT_ADDRESS', d.retirementAddress),
    safe,
    maxAttempts: numberFromEnv(source.TREASURY_MAX_ATTEMPTS, 24, 1),
    arrivalWaitTicks: numberFromEnv(source.TREASURY_ARRIVAL_WAIT_TICKS, 24, 1),
    mercury: {
      apiBase: str('MERCURY_API_BASE', 'https://api.mercury.com/api/v1'),
      token: str('MERCURY_API_TOKEN'),
      accountId: str('MERCURY_ACCOUNT_ID'),
      stripeRecipientId: str('MERCURY_STRIPE_RECIPIENT_ID'),
      sendMode: parseEnum(
        source.MERCURY_SEND_MODE,
        MERCURY_SEND_MODES,
        'direct',
      ),
    },
    stripe: {
      secretKey: str('STRIPE_TREASURY_SECRET_KEY') || str('STRIPE_SECRET_KEY'),
      financialAccountId: str('STRIPE_FINANCIAL_ACCOUNT_ID'),
      payoutMethodId: str('STRIPE_CRYPTO_PAYOUT_METHOD_ID'),
      apiVersion: str('STRIPE_MONEY_MANAGEMENT_VERSION', '2025-11-17.preview'),
    },
    chain: {
      rpcUrl: str('TREASURY_RPC_URL', d.rpcUrl),
      mgro: str('TREASURY_MGRO_ADDRESS', d.mgro),
      usdc: str('TREASURY_USDC_ADDRESS', BASE_USDC),
      weth: str('TREASURY_WETH_ADDRESS', BASE_WETH),
      walletKey: str('TREASURY_WALLET_PRIVATE_KEY'),
      walletAddress: str('TREASURY_WALLET_ADDRESS'),
      openOceanBase: str('OPENOCEAN_API_BASE', OPENOCEAN_BASE),
      uniswap: {
        factory: str('TREASURY_UNISWAP_V3_FACTORY') || undefined,
        quoter: str('TREASURY_UNISWAP_V3_QUOTER') || undefined,
        router: str('TREASURY_UNISWAP_V3_ROUTER') || undefined,
      },
    },
  }
}

/** The address a private key signs as, or null when it is not a key. */
export function walletAddressOf(privateKey: string): string | null {
  try {
    return privateKey ? new ethers.Wallet(privateKey).address : null
  } catch {
    return null
  }
}

export interface ConfigProblem {
  stage: 'all' | 'detect' | 'sweep' | 'onramp' | 'swap' | 'settle'
  problem: string
  fatal?: boolean
}

/**
 * What this configuration cannot do. A fatal problem stops the pipeline;
 * the others leave their stage waiting (flows queue up in front of it) and
 * are shown on the admin status page.
 */
export function configProblems(cfg: TreasuryConfig): ConfigProblem[] {
  const out: ConfigProblem[] = []
  if (sameAddress(cfg.chain.mgro, RETIRED_MGRO)) {
    out.push({
      stage: 'all',
      fatal: true,
      problem:
        'MGRO address is the retired 0xe846…2283 deployment, not the token (see CLAUDE.md); refusing every stage',
    })
  } else if (!isAddress(cfg.chain.mgro)) {
    out.push({
      stage: 'all',
      fatal: true,
      problem: 'MGRO token address is not an address',
    })
  }
  if (!cfg.mercury.token)
    out.push({
      stage: 'detect',
      problem: 'MERCURY_API_TOKEN unset: nothing is detected',
    })
  if (!cfg.mercury.accountId)
    out.push({
      stage: 'detect',
      problem: 'MERCURY_ACCOUNT_ID unset: nothing is detected',
    })
  if (!cfg.mercury.stripeRecipientId)
    out.push({
      stage: 'sweep',
      problem:
        'MERCURY_STRIPE_RECIPIENT_ID unset: sweeps to Stripe cannot be sent',
    })
  if (!cfg.stripe.secretKey)
    out.push({ stage: 'onramp', problem: 'STRIPE_TREASURY_SECRET_KEY unset' })
  if (!cfg.stripe.financialAccountId)
    out.push({ stage: 'onramp', problem: 'STRIPE_FINANCIAL_ACCOUNT_ID unset' })
  if (!cfg.stripe.payoutMethodId)
    out.push({
      stage: 'onramp',
      problem: 'STRIPE_CRYPTO_PAYOUT_METHOD_ID unset: USD cannot become USDC',
    })
  if (!cfg.chain.rpcUrl)
    out.push({ stage: 'swap', problem: 'BASE_RPC_URL unset: no chain access' })
  if (!cfg.chain.walletKey) {
    out.push({
      stage: 'swap',
      problem:
        'TREASURY_WALLET_PRIVATE_KEY unset: swaps and locks cannot be signed',
    })
  } else {
    const derived = walletAddressOf(cfg.chain.walletKey)
    if (!derived)
      out.push({
        stage: 'swap',
        problem: 'TREASURY_WALLET_PRIVATE_KEY is not a valid key',
      })
    else if (!cfg.chain.walletAddress)
      out.push({
        stage: 'swap',
        problem:
          'TREASURY_WALLET_ADDRESS unset: refusing to sign until the key is pinned to an address',
      })
    else if (!sameAddress(derived, cfg.chain.walletAddress))
      out.push({
        stage: 'swap',
        problem:
          'TREASURY_WALLET_PRIVATE_KEY signs as a different address than TREASURY_WALLET_ADDRESS; standing down',
      })
  }
  if (cfg.lockMethod === 'forward' && !isAddress(cfg.forwardTo))
    out.push({
      stage: 'settle',
      problem: 'TREASURY_FORWARD_TO is not an address',
    })
  if (cfg.lockMethod === 'retire' && !isAddress(cfg.retirementAddress))
    out.push({
      stage: 'settle',
      problem: 'TREASURY_RETIREMENT_ADDRESS is not an address',
    })
  return out
}

/** The config with every secret replaced by whether it is set. */
export function redactedConfig(cfg: TreasuryConfig) {
  return {
    disabled: cfg.disabled,
    mode: cfg.mode,
    pollMs: cfg.pollMs,
    requireApproval: cfg.requireApproval,
    lookbackDays: cfg.lookbackDays,
    minDonationUsd: cfg.minDonationCents / 100,
    donationKinds: cfg.donationKinds,
    sweepReservePct: cfg.sweepReservePct,
    caps: {
      maxSweepUsd: cfg.maxSweepCents / 100,
      maxOnrampUsd: cfg.maxOnrampCents / 100,
      maxTickUsd: cfg.maxTickCents / 100,
      maxSwapUsdc: Number(cfg.maxSwapMicro) / 1e6,
      minSwapUsdc: Number(cfg.minSwapMicro) / 1e6,
      slippagePct: cfg.slippagePct,
      maxAttempts: cfg.maxAttempts,
      arrivalWaitTicks: cfg.arrivalWaitTicks,
    },
    swapRoute: cfg.swapRoute,
    lockMethod: cfg.lockMethod,
    forwardTo: cfg.forwardTo,
    retirementAddress: cfg.retirementAddress,
    safe: cfg.safe,
    mercury: {
      apiBase: cfg.mercury.apiBase,
      tokenSet: Boolean(cfg.mercury.token),
      accountId: cfg.mercury.accountId,
      stripeRecipientId: cfg.mercury.stripeRecipientId,
      sendMode: cfg.mercury.sendMode,
    },
    stripe: {
      secretKeySet: Boolean(cfg.stripe.secretKey),
      financialAccountId: cfg.stripe.financialAccountId,
      payoutMethodId: cfg.stripe.payoutMethodId,
      apiVersion: cfg.stripe.apiVersion,
    },
    chain: {
      rpcUrlSet: Boolean(cfg.chain.rpcUrl),
      mgro: cfg.chain.mgro,
      usdc: cfg.chain.usdc,
      weth: cfg.chain.weth,
      walletKeySet: Boolean(cfg.chain.walletKey),
      walletAddress: cfg.chain.walletAddress,
      openOceanBase: cfg.chain.openOceanBase,
      uniswap: cfg.chain.uniswap,
    },
  }
}
