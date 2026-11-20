// A small stand-in for the payment provider's API, shared by the billing tests. It keeps subscriptions, invoices,
// charges, cards and refunds in memory, honours idempotency keys on refunds, and can be told to fail chosen calls,
// which is how the tests replay the things that go wrong in real life.
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_PRICE_GROVE = 'price_grove';

export const unix = (days: number) => Math.floor(Date.now() / 1000) + days * 86400;

type Call = [method: string, path: string, params: Record<string, string>, key: string | null];

export const stripe = {
  calls: [] as Call[],
  subs: {} as Record<string, any>,
  invoices: {} as Record<string, any>,
  sessions: {} as Record<string, any>,
  charges: [] as any[],
  cards: [{ id: 'pm_1', card: { last4: '4242' } }] as any[],
  refunds: [] as { id: string; params: Record<string, string>; key: string | null }[],
  disputesClosed: [] as string[],
  // Each entry makes matching calls fail: `times` of them, then it removes itself.
  failing: [] as { method: string; path: RegExp; times: number; message?: string }[],
  // Slows every call down a little, so two requests really do overlap.
  delayMs: 0,
  sub(id: string) {
    return (this.subs[id] ??= { id, status: 'active', cancel_at_period_end: false, current_period_end: unix(20), metadata: {}, latest_invoice: null });
  },
  fail(method: string, path: RegExp, times = 1, message?: string) {
    this.failing.push({ method, path, times, message });
  },
  refunded(target: string) {
    return this.refunds.filter((r) => r.params.charge === target || r.params.payment_intent === target).reduce((n, r) => n + Number(r.params.amount), 0);
  },
};

const json = (out: any, status = 200) => new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'api.stripe.com') return realFetch(url, init);
  const path = u.pathname.replace('/v1/', '');
  const method = init.method || 'GET';
  const params = Object.fromEntries(new URLSearchParams(method === 'GET' ? u.search : String(init.body || '')));
  const key = init.headers?.['idempotency-key'] || null;
  stripe.calls.push([method, path, params, key]);
  if (stripe.delayMs) await new Promise((r) => setTimeout(r, stripe.delayMs));
  const f = stripe.failing.find((x) => x.method === method && x.path.test(path));
  if (f) {
    if (--f.times <= 0) stripe.failing.splice(stripe.failing.indexOf(f), 1);
    return json({ error: { message: f.message || 'The payment provider is having trouble.' } }, 500);
  }
  const part = path.split('/');
  if (path === 'checkout/sessions') return json({ url: `https://pay.example/${params.mode}` });
  if (part[0] === 'checkout') return stripe.sessions[part[2]] ? json(stripe.sessions[part[2]]) : json({ error: { message: 'No such checkout session' } }, 404);
  if (part[0] === 'subscriptions') {
    const s = stripe.sub(part[1]);
    if (method === 'DELETE') {
      if (s.status === 'canceled') return json({ error: { message: `No such subscription: ${part[1]}` } }, 404);
      s.status = 'canceled';
    } else if (method === 'POST' && 'cancel_at_period_end' in params) s.cancel_at_period_end = params.cancel_at_period_end === 'true';
    return json(s);
  }
  if (part[0] === 'invoices') {
    const inv = stripe.invoices[part[1]];
    if (!inv) return json({ error: { message: 'No such invoice' } }, 404);
    if (part[2] === 'void') inv.status = 'void';
    return json(inv);
  }
  if (path === 'charges/search') {
    const q = params.query || '';
    const last4 = /last4:(\d{4})/.exec(q)?.[1];
    const amount = /amount:(\d+)/.exec(q)?.[1];
    return json({ data: stripe.charges.filter((c) => c.last4 === last4 && (!amount || String(c.amount) === amount)) });
  }
  if (path === 'charges') return json({ data: stripe.charges.filter((c) => !params.customer || c.customer === params.customer) });
  if (part[0] === 'charges') return json(stripe.charges.find((c) => c.id === part[1]) || { id: part[1], customer: 'cus_1' });
  if (path === 'refunds') {
    // The same key is the same refund: the provider answers again without paying again.
    const again = key ? stripe.refunds.find((r) => r.key === key) : null;
    if (again) return json({ id: again.id });
    const ch = stripe.charges.find((c) => c.id === params.charge || c.payment_intent === params.payment_intent);
    const target = params.charge || params.payment_intent;
    if (ch && stripe.refunded(target) + Number(params.amount) > ch.amount) return json({ error: { message: 'Refund amount is greater than what is left on the charge.' } }, 400);
    const r = { id: `re_${stripe.refunds.length + 1}`, params, key };
    stripe.refunds.push(r);
    if (ch && stripe.refunded(target) >= ch.amount) ch.refunded = true;
    return json({ id: r.id });
  }
  if (part[0] === 'disputes' && part[2] === 'close') return stripe.disputesClosed.push(part[1]), json({ id: part[1], status: 'lost' });
  if (path === 'payment_methods') return json({ data: stripe.cards });
  if (path.endsWith('/detach')) return (stripe.cards = stripe.cards.filter((c) => !path.includes(c.id))), json({});
  if (path === 'billing_portal/sessions') return json({ url: 'https://pay.example/portal' });
  return json({});
}) as any;
