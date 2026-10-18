import assert from 'node:assert/strict'
import test from 'node:test'
import { StripeApiError, StripeMoneyClient } from './stripeMoneyClient'

type Call = { url: string; init?: RequestInit }

function fakeFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
    n: number,
  ) => { status?: number; body?: unknown },
) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const r = handler(url, init, calls.length)
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetchImpl }
}

const headerOf = (init: RequestInit | undefined, name: string) =>
  (init?.headers as Record<string, string>)[name]

const input = {
  financialAccount: 'fa_1',
  fromCurrency: 'usd',
  payoutMethod: 'cwa_1',
  toCurrency: 'usdc',
  amountMinor: 25_000,
  amountCurrency: 'usd',
  description: 'Treegens donation x',
  idempotencyKey: 'tg-donation-x-onramp',
}

test('requests carry basic auth, the preview version and the idempotency key', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    body: { id: 'obp_1', status: 'processing' },
  }))
  const client = new StripeMoneyClient({ secretKey: 'sk_test_abc', fetchImpl })
  const op = await client.createOutboundPayment(input)
  assert.equal(op.id, 'obp_1')
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://api.stripe.com/v2/money_management/outbound_payments',
  )
  assert.equal(
    headerOf(calls[0].init, 'Authorization'),
    'Basic ' + Buffer.from('sk_test_abc:').toString('base64'),
  )
  assert.equal(headerOf(calls[0].init, 'Stripe-Version'), '2025-11-17.preview')
  assert.equal(
    headerOf(calls[0].init, 'Idempotency-Key'),
    'tg-donation-x-onramp',
  )
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    from: { financial_account: 'fa_1', currency: 'usd' },
    to: { payout_method: 'cwa_1', currency: 'usdc' },
    amount: { value: 25_000, currency: 'usd' },
    description: 'Treegens donation x',
  })
})

test('a cross-currency send that needs a quote gets one and is retried with it', async () => {
  const { calls, fetchImpl } = fakeFetch((url, _init, n) => {
    if (n === 1)
      return {
        status: 400,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'outbound_payment_quote_required',
            message:
              'An OutboundPaymentQuote is required for this currency pair',
          },
        },
      }
    if (url.endsWith('/outbound_payment_quotes'))
      return { body: { id: 'opq_9', to_amount: { value: 24_900 } } }
    return { body: { id: 'obp_2', status: 'processing' } }
  })
  const client = new StripeMoneyClient({ secretKey: 'sk', fetchImpl })
  const op = await client.createOutboundPayment(input)
  assert.equal(op.id, 'obp_2')
  assert.equal(calls.length, 3)
  assert.match(calls[1].url, /outbound_payment_quotes$/)
  assert.equal(
    headerOf(calls[1].init, 'Idempotency-Key'),
    'tg-donation-x-onramp-quote',
  )
  const retry = JSON.parse(String(calls[2].init?.body))
  assert.equal(retry.outbound_payment_quote, 'opq_9')
  assert.equal(
    headerOf(calls[2].init, 'Idempotency-Key'),
    'tg-donation-x-onramp-q',
  )
})

test('other errors surface as StripeApiError with code and status', async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 402,
    body: {
      error: { code: 'insufficient_funds', message: 'Not enough USD' },
    },
  }))
  const client = new StripeMoneyClient({ secretKey: 'sk', fetchImpl })
  await assert.rejects(
    client.createOutboundPayment(input),
    (error: unknown) => {
      assert.ok(error instanceof StripeApiError)
      assert.equal(error.status, 402)
      assert.equal(error.code, 'insufficient_funds')
      assert.match(error.message, /Not enough USD/)
      return true
    },
  )
})

test('balances and payout-method wallets are read from whichever shape the API uses', () => {
  const fa = {
    balance: { available: { usd: { value: 12_345, currency: 'usd' } } },
  }
  assert.equal(StripeMoneyClient.availableMinor(fa, 'usd'), 12_345)
  assert.equal(StripeMoneyClient.availableMinor(fa, 'usdc'), 0)
  assert.equal(StripeMoneyClient.availableMinor(null, 'usd'), 0)
  assert.deepEqual(
    StripeMoneyClient.cryptoWalletOf({
      crypto_wallet: { address: '0xabc', network: 'Base' },
    }),
    { address: '0xabc', network: 'base' },
  )
  assert.deepEqual(
    StripeMoneyClient.cryptoWalletOf({
      usd_crypto_wallet: { address: '0xdef' },
    }),
    { address: '0xdef', network: 'base' },
  )
  assert.equal(StripeMoneyClient.cryptoWalletOf({ bank_account: {} }), null)
})

test('financial addresses ask for the account and routing numbers of the configured account', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ body: { data: [] } }))
  const client = new StripeMoneyClient({ secretKey: 'sk', fetchImpl })
  await client.listFinancialAddresses('fa_1')
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v2/money_management/financial_addresses')
  assert.equal(url.searchParams.get('financial_account'), 'fa_1')
  assert.deepEqual(url.searchParams.getAll('include'), [
    'credentials.us_bank_account.account_number',
    'credentials.us_bank_account.routing_number',
  ])
  assert.equal(calls[0].init?.method, 'GET')
  assert.equal(headerOf(calls[0].init, 'Idempotency-Key'), undefined)
})
