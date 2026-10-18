import { ethers } from 'ethers'
import DonationFlow from '../../models/DonationFlow'
import { MongoLease, runUnderLease } from '../../utils/mongoLease'
import { LockService } from './lockService'
import { MercuryClient } from './mercuryClient'
import { StripeMoneyClient } from './stripeMoneyClient'
import { SwapService } from './swapService'
import {
  ConfigProblem,
  configProblems,
  loadTreasuryConfig,
  redactedConfig,
  TreasuryConfig,
  walletAddressOf,
} from './treasuryConfig'
import {
  batchKey,
  centsToDollars,
  centsToUsdcMicro,
  formatUnitsFixed,
  idempotencyKey,
  isDonationCredit,
  isTxHash,
  matchUsdcArrival,
  MGRO_DECIMALS,
  pickWithinCap,
  PipelineMode,
  postedTime,
  releaseTargetStatus,
  sameAddress,
  sha256Hex,
  stageForStatus,
  stageFromHoldReason,
  StageName,
  stripeMinorToUsdcMicro,
  sweepAmountCents,
  USDC_DECIMALS,
  UsdcArrival,
  usdToCents,
  why,
} from './treasuryMath'

const LEASE_TTL_MS = 10 * 60_000
const FIRST_TICK_MS = 30_000
const MAX_EVENTS = 60
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')
const LOG_CHUNK = 10_000
/** ~2.3 days of Base blocks: how far back a posted payout's USDC is looked for. */
const MAX_LOG_SPAN = 100_000
/** How long a send waits for its receipt before leaving confirmation to the next tick. */
const RECEIPT_WAIT_MS = 90_000

export interface TickSummary {
  at: string
  mode: PipelineMode
  ranUnderLease: boolean
  detected: number
  held: number
  swept: number
  onramped: number
  bought: number
  settled: number
  failed: number
  errors: string[]
  durationMs: number
}

type Flow = any

export interface PipelineDeps {
  mercury?: MercuryClient
  stripe?: StripeMoneyClient
  provider?: ethers.JsonRpcProvider
  swap?: SwapService
  lock?: LockService
}

const usd = (cents: number) => `$${centsToDollars(cents).toFixed(2)}`

/**
 * Donations → $MGRO, locked for good.
 *
 *   detect   credits on the foundation's Mercury account become DonationFlow rows
 *   sweep    one ACH per tick moves them to the Stripe financial account
 *   onramp   Stripe pays the USD out as USDC to the treasury wallet on Base
 *   swap     the wallet buys canonical $MGRO (Uniswap V3 direct, else OpenOcean)
 *   settle   the $MGRO is locked (TREASURY_LOCK_METHOD; dead address by default)
 *
 * One tick runs the stages in order, under a Mongo lease so a deploy overlap
 * can never sign twice. Every stage is idempotent: payments carry a key
 * derived from the flow, chain sends record their hash before anything
 * waits on them, and a stage that cannot proceed simply leaves its flows
 * where they are and says why on the status page.
 *
 * `dry_run` (the default mode) records the exact request each stage would
 * send and moves nothing; the public ledger shows only `live` flows.
 */
export class TreasuryPipelineService {
  readonly cfg: TreasuryConfig
  readonly problems: ConfigProblem[]
  private readonly mercury: MercuryClient
  private readonly stripe: StripeMoneyClient
  private readonly provider: ethers.JsonRpcProvider | null
  private readonly wallet: ethers.Wallet | null
  private readonly swap: SwapService | null
  private readonly lock: LockService | null
  private readonly lease = new MongoLease('treasury-pipeline', LEASE_TTL_MS)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private payoutMethodOk = false
  lastTick: TickSummary | null = null
  startedAt: Date | null = null

  constructor(
    cfg: TreasuryConfig = loadTreasuryConfig(),
    deps: PipelineDeps = {},
  ) {
    this.cfg = cfg
    this.problems = configProblems(cfg)
    this.mercury =
      deps.mercury ||
      new MercuryClient({
        apiBase: cfg.mercury.apiBase,
        token: cfg.mercury.token,
      })
    this.stripe =
      deps.stripe ||
      new StripeMoneyClient({
        secretKey: cfg.stripe.secretKey,
        apiVersion: cfg.stripe.apiVersion,
      })
    this.provider =
      deps.provider ||
      (cfg.chain.rpcUrl ? new ethers.JsonRpcProvider(cfg.chain.rpcUrl) : null)
    const derived = walletAddressOf(cfg.chain.walletKey)
    this.wallet =
      this.provider && derived && sameAddress(derived, cfg.chain.walletAddress)
        ? new ethers.Wallet(cfg.chain.walletKey, this.provider)
        : null
    this.swap =
      deps.swap ||
      (this.provider
        ? new SwapService({
            provider: this.provider,
            wallet: this.wallet,
            usdc: cfg.chain.usdc,
            weth: cfg.chain.weth,
            mgro: cfg.chain.mgro,
            factory: cfg.chain.uniswap.factory,
            quoter: cfg.chain.uniswap.quoter,
            router: cfg.chain.uniswap.router,
            openOceanBase: cfg.chain.openOceanBase,
            route: cfg.swapRoute,
            slippagePct: cfg.slippagePct,
          })
        : null)
    this.lock =
      deps.lock ||
      (this.provider
        ? new LockService({
            provider: this.provider,
            wallet: this.wallet,
            mgro: cfg.chain.mgro,
            method: cfg.lockMethod,
            forwardTo: cfg.forwardTo,
            retirementAddress: cfg.retirementAddress,
            beneficiary: cfg.safe,
          })
        : null)
  }

  get fatal(): ConfigProblem | null {
    return this.problems.find(p => p.fatal) || null
  }

  get dryRun(): boolean {
    return this.cfg.mode !== 'live'
  }

  /** At least one stage this deployment can run. */
  get configured(): boolean {
    return (
      this.mercury.configured ||
      this.stripe.configured ||
      Boolean(this.provider)
    )
  }

  get walletAddress(): string {
    return this.wallet?.address || this.cfg.chain.walletAddress || ''
  }

  start(): void {
    if (this.timer) return
    if (this.cfg.disabled) {
      console.log('[Treasury] DISABLE_TREASURY_PIPELINE=true; pipeline off')
      return
    }
    if (this.fatal) {
      console.error(`[Treasury] refusing to start: ${this.fatal.problem}`)
      return
    }
    if (!this.configured) {
      console.log(
        '[Treasury] no Mercury, Stripe or chain settings; pipeline idle',
      )
      return
    }
    for (const p of this.problems)
      console.warn(`[Treasury] ${p.stage}: ${p.problem}`)
    const loop = async () => {
      try {
        await this.tick()
      } catch (error) {
        console.error(`[Treasury] tick failed: ${why(error)}`)
      } finally {
        this.timer = setTimeout(loop, this.cfg.pollMs)
        this.timer.unref()
      }
    }
    this.timer = setTimeout(loop, FIRST_TICK_MS)
    this.timer.unref()
    this.startedAt = new Date()
    console.log(
      `[Treasury] started: mode=${this.cfg.mode} route=${this.cfg.swapRoute} lock=${this.cfg.lockMethod} every ${this.cfg.pollMs}ms`,
    )
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One pass over every stage, in order, in the process that holds the lease. */
  async tick(): Promise<TickSummary> {
    const summary: TickSummary = {
      at: new Date().toISOString(),
      mode: this.cfg.mode,
      ranUnderLease: false,
      detected: 0,
      held: 0,
      swept: 0,
      onramped: 0,
      bought: 0,
      settled: 0,
      failed: 0,
      errors: [],
      durationMs: 0,
    }
    if (this.running) {
      summary.errors.push('a tick is already running in this process')
      return summary
    }
    if (this.fatal) {
      summary.errors.push(this.fatal.problem)
      return summary
    }
    this.running = true
    const started = Date.now()
    try {
      const ran = await runUnderLease(this.lease, async () => {
        await this.step('detect', summary, () => this.detect(summary))
        await this.step('sweep', summary, () => this.sweepStage(summary))
        await this.step('onramp', summary, () => this.onrampStage(summary))
        await this.step('swap', summary, () => this.swapStage(summary))
        await this.step('settle', summary, () => this.settleStage(summary))
      })
      summary.ranUnderLease = ran.ran
      if (!ran.ran)
        summary.errors.push('another process holds the treasury lease')
    } finally {
      summary.durationMs = Date.now() - started
      this.lastTick = summary
      this.running = false
    }
    return summary
  }

  private async step(
    name: string,
    s: TickSummary,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn()
    } catch (error) {
      const message = `${name}: ${why(error)}`
      s.errors.push(message)
      console.error(`[Treasury] ${message}`)
    }
  }

  // ---------------------------------------------------------------- detect --

  /** New credits on the Mercury account become flows; the ledger never learns who sent them. */
  private async detect(s: TickSummary): Promise<void> {
    const m = this.cfg.mercury
    if (!this.mercury.configured || !m.accountId) return
    const start = new Date(Date.now() - this.cfg.lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const rows = await this.mercury.listAllTransactions(m.accountId, {
      start,
      status: 'sent',
    })
    const filter = {
      kinds: new Set(this.cfg.donationKinds),
      minCents: this.cfg.minDonationCents,
      excludeCounterpartyIds: new Set(
        m.stripeRecipientId ? [m.stripeRecipientId] : [],
      ),
    }
    const credits = rows
      .filter(tx => isDonationCredit(tx, filter))
      .sort((a, b) => postedTime(a) - postedTime(b))
    let tickCents = 0
    for (const tx of credits) {
      const cents = usdToCents(tx.amount)
      let status: 'detected' | 'held' = this.cfg.requireApproval
        ? 'held'
        : 'detected'
      let holdReason = this.cfg.requireApproval
        ? 'sweep: waiting for an admin release (TREASURY_REQUIRE_APPROVAL)'
        : ''
      if (status === 'detected' && tickCents + cents > this.cfg.maxTickCents) {
        status = 'held'
        holdReason =
          'sweep: over the per-tick cap (TREASURY_MAX_TICK_USD); release by hand'
      }
      const mercury: Record<string, unknown> = {
        txId: tx.id,
        accountId: m.accountId,
        kind: tx.kind || '',
        counterpartyHash: tx.counterpartyName
          ? sha256Hex(tx.counterpartyName)
          : '',
        memo: '',
      }
      if (postedTime(tx)) mercury.postedAt = new Date(postedTime(tx))
      const result = await DonationFlow.updateOne(
        { 'mercury.txId': tx.id },
        {
          $setOnInsert: {
            status,
            mode: this.cfg.mode,
            amountCents: cents,
            currency: 'usd',
            holdReason,
            mercury,
            events: [
              {
                at: new Date(),
                stage: 'detect',
                message: `${usd(cents)} credit (${tx.kind || 'unknown kind'}) seen on Mercury${status === 'held' ? '; held' : ''}`,
              },
            ],
          },
        },
        { upsert: true },
      )
      if (result.upsertedCount) {
        s.detected += 1
        if (status === 'held') s.held += 1
        else tickCents += cents
      }
    }
  }

  // ----------------------------------------------------------------- sweep --

  /** Mercury → Stripe financial account, one ACH per tick for every flow that fits the cap. */
  private async sweepStage(s: TickSummary): Promise<void> {
    const flows: Flow[] = await DonationFlow.find({
      mode: this.cfg.mode,
      status: 'detected',
    })
      .sort({ createdAt: 1 })
      .limit(200)
      .exec()
    if (!flows.length) return
    const m = this.cfg.mercury
    const isSent = (f: Flow) =>
      f.sweep?.status === 'sent' && Boolean(f.sweep?.mercuryPaymentId)

    // 1. Payments already requested: how are they doing?
    const byPayment = new Map<string, Flow[]>()
    for (const f of flows.filter(isSent)) {
      const id = String(f.sweep.mercuryPaymentId)
      byPayment.set(id, [...(byPayment.get(id) || []), f])
    }
    for (const [paymentId, group] of byPayment) {
      if (!this.mercury.configured) break
      try {
        const tx = await this.mercury.getTransaction(m.accountId, paymentId)
        const state = String(tx.status || '').toLowerCase()
        if (state === 'sent') {
          for (const f of group) {
            f.sweep.status = 'settled'
            f.sweep.settledAt = new Date()
            f.status = 'swept'
            this.event(
              f,
              'sweep',
              `Mercury payment ${paymentId} sent to Stripe`,
            )
            await f.save()
            s.swept += 1
          }
        } else if (state === 'failed' || state === 'cancelled') {
          for (const f of group) {
            await this.fail(
              f,
              'sweep',
              `Mercury payment ${paymentId} ${state}${tx.reasonForFailure ? `: ${tx.reasonForFailure}` : ''}`,
              s,
              true,
            )
          }
        }
      } catch (error) {
        for (const f of group) await this.recordError(f, 'sweep', error, s)
      }
    }

    const fresh = flows.filter(f => !isSent(f))
    if (!fresh.length) return
    const amountOf = (f: Flow) =>
      sweepAmountCents(
        f.amountCents,
        this.cfg.sweepReservePct,
        this.cfg.maxSweepCents,
      )

    // 2. Dry run: show exactly what would be sent, then move on.
    if (this.dryRun) {
      for (const f of fresh) {
        const cents = amountOf(f)
        const key = idempotencyKey(String(f._id), 'sweep')
        this.setStage(f, 'sweep', {
          status: 'skipped',
          amountCents: cents,
          idempotencyKey: key,
          dryRun: {
            method: 'POST',
            path: `/account/${m.accountId || '<MERCURY_ACCOUNT_ID>'}/${m.sendMode === 'request' ? 'request-send-money' : 'transactions'}`,
            body: {
              recipientId:
                m.stripeRecipientId || '<MERCURY_STRIPE_RECIPIENT_ID>',
              amount: centsToDollars(cents),
              paymentMethod: 'ach',
              idempotencyKey: key,
              note: `Treegens donation ${f._id}`,
            },
          },
        })
        f.status = 'swept'
        this.event(
          f,
          'sweep',
          `dry run: would send ${usd(cents)} to the Stripe recipient by ACH`,
        )
        await f.save()
        s.swept += 1
      }
      return
    }
    if (!this.mercury.configured || !m.accountId || !m.stripeRecipientId) return

    // 3. Live. A batch formed earlier but never acknowledged by Mercury is
    //    retried as-is (same key, same members); otherwise one new batch.
    const formed = new Map<string, Flow[]>()
    const unformed: Flow[] = []
    for (const f of fresh) {
      if (f.sweep?.batchId)
        formed.set(f.sweep.batchId, [...(formed.get(f.sweep.batchId) || []), f])
      else unformed.push(f)
    }
    if (formed.size === 0 && unformed.length) {
      const { picked } = pickWithinCap(
        unformed,
        amountOf,
        this.cfg.maxSweepCents,
      )
      if (picked.length) {
        const batchId = batchKey(picked.map(f => `${f._id}:${f.releases || 0}`))
        for (const f of picked) {
          this.setStage(f, 'sweep', {
            status: 'pending',
            amountCents: amountOf(f),
            idempotencyKey: batchId,
            batchId,
          })
          await f.save()
        }
        formed.set(batchId, picked)
      }
    }
    for (const [batchId, group] of formed) {
      const total = group.reduce(
        (sum, f) => sum + (f.sweep?.amountCents || 0),
        0,
      )
      if (total <= 0) continue
      try {
        await this.lease.assertHeld()
        const tx = await this.mercury.sendMoney(
          m.accountId,
          {
            recipientId: m.stripeRecipientId,
            amount: centsToDollars(total),
            paymentMethod: 'ach',
            idempotencyKey: batchId,
            note: `Treegens donations ${batchId}`,
          },
          m.sendMode,
        )
        for (const f of group) {
          f.sweep.status = 'sent'
          f.sweep.sentAt = new Date()
          f.sweep.mercuryPaymentId = String(tx?.id || '')
          f.sweep.attempts = (f.sweep.attempts || 0) + 1
          this.event(
            f,
            'sweep',
            `ACH of ${usd(total)} requested from Mercury (${tx?.id || 'no id'}, ${tx?.status || 'unknown'})`,
          )
          await f.save()
        }
      } catch (error) {
        for (const f of group) await this.recordError(f, 'sweep', error, s)
      }
    }
  }

  // ---------------------------------------------------------------- onramp --

  /** Stripe USD → USDC on Base, one outbound payment per flow, FIFO within the balance. */
  private async onrampStage(s: TickSummary): Promise<void> {
    const flows: Flow[] = await DonationFlow.find({
      mode: this.cfg.mode,
      status: 'swept',
    })
      .sort({ createdAt: 1 })
      .limit(200)
      .exec()
    if (!flows.length) return
    const st = this.cfg.stripe
    const isSent = (f: Flow) =>
      f.onramp?.status === 'sent' && Boolean(f.onramp?.stripeOutboundPaymentId)

    for (const f of flows.filter(isSent)) {
      if (!this.stripe.configured) break
      try {
        await this.trackOnramp(f, s)
      } catch (error) {
        await this.recordError(f, 'onramp', error, s)
      }
    }
    const fresh = flows.filter(f => !isSent(f))
    if (!fresh.length) return
    const centsOf = (f: Flow) =>
      Math.min(f.sweep?.amountCents || f.amountCents, this.cfg.maxOnrampCents)

    if (this.dryRun) {
      for (const f of fresh) {
        const cents = centsOf(f)
        const key = idempotencyKey(String(f._id), 'onramp')
        this.setStage(f, 'onramp', {
          status: 'skipped',
          amountCents: cents,
          usdcMicro: centsToUsdcMicro(cents).toString(),
          idempotencyKey: key,
          dryRun: {
            method: 'POST',
            path: '/v2/money_management/outbound_payments',
            headers: {
              'Stripe-Version': st.apiVersion,
              'Idempotency-Key': key,
            },
            body: StripeMoneyClient.paymentBody({
              financialAccount:
                st.financialAccountId || '<STRIPE_FINANCIAL_ACCOUNT_ID>',
              fromCurrency: 'usd',
              payoutMethod:
                st.payoutMethodId || '<STRIPE_CRYPTO_PAYOUT_METHOD_ID>',
              toCurrency: 'usdc',
              amountMinor: cents,
              amountCurrency: 'usd',
              description: `Treegens donation ${f._id}`,
              idempotencyKey: key,
            }),
          },
        })
        f.status = 'onramped'
        this.event(
          f,
          'onramp',
          `dry run: would pay out ${usd(cents)} as USDC to the treasury wallet`,
        )
        await f.save()
        s.onramped += 1
      }
      return
    }
    if (!this.stripe.configured || !st.financialAccountId || !st.payoutMethodId)
      return

    const pm = await this.checkPayoutMethod()
    if (!pm.ok) {
      for (const f of fresh) {
        this.event(f, 'onramp', pm.reason, true)
        await f.save()
      }
      return
    }
    const fa = await this.stripe.getFinancialAccount(st.financialAccountId)
    let available = StripeMoneyClient.availableMinor(fa, 'usd')
    for (const f of fresh) {
      const cents = centsOf(f)
      if (cents <= 0) {
        await this.fail(f, 'onramp', 'nothing was swept for this flow', s)
        continue
      }
      if (cents > available) {
        this.event(
          f,
          'onramp',
          `waiting for ${usd(cents)} to land in the Stripe financial account (available ${usd(available)})`,
          true,
        )
        await f.save()
        break
      }
      const key =
        f.onramp?.idempotencyKey ||
        idempotencyKey(String(f._id), 'onramp') +
          (f.releases ? `-r${f.releases}` : '')
      this.setStage(f, 'onramp', {
        status: 'pending',
        amountCents: cents,
        idempotencyKey: key,
      })
      await f.save()
      try {
        await this.lease.assertHeld()
        const op = await this.stripe.createOutboundPayment({
          financialAccount: st.financialAccountId,
          fromCurrency: 'usd',
          payoutMethod: st.payoutMethodId,
          toCurrency: 'usdc',
          amountMinor: cents,
          amountCurrency: 'usd',
          description: `Treegens donation ${f._id}`,
          idempotencyKey: key,
        })
        f.onramp.status = 'sent'
        f.onramp.sentAt = new Date()
        f.onramp.stripeOutboundPaymentId = String(op?.id || '')
        f.onramp.attempts = 0
        available -= cents
        this.event(
          f,
          'onramp',
          `Stripe outbound payment ${op?.id || 'no id'} created (${op?.status || 'unknown'}): ${usd(cents)} → USDC`,
        )
        await f.save()
      } catch (error) {
        await this.recordError(f, 'onramp', error, s)
      }
    }
  }

  private async trackOnramp(f: Flow, s: TickSummary): Promise<void> {
    const op = await this.stripe.getOutboundPayment(
      f.onramp.stripeOutboundPaymentId,
    )
    const status = String(op?.status || '').toLowerCase()
    if (['failed', 'returned', 'canceled', 'cancelled'].includes(status)) {
      const detail =
        op?.status_details?.failed?.reason ||
        op?.status_details?.returned?.reason ||
        ''
      await this.fail(
        f,
        'onramp',
        `Stripe outbound payment ${op.id} ${status}${detail ? `: ${detail}` : ''}`,
        s,
        true,
      )
      return
    }
    if (status !== 'posted') return
    f.onramp.attempts = (f.onramp.attempts || 0) + 1
    const expected = centsToUsdcMicro(f.onramp.amountCents || f.amountCents)
    const arrival = await this.findUsdcArrival(f, op, expected)
    if (arrival) {
      f.onramp.usdcMicro = arrival.value.toString()
      f.onramp.txHash = arrival.txHash
      f.onramp.status = 'settled'
      f.onramp.settledAt = new Date()
      f.status = 'onramped'
      this.event(
        f,
        'onramp',
        `${formatUnitsFixed(arrival.value, USDC_DECIMALS, 2)} USDC arrived on Base (${arrival.txHash})`,
      )
      s.onramped += 1
    } else if (f.onramp.attempts >= this.cfg.arrivalWaitTicks) {
      const minor = Number(op?.amount?.value ?? f.onramp.amountCents)
      f.onramp.usdcMicro = stripeMinorToUsdcMicro(
        Number.isFinite(minor) && minor > 0 ? minor : f.onramp.amountCents,
      ).toString()
      f.onramp.status = 'settled'
      f.onramp.settledAt = new Date()
      f.status = 'onramped'
      this.event(
        f,
        'onramp',
        `Stripe reports the payout posted; no matching USDC transfer was found on Base after ${f.onramp.attempts} checks, so the Stripe amount is used`,
      )
      s.onramped += 1
    } else {
      this.event(
        f,
        'onramp',
        'posted at Stripe; waiting for the USDC transfer to appear on Base',
        true,
      )
    }
    await f.save()
  }

  /** The USDC transfer on Base that belongs to this payout: by Stripe's trace id when it is a tx hash, else by size. */
  private async findUsdcArrival(
    f: Flow,
    op: any,
    expected: bigint,
  ): Promise<UsdcArrival | null> {
    const wallet = this.walletAddress
    if (!this.provider || !wallet) return null
    const claimed = new Set<string>(
      ((await DonationFlow.distinct('onramp.txHash')) as unknown[])
        .filter(Boolean)
        .map(h => String(h).toLowerCase()),
    )
    const trace = String(op?.trace_id?.value || '')
    if (isTxHash(trace) && !claimed.has(trace.toLowerCase())) {
      const receipt = await this.provider.getTransactionReceipt(trace)
      if (receipt) {
        const hits = this.usdcTransfersTo(receipt.logs, wallet)
        if (hits.length) return hits[0]
      }
    }
    const latest = await this.provider.getBlockNumber()
    const sinceMs = Math.max(
      0,
      Date.now() - new Date(f.onramp?.sentAt || f.updatedAt || 0).getTime(),
    )
    const span = Math.min(MAX_LOG_SPAN, Math.ceil(sinceMs / 2000) + 3000)
    const candidates: UsdcArrival[] = []
    for (
      let from = Math.max(0, latest - span);
      from <= latest;
      from += LOG_CHUNK
    ) {
      const logs = await this.provider.getLogs({
        address: this.cfg.chain.usdc,
        fromBlock: from,
        toBlock: Math.min(latest, from + LOG_CHUNK - 1),
        topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(wallet, 32)],
      })
      for (const log of logs) {
        candidates.push({
          txHash: log.transactionHash,
          value: BigInt(log.data),
          blockNumber: log.blockNumber,
          logIndex: log.index,
        })
      }
    }
    return matchUsdcArrival(expected, candidates, claimed)
  }

  private usdcTransfersTo(
    logs: readonly ethers.Log[],
    wallet: string,
  ): UsdcArrival[] {
    const out: UsdcArrival[] = []
    for (const log of logs) {
      if (!sameAddress(log.address, this.cfg.chain.usdc)) continue
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue
      if (!sameAddress(ethers.dataSlice(log.topics[2], 12), wallet)) continue
      out.push({
        txHash: log.transactionHash,
        value: BigInt(log.data),
        blockNumber: log.blockNumber,
        logIndex: log.index,
      })
    }
    return out
  }

  /** The Stripe payout method must pay exactly the treasury wallet, on Base. Checked once per process. */
  private async checkPayoutMethod(): Promise<{ ok: boolean; reason: string }> {
    if (this.payoutMethodOk) return { ok: true, reason: '' }
    const expected = this.cfg.chain.walletAddress
    if (!expected) {
      return {
        ok: false,
        reason:
          'TREASURY_WALLET_ADDRESS unset: refusing to pay USDC out to an unverified wallet',
      }
    }
    try {
      const pm = await this.stripe.getPayoutMethod(
        this.cfg.stripe.payoutMethodId,
      )
      const w = StripeMoneyClient.cryptoWalletOf(pm)
      if (!w) {
        return {
          ok: false,
          reason: `Stripe payout method ${this.cfg.stripe.payoutMethodId} is not a crypto wallet`,
        }
      }
      if (!sameAddress(w.address, expected)) {
        return {
          ok: false,
          reason: `Stripe payout method pays ${w.address}, not the treasury wallet ${expected}; refusing`,
        }
      }
      if (w.network && !w.network.includes('base')) {
        return {
          ok: false,
          reason: `Stripe payout method is on "${w.network}", not Base; refusing`,
        }
      }
      this.payoutMethodOk = true
      return { ok: true, reason: '' }
    } catch (error) {
      return {
        ok: false,
        reason: `could not read the Stripe payout method: ${why(error)}`,
      }
    }
  }

  // ------------------------------------------------------------------ swap --

  /** USDC → canonical $MGRO, one swap per flow. */
  private async swapStage(s: TickSummary): Promise<void> {
    const flows: Flow[] = await DonationFlow.find({
      mode: this.cfg.mode,
      status: 'onramped',
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .exec()
    if (!flows.length || !this.swap) return
    for (const f of flows) {
      const want = BigInt(f.onramp?.usdcMicro || '0')
      if (want <= 0n) {
        await this.fail(f, 'swap', 'no USDC amount recorded for this flow', s)
        continue
      }
      if (f.swap?.status === 'sent' && isTxHash(f.swap.txHash)) {
        await this.confirmSwap(f, s)
        continue
      }
      if (want < this.cfg.minSwapMicro) {
        await this.park(
          f,
          'swap',
          `${formatUnitsFixed(want, USDC_DECIMALS, 2)} USDC is below TREASURY_MIN_SWAP_USDC`,
          s,
        )
        continue
      }
      if (want > this.cfg.maxSwapMicro) {
        await this.park(
          f,
          'swap',
          `${formatUnitsFixed(want, USDC_DECIMALS, 2)} USDC is above TREASURY_MAX_SWAP_USDC; raise the cap and release`,
          s,
        )
        continue
      }

      if (this.dryRun) {
        let quote = null
        try {
          quote = await this.swap.quote(want)
        } catch (error) {
          this.event(f, 'swap', `dry run: quote failed: ${why(error)}`)
        }
        const out = quote?.amountOut ?? 0n
        this.setStage(f, 'swap', {
          status: 'skipped',
          usdcMicro: want.toString(),
          mgroWei: out.toString(),
          quoteMgroWei: out.toString(),
          route: quote?.route || '',
          dryRun: {
            route: quote?.route || 'no route with liquidity yet',
            amountIn: want.toString(),
            quotedOut: out.toString(),
            minOut: (quote?.minOut ?? 0n).toString(),
            slippagePct: this.cfg.slippagePct,
          },
        })
        f.status = 'bought'
        this.event(
          f,
          'swap',
          quote
            ? `dry run: ${formatUnitsFixed(want, USDC_DECIMALS, 2)} USDC would buy about ${formatUnitsFixed(out, MGRO_DECIMALS, 2)} $MGRO via ${quote.route}`
            : 'dry run: no route with liquidity for USDC → $MGRO yet',
        )
        await f.save()
        s.bought += 1
        continue
      }
      if (!this.wallet) {
        this.event(
          f,
          'swap',
          'treasury wallet is not configured (or its key does not match TREASURY_WALLET_ADDRESS); waiting',
          true,
        )
        await f.save()
        continue
      }
      const balance = await this.swap.usdcBalance(this.wallet.address)
      if (balance < want) {
        await this.waitOrPark(
          f,
          'swap',
          `wallet holds ${formatUnitsFixed(balance, USDC_DECIMALS, 2)} USDC, below this flow's ${formatUnitsFixed(want, USDC_DECIMALS, 2)}`,
          s,
        )
        continue
      }
      const quote = await this.swap.quote(want)
      if (!quote) {
        await this.waitOrPark(
          f,
          'swap',
          'no route with liquidity for USDC → $MGRO',
          s,
        )
        continue
      }
      try {
        await this.lease.assertHeld()
        const sent = await this.swap.send(quote)
        this.setStage(f, 'swap', {
          status: 'sent',
          sentAt: new Date(),
          usdcMicro: want.toString(),
          quoteMgroWei: quote.amountOut.toString(),
          route: quote.route,
          txHash: sent.hash,
        })
        this.event(f, 'swap', `swap sent via ${quote.route}: ${sent.hash}`)
        await f.save()
        await this.waitBriefly(sent.hash)
        await this.confirmSwap(f, s)
      } catch (error) {
        await this.recordError(f, 'swap', error, s)
      }
    }
  }

  private async confirmSwap(f: Flow, s: TickSummary): Promise<void> {
    if (!this.swap) return
    const result = await this.swap.confirm(f.swap.txHash)
    if (result.state === 'pending') {
      this.event(f, 'swap', `waiting for ${f.swap.txHash} to be mined`, true)
      await f.save()
      return
    }
    if (result.state === 'reverted') {
      f.swap.status = 'pending'
      f.swap.txHash = ''
      await this.recordError(
        f,
        'swap',
        new Error(`swap ${result.hash} reverted`),
        s,
      )
      return
    }
    if (result.amountOut <= 0n) {
      await this.park(
        f,
        'swap',
        `swap ${result.hash} was mined but no $MGRO reached the wallet; check the route`,
        s,
      )
      return
    }
    f.swap.status = 'settled'
    f.swap.settledAt = new Date()
    f.swap.mgroWei = result.amountOut.toString()
    f.status = 'bought'
    this.event(
      f,
      'swap',
      `bought ${formatUnitsFixed(result.amountOut, MGRO_DECIMALS, 4)} $MGRO (${result.hash})`,
    )
    await f.save()
    s.bought += 1
  }

  // ---------------------------------------------------------------- settle --

  /** The bought $MGRO leaves circulation. */
  private async settleStage(s: TickSummary): Promise<void> {
    const flows: Flow[] = await DonationFlow.find({
      mode: this.cfg.mode,
      status: 'bought',
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .exec()
    if (!flows.length || !this.lock || !this.swap) return
    const described = this.lock.describe()
    for (const f of flows) {
      const amount = BigInt(f.swap?.mgroWei || '0')
      if (amount <= 0n) {
        await this.fail(f, 'settle', 'no $MGRO recorded from the swap', s)
        continue
      }
      if (f.settle?.status === 'sent' && isTxHash(f.settle.txHash)) {
        await this.confirmSettle(f, s)
        continue
      }
      if (this.dryRun) {
        this.setStage(f, 'settle', {
          status: 'skipped',
          mgroWei: amount.toString(),
          to: described.to,
          method: described.method,
          retired: described.retired,
          dryRun: {
            method: described.method,
            to: described.to,
            amountWei: amount.toString(),
            beneficiary: this.cfg.safe,
          },
        })
        f.status = 'settled'
        this.event(
          f,
          'settle',
          `dry run: would lock ${formatUnitsFixed(amount, MGRO_DECIMALS, 4)} $MGRO (${described.method} → ${described.to})`,
        )
        await f.save()
        s.settled += 1
        continue
      }
      if (!this.wallet) {
        this.event(
          f,
          'settle',
          'treasury wallet is not configured; waiting',
          true,
        )
        await f.save()
        continue
      }
      const problems = await this.lock.preflight()
      if (problems.length) {
        await this.park(f, 'settle', problems.join('; '), s)
        continue
      }
      const balance = await this.swap.mgroBalance(this.wallet.address)
      if (balance < amount) {
        await this.waitOrPark(
          f,
          'settle',
          `wallet holds ${formatUnitsFixed(balance, MGRO_DECIMALS, 4)} $MGRO, below this flow's ${formatUnitsFixed(amount, MGRO_DECIMALS, 4)}`,
          s,
        )
        continue
      }
      try {
        await this.lease.assertHeld()
        const sent = await this.lock.send(amount, String(f._id))
        this.setStage(f, 'settle', {
          status: 'sent',
          sentAt: new Date(),
          mgroWei: amount.toString(),
          to: sent.to,
          method: sent.method,
          txHash: sent.hash,
          retired: sent.method !== 'forward',
        })
        this.event(f, 'settle', `lock sent (${sent.method}): ${sent.hash}`)
        await f.save()
        await this.waitBriefly(sent.hash)
        await this.confirmSettle(f, s)
      } catch (error) {
        await this.recordError(f, 'settle', error, s)
      }
    }
  }

  private async confirmSettle(f: Flow, s: TickSummary): Promise<void> {
    if (!this.lock) return
    const result = await this.lock.confirm(f.settle.txHash)
    if (result.state === 'pending') {
      this.event(
        f,
        'settle',
        `waiting for ${f.settle.txHash} to be mined`,
        true,
      )
      await f.save()
      return
    }
    if (result.state === 'reverted') {
      f.settle.status = 'pending'
      f.settle.txHash = ''
      await this.recordError(
        f,
        'settle',
        new Error(`lock ${result.hash} reverted`),
        s,
      )
      return
    }
    f.settle.status = 'settled'
    f.settle.settledAt = new Date()
    if (result.tokenId !== undefined) f.settle.tokenId = result.tokenId
    f.status = 'settled'
    this.event(
      f,
      'settle',
      `${formatUnitsFixed(BigInt(f.settle.mgroWei || '0'), MGRO_DECIMALS, 4)} $MGRO locked for good (${f.settle.method}, ${result.hash})`,
    )
    await f.save()
    s.settled += 1
  }

  // ----------------------------------------------------------------- admin --

  async status() {
    const counts = await DonationFlow.aggregate([
      {
        $group: {
          _id: { mode: '$mode', status: '$status' },
          count: { $sum: 1 },
          cents: { $sum: '$amountCents' },
        },
      },
    ])
    const flows: Record<
      string,
      Record<string, { count: number; usd: number }>
    > = {}
    for (const r of counts as any[]) {
      const mode = String(r._id?.mode || 'unknown')
      flows[mode] = flows[mode] || {}
      flows[mode][String(r._id?.status)] = {
        count: r.count,
        usd: Math.round(r.cents || 0) / 100,
      }
    }
    const [wallet, stripe] = await Promise.all([
      this.walletBalances(),
      this.stripeBalances(),
    ])
    return {
      running: Boolean(this.timer),
      startedAt: this.startedAt?.toISOString() || null,
      mode: this.cfg.mode,
      dryRun: this.dryRun,
      problems: this.problems,
      config: redactedConfig(this.cfg),
      lastTick: this.lastTick,
      flows,
      wallet,
      stripe,
      lockDestination: this.lock?.describe() || null,
    }
  }

  private async walletBalances() {
    const address = this.walletAddress
    if (!this.provider || !address || !this.swap) return null
    try {
      const [eth, usdc, mgro] = await Promise.all([
        this.provider.getBalance(address),
        this.swap.usdcBalance(address),
        this.swap.mgroBalance(address),
      ])
      return {
        address,
        signerLoaded: Boolean(this.wallet),
        eth: Number(ethers.formatEther(eth)).toFixed(5),
        usdc: formatUnitsFixed(usdc, USDC_DECIMALS, 2),
        mgro: formatUnitsFixed(mgro, MGRO_DECIMALS, 4),
      }
    } catch (error) {
      return { address, signerLoaded: Boolean(this.wallet), error: why(error) }
    }
  }

  private async stripeBalances() {
    const id = this.cfg.stripe.financialAccountId
    if (!this.stripe.configured || !id) return null
    try {
      const fa = await this.stripe.getFinancialAccount(id)
      return {
        financialAccountId: id,
        status: fa?.status || null,
        usdAvailable: StripeMoneyClient.availableMinor(fa, 'usd') / 100,
        usdcAvailable: StripeMoneyClient.availableMinor(fa, 'usdc') / 100,
      }
    } catch (error) {
      return { financialAccountId: id, error: why(error) }
    }
  }

  /** What the operator needs from Stripe: financial accounts, their bank details, payout methods. */
  async stripeOverview() {
    if (!this.stripe.configured) return { configured: false }
    const accounts = await this.stripe.listFinancialAccounts()
    const faId = this.cfg.stripe.financialAccountId
    let addresses: unknown = null
    if (faId) {
      try {
        addresses = await this.stripe.listFinancialAddresses(faId)
      } catch (error) {
        addresses = { error: why(error) }
      }
    }
    let payoutMethods: unknown = null
    try {
      const pms = await this.stripe.listPayoutMethods()
      payoutMethods = (pms?.data || []).map((pm: any) => ({
        id: pm.id,
        type: pm.type,
        status: pm.status ?? pm.usage_status ?? null,
        wallet: StripeMoneyClient.cryptoWalletOf(pm),
        isConfigured: pm.id === this.cfg.stripe.payoutMethodId,
      }))
    } catch (error) {
      payoutMethods = { error: why(error) }
    }
    return {
      configured: true,
      financialAccounts: (accounts?.data || []).map((fa: any) => ({
        id: fa.id,
        status: fa.status,
        isConfigured: fa.id === faId,
        usdAvailable: StripeMoneyClient.availableMinor(fa, 'usd') / 100,
        usdcAvailable: StripeMoneyClient.availableMinor(fa, 'usdc') / 100,
      })),
      financialAddresses: addresses,
      payoutMethods,
    }
  }

  /** What the operator needs from Mercury: the accounts and the saved recipients. */
  async mercuryOverview() {
    if (!this.mercury.configured) return { configured: false }
    const [accounts, recipients] = await Promise.all([
      this.mercury.listAccounts().catch(error => ({ error: why(error) })),
      this.mercury.listRecipients().catch(error => ({ error: why(error) })),
    ])
    return {
      configured: true,
      accounts: Array.isArray((accounts as any)?.accounts)
        ? (accounts as any).accounts.map((a: any) => ({
            id: a.id,
            name: a.name,
            kind: a.kind,
            status: a.status,
            isConfigured: a.id === this.cfg.mercury.accountId,
          }))
        : accounts,
      recipients: Array.isArray((recipients as any)?.recipients)
        ? (recipients as any).recipients.map((r: any) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            paymentMethod: r.paymentMethod ?? r.defaultPaymentMethod ?? null,
            isConfigured: r.id === this.cfg.mercury.stripeRecipientId,
          }))
        : recipients,
    }
  }

  /**
   * Let a held, failed or dry-run flow go (again). A stage whose payment or
   * transaction is still out there keeps its ids and is polled; one the
   * provider rejected starts over with a fresh idempotency key.
   */
  async release(id: string): Promise<Flow | null> {
    const f: Flow = await DonationFlow.findById(id)
    if (!f) return null
    if (f.mode !== this.cfg.mode) {
      const from = f.mode
      f.mode = this.cfg.mode
      f.status = 'detected'
      f.sweep = undefined
      f.onramp = undefined
      f.swap = undefined
      f.settle = undefined
      f.holdReason = ''
      this.event(
        f,
        'admin',
        `released into ${this.cfg.mode} mode from a ${from} record`,
      )
      await f.save()
      return f
    }
    if (f.status !== 'held' && f.status !== 'failed') return f
    const stage: StageName =
      stageFromHoldReason(f.holdReason) || stageForStatus(f.status) || 'sweep'
    const st = this.stageDoc(f, stage)
    if (st.status === 'sent') {
      // The payment or transaction exists; keep polling it.
    } else {
      st.status = 'pending'
      st.mercuryPaymentId = ''
      st.batchId = ''
      st.stripeOutboundPaymentId = ''
      st.txHash = ''
      st.idempotencyKey = ''
      f.releases = (f.releases || 0) + 1
    }
    st.error = ''
    st.attempts = 0
    f.status = releaseTargetStatus(stage)
    f.holdReason = ''
    this.event(f, 'admin', `released at ${stage}; now ${f.status}`)
    await f.save()
    return f
  }

  /** Park a flow that is still moving; it remembers the stage it was at. */
  async hold(id: string, reason: string): Promise<Flow | null> {
    const f: Flow = await DonationFlow.findById(id)
    if (!f) return null
    const stage = stageForStatus(f.status)
    if (!stage) return f
    f.status = 'held'
    f.holdReason = `${stage}: admin hold: ${reason || 'no reason given'}`
    this.event(f, 'admin', `held at ${stage}: ${reason || 'no reason given'}`)
    await f.save()
    return f
  }

  // --------------------------------------------------------------- helpers --

  private stageDoc(f: Flow, stage: StageName): any {
    if (!f[stage]) f[stage] = {}
    return f[stage]
  }

  private setStage(f: Flow, stage: StageName, patch: Record<string, unknown>) {
    const current = f[stage]
    const base =
      current && typeof current.toObject === 'function'
        ? current.toObject()
        : current || {}
    f[stage] = { ...base, ...patch }
  }

  private event(f: Flow, stage: string, message: string, dedupe = false) {
    if (!Array.isArray(f.events)) f.events = []
    const last = f.events[f.events.length - 1]
    if (dedupe && last && last.stage === stage && last.message === message) {
      last.at = new Date()
      return
    }
    f.events.push({ at: new Date(), stage, message })
    if (f.events.length > MAX_EVENTS)
      f.events.splice(0, f.events.length - MAX_EVENTS)
  }

  private async recordError(
    f: Flow,
    stage: StageName,
    error: unknown,
    s: TickSummary,
  ) {
    const st = this.stageDoc(f, stage)
    st.attempts = (st.attempts || 0) + 1
    st.error = why(error)
    this.event(f, stage, `attempt ${st.attempts} failed: ${st.error}`)
    console.error(`[Treasury] flow ${f._id} ${stage}: ${st.error}`)
    if (st.attempts >= this.cfg.maxAttempts) {
      await this.fail(
        f,
        stage,
        `gave up after ${st.attempts} attempts: ${st.error}`,
        s,
      )
      return
    }
    await f.save()
  }

  /** Not an error, but the flow cannot move yet; after enough checks it is parked so the queue shows it. */
  private async waitOrPark(
    f: Flow,
    stage: StageName,
    reason: string,
    s: TickSummary,
  ) {
    const st = this.stageDoc(f, stage)
    st.attempts = (st.attempts || 0) + 1
    if (st.attempts >= this.cfg.maxAttempts) {
      await this.park(f, stage, `${reason} (after ${st.attempts} checks)`, s)
      return
    }
    this.event(f, stage, `${reason}; waiting`, true)
    await f.save()
  }

  private async park(
    f: Flow,
    stage: StageName,
    reason: string,
    s: TickSummary,
  ) {
    f.status = 'held'
    f.holdReason = `${stage}: ${reason}`
    this.stageDoc(f, stage).error = reason
    this.event(f, stage, `held: ${reason}`)
    console.warn(`[Treasury] flow ${f._id} held at ${stage}: ${reason}`)
    s.held += 1
    await f.save()
  }

  /**
   * `terminal` means the provider itself declared the payment dead, so its
   * ids are dropped and a release starts the stage over with a fresh key.
   * Otherwise the ids stay: a release resumes polling what was sent.
   */
  private async fail(
    f: Flow,
    stage: StageName,
    reason: string,
    s: TickSummary,
    terminal = false,
  ) {
    const st = this.stageDoc(f, stage)
    if (terminal) {
      st.status = 'failed'
      st.mercuryPaymentId = ''
      st.batchId = ''
      st.stripeOutboundPaymentId = ''
      st.txHash = ''
    }
    st.error = reason
    f.status = 'failed'
    f.holdReason = `${stage}: ${reason}`
    this.event(f, stage, `failed: ${reason}`)
    console.error(`[Treasury] flow ${f._id} failed at ${stage}: ${reason}`)
    s.failed += 1
    await f.save()
  }

  private async waitBriefly(hash: string): Promise<void> {
    if (!this.provider) return
    try {
      await this.provider.waitForTransaction(hash, 1, RECEIPT_WAIT_MS)
    } catch {
      // Not mined yet: confirm() picks it up on the next tick.
    }
  }
}

export default TreasuryPipelineService
