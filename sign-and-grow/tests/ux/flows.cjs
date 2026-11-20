// UX baseline: walks the core flows of the app in a real browser and counts what a person has to do.
//
// HOW TO RUN
//   1. Start a dev server with the dev outbox, on a throwaway database, with its own build folder so it can run
//      next to other servers on this checkout:
//        NEXT_DIST_DIR=.next-uxbase DATA_DIR=$(mktemp -d) DEV_OUTBOX=1 APP_URL=http://localhost:3690 npx next dev -p 3690
//   2. Run this script with the server address and an output folder:
//        node tests/ux/flows.cjs http://localhost:3690 tests/out/ux-baseline/
//   3. Read <out>/ux-flows.json (counts per flow) and the screenshots in <out>/<flow>/ (one per step, in order).
//   Afterwards: stop the server, delete .next-uxbase, and take the two ".next-uxbase" lines back out of
//   tsconfig.json if next dev added them.
//
//   Options (environment variables):
//     UX_WARMUP=0     skip the warm-up pass. With it (the default), every page is opened once on a separate account
//                     first, so the timings measure the app and not the dev server compiling a page for the first time.
//     UX_HEADED=1     show the browser.
//   The script exits with 1 when any step of any flow fails, and still writes the JSON and the screenshots it got.
//
// WHAT IS COUNTED, PER FLOW
//   actions   every click (desktop), tap (phone), field typed (one per field, plus the characters), key press that
//             moves on (Enter), and file picked (2: opening the file picker and choosing the file). Opening an email
//             in the mailbox counts as one click or tap.
//   screens   every page, dialog or email the person passes through. A page that only changes in place (a file
//             finished uploading, a field was placed) is a "state": it gets a screenshot and is measured, but is not
//             counted as a new screen.
//   choices   on each screen and state: every control the person could use (buttons, links, form fields, tabs),
//             visible and enabled, inside the open dialog when there is one. Also how many of them are on the first
//             screenful, how many notices and warnings are shown, how many words are on it, and how many screenfuls
//             tall the page is.
//   timing    wall_ms is the time the script took, with no human thinking time: it is the time spent waiting for the
//             app. klm_estimate_s is a keystroke-level-model estimate of a person's time for the same actions (mental
//             preparation 1.35 s, pointing 1.1 s, press 0.2 s, 0.28 s a character, 4 s to find a file), plus the wait.
//             It leaves out reading: read_all_s is how long reading every word on every screen would take at 240
//             words a minute, as a measure of how much text a flow puts in front of someone.
//
// THE FLOWS
//   a  A new sender signs up, confirms their address and sends their first document to one person, one signature.
//   b  That person opens the email, agrees, signs and finishes. On a phone (iPhone 13) and on a desktop.
//   c  The sender sends from a template (the template is made through the API beforehand, not counted).
//   d  The sender finds the completed document and downloads it.
//   e  The sender opens Settings and changes their name.
//   f  A signer who cannot sign right now looks for help on the signing page, on a phone.
//   Then an inventory (not counted as a flow): every Settings tab, every option in the editor, on the envelope page
//   and on the signing page, written to the JSON under "inventory" with screenshots in <out>/inventory/.
//
// Buttons and links are found by role and by a pattern of their accessible name, so small changes of wording do not
// break the script. When a pattern no longer matches anything, the step fails with the pattern in the message.

const fs = require('node:fs');
const path = require('node:path');
let pw;
try {
  pw = require('playwright');
} catch {
  console.error('Playwright is not installed where Node can find it. Install it (npm i -g playwright) or set NODE_PATH.');
  process.exit(2);
}
const { chromium, devices } = pw;
const { PDFDocument, StandardFonts } = require('pdf-lib');

const BASE = (process.argv[2] || 'http://localhost:3690').replace(/\/$/, '');
const OUT = path.resolve(process.argv[3] || 'tests/out/ux-baseline');
const WARMUP = process.env.UX_WARMUP !== '0';
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const PHONE = devices['iPhone 13'];
const STAMP = Date.now().toString(36);
const PASSWORD = 'plant-more-trees';
const SENDER = { name: 'Rosa Gardener', email: `rosa-${STAMP}@example.org` };
const SIGNER_PHONE = { name: 'Ada Sponsor', email: `ada-${STAMP}@example.org` };
const SIGNER_DESK = { name: 'Ben Partner', email: `ben-${STAMP}@example.org` };
const SIGNER_TPL = { name: 'Cleo Client', email: `cleo-${STAMP}@example.org` };
const SIGNER_HELP = { name: 'Dev Busy', email: `dev-${STAMP}@example.org` };
const DOC_NAME = 'Planting partnership';

fs.mkdirSync(OUT, { recursive: true });
const report = { base: BASE, started_at: new Date().toISOString(), conventions: {}, flows: {}, inventory: {}, failures: [], console_errors: [] };

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const visible = (loc) => loc.filter({ visible: true });
const byRole = (scope, role, name) => visible(scope.getByRole(role, { name })).first();

async function makePdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < 2; p++) {
    const page = d.addPage([612, 792]);
    page.drawText(p === 0 ? `${DOC_NAME} agreement` : 'Signatures', { x: 72, y: 700, size: 22, font: bold });
    const lines = p === 0
      ? ['This agreement is made between the Planting Partner and the Sponsor.', 'The Sponsor agrees to fund the planting and care of mangrove seedlings', 'along the agreed stretch of coastline for a period of three years.']
      : ['Signed by the Sponsor:', '', '', '', 'Date:'];
    lines.forEach((l, i) => page.drawText(l, { x: 72, y: 650 - i * 24, size: 12, font }));
  }
  const dir = path.join(OUT, '_files');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(DOC_NAME)}.pdf`);
  fs.writeFileSync(file, await d.save());
  return file;
}

async function outbox() {
  const r = await fetch(`${BASE}/api/dev/outbox`);
  if (!r.ok) throw new Error(`The dev outbox answered ${r.status}. Start the server with DEV_OUTBOX=1 and no SMTP_URL.`);
  return (await r.json()).emails || [];
}
async function waitMail(to, test, what) {
  for (let i = 0; i < 60; i++) {
    const m = (await outbox()).find((x) => x.to_email === to && test(x));
    if (m) return m;
    await sleep(250);
  }
  throw new Error(`No email to ${to} (${what}) in the dev outbox after 15 seconds`);
}

// The API, called from inside a browser page that is signed in, the way the app itself calls it.
async function apiIn(page, pathname, { method, body, pdfBase64, fileName } = {}) {
  const res = await page.evaluate(async ([pathname, method, body, pdfBase64, fileName]) => {
    let init = { method: method || (body || pdfBase64 ? 'POST' : 'GET') };
    if (pdfBase64) {
      const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), fileName);
      init.body = form;
    } else if (body) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`/api${pathname}`, init);
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, [pathname, method, body, pdfBase64, fileName]);
  if (res.status >= 400) throw new Error(`${method || 'POST'} /api${pathname}: ${res.status} ${res.data?.error || ''}`);
  return res.data;
}

// Makes and sends an envelope for one signer with one signature field, through the API (setup, never counted).
async function sendByApi(page, pdf, subject, signer, kind = 'envelope') {
  const file = await apiIn(page, '/files', { pdfBase64: fs.readFileSync(pdf).toString('base64'), fileName: `${slug(subject)}.pdf` });
  const tpl = kind === 'template';
  const { envelope } = await apiIn(page, '/envelopes', { body: {
    kind, subject, message: '',
    documents: [{ id: 'd1', file_id: file.id, name: subject }],
    recipients: [{ id: 'r1', routing_order: 1, role: 'signer', name: tpl ? '' : signer.name, email: tpl ? '' : signer.email, ...(tpl ? { role_name: 'Client' } : {}) }],
    fields: [{ document_id: 'd1', recipient_id: 'r1', type: 'signature', page: 1, x: 0.14, y: 0.2, w: 0.3, h: 0.06 }],
  } });
  if (!tpl) await apiIn(page, `/envelopes/${envelope.id}/send`, { method: 'POST', body: {} });
  return envelope.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Measuring one screen: runs in the page. Looks inside the open dialog when there is one.

function measureInPage() {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open]')].filter(vis);
  const dialog = dialogs[dialogs.length - 1] || null;
  const scope = dialog || document.body;
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=switch], [role=option]';
  const seen = new Set();
  const controls = [];
  for (let el of scope.querySelectorAll(sel)) {
    // A visually hidden input (a file picker or a styled checkbox) is used through the label around it.
    const r0 = el.getBoundingClientRect();
    if (el.matches('input') && (r0.width < 4 || r0.height < 4)) el = el.closest('label') || el;
    if (seen.has(el) || !vis(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
    const lab = el.labels?.[0]?.innerText || el.closest('label')?.innerText;
    const name = (el.getAttribute('aria-label') || labelled || (el.matches('input, select, textarea') ? lab || el.getAttribute('placeholder') : '') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const kind = el.matches('a') ? 'link' : el.matches('select') ? 'select' : el.matches('textarea') ? 'textbox' : el.matches('input[type=checkbox], [role=checkbox]') ? 'checkbox' : el.matches('input[type=radio], [role=radio]') ? 'radio' : el.matches('input[type=file]') || (el.matches('label') && el.querySelector('input[type=file]')) ? 'file' : el.matches('input') ? 'textbox' : el.matches('[role=tab]') ? 'tab' : 'button';
    const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
    controls.push({ kind, name, disabled, first_screen: r.top < innerHeight && r.bottom > 0 });
  }
  const enabled = controls.filter((c) => !c.disabled);
  const words = (scope.innerText || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const notices = [...scope.querySelectorAll('.notice, [role=alert], [role=note], .ed-banner')].filter(vis).filter((n, i, all) => !all.some((o) => o !== n && o.contains(n)));
  const heading = (dialog && (dialog.getAttribute('aria-label') || document.getElementById(dialog.getAttribute('aria-labelledby') || '')?.innerText))
    || document.querySelector('h1')?.innerText || document.title;
  const count = (k) => enabled.filter((c) => c.kind === k).length;
  return {
    heading: (heading || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    in_dialog: !!dialog,
    choices: enabled.length,
    choices_first_screen: enabled.filter((c) => c.first_screen).length,
    by_kind: { buttons: count('button'), links: count('link'), fields: count('textbox') + count('select') + count('file'), checkboxes: count('checkbox') + count('radio'), tabs: count('tab') },
    disabled: controls.length - enabled.length,
    notices: notices.length,
    notice_text: notices.map((n) => n.innerText.replace(/\s+/g, ' ').trim().slice(0, 160)),
    words,
    screenfuls: dialog ? +(dialog.scrollHeight / innerHeight).toFixed(1) : +(document.documentElement.scrollHeight / innerHeight).toFixed(1),
    controls: enabled.map((c) => `${c.kind}: ${c.name}`),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A flow: counts actions, screens, choices and time, and takes the screenshots.

class Flow {
  constructor(id, title, page, { touch = false, device = 'desktop' } = {}) {
    Object.assign(this, { id, title, page, touch, device });
    this.dir = path.join(OUT, id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.n = 0;
    this.actions = { clicks: 0, taps: 0, fields_typed: 0, characters_typed: 0, key_presses: 0, files_picked: 0 };
    this.klm = 0;
    this.waitMs = 0;
    this.log = [];
    this.screens = [];
    this.states = [];
    this.notes = [];
    this.t0 = Date.now();
  }
  get total() {
    const a = this.actions;
    return a.clicks + a.taps + a.fields_typed + a.key_presses + a.files_picked * 2;
  }
  async settle() {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    // Text that says it is loading has to go first.
    await this.page.waitForFunction(() => !/^(Loading|Opening your document|Starting a new)/i.test(document.querySelector('main, .sn, .ed, body')?.innerText?.trim() || ''), null, { timeout: 15000 }).catch(() => {});
    await sleep(350);
  }
  async shoot(label, isScreen) {
    this.n += 1;
    const base = `${String(this.n).padStart(2, '0')}-${slug(label)}`;
    const m = await this.page.evaluate(measureInPage);
    const file = path.join(this.dir, `${base}.png`);
    await this.page.screenshot({ path: file });
    let full = null;
    if (!m.in_dialog && m.screenfuls > 1.3) {
      full = path.join(this.dir, `${base}-full.png`);
      await this.page.screenshot({ path: full, fullPage: true });
    }
    const entry = { n: this.n, label, kind: isScreen ? (m.in_dialog ? 'dialog' : this.isMail ? 'email' : 'page') : 'state', url: this.page.url().replace(BASE, ''), at_ms: Date.now() - this.t0, screenshot: path.relative(OUT, file), ...(full ? { screenshot_full: path.relative(OUT, full) } : {}), ...m };
    (isScreen ? this.screens : this.states).push(entry);
    this.tEnd = Date.now();
    this.log.push({ step: this.n, [isScreen ? 'screen' : 'state']: label, heading: m.heading, choices: m.choices, words: m.words });
    return entry;
  }
  // A new page, dialog or email the person passes through.
  async screen(label, { mail = false } = {}) {
    this.isMail = mail;
    await this.settle();
    return this.shoot(label, true);
  }
  // The same page, changed in place.
  async state(label) {
    await this.settle();
    return this.shoot(label, false);
  }
  async timed(what, fn) {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - t;
      this.waitMs += ms;
      this.tEnd = Date.now();
      this.log.push({ action: what, ms });
    }
  }
  // A click on a desktop, a tap on a phone. `then` waits for whatever the press leads to.
  async press(loc, what, then) {
    await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error(`Could not find ${what}`); });
    if (this.touch) this.actions.taps++;
    else this.actions.clicks++;
    this.klm += 2.65;
    await this.timed(`${this.touch ? 'tap' : 'click'}: ${what}`, async () => {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      if (this.touch) await loc.tap();
      else await loc.click();
      if (then) await then();
    });
  }
  // Pressing at a point (placing a field on a page).
  async pressAt(x, y, what, then) {
    if (this.touch) this.actions.taps++;
    else this.actions.clicks++;
    this.klm += 2.65;
    await this.timed(`${this.touch ? 'tap' : 'click'}: ${what}`, async () => {
      if (this.touch) await this.page.touchscreen.tap(x, y);
      else await this.page.mouse.click(x, y);
      if (then) await then();
    });
  }
  // Counts as a press without doing one, for a link followed with goto (email links open in a new tab).
  async follow(href, what, then) {
    if (this.touch) this.actions.taps++;
    else this.actions.clicks++;
    this.klm += 2.65;
    await this.timed(`${this.touch ? 'tap' : 'click'}: ${what}`, async () => {
      await this.page.goto(href);
      if (then) await then();
    });
  }
  async type(loc, text, what) {
    await loc.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error(`Could not find the field ${what}`); });
    this.actions.fields_typed++;
    this.actions.characters_typed += text.length;
    this.klm += 1.35 + 1.1 + 0.2 + 0.28 * text.length;
    await this.timed(`type: ${what} (${text.length} characters)`, async () => {
      if (this.touch) await loc.tap().catch(() => {});
      await loc.fill(text);
    });
  }
  async key(key, what, then) {
    this.actions.key_presses++;
    this.klm += 1.35 + 0.28;
    await this.timed(`key ${key}: ${what}`, async () => {
      await this.page.keyboard.press(key);
      if (then) await then();
    });
  }
  async file(loc, file, what, then) {
    this.actions.files_picked++;
    this.klm += 2 * 2.65 + 4;
    await this.timed(`pick file: ${what}`, async () => {
      await loc.setInputFiles(file);
      if (then) await then();
    });
  }
  note(text) {
    this.notes.push(text);
  }
  summary() {
    const s = this.screens;
    const all = [...this.screens, ...this.states];
    // Up to the last thing the person did or saw: checks the script makes afterwards are not counted.
    const wall = (this.tEnd || Date.now()) - this.t0;
    const words = s.reduce((n, x) => n + x.words, 0);
    return {
      title: this.title,
      device: this.device,
      ok: !this.error,
      ...(this.error ? { error: this.error } : {}),
      actions_total: this.total,
      actions: this.actions,
      screens_total: s.length,
      screens_by_kind: { pages: s.filter((x) => x.kind === 'page').length, dialogs: s.filter((x) => x.kind === 'dialog').length, emails: s.filter((x) => x.kind === 'email').length },
      choices_seen_total: s.reduce((n, x) => n + x.choices, 0),
      choices_max_one_screen: Math.max(0, ...all.map((x) => x.choices)),
      choices_first_screen_avg: s.length ? Math.round(s.reduce((n, x) => n + x.choices_first_screen, 0) / s.length) : 0,
      notices_seen_total: s.reduce((n, x) => n + x.notices, 0),
      words_seen_total: words,
      read_all_s: Math.round((words / 240) * 60),
      wall_ms: wall,
      app_wait_ms: this.waitMs,
      klm_estimate_s: Math.round(this.klm + this.waitMs / 1000),
      notes: this.notes,
      path: s.map((x) => `${x.kind}: ${x.label}`),
      screens: s,
      states: this.states,
      log: this.log,
    };
  }
}

async function runFlow(flow, fn) {
  console.log(`\n== ${flow.id}: ${flow.title}`);
  try {
    await fn(flow);
    console.log(`ok    ${flow.id}: ${flow.total} actions, ${flow.screens.length} screens`);
  } catch (e) {
    flow.error = String(e?.message || e).split('\n').slice(0, 4).join(' ');
    report.failures.push(`${flow.id}: ${flow.error}`);
    console.log(`FAIL  ${flow.id}: ${flow.error}`);
    try {
      await flow.page.screenshot({ path: path.join(flow.dir, `FAIL-${String(flow.n + 1).padStart(2, '0')}.png`), fullPage: true });
    } catch {}
  }
  report.flows[flow.id] = flow.summary();
  writeReport();
  return !flow.error;
}

function writeReport() {
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'ux-flows.json'), JSON.stringify(report, null, 2));
}

// A browser context with the Next.js dev tools badge hidden, so it is neither in the pictures nor counted.
async function newContext(browser, opts) {
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
  await ctx.addInitScript(() => {
    const css = 'nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }';
    const add = () => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  });
  return ctx;
}
function watchErrors(page, who) {
  page.on('pageerror', (e) => report.console_errors.push(`${who}: ${String(e).slice(0, 300)}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|favicon|\[HMR\]|webpack-hmr|Download the React DevTools/i.test(m.text()) && report.console_errors.push(`${who}: ${m.text().slice(0, 300)}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Warm-up: opens every page once on its own account, so the dev server has compiled them before anything is timed.

async function warmUp(browser, pdf) {
  const t = Date.now();
  const ctx = await newContext(browser, DESKTOP);
  const p = await ctx.newPage();
  p.setDefaultTimeout(60000);
  const who = { name: 'Warm Up', email: `warm-${STAMP}@example.org` };
  await p.goto(BASE);
  await p.goto(`${BASE}/signup`);
  await apiIn(p, '/auth/signup', { body: { ...who, password: PASSWORD } });
  const m = await waitMail(who.email, (x) => x.link?.includes('verify-email'), 'confirmation');
  await p.goto(m.link);
  await p.getByText(/confirmed/i).first().waitFor().catch(() => {});
  const id = await sendByApi(p, pdf, 'Warm-up agreement', { name: 'Wanda Warm', email: `wanda-${STAMP}@example.org` });
  const tpl = await sendByApi(p, pdf, 'Warm-up template', null, 'template');
  for (const u of ['/app', '/app/envelopes', '/app/templates', '/app/settings', `/app/envelopes/${id}`, `/app/templates/${tpl}/edit`, '/help']) {
    await p.goto(BASE + u);
    await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  }
  // The editor, with a draft that is thrown away afterwards.
  const { envelope } = await apiIn(p, '/envelopes', { body: { kind: 'envelope' } });
  await p.goto(`${BASE}/app/envelopes/${envelope.id}/edit`);
  await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await apiIn(p, `/envelopes/${envelope.id}`, { method: 'DELETE' }).catch(() => {});
  const link = (await waitMail(`wanda-${STAMP}@example.org`, (x) => x.link?.includes('/sign/'), 'invitation')).link;
  const s = await ctx.newPage();
  await s.goto(`${BASE}/api/dev/outbox`);
  await s.goto(link);
  await s.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await s.goto(`${BASE}/verify-email?token=nothing`).catch(() => {});
  await ctx.close();
  return Date.now() - t;
}

// ---------------------------------------------------------------------------------------------------------------
// The flows

// (a) Sign up, confirm the address, send a first document to one person with one signature field.
async function flowA(f, pdf) {
  const p = f.page;
  await p.goto(BASE);
  await f.screen('Landing page');
  const cta = byRole(p, 'link', /start free|sign up|create (an |your )?account|get started|try (it )?free/i);
  await f.press(cta, 'the sign-up button on the landing page', () => p.waitForURL(/\/signup/));
  await f.screen('Sign up form');
  await f.type(p.getByLabel(/your name|full name|^name/i).first(), SENDER.name, 'name');
  await f.type(p.getByLabel(/^email/i).first(), SENDER.email, 'email');
  await f.type(p.getByLabel(/password/i).first(), PASSWORD, 'password');
  await f.press(byRole(p, 'button', /create (an |my |your )?account|sign up|start/i), 'Create account', () => p.waitForURL(/\/app(\/|$|\?)/));
  await f.screen('App home before the address is confirmed');

  // The confirmation email, read from the dev outbox as the mailbox.
  const mail = await waitMail(SENDER.email, (x) => x.link?.includes('verify-email'), 'confirmation');
  const app = p;
  const box = await p.context().newPage();
  f.page = box;
  await f.follow(`${BASE}/api/dev/outbox?id=${mail.id}`, 'open the confirmation email in the mailbox');
  await f.screen(`Email: ${mail.subject}`, { mail: true });
  const href = await box.locator('a[href*="verify-email"]').first().getAttribute('href');
  await f.follow(href, 'the confirm link in the email', () => box.getByText(/confirmed|did not work|one more step/i).first().waitFor());
  await f.screen('Email confirmed');
  await f.press(byRole(box, 'link', /go to|continue|open|start/i), 'the link back into the app', () => box.waitForURL(/\/app(\/|$|\?)/));
  await f.screen('App home');
  f.note('The confirmation link opens in a new tab. The tab the person signed up in still shows the "confirm your email" banner until it is reloaded.');
  await app.close();

  await f.press(byRole(box, 'link', /send (for signature|a document)|new envelope|send your first/i), 'Send for signature', () => box.waitForURL(/\/edit/));
  await f.screen('Editor, step 1 (Add)');
  await f.file(box.locator('input[type=file]').first(), pdf, 'the PDF, from the drop zone', () => box.getByLabel(/document name/i).first().waitFor());
  await f.state('Editor, step 1, after the upload');
  if (!(await visible(box.getByLabel(/recipient name/i)).count())) await f.press(byRole(box, 'button', /add (a )?recipient|add (a )?person|add signer/i), 'Add recipient');
  await f.type(visible(box.getByLabel(/recipient name/i)).first(), SIGNER_PHONE.name, 'recipient name');
  await f.type(visible(box.getByLabel(/recipient email/i)).first(), SIGNER_PHONE.email, 'recipient email');
  const subject = box.getByLabel(/subject/i).first();
  if (!(await subject.inputValue().catch(() => ''))) await f.type(subject, `Please sign: ${DOC_NAME}`, 'email subject');
  else f.note(`The email subject was filled in from the file name: "${await subject.inputValue()}".`);
  report.first_subject = await subject.inputValue();
  await f.state('Editor, step 1, filled in');

  await f.press(byRole(box, 'button', /^(next|continue)$/i), 'Next', () => box.locator('.pdfpage canvas, canvas').first().waitFor());
  await f.screen('Editor, step 2 (Place fields)');
  const palette = box.getByRole('group', { name: /add a field|field types|add fields?/i }).first();
  await f.press(byRole((await palette.count()) ? palette : box, 'button', /^signature$/i), 'the Signature field type');
  const pg = box.locator('.pdfpage').nth(1);
  await pg.scrollIntoViewIfNeeded();
  const b = await pg.boundingBox();
  await f.pressAt(b.x + b.width * 0.3, b.y + b.height * 0.22, 'the place on page 2 for the signature', () => box.locator('.field').first().waitFor());
  await f.state('Editor, step 2, signature placed');
  await f.press(byRole(box, 'button', /^(next|continue)$/i), 'Next', () => box.getByRole('button', { name: /^send( now)?$/i }).first().waitFor());
  await f.screen('Editor, step 3 (Review and send)');
  await f.press(visible(box.getByRole('button', { name: /^send( now)?$/i })).last(), 'Send', async () => {
    // A question before sending (an address that bounced before) is answered and counted.
    const r = await Promise.race([box.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/).then(() => 'sent'), box.getByRole('dialog').first().waitFor().then(() => 'asked')]);
    if (r === 'asked') f.note('A dialog came up after Send.');
  });
  if (!/\/app\/envelopes\/env_[^/]+(\?|$)/.test(box.url())) {
    await f.screen('Question after Send');
    await f.press(byRole(box.getByRole('dialog').first(), 'button', /send/i), 'Send in the dialog', () => box.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/));
  }
  await f.screen('Envelope page, just sent');
  return box;
}

// (b) The person opens the email, agrees, signs and finishes.
async function flowB(f, signer) {
  const p = f.page;
  const mail = await waitMail(signer.email, (x) => x.link?.includes('/sign/'), 'signing invitation');
  await f.follow(`${BASE}/api/dev/outbox?id=${mail.id}`, 'open the invitation in the mailbox');
  await f.screen(`Email: ${mail.subject}`, { mail: true });
  const cta = visible(p.locator('a[href*="/sign/"]')).first();
  const ctaText = (await cta.innerText().catch(() => '')).trim();
  f.note(`The button in the email says "${ctaText}".`);
  await f.follow(await cta.getAttribute('href'), `"${ctaText}" in the email`, () => p.getByRole('checkbox').first().waitFor());
  await f.screen('Signing: who sent it, and the consent');
  await f.press(byRole(p, 'checkbox', /agree|electronic/i), 'the box to agree to electronic records');
  await f.press(byRole(p, 'button', /^(continue|start|agree and continue|next)$/i), 'Continue', () => p.locator('.pdfpage canvas').first().waitFor());
  await f.screen('Signing: the document');
  const sigField = byRole(p, 'button', /sign here|signature.*(required|sign)/i);
  const next = byRole(p, 'button', /^(next|start)$/i);
  if (await next.count()) {
    await f.press(next, 'Next (takes them to the signature)');
    await f.state('Signing: at the signature field');
  } else f.note('There was no Next button; the person has to find the field themselves.');
  if (!(await p.getByRole('dialog').count())) await f.press(sigField, 'the signature field', () => p.getByRole('dialog').first().waitFor());
  else f.note('Next opened the signature dialog by itself.');
  await f.screen('Adopt your signature');
  await f.press(byRole(p.getByRole('dialog').first(), 'button', /adopt|^sign$|use this/i), 'Adopt and sign', () => p.locator('.field img, .field.fill').first().waitFor());
  // When nothing else is required, the check before finishing opens by itself.
  const review = p.getByRole('dialog').filter({ hasText: /signing as|before you finish/i });
  const opened = await review.first().waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  if (!opened) {
    f.note('The check before finishing did not open by itself, so the person presses Finish.');
    await f.press(byRole(p, 'button', /^finish/i), 'Finish', () => review.first().waitFor());
  } else f.note('The check before finishing opened by itself once the signature was on.');
  await f.screen('Check before you finish');
  await f.press(byRole(review.first(), 'button', /^(finish|approve|sign)( and send| now)?$|^send$/i), 'Finish and send', () => p.getByRole('heading', { name: /done|thank|finished/i }).first().waitFor());
  await f.screen('Done');
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (sideways) f.note('The done page scrolls sideways.');
}

// (c) Send from a template.
async function flowC(f, templateName) {
  const p = f.page;
  await p.goto(`${BASE}/app`);
  await f.screen('App home');
  await f.press(byRole(p, 'link', /^templates$/i), 'Templates in the menu', () => p.waitForURL(/\/app\/templates/));
  await f.screen('Templates');
  await f.press(byRole(p, 'button', new RegExp(`^use\\b.*${templateName.split(' ')[0]}`, 'i')), `Use on "${templateName}"`, () => p.getByRole('dialog').first().waitFor());
  await f.screen('Use the template');
  const d = p.getByRole('dialog').first();
  await f.type(d.getByLabel(/full name|^name/i).first(), SIGNER_TPL.name, 'name of the person signing');
  await f.type(d.getByLabel(/email/i).first(), SIGNER_TPL.email, 'their email');
  await f.press(byRole(d, 'button', /^send( now)?$/i), 'Send now', () => p.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/));
  await f.screen('Envelope page, just sent');
}

// (d) Find the completed document and download it.
async function flowD(f, subject) {
  const p = f.page;
  await p.goto(`${BASE}/app`);
  await f.screen('App home');
  await f.press(byRole(p, 'link', /^envelopes$|^documents$/i), 'Envelopes in the menu', () => p.waitForURL(/\/app\/envelopes(\?|$)/));
  await f.screen('Envelopes');
  await f.type(p.getByRole('searchbox').first(), DOC_NAME, 'the search box');
  await p.getByText(subject).first().waitFor();
  await f.state('Envelopes, search typed');
  await f.press(byRole(p, 'link', new RegExp(`^${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')), 'the document in the list', () => p.waitForURL(/\/app\/envelopes\/env_[^/]+(\?|$)/));
  await f.screen('Envelope page, completed');
  const dl = byRole(p, 'link', /download.*(certificate|signed)|download pdf|^download$/i);
  const name = (await dl.innerText().catch(() => '')).trim();
  let file;
  await dl.waitFor();
  const coming = p.waitForEvent('download', { timeout: 30000 });
  await f.press(dl, `"${name}"`, async () => {
    file = await coming;
  });
  const to = path.join(f.dir, file.suggestedFilename());
  await file.saveAs(to);
  f.note(`Downloaded ${file.suggestedFilename()}, ${fs.statSync(to).size} bytes, with "${name}".`);
  const rowDl = await p.goto(`${BASE}/app/envelopes?box=completed`).then(() => visible(p.getByRole('link', { name: /download/i })).count());
  if (rowDl) f.note('A shorter way exists: the list itself has a Download button on each completed row (Envelopes, Completed, Download).');
}

// (e) Settings: change their name.
async function flowE(f) {
  const p = f.page;
  await p.goto(`${BASE}/app`);
  await f.screen('App home');
  await f.press(byRole(p, 'link', /^settings$/i), 'Settings in the menu', () => p.waitForURL(/\/app\/settings/));
  await f.screen('Settings, first tab');
  let nameBox = visible(p.getByLabel(/^(your )?(full )?name$/i)).first();
  if (!(await nameBox.count())) {
    await f.press(byRole(p, 'tab', /profile|you|account/i), 'the Profile tab');
    await f.state('Settings, Profile');
    nameBox = visible(p.getByLabel(/^(your )?(full )?name$/i)).first();
  }
  await f.type(nameBox, 'Rosa M. Gardener', 'their name');
  await f.press(byRole(p, 'button', /save( profile| name| changes)?$/i), 'Save', () => p.getByText(/saved/i).first().waitFor());
  await f.state('Settings, saved');
  const me = await apiIn(p, '/me');
  if (me.user?.name !== 'Rosa M. Gardener') throw new Error(`The name was not saved: it is "${me.user?.name}"`);
}

// (f) A signer who cannot sign right now looks for help, on a phone.
async function flowF(f, signer) {
  const p = f.page;
  const mail = await waitMail(signer.email, (x) => x.link?.includes('/sign/'), 'signing invitation');
  await f.follow(`${BASE}/api/dev/outbox?id=${mail.id}`, 'open the invitation in the mailbox');
  await f.screen(`Email: ${mail.subject}`, { mail: true });
  const helpInMail = await visible(p.getByRole('link', { name: /help|cannot|can't|questions/i })).allInnerTexts().catch(() => []);
  f.note(helpInMail.length ? `The email has help links: ${helpInMail.map((t) => `"${t.trim()}"`).join(', ')}.` : 'The email has no help link.');
  await f.follow(await visible(p.locator('a[href*="/sign/"]')).first().getAttribute('href'), 'the signing button in the email', () => p.getByRole('checkbox').first().waitFor());
  await f.screen('Signing: who sent it, and the consent');
  const footHelp = await visible(p.locator('footer').getByRole('link', { name: /help/i })).count();
  f.note(footHelp ? 'There is also a Help link in the footer, below the consent text.' : 'No Help link in the footer.');
  await f.press(byRole(p, 'button', /other actions|more|menu|help/i), 'Other actions', () => p.getByRole('dialog').first().waitFor());
  await f.screen('Other actions');
  await f.press(byRole(p.getByRole('dialog').first(), 'button', /^help/i), 'Help in Other actions', () => p.getByRole('dialog').filter({ hasText: /question|helper|person/i }).first().waitFor());
  await f.screen('Help');
  const box = visible(p.getByRole('dialog').first().getByRole('textbox')).first();
  await f.type(box, 'I cannot sign this today. What can I do?', 'the question');
  const before = await p.getByRole('dialog').first().innerText();
  await f.key('Enter', 'send the question', () => p.waitForFunction((b) => {
    const d = document.querySelector('[role=dialog]');
    return d && d.innerText !== b && !/thinking|…$/i.test(d.innerText.trim().slice(-20));
  }, before, { timeout: 20000 }));
  await sleep(1500);
  await f.state('Help, answered');
  const answer = await p.locator('[role=log]').first().innerText().catch(() => '');
  f.note(`The helper answered: "${answer.replace(/\s+/g, ' ').trim().slice(0, 500)}"`);
  await f.press(byRole(p.getByRole('dialog').first(), 'button', /talk to a person|write to a person|contact/i), 'Talk to a person', () => p.getByRole('dialog').filter({ hasText: /write to a person|message/i }).first().waitFor());
  await f.screen('Write to a person');
}

// ---------------------------------------------------------------------------------------------------------------
// The inventory: every place a person can set something today.

function inventoryInPage() {
  const vis = (el) => {
    if (el.closest('[aria-hidden="true"], [hidden]')) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(vis);
  const scope = dialogs[dialogs.length - 1] || document.querySelector('main, .sn, .ed, .settings') || document.body;
  const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const items = [];
  for (const el of scope.querySelectorAll('h1, h2, h3, legend, label, input, select, textarea, button, a[href], [role=tab], summary')) {
    if (el.matches('input, select, textarea') && el.closest('label')) continue; // said with its label
    const hidden = el.matches('input') && el.getBoundingClientRect().width < 4;
    if (!hidden && !vis(el)) continue;
    if (el.matches('h1, h2, h3, legend')) items.push(`## ${text(el)}`);
    else if (el.matches('label')) {
      const c = el.querySelector('input, select, textarea');
      if (!c) continue;
      const kind = c.matches('select') ? `select [${[...c.options].map((o) => o.text).join(' | ')}]` : c.type === 'checkbox' ? 'checkbox' : c.type === 'radio' ? 'radio' : c.type === 'file' ? 'file' : c.matches('textarea') ? 'text area' : `${c.type || 'text'} field`;
      items.push(`${kind}: ${text(el).slice(0, 140)}`);
    } else if (el.matches('select')) items.push(`select ${el.getAttribute('aria-label') || ''} [${[...el.options].map((o) => o.text).join(' | ')}]`);
    else if (el.matches('input, textarea')) items.push(`${el.type || 'text'} field: ${el.getAttribute('aria-label') || el.placeholder || el.name || ''}`);
    else if (el.matches('[role=tab]')) items.push(`tab: ${text(el)}`);
    else if (el.matches('summary')) items.push(`expander: ${text(el)}`);
    else items.push(`${el.matches('a') ? 'link' : 'button'}: ${(el.getAttribute('aria-label') || text(el)).slice(0, 100)}`);
  }
  return items.filter((x, i, all) => x.trim() && all.indexOf(x) === i);
}

async function inventory(browser, page, ids) {
  const dir = path.join(OUT, 'inventory');
  fs.mkdirSync(dir, { recursive: true });
  const take = async (key, p = page) => {
    await p.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await sleep(400);
    await p.screenshot({ path: path.join(dir, `${slug(key)}.png`), fullPage: !(await p.getByRole('dialog').count()) });
    report.inventory[key] = await p.evaluate(inventoryInPage);
  };
  // Settings: every tab.
  await page.goto(`${BASE}/app/settings`);
  await page.getByRole('tab').first().waitFor();
  const tabs = await visible(page.getByRole('tab')).allInnerTexts();
  report.inventory_settings_tabs = tabs;
  for (const t of tabs) {
    await page.getByRole('tab', { name: t, exact: true }).click();
    await take(`settings - ${t}`);
  }
  // The editor: a fresh draft with the PDF and one person, every option opened.
  const { envelope } = await apiIn(page, '/envelopes', { body: { kind: 'envelope' } });
  await page.goto(`${BASE}/app/envelopes/${envelope.id}/edit`);
  await page.locator('input[type=file]').first().setInputFiles(ids.pdf);
  await page.getByLabel(/document name/i).first().waitFor();
  if (!(await visible(page.getByLabel(/recipient name/i)).count())) await byRole(page, 'button', /add recipient/i).click();
  await visible(page.getByLabel(/recipient name/i)).first().fill('Ivy Inventory');
  await visible(page.getByLabel(/recipient email/i)).first().fill(`ivy-${STAMP}@example.org`);
  const more = byRole(page, 'button', /more options/i);
  if (await more.count()) await more.click();
  const order = page.getByText(/signing order/i).first();
  await take('editor - step 1 (with More opened for one person)');
  await page.getByRole('button', { name: /^next$/i }).first().click();
  await page.locator('.pdfpage canvas').first().waitFor();
  await take('editor - step 2 (field types)');
  // Select one field of each kind that has its own settings and list them.
  const pg = page.locator('.pdfpage').first();
  for (const [type, y] of [['Text', 0.3], ['Signature', 0.5], ['Dropdown', 0.7]]) {
    await byRole(page.getByRole('group', { name: /add a field/i }).first(), 'button', new RegExp(`^${type}$`, 'i')).click();
    const b = await pg.boundingBox();
    await page.mouse.click(b.x + b.width * 0.4, b.y + b.height * y);
    await sleep(300);
    const sheet = byRole(page, 'button', /^settings$/i);
    if (await sheet.count()) await sheet.click().catch(() => {});
    await sleep(200);
    const panel = page.locator('.ed-side, .pane').filter({ hasText: /field settings|assigned to/i }).first();
    report.inventory[`editor - field settings (${type})`] = await (await panel.count() ? panel : page.locator('body')).evaluate((root) => {
      const out = [];
      for (const el of root.querySelectorAll('label, button, select')) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (el.matches('label')) out.push(`${el.querySelector('select') ? 'select' : el.querySelector('input[type=checkbox]') ? 'checkbox' : 'field'}: ${el.innerText.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
        else if (el.matches('button')) out.push(`button: ${(el.getAttribute('aria-label') || el.innerText).replace(/\s+/g, ' ').trim()}`);
      }
      return out.filter((x, i, a) => a.indexOf(x) === i);
    });
    await page.screenshot({ path: path.join(dir, `editor-field-settings-${slug(type)}.png`) });
  }
  await page.getByRole('button', { name: /^next$/i }).first().click();
  await page.getByRole('button', { name: /^send$/i }).first().waitFor();
  await take('editor - step 3 (review)');
  void order;
  await apiIn(page, `/envelopes/${envelope.id}`, { method: 'DELETE' }).catch(() => {});
  // The envelope page, while out and when completed.
  if (ids.outEnvelope) {
    await page.goto(`${BASE}/app/envelopes/${ids.outEnvelope}`);
    await page.getByRole('heading').first().waitFor();
    await take('envelope page - waiting for someone');
  }
  if (ids.doneEnvelope) {
    await page.goto(`${BASE}/app/envelopes/${ids.doneEnvelope}`);
    await page.getByRole('heading').first().waitFor();
    await take('envelope page - completed');
  }
  // The signing page: Other actions, the signature dialog, on a fresh link.
  if (ids.signLink) {
    const ctx = await newContext(browser, PHONE);
    const s = await ctx.newPage();
    await s.goto(ids.signLink);
    await s.getByRole('checkbox').first().waitFor();
    await take('signing page - consent', s);
    await byRole(s, 'button', /other actions/i).tap();
    await s.getByRole('dialog').first().waitFor();
    await take('signing page - other actions (consent)', s);
    await s.keyboard.press('Escape');
    await byRole(s, 'checkbox', /agree/i).tap();
    await byRole(s, 'button', /^continue$/i).tap();
    await s.locator('.pdfpage canvas').first().waitFor();
    await take('signing page - document', s);
    await byRole(s, 'button', /other actions/i).tap();
    await s.getByRole('dialog').first().waitFor();
    await take('signing page - other actions (document)', s);
    await s.keyboard.press('Escape');
    await sleep(300);
    await byRole(s, 'button', /sign here|signature/i).tap();
    await s.getByRole('dialog').first().waitFor();
    for (const t of await visible(s.getByRole('dialog').getByRole('tab')).allInnerTexts()) {
      await s.getByRole('dialog').getByRole('tab', { name: t, exact: true }).tap();
      await take(`signing page - adopt signature, ${t}`, s);
    }
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------

(async () => {
  let browser;
  try {
    const up = await fetch(`${BASE}/api/me`).catch(() => null);
    if (!up) throw new Error(`Nothing answers at ${BASE}. Start the dev server first (see the top of this file).`);
    await outbox();
    const pdf = await makePdf();
    browser = await chromium.launch(process.env.UX_HEADED === '1' ? { headless: false } : undefined);
    report.conventions = {
      desktop: `${DESKTOP.viewport.width}x${DESKTOP.viewport.height}`, phone: 'iPhone 13 (390x844, touch)',
      action_total: 'clicks + taps + fields typed + key presses + 2 per file picked',
      choices: 'enabled, visible controls inside the open dialog, or on the whole page when no dialog is open',
      klm: 'M 1.35 s + P 1.1 s + B 0.2 s per press, + 0.28 s a character, + 4 s to find a file, + the time the app took',
    };
    if (WARMUP) {
      console.log('warming up the dev server (every page once, on its own account)…');
      report.warmup_ms = await warmUp(browser, pdf).catch((e) => (console.log(`warm-up had a problem: ${e.message}`), -1));
    }

    // (a)
    const ctxA = await newContext(browser, DESKTOP);
    const pa = await ctxA.newPage();
    pa.setDefaultTimeout(20000);
    watchErrors(pa, 'sender');
    ctxA.on('page', (p) => watchErrors(p, 'sender'));
    const fa = new Flow('a-send-first', 'New sender signs up and sends a first document to one person, one signature field', pa);
    let sender = pa;
    const okA = await runFlow(fa, async (f) => { sender = await flowA(f, pdf); });
    sender = fa.page;
    const firstEnvelope = (sender.url().match(/env_[A-Za-z0-9_-]+/) || [])[0];

    // Set-up for the other flows, through the API as the sender (never counted).
    const ids = { pdf };
    if (okA) {
      ids.desk = await sendByApi(sender, pdf, `Please sign: ${DOC_NAME} (desktop)`, SIGNER_DESK).catch((e) => report.failures.push(`setup desktop envelope: ${e.message}`));
      ids.template = await sendByApi(sender, pdf, 'Sponsor agreement', null, 'template').catch((e) => report.failures.push(`setup template: ${e.message}`));
      ids.help = await sendByApi(sender, pdf, `Please sign: ${DOC_NAME} (help)`, SIGNER_HELP).catch((e) => report.failures.push(`setup help envelope: ${e.message}`));
    }

    // (b) on a phone, then on a desktop.
    const ctxB = await newContext(browser, PHONE);
    const pb = await ctxB.newPage();
    pb.setDefaultTimeout(20000);
    watchErrors(pb, 'signer phone');
    const okB = okA && await runFlow(new Flow('b-sign-phone', 'The person signs on a phone', pb, { touch: true, device: 'iPhone 13' }), (f) => flowB(f, SIGNER_PHONE));
    await ctxB.close();
    const ctxB2 = await newContext(browser, DESKTOP);
    const pb2 = await ctxB2.newPage();
    pb2.setDefaultTimeout(20000);
    watchErrors(pb2, 'signer desktop');
    if (okA) await runFlow(new Flow('b-sign-desktop', 'A person signs on a desktop', pb2), (f) => flowB(f, SIGNER_DESK));
    await ctxB2.close();

    // (c) template, (d) download, (e) settings: the sender again, signed in.
    if (okA && ids.template) await runFlow(new Flow('c-template-send', 'The sender sends from a template', sender), (f) => flowC(f, 'Sponsor agreement'));
    const tplSent = (sender.url().match(/env_[A-Za-z0-9_-]+/) || [])[0];
    if (okB) await runFlow(new Flow('d-find-download', 'The sender finds the completed document and downloads it', sender), (f) => flowD(f, report.first_subject || `Please sign: ${DOC_NAME}`));
    if (okA) await runFlow(new Flow('e-settings-name', 'The sender changes their name in Settings', sender), (f) => flowE(f));

    // (f) help on the signing page, on a phone.
    let helpLink = null;
    if (okA && ids.help) {
      const ctxF = await newContext(browser, PHONE);
      const pf = await ctxF.newPage();
      pf.setDefaultTimeout(20000);
      watchErrors(pf, 'signer needing help');
      await runFlow(new Flow('f-signer-help', 'A signer who cannot sign right now looks for help', pf, { touch: true, device: 'iPhone 13' }), (f) => flowF(f, SIGNER_HELP));
      helpLink = (await waitMail(SIGNER_HELP.email, (x) => x.link?.includes('/sign/'), 'invitation').catch(() => null))?.link;
      await ctxF.close();
    }

    // The inventory.
    if (okA) {
      console.log('\n== inventory');
      try {
        await inventory(browser, sender, { pdf, outEnvelope: tplSent || ids.desk, doneEnvelope: firstEnvelope, signLink: helpLink });
        console.log(`ok    inventory: ${Object.keys(report.inventory).length} places`);
      } catch (e) {
        report.failures.push(`inventory: ${e.message.split('\n')[0]}`);
        console.log(`FAIL  inventory: ${e.message.split('\n')[0]}`);
        await sender.screenshot({ path: path.join(OUT, 'inventory', 'FAIL.png'), fullPage: true }).catch(() => {});
      }
    }

    // One line per flow.
    report.table = Object.entries(report.flows).map(([id, x]) => ({ flow: id, ok: x.ok, actions: x.actions_total, screens: x.screens_total, choices_seen: x.choices_seen_total, max_choices: x.choices_max_one_screen, words: x.words_seen_total, notices: x.notices_seen_total, wall_s: +(x.wall_ms / 1000).toFixed(1), klm_s: x.klm_estimate_s }));
    console.log('');
    console.table(report.table);
  } catch (e) {
    report.failures.push(`run: ${e.message}`);
    console.error(e);
  } finally {
    writeReport();
    await browser?.close().catch(() => {});
    console.log(`\nWrote ${path.join(OUT, 'ux-flows.json')}${report.failures.length ? `\nFAILED: ${report.failures.join('; ')}` : '\nUX FLOWS OK'}`);
    process.exit(report.failures.length ? 1 : 0);
  }
})();
