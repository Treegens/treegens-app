import assert from 'node:assert/strict'
import test from 'node:test'
import { MercuryApiError, MercuryClient } from './mercuryClient'

type Call = { url: string; init?: RequestInit }

function fakeFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status?: number; body?: unknown },
) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const r = handler(url, init)
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetchImpl }
}

const headerOf = (init: RequestInit | undefined, name: string) =>
  (init?.headers as Record<string, string>)[name]

test('listTransactions builds the query and sends the bearer token', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    body: { total: 1, transactions: [{ id: 't1', amount: 5, status: 'sent' }] },
  }))
  const client = new MercuryClient({
    apiBase: 'https://api.mercury.com/api/v1/',
    token: 'secret-token',
    fetchImpl,
  })
  assert.equal(client.configured, true)
  const r = await client.listTransactions('acct_1', {
    start: '2026-09-18',
    status: 'sent',
    limit: 9999,
  })
  assert.equal(r.transactions[0].id, 't1')
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/v1/account/acct_1/transactions')
  assert.equal(url.searchParams.get('limit'), '500')
  assert.equal(url.searchParams.get('offset'), '0')
  assert.equal(url.searchParams.get('start'), '2026-09-18')
  assert.equal(url.searchParams.get('status'), 'sent')
  assert.equal(headerOf(calls[0].init, 'Authorization'), 'Bearer secret-token')
  assert.equal(calls[0].init?.method, 'GET')
})

test('listAllTransactions pages until a short page', async () => {
  const page = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${from + i}`,
      amount: 1,
      status: 'sent',
    }))
  const { calls, fetchImpl } = fakeFetch(url => {
    const offset = Number(new URL(url).searchParams.get('offset'))
    return {
      body: {
        total: 502,
        transactions: offset === 0 ? page(500, 0) : page(2, 500),
      },
    }
  })
  const client = new MercuryClient({
    apiBase: 'https://api.mercury.com/api/v1',
    token: 't',
    fetchImpl,
  })
  const rows = await client.listAllTransactions('acct_1', { status: 'sent' })
  assert.equal(rows.length, 502)
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1].url).searchParams.get('offset'), '500')
})

test('sendMoney posts an ACH to the recipient with the idempotency key, direct or for approval', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    body: { id: 'pay_1', status: 'pending', amount: -250 },
  }))
  const client = new MercuryClient({
    apiBase: 'https://api.mercury.com/api/v1',
    token: 't',
    fetchImpl,
  })
  const tx = await client.sendMoney('acct_1', {
    recipientId: 'recp_stripe',
    amount: 250,
    idempotencyKey: 'tg-sweep-abc',
    note: 'Treegens donations',
  })
  assert.equal(tx.id, 'pay_1')
  assert.equal(
    new URL(calls[0].url).pathname,
    '/api/v1/account/acct_1/transactions',
  )
  assert.equal(calls[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    paymentMethod: 'ach',
    recipientId: 'recp_stripe',
    amount: 250,
    idempotencyKey: 'tg-sweep-abc',
    note: 'Treegens donations',
  })
  assert.equal(headerOf(calls[0].init, 'Content-Type'), 'application/json')

  await client.sendMoney(
    'acct_1',
    { recipientId: 'r', amount: 1, idempotencyKey: 'k' },
    'request',
  )
  assert.equal(
    new URL(calls[1].url).pathname,
    '/api/v1/account/acct_1/request-send-money',
  )
})

test('errors carry the status and Mercury message, never the token', async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 400,
    body: { errors: { message: 'Duplicate payment within 24 hours' } },
  }))
  const client = new MercuryClient({
    apiBase: 'https://api.mercury.com/api/v1',
    token: 'super-secret',
    fetchImpl,
  })
  await assert.rejects(
    client.getTransaction('acct_1', 'pay_1'),
    (error: unknown) => {
      assert.ok(error instanceof MercuryApiError)
      assert.equal(error.status, 400)
      assert.match(error.message, /Duplicate payment within 24 hours/)
      assert.doesNotMatch(error.message, /super-secret/)
      return true
    },
  )
})

test('an unconfigured client says so', () => {
  const client = new MercuryClient({ apiBase: 'https://x', token: '' })
  assert.equal(client.configured, false)
})
