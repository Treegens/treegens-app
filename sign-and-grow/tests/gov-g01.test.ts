// gov-G01: the honesty guard and the account's switches.
//   1. The registry of certifications (src/lib/claims.ts): everything starts as not held, and an entry reads as held
//      only with a registry link, a number, a scope and dates that have not run out.
//   2. /security/certifications is built from the registry alone, and /security quotes it.
//   3. The scan: no page, email, PDF text, README or doc names a certification or uses a risky word unless the
//      sentence is on the reviewed list (tests/claims-allow.json) and agrees with the registry.
//   4. The account's switches (src/server/tenantpolicy.ts), their defaults under both profiles, who may change them.
//   5. The signing record carries no trees for a government installation, and one made before is never rebuilt.
//   6. What the switches do: no tree lines on screens and in emails, and no question to the AI model.
// The payment provider is the stand-in of the billing tests; the AI model is a stub. Nothing reaches the network.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, Client, signUp, mailTo, simple, signAll, tokenFor, type Server } from './helpers.ts';
import { stripe, unix } from './stripe-fake.ts';
import { CLAIMS, CLAIM_GROUPS, claimText, claimStatus, claimSentence, claimProblems, claimsSummary, noneHeld, claimById, type Claim } from '../src/lib/claims.ts';
import { scan, scanText, withoutComments, ALL_PATTERNS, type Hit } from './claims-scan.ts';
import { deploymentProfile, deploymentProfileWarning, isGovernment } from '../src/lib/deployment.ts';

let db: Server['db'];
let billing: Server['billing'];
let policy: typeof import('../src/server/tenantpolicy.ts');
let prov: typeof import('../src/lib/chatprovider.ts');

const root = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

const ENV = ['DEPLOYMENT_PROFILE', 'SUPPORT_CHAT_API_KEY', 'SUPPORT_CHAT_BASE_URL', 'SUPPORT_CHAT_MODEL', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'SUPPORT_CHAT_DAILY_LIMIT', 'SUPPORT_CHAT_PROVIDER_NAME'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let modelCalls: any[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k]));
});
const government = () => void (process.env.DEPLOYMENT_PROFILE = 'government');
const noModel = () => {
  for (const k of ENV.slice(1)) delete process.env[k];
};
/** A model answers the chat: the operator's own, or a hosted one. Every call to it is kept in modelCalls. */
function model(kind: 'own' | 'openrouter' | 'moonshot') {
  noModel();
  if (kind === 'own') Object.assign(process.env, { SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1', SUPPORT_CHAT_MODEL: 'local-1', SUPPORT_CHAT_PROVIDER_NAME: 'The agency model' });
  if (kind === 'openrouter') process.env.OPENROUTER_API_KEY = 'k';
  if (kind === 'moonshot') process.env.MOONSHOT_API_KEY = 'k';
  modelCalls = [];
  const enc = new TextEncoder();
  globalThis.fetch = (async (url: any, init: any = {}) => {
    modelCalls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'From the model.' } }] })}\n\ndata: [DONE]\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
}

let evn = 0;
const event = (type: string, object: any) => billing.applyStripeEvent({ id: `evg_${++evn}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
type Person = { c: Client; id: string; email: string; cus: string; sub: string; k: number };
let n = 0;
async function person(first: string): Promise<Person> {
  const k = ++n;
  const email = `${first.toLowerCase()}${k}@g01.example`;
  const c = await signUp(`${first} Sender`, email, `198.51.90.${k}`);
  return { c, id: (await c.get('/me')).data.account.id, email, cus: `cusg_${k}`, sub: `subg_${k}`, k };
}
// A month of the plan, paid, so that its signatures are paid for and plant trees (as tests/impact.test.ts does).
async function subscribe(p: Person, days = 20) {
  const inv = `ing_${p.k}_1`;
  Object.assign(stripe.sub(p.sub), { customer: p.cus, status: 'active', metadata: { sg_account: p.id }, current_period_end: unix(days) });
  const o = {
    id: inv, customer: p.cus, subscription: p.sub, amount_paid: 900, currency: 'usd', status: 'paid', billing_reason: 'subscription_create', hosted_invoice_url: `https://pay.example/${inv}`,
    lines: { data: [{ period: { start: unix(0), end: unix(days) }, metadata: { sg_account: p.id }, price: { id: 'price_grove' } }] },
  };
  stripe.invoices[inv] = o;
  stripe.charges.unshift({ id: `ch_${inv}`, paid: true, refunded: false, amount: 900, currency: 'usd', customer: p.cus, invoice: inv, last4: '4242', created: unix(0) });
  await event('checkout.session.completed', { id: `csg_${p.k}`, mode: 'subscription', client_reference_id: p.id, customer: p.cus, subscription: p.sub, payment_status: 'paid' });
  await event('invoice.paid', o);
}
async function send(p: Person, email: string) {
  const e = await simple(p.c, email, { recipients: [{ id: 'r', role: 'signer', name: `Signer ${email.split('@')[0]}`, email }] });
  const r = await p.c.post(`/envelopes/${e.id}/send`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return e.id as string;
}
const sees = async (eid: string, email: string) => (await new Client().get(`/sign/${tokenFor(eid, email)}/impact`)).data;
async function pdfText(pdf: Uint8Array): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  try {
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push(...(await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str));
    return out.join('\n');
  } finally {
    await doc.destroy().catch(() => {});
  }
}
const download = async (p: Person, eid: string) => (await p.c.get(`/envelopes/${eid}/download`)).data as Uint8Array;
const TREE_WORDS = /Signed without paper|mangrove|sheets? of paper|Treegens|litres of water|CO2e/i;
let askN = 0;
const ask = (c: Client, extra: any = {}) => c.call('POST', '/public/chat', { messages: [{ role: 'user', content: `How do I send a document? (${++askN})` }], screen: extra.link ? 'signing' : 'help', ...extra });
const isStream = (r: { data: any }) => r.data instanceof Uint8Array && new TextDecoder().decode(r.data).includes('From the model.');
const history = (accountId: string) => db.all("SELECT details FROM security_events WHERE account_id=? AND kind='settings.changed' ORDER BY rowid", accountId).map((l: any) => JSON.parse(l.details).settings);

before(async () => {
  ({ db, billing } = await boot());
  policy = await import('../src/server/tenantpolicy.ts');
  prov = await import('../src/lib/chatprovider.ts');
});

// ---- 1. The registry ----------------------------------------------------------------------------------------------

test('the registry: every name a public buyer asks about is there once, and every one starts as not held', () => {
  const ids = CLAIMS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'no id twice');
  for (const name of ['ISO/IEC 27001', 'ISO/IEC 27017', 'ISO/IEC 27018', 'ISO/IEC 27701', 'SOC 2 Type II', 'FedRAMP Moderate', 'FedRAMP High', 'DoD Impact Level 4', 'DoD Impact Level 5', 'GovRAMP', 'BSI C5', 'ENS', 'ACN', 'SecNumCloud', 'ISMAP', 'CSAP', 'IRAP', 'CCCS', 'Cyber Essentials Plus', 'G-Cloud', 'eIDAS qualified trust service provider', 'Qualified electronic seal', 'QES', 'FIPS 140-3', 'WCAG 2.2 AA', 'EN 301 549', 'Section 508', 'HIPAA', 'Digital Public Goods', 'CCA', 'ICP-Brasil'])
    assert.ok(CLAIMS.some((c) => c.name.includes(name)), `${name} is in the registry`);
  for (const c of CLAIMS) {
    assert.equal(c.status, 'not_held', `${c.id} is not held: only the owner sets one to held, with the registry link opened`);
    assert.equal(c.held, undefined);
    assert.equal(c.engaged, undefined);
    assert.equal(claimStatus(c), 'not_held');
    assert.deepEqual(claimProblems(c), []);
    const s = claimSentence(c);
    assert.equal(s, c.no);
    assert.match(s, /\b(not|no|No|Nobody)\b/, `${c.id}: the sentence says it is not held: "${s}"`);
    assert.match(s, /\.$/);
    assert.doesNotMatch(`${s} ${c.what} ${c.name}`, /—/, 'no em dash');
    assert.doesNotMatch(s, /\b(yet|soon|working towards|in progress|planned|roadmap)\b/i, `${c.id}: nothing is hinted at`);
    assert.ok(CLAIM_GROUPS.some(([g]) => g === c.group));
    assert.ok(c.what.length > 20 && !/GrowSigning|\bwe\b|\bour\b/i.test(c.what), `${c.id}: "what" explains the thing and says nothing about us`);
  }
  assert.equal(claimText('iso-27001'), 'GrowSigning does not hold an ISO/IEC 27001 certificate.');
  assert.equal(claimText('qes'), 'GrowSigning does not make qualified electronic signatures, and does not make advanced ones. It makes simple electronic signatures.');
  assert.throws(() => claimText('iso-9001'), /no claim "iso-9001"/);
  assert.ok(noneHeld());
  assert.match(claimsSummary(), /^GrowSigning holds none of the \d+ certifications/);
  assert.ok(claimsSummary().includes(claimText('iso-27001')) && claimsSummary().includes(claimText('soc2-type2')), 'the summary quotes the registry');
  // The rule is written at the top of the file, where whoever changes a status reads it first.
  const head = read('src/lib/claims.ts').slice(0, 2200);
  assert.match(head, /Only the owner may set an entry to 'held'/);
  assert.match(head, /No entry is 'in_progress' unless the owner has signed an engagement/);
});

test('held means: a registry link, a number, a scope, dates that have not run out, and who checked. Anything less reads as not held', () => {
  const base = claimById('iso-27001');
  const now = new Date('2027-03-10T12:00:00Z');
  const full = { registry_url: 'https://registry.example.org/cert/IS-123', number: 'IS 123456', scope: 'the hosted service at growsigning.com', issued: '2027-01-15', expires: '2030-01-14', checked_by: 'The owner', checked_on: '2027-01-20' };
  const held = (over: Partial<typeof full> = {}, status: Claim['status'] = 'held'): Claim => ({ ...base, status, held: { ...full, ...over } });

  assert.equal(claimStatus(held(), now), 'held');
  const s = claimSentence(held(), now);
  assert.equal(s, 'GrowSigning holds an ISO/IEC 27001 certificate: number IS 123456, for the hosted service at growsigning.com, issued 2027-01-15 and running until 2030-01-14. Check it yourself at https://registry.example.org/cert/IS-123');
  // On its last day it is held; the day after it reads as not held, with the plain sentence.
  assert.equal(claimStatus(held(), new Date('2030-01-14T23:59:00Z')), 'held');
  assert.equal(claimStatus(held(), new Date('2030-01-15T00:00:01Z')), 'not_held');
  assert.equal(claimSentence(held(), new Date('2030-01-15T00:00:01Z')), base.no);
  assert.match(claimProblems(held(), new Date('2031-01-01T00:00:00Z')).join(' '), /It expired on 2030-01-14\./);

  for (const [over, why] of [
    [{ registry_url: '' }, 'no link'], [{ registry_url: 'http://registry.example.org/x' }, 'not https'], [{ registry_url: 'see our website' }, 'not a link'],
    [{ number: ' ' }, 'no number'], [{ scope: '' }, 'no scope'], [{ issued: '15 January 2027' }, 'a date that cannot be read'], [{ issued: '2027-02-30' }, 'a day that does not exist'],
    [{ expires: '' }, 'no expiry'], [{ expires: '2026-12-31' }, 'expires before it was issued'], [{ issued: '2027-06-01' }, 'issued in the future'],
    [{ checked_by: '' }, 'nobody checked'], [{ checked_on: '' }, 'no day of checking'], [{ checked_on: '2027-12-01' }, 'checked in the future'],
  ] as [Partial<typeof full>, string][]) {
    assert.equal(claimStatus(held(over), now), 'not_held', why);
    assert.equal(claimSentence(held(over), now), base.no, why);
    assert.ok(claimProblems(held(over), now).length > 0, why);
  }
  assert.equal(claimStatus({ ...base, status: 'held' }, now), 'not_held', 'held with nothing written down');
  // The summary and the page count only what reads as held.
  const list = CLAIMS.map((c) => (c.id === 'iso-27001' ? held() : c));
  assert.equal(noneHeld(now, list), false);
  assert.match(claimsSummary(now, list), /GrowSigning holds 1: ISO\/IEC 27001\. It holds none of the others\./);
  assert.ok(noneHeld(new Date('2031-01-01T00:00:00Z'), list), 'and none again once it has run out');

  // In progress: only with the assessor and the day the engagement was signed. The sentence still says not held.
  const engaged: Claim = { ...base, status: 'in_progress', engaged: { assessor: 'Example Audit Ltd', engaged_on: '2027-02-01' } };
  assert.equal(claimStatus(engaged, now), 'in_progress');
  assert.equal(claimSentence(engaged, now), `${base.no} Example Audit Ltd was engaged on 2027-02-01 to assess it. Until that is done, it is not held.`);
  assert.equal(claimStatus({ ...base, status: 'in_progress' }, now), 'not_held', '"we plan to" is not in progress');
  assert.equal(claimStatus({ ...engaged, engaged: { assessor: '', engaged_on: '2027-02-01' } }, now), 'not_held');
  assert.equal(claimStatus({ ...engaged, engaged: { assessor: 'Example Audit Ltd', engaged_on: '2027-09-01' } }, now), 'not_held', 'an engagement dated in the future');
});

// ---- 2. The pages ---------------------------------------------------------------------------------------------------

test('/security/certifications is built from the registry alone, and /security and the footer lead to it', () => {
  const page = read('src/app/security/certifications/page.tsx');
  assert.match(page, /from '@\/lib\/claims'/);
  assert.match(page, /claimSentence\(c, now\)/, 'each line is the registry\'s own sentence');
  assert.match(page, /export const dynamic = 'force-dynamic'/, 'worked out on every visit, so an expired entry stops reading as held');
  // No sentence of its own about any certification: the scan finds no name and no risky word in the page's text.
  assert.deepEqual(scanText('src/app/security/certifications/page.tsx', page), []);
  assert.doesNotMatch(page, /<img|badge|logo/i, 'no badges');
  const sec = read('src/app/security/page.tsx');
  assert.match(sec, /<Point title="No security certification\.">We have not been audited against a security standard, and we will not hint that we have\. \{claimsSummary\(\)\} <Link href=\{CLAIMS_PAGE\}>/);
  assert.match(read('src/components/Public.tsx'), /<Link href="\/security\/certifications">Certifications<\/Link>/);
});

// ---- 3. The scan ----------------------------------------------------------------------------------------------------

test('the scan reads what people read: comments are left out, and colours, sizes and identifiers are not hits', () => {
  const src = ['// We are SOC 2 compliant and ISO 27001 certified.', 'const a = 1; // FedRAMP', '/* HIPAA', ' eIDAS */ const url = "https://example.org/x"; const c = "#c5c508";', '{/* QES */}<p>Hello</p>'].join('\n');
  assert.deepEqual(scanText('x.tsx', src), []);
  assert.equal(withoutComments(src).split('\n').length, 5, 'line numbers are kept');
  assert.match(withoutComments(src), /https:\/\/example\.org\/x/, 'the // of a web address is not a comment');
  for (const fine of ['color: #c5c508; width: 508px;', 'const isCertified = certifiedCopy(c5, il4);', 'padding: 508 0 5', 'a qualified lawyer', 'an advanced setting', 'the FIPSA team', 'Use section 5.0.8', 'our socks, 2 pairs', 'the ensemble', 'gave an accreditedBy value'])
    assert.deepEqual(scanText('x.tsx', `const s = '${fine}';`), [], fine);
  const found = (line: string) => scanText('x.md', line).map((h) => h.key);
  assert.deepEqual(found('We are SOC 2 compliant.'), ['SOC 2', 'compliant']);
  assert.deepEqual(found('ISO 27001 certified hosting'), ['ISO 27xxx', 'certified']);
  assert.deepEqual(found('ISO/IEC 27701'), ['ISO 27xxx']);
  assert.deepEqual(found('FedRAMP Moderate, Fed-RAMP, StateRAMP'), ['FedRAMP', 'GovRAMP']);
  assert.deepEqual(found('a BSI C5 attestation'), ['BSI C5']);
  assert.deepEqual(found('Section 508 and our VPAT'), ['Section 508', 'VPAT']);
  assert.deepEqual(found('508 compliant'), ['Section 508', 'compliant']);
  assert.deepEqual(found('FIPS validated'), ['FIPS']);
  assert.deepEqual(found('eIDAS compliant'), ['eIDAS', 'compliant']);
  assert.deepEqual(found('Legally binding e-signatures'), ['legally binding']);
  assert.deepEqual(found('a qualified electronic signature (QES)'), ['QES', 'qualified electronic signature']);
  assert.deepEqual(found('an Advanced Electronic Signature'), ['advanced electronic signature']);
  assert.deepEqual(found('complies with SecNumCloud, IRAP, ISMAP'), ['SecNumCloud', 'ISMAP', 'IRAP', 'compliant']);
  assert.deepEqual(found('HIPAA ready'), ['HIPAA']);
  assert.deepEqual(found('WCAG 2.2 AA, EN 301 549'), ['WCAG']);
  // A phrase broken over two lines is found on the line it starts on.
  assert.deepEqual(scanText('x.md', 'we make "qualified"\nsignatures here').map((h) => [h.line, h.key]), [[1, 'qualified electronic signature']]);
  // JSX text and strings in code are read.
  assert.deepEqual(scanText('x.tsx', '<p>We are FedRAMP authorized.</p> {/* fine */}').map((h) => h.key), ['FedRAMP']);
  assert.deepEqual(scanText('x.ts', "export const A = 'GrowSigning is ISO 27001 certified.'; // not really").map((h) => h.key), ['ISO 27xxx', 'certified']);
});

test('no page, email, PDF text, README or doc says more about a certification or the law than the registry does', () => {
  const allow: { file: string; has: string; kind: 'denial' | 'explains' | 'not-shown'; claim?: string; why: string }[] = JSON.parse(read('tests/claims-allow.json')).allow;
  for (const a of allow) {
    assert.ok(a.file && a.has && a.has.length >= 12 && a.why && a.why.length >= 10, `an entry of tests/claims-allow.json needs a file, at least 12 characters of the sentence and a reason: ${JSON.stringify(a)}`);
    assert.ok(['denial', 'explains', 'not-shown'].includes(a.kind), `kind of ${JSON.stringify(a)}`);
    if (a.kind === 'denial') assert.ok(a.claim === 'any' || CLAIMS.some((c) => c.id === a.claim), `a denial names the registry entry it denies: ${JSON.stringify(a)}`);
  }
  const hits = scan(root);
  const used = new Set<object>();
  const unlisted: Hit[] = [], wrong: string[] = [];
  for (const h of hits) {
    const on = allow.filter((a) => a.file === h.file && h.text.includes(a.has));
    if (!on.length) unlisted.push(h);
    for (const a of on) {
      used.add(a);
      // A sentence that says we do not have it is true only while the registry says so too.
      if (a.kind === 'denial' && (a.claim === 'any' ? !noneHeld() : claimStatus(claimById(a.claim!)) === 'held'))
        wrong.push(`${h.file}:${h.line} says we do not have "${a.claim}", and src/lib/claims.ts now says it is held. Print claimText() there instead.\n    ${h.text.slice(0, 200)}`);
    }
  }
  // Every hit, with its file and line, for whoever reviews: node --test prints this with the test.
  console.log(`The honesty scan: ${hits.length} places name a certification or use a risky word, in ${new Set(hits.map((h) => h.file)).size} files. Each is on the reviewed list.`);
  for (const h of hits) console.log(`  ${h.file}:${h.line} [${h.key}] ${h.text.slice(0, 110)}`);
  assert.deepEqual(unlisted.map((h) => `${h.file}:${h.line} [${h.key}] ${h.text.slice(0, 240)}`), [],
    'These lines name a certification or use a word such as "certified", "compliant" or "qualified signature", and nobody has reviewed them. If the sentence says we HAVE something, print claimText(id) from src/lib/claims.ts instead. If it says we do not, or explains a law, add it to tests/claims-allow.json with the reason.');
  assert.deepEqual(wrong, []);
  const stale = allow.filter((a) => !used.has(a)).map((a) => `${a.file}: "${a.has}"`);
  assert.deepEqual(stale, [], 'These entries of tests/claims-allow.json match no line any more. Remove them, so the list stays a list of sentences somebody read.');
  // The list never lets a whole file through, and never a sentence that claims.
  for (const a of allow) assert.doesNotMatch(a.has, /^(.{0,11}|GrowSigning is|We are|We hold)$/i);
  // What is scanned includes the places people read.
  const files = new Set(hits.map((h) => h.file));
  for (const f of ['README.md', 'docs/controls.md', 'src/lib/policy.ts']) assert.ok(files.has(f), `${f} is scanned`);
  assert.ok(ALL_PATTERNS.length >= 30);
});

// ---- 4. The switches ----------------------------------------------------------------------------------------------

test('DEPLOYMENT_PROFILE: unset or "government", and a value nobody knows is said out loud', () => {
  assert.equal(deploymentProfile({}), null);
  assert.equal(deploymentProfile({ DEPLOYMENT_PROFILE: ' Government ' }), 'government');
  assert.equal(isGovernment({ DEPLOYMENT_PROFILE: 'government' }), true);
  assert.equal(deploymentProfileWarning({}), null);
  assert.equal(deploymentProfileWarning({ DEPLOYMENT_PROFILE: 'government' }), null);
  for (const typo of ['goverment', 'gov', 'public', 'true']) {
    assert.equal(deploymentProfile({ DEPLOYMENT_PROFILE: typo }), null);
    assert.match(deploymentProfileWarning({ DEPLOYMENT_PROFILE: typo })!, new RegExp(`is set to "${typo}", which is not a profile this server knows\\. The only one is "government"\\.`));
  }
});

test('an account starts with trees and AI answers on; under the government profile with both off, and its record never carries trees', async () => {
  noModel();
  const p = await person('Ada');
  assert.deepEqual(policy.tenantPolicy(p.id), { impact_display: 'on', impact_record: 'on', ai_helper: 'on', white_label: false });
  assert.deepEqual(policy.tenantPolicy('no-such-account'), { impact_display: 'on', impact_record: 'on', ai_helper: 'on', white_label: false });
  // The shape pages get: from /api/me, and from /api/sign/:token for the account whose document it is.
  assert.deepEqual((await p.c.get('/me')).data.policy, { impact_display: 'on', ai_helper: 'on', white_label: false });
  const eid = await send(p, 'shape@signers.example');
  assert.deepEqual((await new Client().get(`/sign/${tokenFor(eid, 'shape@signers.example')}`)).data.policy, { impact_display: 'on', ai_helper: 'on', white_label: false });

  government();
  assert.deepEqual(policy.tenantPolicy(p.id), { impact_display: 'off', impact_record: 'off', ai_helper: 'off', white_label: false }, 'an account that never chose follows the server');
  const g = await person('Gov');
  assert.deepEqual((await g.c.get('/me')).data.policy, { impact_display: 'off', ai_helper: 'off', white_label: false });
  assert.deepEqual((await new Client().get(`/sign/${tokenFor(eid, 'shape@signers.example')}`)).data.policy, { impact_display: 'off', ai_helper: 'off', white_label: false });
  // An admin may put the tree lines on screens back; the record stays without them whatever the account chose.
  const on = await g.c.put('/account/policy', { impact_display: 'on' });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.deepEqual([on.data.impact_display, on.data.impact_record, on.data.record_fixed], ['on', 'off', true]);
  assert.deepEqual((await g.c.get('/account/impact-record')).data, { on: false, fixed: true }, 'the page shows no switch for the record');
  const refused = await g.c.put('/account/impact-record', { on: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, 'This server never puts trees on the signing record, so there is nothing to switch. Nothing was changed.');
  assert.match(read('src/components/settings/TreesOnRecord.tsx'), /if \(!d \|\| d\.fixed\) return null;/);

  delete process.env.DEPLOYMENT_PROFILE;
  assert.equal(policy.tenantPolicy(g.id).impact_display, 'on', 'what an account chose stays chosen');
  assert.equal(policy.tenantPolicy(g.id).ai_helper, 'on', 'what it never chose follows the server again');
});

test('owners and admins change the switches in a browser; a member, an API key and a stranger cannot; every change is in the history', async () => {
  noModel();
  const p = await person('Bea');
  const seen = await p.c.get('/account/policy');
  assert.deepEqual(seen.data, { impact_display: 'on', ai_helper: 'on', white_label: false, impact_record: 'on', record_fixed: false, ai_available: false, ai_provider: null });

  const off = await p.c.put('/account/policy', { impact_display: 'off' });
  assert.equal(off.status, 200);
  assert.equal(off.data.impact_display, 'off');
  assert.deepEqual(history(p.id).at(-1), { trees_on_screens_and_emails: { from: 'on', to: 'off' } });
  // The same again changes nothing and writes nothing.
  const lines = history(p.id).length;
  assert.equal((await p.c.put('/account/policy', { impact_display: 'off' })).status, 200);
  assert.equal(history(p.id).length, lines);
  const en = JSON.parse(read('src/locales/en.json'));
  assert.equal(en['security.setting.trees_on_screens_and_emails'], 'Trees on screens and emails');
  assert.equal(en['security.setting.ai_answers_in_help_chat'], 'AI answers in the help chat');

  // What is refused, in words, with nothing changed.
  for (const [body, re] of [
    [{}, /Send "impact_display" or "ai_helper", each "on" or "off"\. Nothing was changed\./],
    [{ impact_display: true }, /Send "impact_display" as "on" or "off"\. Nothing was changed\./],
    [{ ai_helper: 'yes' }, /Send "ai_helper" as "on" or "off"\. Nothing was changed\./],
    [{ impact_display: 'on', ai_helper: 'maybe' }, /Send "ai_helper" as "on" or "off"/],
    [{ white_label: 1 }, /"white_label" and "impact_record" cannot be changed here\. Nothing was changed\./],
    [{ impact_display: 'on', white_label: true }, /cannot be changed here/],
    [[], /Send a JSON object/],
  ] as [any, RegExp][]) {
    const r = await p.c.put('/account/policy', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  }
  assert.equal(policy.tenantPolicy(p.id).impact_display, 'off', 'a refused request with a good half changed nothing');
  assert.equal(db.get('SELECT white_label w FROM accounts WHERE id=?', p.id).w, 0);
  // No model answers here, so AI answers cannot be switched on (the page shows no switch); off is always possible.
  const none = await p.c.put('/account/policy', { ai_helper: 'on' });
  assert.equal(none.status, 409);
  assert.equal(none.data.error, 'No AI model is set up for the help chat on this server, so there is nothing to switch on. Nothing was changed.');
  assert.equal((await p.c.put('/account/policy', { ai_helper: 'off' })).status, 200);
  assert.deepEqual(history(p.id).at(-1), { ai_answers_in_help_chat: { from: 'on', to: 'off' } });

  // An API key, even one with the admin scope, cannot change them. It can read them.
  const key = (await p.c.post('/api-keys', { name: 'Sync', scope: 'admin' })).data.key;
  const withKey = new Client();
  const viaKey = await withKey.call('PUT', '/account/policy', { impact_display: 'on' }, { authorization: `Bearer ${key}` });
  assert.equal(viaKey.status, 403);
  assert.equal(viaKey.data.error, 'An API key cannot change these settings. That needs an owner or an admin signed in to the app, under Settings, Account. Nothing was changed.');
  assert.equal((await withKey.call('GET', '/account/policy', undefined, { authorization: `Bearer ${key}` })).data.impact_display, 'off');
  // A member of the team, and someone who is not signed in.
  assert.equal((await p.c.post('/account/invites', { email: 'member@g01.example', role: 'member' })).status, 200);
  const m = new Client();
  m.ip = '198.51.91.1';
  const inv = db.get('SELECT token FROM invites WHERE email=? ORDER BY created_at DESC', 'member@g01.example').token;
  assert.equal((await m.post('/auth/signup', { name: 'Mem Ber', email: 'member@g01.example', password: 'correct horse battery', invite: inv })).status, 200);
  assert.equal((await m.put('/account/policy', { impact_display: 'on' })).status, 403);
  assert.equal((await m.get('/account/policy')).status, 403);
  assert.equal((await new Client().put('/account/policy', { impact_display: 'on' })).status, 401);
  assert.equal(policy.tenantPolicy(p.id).impact_display, 'off');
  // Another account is not touched by any of it.
  const q = await person('Cy');
  assert.deepEqual(policy.clientPolicy(q.id), { impact_display: 'on', ai_helper: 'on', white_label: false });
  // A member reads the client shape through /me like everyone, and learns nothing else.
  assert.deepEqual((await m.get('/me')).data.policy, { impact_display: 'off', ai_helper: 'off', white_label: false });
});

// ---- 5 and 6. What the switches do ------------------------------------------------------------------------------------

test('trees on screens and emails, off: nothing by Finish, on the finished screen, in the invitation or the completion email. The count goes on', async () => {
  const p = await person('Dee');
  await subscribe(p);
  const impact = await import('../src/server/impact.ts');
  // On, as every account starts: the signer is told, in the email and by Finish.
  const first = await send(p, 'h1@signers.example');
  assert.equal((await sees(first, 'h1@signers.example')).finish, 10);
  assert.match(textOf(mailTo('h1@signers.example').at(-1)!.html), /10 mangroves will be planted with Treegens when you finish\./);
  assert.equal((await p.c.get(`/envelopes/${first}/impact`)).data.sent.paid, 1);
  assert.equal((await signAll(first, 'h1@signers.example')).status, 200);
  assert.equal((await sees(first, 'h1@signers.example')).done.trees, 10);
  assert.match(textOf(mailTo('h1@signers.example').at(-1)!.html), /sheets? of paper and .* litres of water were not used/);

  assert.equal((await p.c.put('/account/policy', { impact_display: 'off' })).status, 200);
  // The document that is already out says nothing more either: the switch is about what is shown from now on.
  assert.deepEqual(await sees(first, 'h1@signers.example'), { finish: 0, done: null });
  const second = await send(p, 'h2@signers.example');
  assert.deepEqual(await sees(second, 'h2@signers.example'), { finish: 0, done: null });
  assert.doesNotMatch(textOf(mailTo('h2@signers.example').at(-1)!.html), /mangrove|Treegens|planted/i, 'the invitation');
  assert.deepEqual((await p.c.get(`/envelopes/${second}/impact`)).data, { plus: false, sent: null }, 'the sender\'s envelope page');
  const drafted = await simple(p.c, 'h3@signers.example');
  assert.deepEqual((await p.c.get(`/envelopes/${drafted.id}/impact`)).data, { plus: false, sent: null }, 'the review step of a draft');
  assert.equal((await signAll(second, 'h2@signers.example')).status, 200);
  assert.deepEqual(await sees(second, 'h2@signers.example'), { finish: 0, done: null }, 'the finished screen');
  for (const mail of mailTo('h2@signers.example')) assert.doesNotMatch(textOf(mail.html), /mangrove|Treegens|sheets? of paper|litres of water/i, `"${mail.subject}" says nothing about trees or paper`);
  for (const mail of mailTo(p.email).filter((x: any) => /Simple agreement|completed|finished/i.test(x.subject + x.html)).slice(-1)) assert.doesNotMatch(textOf(mail.html), /sheets? of paper|litres of water/i);
  // Hidden is not the same as not counted: both paid signatures are in the account's total.
  assert.equal(impact.treesOfAccount(p.id), 20);
  // The signing record has its own switch ('Trees on the signing record'), and this one does not touch it.
  assert.match(await pdfText(await download(p, second)), /Signed without paper/);

  assert.equal((await p.c.put('/account/policy', { impact_display: 'on' })).status, 200);
  assert.equal((await sees(second, 'h2@signers.example')).done.trees, 10, 'back on, the facts are as they were');
  assert.deepEqual(history(p.id).slice(-2), [{ trees_on_screens_and_emails: { from: 'on', to: 'off' } }, { trees_on_screens_and_emails: { from: 'off', to: 'on' } }]);
});

test('the signing record of a government installation has no trees, no paper estimate and no AI words; one made before is never rebuilt', async () => {
  const p = await person('Eve');
  await subscribe(p);
  const old = await send(p, 'k1@signers.example');
  assert.equal((await signAll(old, 'k1@signers.example')).status, 200);
  const made = await download(p, old);
  const madeText = await pdfText(made);
  assert.match(madeText, /Signed without paper/);
  assert.match(madeText, /fund 10 mangroves/);
  assert.doesNotMatch(madeText, /\bAI\b|help chat|helper|model/i, 'nothing about the AI helper is ever on a record');

  government();
  const fresh = await send(p, 'k2@signers.example');
  assert.equal((await signAll(fresh, 'k2@signers.example')).status, 200);
  const rec = await pdfText(await download(p, fresh));
  assert.doesNotMatch(rec, TREE_WORDS);
  assert.doesNotMatch(rec, /\bAI\b|help chat|helper/i);
  assert.match(rec, /Certificate|Signing record|Envelope/i, 'the rest of the record is there');
  // The account cannot put them back on this server, with the switch or with a row somebody edited.
  db.run('UPDATE accounts SET cert_impact_off=0 WHERE id=?', p.id);
  const again = await send(p, 'k3@signers.example');
  assert.equal((await signAll(again, 'k3@signers.example')).status, 200);
  assert.doesNotMatch(await pdfText(await download(p, again)), TREE_WORDS);
  // The record made before the profile was set is the same file, byte for byte.
  assert.deepEqual(Buffer.from(await download(p, old)), Buffer.from(made));

  delete process.env.DEPLOYMENT_PROFILE;
  assert.deepEqual(Buffer.from(await download(p, fresh)), Buffer.from(await download(p, fresh)));
  assert.doesNotMatch(await pdfText(await download(p, fresh)), TREE_WORDS, 'and one made under it does not gain the box later');
  // The page that explains the record says when the box is there, and carries today's version.
  const page = read('src/app/security/certificate/page.tsx');
  assert.match(page, /printed only when the sender's account has Trees on the signing record switched on, and never by a server set up for a public body/);
  const { CERTIFICATE_PAGE_VERSION } = await import('../src/lib/evidence.ts');
  assert.ok(CERTIFICATE_PAGE_VERSION >= '2026-11-21');
});

test('AI answers in the help chat, off: the account\'s people and its signers get the built-in answers and nothing goes to the model', async () => {
  model('own');
  const p = await person('Fay');
  const q = await person('Gil');
  const eid = await send(p, 'm1@signers.example');
  const link = tokenFor(eid, 'm1@signers.example');
  const other = tokenFor(await send(q, 'm2@signers.example'), 'm2@signers.example');
  const signer = () => Object.assign(new Client(), { ip: `198.51.92.${++askN}` });

  // On, as every account starts: the model answers, and the dialog says so.
  assert.equal((await p.c.get('/account/policy')).data.ai_available, true);
  assert.equal((await p.c.get('/account/policy')).data.ai_provider, 'The agency model');
  assert.ok(isStream(await ask(p.c)));
  assert.ok(isStream(await ask(signer(), { link })));
  assert.equal((await p.c.get('/public/chat')).data.ai, true);
  assert.equal((await signer().get(`/public/chat?link=${link}`)).data.ai, true);

  assert.equal((await p.c.put('/account/policy', { ai_helper: 'off' })).status, 200);
  modelCalls = [];
  const mine = await ask(p.c);
  assert.equal(mine.status, 200);
  assert.deepEqual([mine.data.mode, mine.data.why], ['builtin', 'off'], 'answered as on a server with no model');
  assert.ok(mine.data.reply.length > 20, 'and it is still an answer');
  const theirs = await ask(signer(), { link });
  assert.deepEqual([theirs.data.mode, theirs.data.why], ['builtin', 'off'], 'the people who sign its documents too');
  assert.equal(modelCalls.length, 0, 'nothing was sent to the model');
  // The dialog is told the truth before anything is typed, so it does not say "An AI helper answers here".
  const lib = await import('../src/lib/chat.ts');
  const told = (await p.c.get('/public/chat')).data;
  assert.deepEqual([told.ai, told.provider, told.note], [false, null, lib.CHAT_BUILTIN_NOTE]);
  assert.equal((await signer().get(`/public/chat?link=${link}`)).data.ai, false);
  assert.match(read('src/components/HelpChat.tsx'), /\/api\/public\/chat\$\{link \? `\?link=\$\{encodeURIComponent\(link\)\}` : ''\}/);
  // Someone signed in to an account with AI on, signing a document of the account with it off: off wins.
  assert.deepEqual([(await ask(q.c, { link })).data.mode], ['builtin']);
  assert.equal(modelCalls.length, 0);
  // Everyone else is as before: another account, its signers, a visitor, and a link that does not exist.
  assert.ok(isStream(await ask(q.c)));
  assert.ok(isStream(await ask(signer(), { link: other })));
  assert.ok(isStream(await ask(signer())));
  assert.ok(isStream(await ask(signer(), { link: 'no-such-link' })));
  assert.equal((await signer().get('/public/chat?link=no-such-link')).data.ai, true);
  assert.equal((await signer().get('/public/chat')).data.ai, true);
  // Back on.
  assert.equal((await p.c.put('/account/policy', { ai_helper: 'on' })).status, 200);
  assert.ok(isStream(await ask(p.c)));
  assert.deepEqual(history(p.id).slice(-2), [{ ai_answers_in_help_chat: { from: 'on', to: 'off' } }, { ai_answers_in_help_chat: { from: 'off', to: 'on' } }]);
});

test('a government installation never sends the chat to a hosted AI service; only to a model the operator points it at, once an admin switches it on', async () => {
  const env = (o: Record<string, string>) => ({ DEPLOYMENT_PROFILE: 'government', ...o });
  // The server's rule, from the settings alone.
  assert.equal(prov.chatModelOn(env({ OPENROUTER_API_KEY: 'k' })), false);
  assert.equal(prov.chatModelOn(env({ MOONSHOT_API_KEY: 'k' })), false);
  assert.equal(prov.chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k' })), false, 'a key alone goes to OpenRouter by default');
  assert.equal(prov.chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://openrouter.ai/api/v1' })), false);
  assert.equal(prov.chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://api.moonshot.ai/v1' })), false);
  assert.equal(prov.chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1' })), true);
  assert.equal(prov.chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://localhost:11434/v1' })), true);
  assert.equal(prov.chatModelOn(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.agency.example/v1', SUPPORT_CHAT_DAILY_LIMIT: '0' })), false);
  assert.equal(prov.chatModelOn({ OPENROUTER_API_KEY: 'k' }), true, 'the ordinary profile is as it was');
  // So the pages that name where the chat goes name nobody.
  const { dataPlace } = await import('../src/lib/dataplace.ts');
  assert.ok(!dataPlace(env({ OPENROUTER_API_KEY: 'k' })).processors.some((x: any) => x.id === 'chat'));
  assert.match(prov.chatPrivacyPoint(env({ OPENROUTER_API_KEY: 'k' })).title, /answers from the built-in help/);

  // A hosted key left in the settings: visitors, accounts and signers all get the built-in answers.
  model('openrouter');
  government();
  const p = await person('Hal');
  const visitor = () => Object.assign(new Client(), { ip: `198.51.93.${++askN}` });
  assert.equal((await visitor().get('/public/chat')).data.ai, false);
  assert.deepEqual([(await ask(visitor())).data.mode, (await ask(p.c)).data.mode], ['builtin', 'builtin']);
  assert.equal(modelCalls.length, 0);
  const none = await p.c.put('/account/policy', { ai_helper: 'on' });
  assert.equal(none.status, 409);
  assert.match(none.data.error, /^No AI model that this server may use is set up, so there is nothing to switch on\. Whoever runs this server can point the help chat at a model of their own/);
  assert.equal((await p.c.get('/account/policy')).data.ai_available, false, 'so the page shows no switch');

  // The operator's own model: still off for the account until an admin switches it on.
  model('own');
  government();
  assert.deepEqual([(await p.c.get('/account/policy')).data.ai_available, (await p.c.get('/account/policy')).data.ai_helper], [true, 'off']);
  assert.equal((await ask(p.c)).data.mode, 'builtin');
  assert.equal(modelCalls.length, 0);
  assert.equal((await p.c.put('/account/policy', { ai_helper: 'on' })).status, 200);
  assert.ok(isStream(await ask(p.c)));
  assert.equal(modelCalls.length, 1);
  assert.match(modelCalls[0].url, /^https:\/\/llm\.agency\.example\/v1\//);
});

test('the settings page shows the switches under Account, and the AI one only where a model answers', () => {
  const page = read('src/app/app/settings/page.tsx');
  assert.match(page, /<TreesOnRecord \/>\n[^\n]*\n\s*<TenantSwitches \/>/, 'under Account, after Trees on the signing record');
  const sw = read('src/components/settings/TenantSwitches.tsx');
  assert.match(sw, /'Trees on screens and emails'/);
  assert.match(sw, /\{d\.ai_available && row\('ai_helper', 'AI answers in the help chat'/);
  assert.match(sw, /role="switch"/);
  assert.match(sw, /minHeight: 44/);
  assert.doesNotMatch(sw, /white_label|White label/i, 'nothing is offered for a feature that is not built');
  // The pages never import server code.
  for (const f of ['src/components/settings/TenantSwitches.tsx', 'src/app/security/certifications/page.tsx']) assert.doesNotMatch(read(f), /@\/server\//);
});
