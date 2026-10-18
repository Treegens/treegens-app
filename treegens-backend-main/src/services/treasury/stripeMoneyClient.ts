import type { FetchLike } from './mercuryClient'

export const STRIPE_API_BASE = 'https://api.stripe.com'
/** The preview version world.treegens.app's treasury cron already runs on. */
export const STRIPE_MONEY_MANAGEMENT_VERSION = '2025-11-17.preview'

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

export interface OutboundPaymentInput {
  financialAccount: string
  /** Balance currency the money leaves in, e.g. 'usd'. */
  fromCurrency: string
  /** A crypto-wallet payout method (`cwa_…`) registered in the Stripe Dashboard. */
  payoutMethod: string
  /** What the recipient receives, e.g. 'usdc'. */
  toCurrency: string
  /** Minor units of `amountCurrency` (cents). */
  amountMinor: number
  amountCurrency: string
  description: string
  idempotencyKey: string
  /** Set when Stripe asked for a quote first (cross-currency sends). */
  quoteId?: string
}

/**
 * Stripe Money Management (v2): the USD financial account and outbound
 * payments to a crypto-wallet payout method, which is how USD becomes USDC
 * on Base. Same calls and API version as world.treegens.app's treasury cron.
 */
export class StripeMoneyClient {
  private readonly fetchImpl: FetchLike
  private readonly apiBase: string
  private readonly apiVersion: string

  constructor(
    private readonly opts: {
      secretKey: string
      apiVersion?: string
      apiBase?: string
      fetchImpl?: FetchLike
      timeoutMs?: number
    },
  ) {
    this.fetchImpl = opts.fetchImpl || ((input, init) => fetch(input, init))
    this.apiBase = (opts.apiBase || STRIPE_API_BASE).replace(/\/+$/, '')
    this.apiVersion = opts.apiVersion || STRIPE_MONEY_MANAGEMENT_VERSION
  }

  get configured(): boolean {
    return Boolean(this.opts.secretKey)
  }

  getFinancialAccount(id: string): Promise<any> {
    return this.request(
      'GET',
      `/v2/money_management/financial_accounts/${encodeURIComponent(id)}`,
    )
  }

  listFinancialAccounts(): Promise<{ data: any[] }> {
    return this.request('GET', '/v2/money_management/financial_accounts')
  }

  /** The bank details (routing + account number) a Mercury recipient is saved from. */
  listFinancialAddresses(financialAccount: string): Promise<{ data: any[] }> {
    const params = new URLSearchParams()
    params.set('financial_account', financialAccount)
    params.append('include', 'credentials.us_bank_account.account_number')
    params.append('include', 'credentials.us_bank_account.routing_number')
    return this.request(
      'GET',
      `/v2/money_management/financial_addresses?${params.toString()}`,
    )
  }

  listPayoutMethods(): Promise<{ data: any[] }> {
    return this.request('GET', '/v2/money_management/payout_methods')
  }

  getPayoutMethod(id: string): Promise<any> {
    return this.request(
      'GET',
      `/v2/money_management/payout_methods/${encodeURIComponent(id)}`,
    )
  }

  createOutboundPaymentQuote(input: OutboundPaymentInput): Promise<any> {
    return this.request(
      'POST',
      '/v2/money_management/outbound_payment_quotes',
      StripeMoneyClient.paymentBody(input),
      `${input.idempotencyKey}-quote`,
    )
  }

  /**
   * USD out of the financial account, USDC into the treasury wallet.
   * If Stripe answers that a cross-currency send needs a quote, one is
   * created and the payment is retried with it (a new idempotency key: the
   * body changed).
   */
  async createOutboundPayment(input: OutboundPaymentInput): Promise<any> {
    try {
      return await this.request(
        'POST',
        '/v2/money_management/outbound_payments',
        StripeMoneyClient.paymentBody(input),
        input.idempotencyKey,
      )
    } catch (error) {
      if (
        error instanceof StripeApiError &&
        !input.quoteId &&
        /quote/i.test(`${error.code} ${error.message}`)
      ) {
        const quote = await this.createOutboundPaymentQuote(input)
        if (!quote?.id) throw error
        return this.createOutboundPayment({
          ...input,
          quoteId: quote.id,
          idempotencyKey: `${input.idempotencyKey}-q`,
        })
      }
      throw error
    }
  }

  getOutboundPayment(id: string): Promise<any> {
    return this.request(
      'GET',
      `/v2/money_management/outbound_payments/${encodeURIComponent(id)}`,
    )
  }

  static paymentBody(input: OutboundPaymentInput) {
    return {
      from: {
        financial_account: input.financialAccount,
        currency: input.fromCurrency,
      },
      to: { payout_method: input.payoutMethod, currency: input.toCurrency },
      amount: { value: input.amountMinor, currency: input.amountCurrency },
      description: input.description,
      ...(input.quoteId ? { outbound_payment_quote: input.quoteId } : {}),
    }
  }

  /** Available balance of a financial account in minor units of `currency`. */
  static availableMinor(financialAccount: any, currency: string): number {
    const v = financialAccount?.balance?.available?.[currency]?.value
    const n = Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
  }

  /** The wallet a crypto payout method pays, whichever field the API version uses. */
  static cryptoWalletOf(
    payoutMethod: any,
  ): { address: string; network: string } | null {
    const w =
      payoutMethod?.crypto_wallet ||
      payoutMethod?.usd_crypto_wallet ||
      payoutMethod?.usdc_crypto_wallet ||
      null
    if (!w?.address) return null
    return {
      address: String(w.address),
      network: String(w.network || 'base').toLowerCase(),
    }
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization:
        'Basic ' + Buffer.from(`${this.opts.secretKey}:`).toString('base64'),
      'Stripe-Version': this.apiVersion,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const res = await this.fetchImpl(this.apiBase + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const err = json?.error || {}
      const code = String(err.code || err.type || '')
      const detail = err.message || text.slice(0, 200) || `HTTP ${res.status}`
      throw new StripeApiError(
        res.status,
        `Stripe ${method} ${path.split('?')[0]} → ${res.status}: ${detail}`,
        code,
        json ?? text,
      )
    }
    return json as T
  }
}
