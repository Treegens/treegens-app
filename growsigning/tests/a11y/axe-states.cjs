// axe-core in a real browser on every state of the signing page, the editor and the envelope page, at 320 and 1280.
// node tests/a11y/axe-states.cjs http://localhost:3851
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3851';
const OUT = process.env.A11Y_OUT || path.resolve(__dirname, '../out/a11y');
fs.mkdirSync(OUT, { recursive: true });
const STAMP = Date.now();
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [path.resolve(__dirname, '../..')] }), 'utf8');
const PDF = fs.readFileSync(path.join(__dirname, 'sample.pdf')).toString('base64');
const results = {};

async function api(page, p, opts = {}) {
  for (let i = 0; i < 5; i++) { try { return await api1(page, p, opts); } catch (e) { if (i === 4) throw e; await page.waitForTimeout(3000); } }
}
async function api1(page, p, opts = {}) {
  return page.evaluate(async ([p, opts]) => {
    const init = { method: opts.method || (opts.body || opts.pdf ? 'POST' : 'GET') };
    if (opts.pdf) {
      const bytes = Uint8Array.from(atob(opts.pdf), (c) => c.charCodeAt(0));
      const f = new FormData(); f.append('file', new Blob([bytes], { type: 'application/pdf' }), 'Lease.pdf'); init.body = f;
    } else if (opts.body) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(opts.body); }
    const r = await fetch('/api' + p, init); return r.json();
  }, [p, opts]);
}
// A dev server can still be redirecting from the page before (a new draft opens its editor): try a navigation again.
async function go(page, url) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.goto(url);
    } catch (e) {
      if (i === 2) throw e;
      await page.waitForTimeout(2000);
    }
  }
}
async function mail(to, test) {
  for (let i = 0; i < 40; i++) {
    const m = ((await (await fetch(`${BASE}/api/dev/outbox`)).json()).emails || []).find((x) => x.to_email === to && test(x));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no mail to ' + to);
}
async function axe(page, name) {
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200), summary: n.failureSummary.slice(0, 300) })) }));
  });
  // Reflow (WCAG 1.4.10): at 320 px, which is 1280 px at 400 percent zoom, nothing makes the page scroll sideways.
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) r.push({ id: 'reflow', impact: 'serious', help: `The page is ${wide} px wider than the window`, nodes: [] });
  results[name] = r;
  await page.screenshot({ path: path.join(OUT, `axe-${name}.png`), fullPage: false });
  const bad = r.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  console.log(`${name}: ${bad.length ? bad.map((v) => `${v.impact} ${v.id} (${v.nodes.length})`).join(', ') : 'no serious or critical'}${r.length - bad.length ? `; ${r.length - bad.length} lesser` : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/signup');
  const email = `ax-${STAMP}@example.org`;
  await api(p, '/auth/signup', { body: { name: 'Rosa Sender', email, password: 'correct horse battery 42', phone: `+4474${String(Date.now()).slice(-8)}` } });
  // Confirmed the way the link in the email does it, in this browser.
  const confirm = (await mail(email, (x) => x.link?.includes('verify-email'))).link;
  await api(p, '/auth/verify', { body: { token: new URL(confirm).searchParams.get('token') } });
  await p.waitForTimeout(1500);
  const make = async (who, extra = {}) => {
    const file = await api(p, '/files', { pdf: PDF });
    const to = `s-${who}-${STAMP}@example.org`;
    const r = await api(p, '/envelopes', { body: { subject: 'Garden lease for the community plot', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: to, ...(extra.code ? { access_code: extra.code } : {}) }], fields: [
      { id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
      { id: 'g', document_id: 'd', recipient_id: 'r', type: 'text', page: 0, x: 0.5, y: 0.6, w: 0.3, h: 0.04, required: true, label: 'Plot number' },
      ...(extra.stamp ? [{ id: 'h', document_id: 'd', recipient_id: 'r', type: 'stamp', required: false, page: 0, x: 0.6, y: 0.7, w: 0.2, h: 0.12 }] : []),
    ] } });
    if (!r.envelope) throw new Error(JSON.stringify(r));
    const s = await api(p, `/envelopes/${r.envelope.id}/send`, { body: {} });
    if (s.error) throw new Error(JSON.stringify(s));
    return { id: r.envelope.id, link: (await mail(to, (x) => x.link?.includes('/sign/'))).link };
  };
  const sizes = { w320: { width: 320, height: 640 }, w1280: { width: 1280, height: 900 } };
  const only = process.env.ONLY || '';
  for (const [size, vp] of Object.entries(sizes)) {
    // Sender screens: the editor and the envelope page.
    const sc = await browser.newContext({ viewport: vp, storageState: await ctx.storageState() });
    const sp = await sc.newPage();
    const env = await make('env-' + size);
    await go(sp, BASE + '/app/envelopes/new');
    await sp.waitForTimeout(3000);
    await axe(sp, `${size}-editor-start`);
    // A draft with a file and a person: the field step.
    const file = await api(sp, '/files', { pdf: PDF });
    const draft = await api(sp, '/envelopes', { body: { subject: 'Draft lease', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Dan Draft', email: `dd-${STAMP}@example.org` }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] } });
    await go(sp, `${BASE}/app/envelopes/${draft.envelope.id}/edit`);
    await sp.waitForTimeout(3500);
    await axe(sp, `${size}-editor-draft`);
    const step2 = sp.getByRole('button', { name: /^(Next|Continue|Place fields|Fields)/ }).first();
    if (await step2.isVisible().catch(() => false)) { await step2.click(); await sp.waitForTimeout(2500); await axe(sp, `${size}-editor-step2`); }
    const step3 = sp.getByRole('button', { name: /^(Next|Continue|Review)/ }).first();
    if (await step3.isVisible().catch(() => false)) { await step3.click(); await sp.waitForTimeout(2500); await axe(sp, `${size}-editor-step3`); }
    await go(sp, `${BASE}/app/envelopes/${env.id}`);
    await sp.waitForTimeout(3000);
    await axe(sp, `${size}-envelope`);
    await sc.close();

    // Code check.
    const coded = await make('code-' + size, { code: 'tulip' });
    let c = await browser.newContext({ viewport: vp });
    let s = await c.newPage();
    await go(s, coded.link);
    await s.waitForTimeout(3500);
    await axe(s, `${size}-sign-code`);
    await c.close();

    // Consent, document, adopt, stamp, review, done.
    const one = await make('sign-' + size, { stamp: true });
    c = await browser.newContext({ viewport: vp });
    s = await c.newPage();
    await go(s, one.link);
    await s.getByRole('checkbox').first().waitFor({ timeout: 60000 });
    await axe(s, `${size}-sign-consent`);
    await s.getByRole('checkbox').first().check();
    await s.locator('.sg-continue').click();
    await s.locator('.sg-doc .field.fill').first().waitFor({ timeout: 60000 });
    await s.waitForTimeout(1500);
    await axe(s, `${size}-sign-document`);
    const next = () => s.getByRole('button', { name: 'Next', exact: true }).first().click();
    await next();
    await s.waitForTimeout(1500);
    await axe(s, `${size}-sign-adopt`);
    // A typed name that is not the name the document is for: the review asks about it at Finish.
    await s.locator('[role=dialog] input').first().fill('S. Signer');
    await s.locator('[role=dialog]').getByRole('button', { name: 'Sign', exact: true }).click();
    await s.waitForTimeout(1200);
    await next();
    await s.waitForTimeout(1000);
    await s.keyboard.type('42');
    const done = s.locator('[role=dialog]').getByRole('button', { name: 'Done', exact: true });
    if (await done.isVisible().catch(() => false)) await done.click();
    await s.waitForTimeout(600);
    // Stamp dialog (optional here, so Next does not go there): a click on it.
    await s.locator('.sg-doc .field.fill.stamp').first().click();
    await s.waitForTimeout(1500);
    await axe(s, `${size}-sign-stamp`);
    await s.keyboard.press('Escape');
    await s.waitForTimeout(600);
    // The stamp is optional only if the sender said so; take it off the envelope by finishing without it is not
    // possible, so the review is reached through Finish with what is there.
    await s.getByRole('button', { name: /^Finish/ }).first().click().catch((e) => console.log('finish', e.message));
    await s.waitForTimeout(2000);
    await axe(s, `${size}-sign-review`);
    const fin = s.locator('[role=dialog]').getByRole('button', { name: /^(Finish|Sign and finish|Finish anyway)/ }).last();
    if (await fin.isVisible().catch(() => false)) await fin.click(); else console.log('no review dialog');
    await s.waitForTimeout(3000);
    await axe(s, `${size}-sign-done`);
    await c.close();
    // Declined.
    const dec = await make('dec-' + size);
    c = await browser.newContext({ viewport: vp });
    s = await c.newPage();
    await go(s, dec.link);
    await s.getByRole('checkbox').first().waitFor({ timeout: 60000 });
    await api(s, `/sign/${dec.link.split('/sign/')[1].split(/[?#]/)[0]}/decline`, { body: { reason: 'The plot number is wrong.' } });
    await s.reload();
    await s.waitForTimeout(3500);
    await axe(s, `${size}-sign-declined`);
    await c.close();
  }
  fs.writeFileSync(path.join(OUT, 'axe-results.json'), JSON.stringify(results, null, 1));
  await browser.close();
  const bad = Object.values(results).flat().filter((v) => v.impact === 'serious' || v.impact === 'critical');
  if (bad.length) process.exit(3);
})().catch((e) => { console.error(e); fs.writeFileSync(path.join(OUT, 'axe-results.json'), JSON.stringify(results, null, 1)); process.exit(1); });
