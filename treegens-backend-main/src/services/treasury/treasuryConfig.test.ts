import assert from 'node:assert/strict'
import test from 'node:test'
import { ethers } from 'ethers'
import {
  configProblems,
  DEFAULT_DONATION_KINDS,
  loadTreasuryConfig,
  redactedConfig,
  RETIRED_MGRO,
  walletAddressOf,
} from './treasuryConfig'

const MGRO = '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568'
const SAFE = '0x64b05503c6F2233d279E6B8B8f2Da6936dEd584C'
const defaults = {
  mgro: MGRO,
  rpcUrl: 'https://mainnet.base.org',
  safe: SAFE,
  retirementAddress: '',
}

test('an empty environment is a dry run with conservative caps', () => {
  const cfg = loadTreasuryConfig({}, defaults)
  assert.equal(cfg.mode, 'dry_run')
  assert.equal(cfg.disabled, false)
  assert.equal(cfg.pollMs, 300_000)
  assert.equal(cfg.requireApproval, false)
  assert.equal(cfg.lookbackDays, 30)
  assert.equal(cfg.minDonationCents, 100)
  assert.deepEqual(cfg.donationKinds, DEFAULT_DONATION_KINDS)
  assert.equal(cfg.maxSweepCents, 1_000_000)
  assert.equal(cfg.maxOnrampCents, 1_000_000)
  assert.equal(cfg.maxTickCents, 2_500_000)
  assert.equal(cfg.maxSwapMicro, 10_000_000_000n)
  assert.equal(cfg.minSwapMicro, 1_000_000n)
  assert.equal(cfg.slippagePct, 3)
  assert.equal(cfg.swapRoute, 'auto')
  assert.equal(cfg.lockMethod, 'dead')
  assert.equal(cfg.forwardTo, SAFE)
  assert.equal(cfg.safe, SAFE)
  assert.equal(cfg.chain.mgro, MGRO)
  assert.equal(cfg.chain.rpcUrl, 'https://mainnet.base.org')
  assert.equal(cfg.mercury.apiBase, 'https://api.mercury.com/api/v1')
  assert.equal(cfg.mercury.sendMode, 'direct')
  assert.equal(cfg.stripe.apiVersion, '2025-11-17.preview')
})

test('values are parsed, clamped and fall back on nonsense', () => {
  const cfg = loadTreasuryConfig(
    {
      TREASURY_PIPELINE_MODE: 'LIVE',
      TREASURY_POLL_MS: '1000',
      TREASURY_MAX_SWAP_USDC: '250.5',
      TREASURY_SWAP_SLIPPAGE_PCT: '45',
      TREASURY_SWAP_ROUTE: 'openocean',
      TREASURY_LOCK_METHOD: 'nonsense',
      TREASURY_DONATION_KINDS: 'checkDeposit, other',
      TREASURY_REQUIRE_APPROVAL: 'true',
      MERCURY_SEND_MODE: 'request',
      STRIPE_SECRET_KEY: 'sk_live_fallback',
      TREASURY_FORWARD_TO: '0x000000000000000000000000000000000000dEaD',
    },
    defaults,
  )
  assert.equal(cfg.mode, 'live')
  assert.equal(cfg.pollMs, 60_000)
  assert.equal(cfg.maxSwapMicro, 250_500_000n)
  assert.equal(cfg.slippagePct, 10)
  assert.equal(cfg.swapRoute, 'openocean')
  assert.equal(cfg.lockMethod, 'dead')
  assert.deepEqual(cfg.donationKinds, ['checkDeposit', 'other'])
  assert.equal(cfg.requireApproval, true)
  assert.equal(cfg.mercury.sendMode, 'request')
  assert.equal(cfg.stripe.secretKey, 'sk_live_fallback')
  assert.equal(cfg.forwardTo, '0x000000000000000000000000000000000000dEaD')
})

test('the retired MGRO deployment is fatal; a missing stage is just a problem', () => {
  const retired = loadTreasuryConfig({}, { ...defaults, mgro: RETIRED_MGRO })
  const fatal = configProblems(retired).find(p => p.fatal)
  assert.ok(fatal)
  assert.match(fatal.problem, /retired/)

  const problems = configProblems(loadTreasuryConfig({}, defaults))
  assert.equal(
    problems.some(p => p.fatal),
    false,
  )
  const stages = new Set(problems.map(p => p.stage))
  assert.ok(stages.has('detect'))
  assert.ok(stages.has('sweep'))
  assert.ok(stages.has('onramp'))
  assert.ok(stages.has('swap'))
  assert.equal(stages.has('settle'), false)
})

test('the wallet key must sign as the pinned address', () => {
  const wallet = ethers.Wallet.createRandom()
  const other = ethers.Wallet.createRandom()
  assert.equal(walletAddressOf(wallet.privateKey), wallet.address)
  assert.equal(walletAddressOf('not-a-key'), null)
  assert.equal(walletAddressOf(''), null)

  const mismatch = configProblems(
    loadTreasuryConfig(
      {
        TREASURY_WALLET_PRIVATE_KEY: wallet.privateKey,
        TREASURY_WALLET_ADDRESS: other.address,
      },
      defaults,
    ),
  )
  assert.ok(mismatch.some(p => /different address/.test(p.problem)))

  const unpinned = configProblems(
    loadTreasuryConfig(
      { TREASURY_WALLET_PRIVATE_KEY: wallet.privateKey },
      defaults,
    ),
  )
  assert.ok(unpinned.some(p => /TREASURY_WALLET_ADDRESS unset/.test(p.problem)))

  const matching = configProblems(
    loadTreasuryConfig(
      {
        TREASURY_WALLET_PRIVATE_KEY: wallet.privateKey,
        TREASURY_WALLET_ADDRESS: wallet.address.toLowerCase(),
      },
      defaults,
    ),
  )
  assert.equal(
    matching.some(p => p.stage === 'swap' && /WALLET/.test(p.problem)),
    false,
  )
})

test('lock methods that need an address complain when it is missing', () => {
  const retire = configProblems(
    loadTreasuryConfig({ TREASURY_LOCK_METHOD: 'retire' }, defaults),
  )
  assert.ok(retire.some(p => /TREASURY_RETIREMENT_ADDRESS/.test(p.problem)))
  const forward = configProblems(
    loadTreasuryConfig(
      { TREASURY_LOCK_METHOD: 'forward', TREASURY_FORWARD_TO: 'nope' },
      defaults,
    ),
  )
  assert.ok(forward.some(p => /TREASURY_FORWARD_TO/.test(p.problem)))
})

test('the redacted config never contains a secret', () => {
  const wallet = ethers.Wallet.createRandom()
  const cfg = loadTreasuryConfig(
    {
      MERCURY_API_TOKEN: 'mercury-secret',
      STRIPE_TREASURY_SECRET_KEY: 'sk_live_secret',
      TREASURY_WALLET_PRIVATE_KEY: wallet.privateKey,
      TREASURY_WALLET_ADDRESS: wallet.address,
    },
    defaults,
  )
  const text = JSON.stringify(redactedConfig(cfg))
  assert.doesNotMatch(text, /mercury-secret/)
  assert.doesNotMatch(text, /sk_live_secret/)
  assert.doesNotMatch(text, new RegExp(wallet.privateKey.slice(2, 20)))
  assert.match(text, /"tokenSet":true/)
  assert.match(text, /"secretKeySet":true/)
  assert.match(text, /"walletKeySet":true/)
  assert.match(text, new RegExp(wallet.address))
})
