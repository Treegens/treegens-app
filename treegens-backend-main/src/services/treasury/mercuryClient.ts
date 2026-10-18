import type { MercurySendMode } from './treasuryMath'

/** Injected in tests; defaults to the global fetch (Node ≥ 18). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface MercuryTransaction {
  id: string
  /** Dollars; positive for credits, negative for debits. */
  amount: number
  status: 'pending' | 'sent' | 'cancelled' | 'failed' | string
  kind?: string
  counterpartyId?: string | null
  counterpartyName?: string | null
  createdAt?: string
  postedAt?: string | null
  estimatedDeliveryDate?: string | null
  failedAt?: string | null
  reasonForFailure?: string | null
  note?: string | null
  externalMemo?: string | null
  bankDescription?: string | null
  dashboardLink?: string
}

export interface MercurySendMoneyInput {
  recipientId: string
  /** Dollars with at most two decimals. */
  amount: number
  paymentMethod?: 'ach'
  idempotencyKey: string
  note?: string
  externalMemo?: string
}

export class MercuryApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

const encode = (s: string) => encodeURIComponent(String(s))

/**
 * Mercury (mercury.com) REST API, the parts the pipeline needs:
 * read an account's transactions, read one back, list recipients, and send
 * an ACH payment to a saved recipient.
 *
 * The token never appears in an error message or a log line.
 */
export class MercuryClient {
  private readonly fetchImpl: FetchLike

  constructor(
    private readonly opts: {
      apiBase: string
      token: string
      fetchImpl?: FetchLike
      timeoutMs?: number
    },
  ) {
    this.fetchImpl = opts.fetchImpl || ((input, init) => fetch(input, init))
  }

  get configured(): boolean {
    return Boolean(this.opts.token && this.opts.apiBase)
  }

  listAccounts(): Promise<{ accounts: any[] }> {
    return this.request('GET', '/accounts')
  }

  listRecipients(): Promise<{ recipients: any[] }> {
    return this.request('GET', '/recipients')
  }

  listTransactions(
    accountId: string,
    q: {
      start?: string
      end?: string
      status?: string
      limit?: number
      offset?: number
    } = {},
  ): Promise<{ total: number; transactions: MercuryTransaction[] }> {
    const params = new URLSearchParams()
    params.set('limit', String(Math.min(500, Math.max(1, q.limit ?? 500))))
    params.set('offset', String(Math.max(0, q.offset ?? 0)))
    if (q.start) params.set('start', q.start)
    if (q.end) params.set('end', q.end)
    if (q.status) params.set('status', q.status)
    return this.request(
      'GET',
      `/account/${encode(accountId)}/transactions?${params.toString()}`,
    )
  }

  /** Every page, oldest page first as Mercury returns them; bounded by `maxPages`. */
  async listAllTransactions(
    accountId: string,
    q: { start?: string; end?: string; status?: string } = {},
    maxPages = 20,
  ): Promise<MercuryTransaction[]> {
    const out: MercuryTransaction[] = []
    const limit = 500
    let offset = 0
    for (let page = 0; page < maxPages; page++) {
      const r = await this.listTransactions(accountId, { ...q, limit, offset })
      const rows = r?.transactions || []
      out.push(...rows)
      if (rows.length < limit) break
      offset += rows.length
    }
    return out
  }

  getTransaction(accountId: string, txId: string): Promise<MercuryTransaction> {
    return this.request(
      'GET',
      `/account/${encode(accountId)}/transaction/${encode(txId)}`,
    )
  }

  /**
   * Send USD to a saved recipient.
   *   direct   POST /account/{id}/transactions (needs a token allowed to
   *            send money; Mercury may still require in-app approval)
   *   request  POST /account/{id}/request-send-money (queues it for approval
   *            in the Mercury dashboard)
   */
  sendMoney(
    accountId: string,
    input: MercurySendMoneyInput,
    mode: MercurySendMode = 'direct',
  ): Promise<MercuryTransaction> {
    const path =
      mode === 'request'
        ? `/account/${encode(accountId)}/request-send-money`
        : `/account/${encode(accountId)}/transactions`
    return this.request('POST', path, { paymentMethod: 'ach', ...input })
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = this.opts.apiBase.replace(/\/+$/, '') + path
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await this.fetchImpl(url, {
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
      const detail =
        json?.errors?.message ||
        json?.message ||
        json?.error ||
        text.slice(0, 200) ||
        `HTTP ${res.status}`
      throw new MercuryApiError(
        res.status,
        `Mercury ${method} ${path.split('?')[0]} → ${res.status}: ${detail}`,
        json ?? text,
      )
    }
    return json as T
  }
}
