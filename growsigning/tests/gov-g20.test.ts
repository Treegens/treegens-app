// gov-G20: the help chat's model on a server that keeps what people type inside its own boundary.
//   1. Under DEPLOYMENT_PROFILE=government or OUTSIDE_CALLS=listed/none the hosted defaults are never used; only
//      SUPPORT_CHAT_API_KEY with SUPPORT_CHAT_BASE_URL counts, at a private address or a name in OUTBOUND_ALLOW.
//   3. The account's switch, enforced for its app pages, its signers and its public forms; an organisation can force it off.
//   4. The chat route keeps nothing but the limit counters (and a chat a person chooses to attach to a help request);
//      the security pages and the DPA template say what model host answers, and that nothing is stored or trained on.
//   5. The model line: which model on which host, only for people signed in to the app.
// The model is a stub. Nothing reaches the network.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, simple, tokenFor, type Server } from './helpers.ts';
import { boundaryRequired, boundaryModel, boundaryChatWarning, isPrivateAddress, plainHttpAllowed, modelLine, hostedKind, CHAT_NOT_TRAINED } from '../src/lib/chatboundary.ts';
import { chatProvider, chatModelOn } from '../src/lib/chatprovider.ts';
import { outsideServices, outsidePolicy, applyOutsideCalls, hostAllowed } from '../src/lib/outside.ts';

let db: Server['db'];
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const ENV = ['DEPLOYMENT_PROFILE', 'OUTSIDE_CALLS', 'OUTBOUND_ALLOW', 'SUPPORT_CHAT_API_KEY', 'SUPPORT_CHAT_BASE_URL', 'SUPPORT_CHAT_MODEL', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'SUPPORT_CHAT_DAILY_LIMIT', 'SUPPORT_CHAT_PROVIDER_NAME'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let modelCalls: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]));
});
/** The process settings: only what is given, for the chat and the boundary. */
function settings(o: Record<string, string>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, o);
  modelCalls = [];
  const enc = new TextEncoder();
  globalThis.fetch = (async (url: any) => {
    modelCalls.push(String(url));
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'From the model.' } }] })}\n\ndata: [DONE]\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
}
const OWN = { SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://10.20.0.5:8000/v1', SUPPORT_CHAT_MODEL: 'qwen3-8b' };

let n = 0;
async function person(first: string) {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@g20.example`;
  const c = await signUp(`${first} Sender`, email, `198.51.120.${k}`);
  return { c, id: (await c.get('/me')).data.account.id as string, email };
}
let askN = 0;
const visitor = () => Object.assign(new Client(), { ip: `198.51.121.${++askN % 250}` });
const ask = (c: Client, extra: any = {}) => c.call('POST', '/public/chat', { messages: [{ role: 'user', content: `How do I send a document? (${++askN})` }], screen: extra.link ? 'signing' : 'help', ...extra });
const isStream = (r: { data: any }) => r.data instanceof Uint8Array && new TextDecoder().decode(r.data).includes('From the model.');

const OP = 'op@g20.example';
before(async () => {
  process.env.OPERATOR_EMAILS = OP;
  ({ db } = await boot());
});

// ---- 1. Hosted defaults never used inside the boundary -------------------------------------------------------------
test('1. government and closed-network servers never use a hosted model; only a model at a private address or in OUTBOUND_ALLOW', () => {
  for (const mode of [{ DEPLOYMENT_PROFILE: 'government' }, { OUTSIDE_CALLS: 'listed' }, { OUTSIDE_CALLS: 'none' }, { OUTSIDE_CALLS: 'typo' }]) {
    const env = (o: Record<string, string>) => ({ ...mode, ...o });
    assert.equal(boundaryRequired(env({})), true, JSON.stringify(mode));
    assert.equal(chatModelOn(env({ OPENROUTER_API_KEY: 'k' })), false);
    assert.equal(chatModelOn(env({ MOONSHOT_API_KEY: 'k' })), false);
    assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k' })), false, 'a key alone is OpenRouter by default');
    assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://openrouter.ai/api/v1', OUTBOUND_ALLOW: 'openrouter.ai' })), false, 'listing a hosted service does not make it one of ours');
    assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://api.moonshot.ai/v1', OUTBOUND_ALLOW: 'api.moonshot.ai' })), false);
    assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1' })), false, 'a public name that is not listed');
    assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1', OUTBOUND_ALLOW: 'llm.agency.example' })), true);
    assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1', OUTBOUND_ALLOW: '*.agency.example' })), true);
    // Private addresses, for this setting only, also over plain http.
    for (const url of ['http://10.20.0.5:8000/v1', 'http://172.16.4.2/v1', 'http://192.168.1.9:11434/v1', 'http://100.64.0.3/v1', 'http://[fd12::5]:8000/v1', 'http://localhost:8080/v1', 'https://10.1.1.1/v1'])
      assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: url })), true, url);
    // Never a link-local address (a cloud's metadata service), and never a public address.
    for (const url of ['http://169.254.169.254/v1', 'http://[fe80::1]/v1', 'http://8.8.8.8/v1', 'https://8.8.8.8/v1', 'http://172.32.0.1/v1', 'http://llm.agency.example/v1'])
      assert.equal(chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: url, OUTBOUND_ALLOW: 'llm.agency.example' })), false, url);
  }
  // The ordinary server is as it was: hosted defaults allowed, plain http only to this machine.
  assert.equal(boundaryRequired({}), false);
  assert.equal(boundaryRequired({ OUTSIDE_CALLS: 'all' }), false);
  assert.equal(chatModelOn({ OPENROUTER_API_KEY: 'k' }), true);
  assert.equal(chatProvider({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://10.20.0.5:8000/v1' }), null);
  assert.equal(plainHttpAllowed('http://10.20.0.5/v1', {}), false);
  // The address helpers.
  for (const h of ['10.0.0.1', '127.0.0.1', '172.31.255.255', '192.168.0.1', 'fd00::1', 'fc00::1', '::1', '[::1]', '::ffff:10.0.0.1', 'localhost']) assert.equal(isPrivateAddress(h), true, h);
  for (const h of ['8.8.8.8', '172.15.0.1', '169.254.169.254', 'fe80::1', '2001:db8::1', '10.0.0.256', 'llm.internal', '']) assert.equal(isPrivateAddress(h), false, h);
});

test('1. the operator hears why, once, when the server starts; the chat says it answers from the built-in help', async () => {
  const gov = { DEPLOYMENT_PROFILE: 'government' };
  const w = (o: Record<string, string>) => boundaryChatWarning(chatProvider(o), o);
  assert.match(w({ ...gov, OPENROUTER_API_KEY: 'k' })!, /^DEPLOYMENT_PROFILE=government: the help chat answers from the built-in help only, because it does not use the hosted AI service set in OPENROUTER_API_KEY/);
  assert.match(w({ OUTSIDE_CALLS: 'none', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1' })!, /^OUTSIDE_CALLS=none: .*neither a private network address nor listed in OUTBOUND_ALLOW\. Add it to OUTBOUND_ALLOW/);
  assert.match(w({ ...gov, SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://openrouter.ai/api/v1' })!, /points at OpenRouter or Moonshot AI/);
  assert.equal(w({ ...gov, ...OWN }), null);
  assert.equal(w({ OPENROUTER_API_KEY: 'k' }), null, 'nothing to say on an ordinary server');
  assert.equal(w({ ...gov }), null, 'nothing set up, nothing to say');
  // Plain http to a name: unusable at all, and said so with what to write instead.
  assert.match(w({ ...gov, SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://llm.internal:8000/v1' })!, /SUPPORT_CHAT_BASE_URL cannot be used: it must start with https:\/\/, or with http:\/\/ only for a private network address/);
  for (const s of [w({ ...gov, OPENROUTER_API_KEY: 'k' })!]) assert.doesNotMatch(s, /\u2014/);
  assert.match(read('src/instrumentation.ts'), /boundaryChatWarning\(chatProvider\(\)\)/);

  // Through the route: a hosted key on a government server gets the built-in answers, and nothing is sent.
  settings({ ...gov, OPENROUTER_API_KEY: 'k' });
  const v = visitor();
  assert.equal((await v.get('/public/chat')).data.ai, false);
  const r = await ask(v);
  assert.deepEqual([r.data.mode, r.data.why], ['builtin', 'off']);
  assert.equal(modelCalls.length, 0);
  // The model of their own answers.
  settings({ ...gov, ...OWN });
  assert.equal((await visitor().get('/public/chat')).data.ai, true);
  assert.ok(isStream(await ask(visitor())));
  assert.deepEqual(modelCalls, ['http://10.20.0.5:8000/v1/chat/completions']);
});

test('1. OUTSIDE_CALLS=none keeps the chat model at a private address, and lets the guard connect to it; only that setting', () => {
  const env: Record<string, string | undefined> = { OUTSIDE_CALLS: 'none', ...OWN };
  const chat = outsideServices(env).find((s) => s.id === 'chat')!;
  assert.deepEqual([chat.on, chat.hosts], [true, ['10.20.0.5']]);
  assert.deepEqual(applyOutsideCalls(env).map((s) => s.id).filter((x) => x === 'chat'), [], 'not switched off');
  assert.equal(env.SUPPORT_CHAT_API_KEY, 'k');
  const p = outsidePolicy(env);
  assert.equal(hostAllowed(p, '10.20.0.5'), true);
  assert.equal(hostAllowed(p, '10.20.0.6'), false, 'only that address, not the whole private network');
  // A public name not listed: the chat is off, so nothing is allowed for it.
  const env2: Record<string, string | undefined> = { OUTSIDE_CALLS: 'none', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1' };
  assert.equal(outsideServices(env2).find((s) => s.id === 'chat')!.on, false);
  assert.equal(hostAllowed(outsidePolicy(env2), 'llm.agency.example'), false);
  // A private address does not open any other service: a converter at a private address is still switched off.
  const env3: Record<string, string | undefined> = { OUTSIDE_CALLS: 'none', CONVERTER_URL: 'http://10.20.0.7:3000' };
  assert.ok(applyOutsideCalls(env3).some((s) => s.id === 'converter'));
});

// ---- 3. The account's switch: its app pages, its signers, its public forms; an organisation can force it off -------
async function send(c: Client, email: string) {
  const e = await simple(c, email, { recipients: [{ id: 'r', role: 'signer', name: `Signer ${email.split('@')[0]}`, email }] });
  assert.equal((await c.post(`/envelopes/${e.id}/send`)).status, 200);
  return tokenFor(e.id, email);
}
const at = () => new Date().toISOString();
function forms(accountId: string, k: string) {
  db.run('INSERT INTO powerforms (id, account_id, template_id, slug, name, created_at) VALUES (?,?,?,?,?,?)', `pf_${k}`, accountId, 'tpl_none', `form-${k}`, 'Intake', at());
  db.run('INSERT INTO clickwraps (id, account_id, slug, name, secret, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', `cw_${k}`, accountId, `terms-${k}`, 'Terms', 's', at(), at());
  return { form: `form-${k}`, terms: `terms-${k}` };
}

test('3. switched off: the account\'s people, its signers and the people on its forms and agreement pages get the built-in answers; Help stays', async () => {
  settings({ DEPLOYMENT_PROFILE: 'government', ...OWN });
  const p = await person('Ada');
  const q = await person('Ben');
  const link = await send(p.c, 's1@g20.example');
  const f = forms(p.id, 'ada');
  const g = forms(q.id, 'ben');
  // On, as every account starts.
  assert.equal((await visitor().get(`/public/chat?form=${f.form}`)).data.ai, true);
  assert.ok(isStream(await ask(visitor(), { form: f.form })));

  assert.equal((await p.c.put('/account/policy', { ai_helper: 'off' })).status, 200);
  modelCalls = [];
  for (const [who, extra] of [[p.c, {}], [visitor(), { link }], [visitor(), { form: f.form }], [visitor(), { form: f.terms }]] as [Client, any][]) {
    const r = await ask(who, extra);
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.mode, r.data.why], ['builtin', 'off'], JSON.stringify(extra));
    assert.ok(r.data.reply.length > 20, 'still an answer');
  }
  assert.equal(modelCalls.length, 0, 'nothing went to the model');
  for (const q of [`?form=${f.form}`, `?form=${f.terms}`, `?link=${link}`]) {
    const d = (await visitor().get(`/public/chat${q}`)).data;
    assert.deepEqual([d.ai, d.provider], [false, null], q);
  }
  assert.equal((await p.c.get('/public/chat')).data.ai, false);
  // Everyone else is as before: another account's forms, a visitor, an unknown slug.
  assert.ok(isStream(await ask(visitor(), { form: g.form })));
  assert.ok(isStream(await ask(visitor(), { form: 'no-such-form' })));
  assert.ok(isStream(await ask(visitor())));
  // A slug of an account with AI on cannot switch it back on for an account that has it off.
  assert.equal((await ask(p.c, { form: g.form })).data.mode, 'builtin');
  // The pages: the form and agreement pages send their slug to /help, the dialog sends it with its question, and the
  // Help entry is never taken away (designer's note gov-G20: "Help removed" is never allowed).
  assert.match(read('src/app/f/[slug]/page.tsx'), /\/help\?topic=signing&form=\$\{encodeURIComponent\(slug\)\}#contact/);
  assert.match(read('src/app/agree/[slug]/page.tsx'), /\/help\?form=\$\{encodeURIComponent\(slug\)\}/);
  const hc = read('src/components/HelpChat.tsx');
  assert.match(hc, /get\('form'\)/);
  assert.match(hc, /\.\.\.\(form \? \{ form \} : \{\}\)/);
  assert.doesNotMatch(read('src/components/AppShell.tsx'), /ai_helper[^\n]*HelpChatButton/);
});

test('3. an organisation above the account forces AI answers off; the agency cannot switch them back on', async () => {
  settings({ DEPLOYMENT_PROFILE: 'government', ...OWN });
  const op = await signUp('Opal Operator', OP, '198.51.122.1');
  const admin = await signUp('Gita Central', 'gita@g20.example', '198.51.122.2');
  const a = await person('Cai');
  const link = await send(a.c, 's2@g20.example');
  const f = forms(a.id, 'cai');
  const org = await op.post('/operator/orgs', { name: 'Government of Example', admin_email: 'gita@g20.example' });
  assert.equal(org.status, 200, JSON.stringify(org.data));
  const id = org.data.org.id;
  assert.equal((await op.put(`/operator/accounts/${a.id}/org`, { org_id: id })).status, 200);
  assert.ok(isStream(await ask(a.c)), 'on until the organisation says otherwise');
  const off = await admin.put(`/orgs/${id}/policy`, { ai_helper: 'off' });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  modelCalls = [];
  for (const [who, extra] of [[a.c, {}], [visitor(), { link }], [visitor(), { form: f.form }]] as [Client, any][])
    assert.deepEqual([(await ask(who, extra)).data.mode], ['builtin']);
  assert.equal(modelCalls.length, 0);
  const back = await a.c.put('/account/policy', { ai_helper: 'on' });
  assert.equal(back.status, 409);
  assert.match(back.data.error, /Government of Example/);
  assert.doesNotMatch(back.data.error, /\u2014/);
});

// ---- 4. Nothing kept but the counts; the pages say what model host answers ----------------------------------------
const tableCounts = () => Object.fromEntries(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((t: any) => [t.name, db.get(`SELECT count(*) n FROM "${t.name}"`).n]));
function holdsText(marker: string): string[] {
  const out: string[] = [];
  for (const t of db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'") as any[]) {
    const cols = db.all(`PRAGMA table_info("${t.name}")`).map((c: any) => c.name);
    for (const c of cols) if (db.get(`SELECT 1 x FROM "${t.name}" WHERE CAST("${c}" AS TEXT) LIKE ? LIMIT 1`, `%${marker}%`)) out.push(`${t.name}.${c}`);
  }
  return out;
}

test('4. the chat route keeps nothing but the limit counts: no other table grows, the question is nowhere, and nothing is logged', async () => {
  settings({ DEPLOYMENT_PROFILE: 'government', ...OWN });
  const p = await person('Dee');
  const link = await send(p.c, 's3@g20.example');
  const said: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) (console as any)[k] = (...a: any[]) => said.push(a.map(String).join(' '));
  const before = tableCounts();
  const marker = 'zq7marker';
  try {
    // A model answer, a built-in answer (model down), a signer's question and a visitor's.
    const q = (c: Client, extra: any = {}) => c.call('POST', '/public/chat', { messages: [{ role: 'user', content: `Where is my ${marker} document? (${++askN})` }], screen: extra.link ? 'signing' : 'app', ...extra });
    assert.ok(isStream(await q(p.c)));
    assert.ok(isStream(await q(visitor(), { link })));
    globalThis.fetch = (async () => new Response('no', { status: 500 })) as any;
    assert.equal((await q(visitor())).data.mode, 'builtin');
    process.env.SUPPORT_CHAT_DAILY_LIMIT = '0';
    assert.equal((await q(visitor())).data.mode, 'builtin');
  } finally {
    Object.assign(console, orig);
  }
  const after = tableCounts();
  const grew = Object.keys(after).filter((t) => after[t] !== before[t]);
  assert.deepEqual(grew.filter((t) => t !== 'chat_counts'), [], `tables that grew: ${grew.join(', ')}`);
  assert.ok(after.chat_counts > before.chat_counts, 'the counts are kept');
  assert.deepEqual(holdsText(marker), [], 'the question is in no table');
  assert.ok(!said.some((l) => l.includes(marker)), 'and in no log line');
  // The counts hold fingerprints, never an internet address, a link or an account id.
  for (const r of db.all('SELECT key FROM chat_counts') as any[]) assert.doesNotMatch(r.key, /198\.51|@|acc_|^[a-z]+:[0-9a-f-]{36}$/);
  // What a person chooses to send to a person is kept, as part of their help request, and only then.
  const sent = await visitor().post('/public/support', { name: 'Dee Visitor', email: 'dee.visitor@g20.example', topic: 'other', message: 'Please help me find my document.', chat: [{ from: 'you', text: `Where is my ${marker} document?` }] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(holdsText(marker).includes('support_requests.chat'), holdsText(marker).join(', '));
});

test('4. /security and /security/processing name the model and host; "nothing is sent to train a model" only for a model inside the network', async () => {
  const { dataPlace } = await import('../src/lib/dataplace.ts');
  const { chatPrivacyPoint } = await import('../src/lib/chatprovider.ts');
  const gov = { DEPLOYMENT_PROFILE: 'government', ...OWN, SUPPORT_CHAT_DAILY_LIMIT: '50' };
  const point = chatPrivacyPoint(gov);
  // A model at a private address: said as inside this server's network, not as an outside service of unknown country.
  assert.equal(point.title, "What you type into the help chat stays inside this server's network.");
  assert.match(point.text, /^It goes to the model qwen3-8b that the people who run this server run themselves, at 10\.20\.0\.5:8000\./);
  assert.ok(point.text.endsWith(CHAT_NOT_TRAINED));
  assert.equal(CHAT_NOT_TRAINED, "Nothing is sent to train a model. What the model's own program logs is set by the people who run it.");
  assert.doesNotMatch(point.text, /own terms|The service at|Ask them/, 'a model of their own has no terms of a provider');
  const chat = dataPlace(gov).processors.find((x: any) => x.id === 'chat')!;
  assert.equal(chat.country, 'Same network as this server');
  assert.deepEqual(chat.missing, [], 'no "Ask them" line for a model in their own network');
  assert.match(chat.purpose, /the AI model qwen3-8b, which runs inside this server's own network at 10\.20\.0\.5:8000\)\. This server stores nothing typed into the help chat, and sends nothing to train a model\./);
  assert.ok(dataPlace(gov).unstated.every((u) => !/help chat/.test(u)));
  // A hosted provider on an ordinary server: this server stores nothing, and the provider's own terms decide keeping
  // and training. Never "nothing is sent to train a model" there.
  const hosted = chatPrivacyPoint({ OPENROUTER_API_KEY: 'k' });
  assert.match(hosted.text, /^It goes to OpenRouter, which is listed under "Where your data is" below\. Answers come from moonshotai\/kimi-k3 on openrouter\.ai\./);
  assert.match(hosted.text, /What OpenRouter keeps of what is typed, and whether it trains on it, is set by its own terms\.$/);
  for (const env of [{ OPENROUTER_API_KEY: 'k' }, { MOONSHOT_API_KEY: 'k' }, { SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.example.org/v1' }]) {
    const t = chatPrivacyPoint(env).text, row = dataPlace(env).processors.find((x: any) => x.id === 'chat')!;
    assert.doesNotMatch(t, /train a model/, JSON.stringify(env));
    assert.doesNotMatch(row.purpose, /train a model/, JSON.stringify(env));
    assert.match(row.purpose, /whether it trains on it, is set by its own terms/);
    assert.match(row.name!, /^[A-Z]/, 'a table cell starts with a capital');
  }
  // A plain service someone else runs: lower case in the middle of the sentence, never "goes to The service".
  assert.match(chatPrivacyPoint({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.example.org/v1' }).text, /^It goes to the service at llm\.example\.org, /);
  // Without a model of its own, a government server says why it answers from the built-in help.
  assert.match(chatPrivacyPoint({ DEPLOYMENT_PROFILE: 'government', OPENROUTER_API_KEY: 'k' }).text, /^This server keeps the help chat inside its own network, and no AI model of its own is set up for it, so nothing typed into it leaves the server\./);
  // The pages use these, and the DPA template carries the same clause.
  const sec = read('src/app/security/page.tsx'), proc = read('src/app/security/processing/page.tsx');
  assert.match(sec, /chatPrivacyPoint\(\)/);
  assert.match(proc, /<b>The help chat:<\/b> \{CHAT_KEPT_PAGE\}/);
  assert.match(proc, /chatAt\.inside \? CHAT_NOT_TRAINED : chatTermsLine\(chatAt\.name/);
  assert.match(proc, /modelLine\(chatAt\)/);
  const dpa = read('docs/procurement/data-processing-terms-template.md');
  assert.ok(dpa.includes('The help chat: the software stores nothing typed into it.'));
  assert.ok(dpa.replace(/\s+/g, ' ').includes('[Where the model runs inside the operator\'s own network: nothing typed into it is sent to train a model.]'));
  assert.doesNotMatch(dpa, /The help chat: nothing typed into it is stored, and nothing is sent to train a model\./, 'no unconditional promise');
  for (const t of [point.text, hosted.text, chat.purpose, dpa, read('docs/self-hosted-model.md')]) assert.doesNotMatch(t, /\u2014/);
  // No certification is claimed by any of it.
  assert.doesNotMatch(read('docs/self-hosted-model.md'), /certified|compliant|accredited/i);
});

// ---- 5. The model line ----------------------------------------------------------------------------------------------
test('5. the model line: which model on which host, for people signed in to the app only; never on a signing page or a form', async () => {
  settings({ DEPLOYMENT_PROFILE: 'government', ...OWN });
  assert.equal(modelLine({ model: 'qwen3-8b', host: '10.20.0.5:8000' }), 'Answers come from qwen3-8b on 10.20.0.5:8000.');
  const p = await person('Eve');
  const link = await send(p.c, 's4@g20.example');
  const f = forms(p.id, 'eve');
  assert.equal((await p.c.get('/public/chat')).data.model_line, 'Answers come from qwen3-8b on 10.20.0.5:8000.');
  assert.equal((await visitor().get('/public/chat')).data.model_line, null, 'a visitor');
  assert.equal((await visitor().get(`/public/chat?link=${link}`)).data.model_line, null, 'a signer');
  assert.equal((await p.c.get(`/public/chat?link=${link}`)).data.model_line, null, 'a signer who is signed in too');
  assert.equal((await visitor().get(`/public/chat?form=${f.form}`)).data.model_line, null, 'a form');
  // Off, or no model: no line.
  assert.equal((await p.c.put('/account/policy', { ai_helper: 'off' })).status, 200);
  assert.equal((await p.c.get('/public/chat')).data.model_line, null);
  settings({ DEPLOYMENT_PROFILE: 'government', OPENROUTER_API_KEY: 'k' });
  const q = await person('Fin');
  assert.equal((await q.c.get('/public/chat')).data.model_line, null);
  // The dialog shows it at its foot on the app's own screens only.
  assert.match(read('src/components/HelpChat.tsx'), /status\?\.ai && status\.model_line && \(screen === 'app' \|\| screen === 'editor' \|\| screen === 'plan'\)/);
});

// ---- Repair (skeptic and simplicity review) ------------------------------------------------------------------------
test('repair: the hosted defaults are refused however they are spelled (trailing dot, port, a name under them, .cn)', () => {
  for (const mode of [{ DEPLOYMENT_PROFILE: 'government' }, { OUTSIDE_CALLS: 'listed' }]) {
    for (const [url, allow] of [
      ['https://openrouter.ai./api/v1', 'openrouter.ai'], ['https://openrouter.ai:8443/api/v1', 'openrouter.ai'], ['https://OpenRouter.AI/api/v1', 'openrouter.ai'],
      ['https://eu.openrouter.ai/api/v1', '*.openrouter.ai'], ['https://api.moonshot.cn/v1', 'api.moonshot.cn'], ['https://api.moonshot.ai./v1', 'api.moonshot.ai'],
      ['https://x.moonshot.ai:444/v1', '*.moonshot.ai'],
    ]) {
      const env = { ...mode, SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: url, OUTBOUND_ALLOW: allow };
      assert.equal(chatModelOn(env), false, url);
      assert.notEqual(chatProvider(env)!.style, 'plain', url);
      assert.match(boundaryChatWarning(chatProvider(env), env)!, /points at OpenRouter or Moonshot AI/, url);
    }
  }
  assert.equal(hostedKind('openrouter.ai.'), 'openrouter');
  assert.equal(hostedKind('api.moonshot.cn'), 'moonshot');
  assert.equal(hostedKind('notopenrouter.ai'), null, 'a name that only ends in the same letters is not it');
  assert.equal(hostedKind('openrouter.ai.agency.example'), null);
  // A look-alike name the operator runs and lists still counts.
  assert.equal(chatModelOn({ DEPLOYMENT_PROFILE: 'government', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://notopenrouter.ai/v1', OUTBOUND_ALLOW: 'notopenrouter.ai' }), true);
  // The name the pages print for the trailing-dot spelling is OpenRouter's, with its terms, on an ordinary server.
  assert.equal(chatProvider({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://openrouter.ai./api/v1' })!.name, 'OpenRouter');
});

test('repair: cloud metadata addresses inside the private ranges never count as a model', () => {
  for (const h of ['fd00:ec2::254', '[fd00:ec2::254]', 'fd00:0ec2::23', '100.100.100.200', '::ffff:100.100.100.200', '::ffff:169.254.169.254'])
    assert.equal(isPrivateAddress(h), false, h);
  for (const url of ['http://[fd00:ec2::254]/v1', 'http://100.100.100.200/v1', 'https://100.100.100.200/v1'])
    assert.equal(chatModelOn({ DEPLOYMENT_PROFILE: 'government', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: url }), false, url);
  // Their neighbours are still private networks.
  for (const h of ['fd00:ec3::1', '100.100.100.201', '100.64.0.1']) assert.equal(isPrivateAddress(h), true, h);
  const doc = read('docs/self-hosted-model.md');
  assert.match(doc, /fd00:ec2::\/32/);
  assert.match(doc, /100\.100\.100\.200/);
});

test('repair: the model\'s address and name go only to people signed in to the app, never to a signer or a visitor', async () => {
  settings({ DEPLOYMENT_PROFILE: 'government', ...OWN });
  const p = await person('Gil');
  const link = await send(p.c, 's9@g20.example');
  const f = forms(p.id, 'gil');
  const me = (await p.c.get('/public/chat')).data;
  assert.equal(me.ai, true);
  assert.equal(me.provider, "the model that runs inside this server's own network");
  for (const [who, q] of [[visitor(), ''], [visitor(), `?link=${link}`], [p.c, `?link=${link}`], [visitor(), `?form=${f.form}`]] as [Client, string][]) {
    const d = (await who.get(`/public/chat${q}`)).data;
    assert.equal(d.ai, true, q);
    assert.deepEqual([d.provider, d.model_line], [null, null], q || 'a visitor');
    assert.doesNotMatch(JSON.stringify(d), /10\.20\.0\.5|qwen3/, q || 'a visitor');
  }
});

test('repair: /help promises no AI helper, so it is true for a visitor whose account switched AI off', () => {
  const page = read('src/app/help/page.tsx');
  assert.match(page, /You do not need an account to get help\. Answers come at once/);
  assert.doesNotMatch(page, /An AI helper' :/);
});

test('repair: the Settings line for a model inside the network says so, once, without a country question', async () => {
  const { whereLine } = await import('../src/lib/aiassist.ts');
  const p = chatProvider({ DEPLOYMENT_PROFILE: 'government', ...OWN })!;
  assert.equal(p.inside, true);
  assert.equal(whereLine(p), "The text goes to the model qwen3-8b, which runs inside this server's own network (10.20.0.5:8000).");
  assert.equal(chatProvider({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.example.org/v1' })!.inside, false);
  assert.equal(chatProvider({ DEPLOYMENT_PROFILE: 'government', SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1', OUTBOUND_ALLOW: 'llm.agency.example' })!.inside, false, 'a listed name is not proven to be inside');
});
