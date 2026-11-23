// Signing with the keyboard alone: Tab, Shift+Tab, Space and Enter, no mouse. Logs what has the focus and what a
// screen reader would be told (the accessible name), and the size of each target.
// node tests/a11y/keyboard-sign.cjs http://localhost:3851 [320|390|1280]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3851';
const W = Number(process.argv[3] || 390);
const OUT = process.env.A11Y_OUT || path.resolve(__dirname, '../out/a11y');
fs.mkdirSync(OUT, { recursive: true });
const STAMP = Date.now();
const PDF = fs.readFileSync(path.join(__dirname, 'sample.pdf')).toString('base64');
const log = [];
const say = (s) => (console.log(s), log.push(s));

async function api(page, p, opts = {}) {
  for (let i = 0; i < 5; i++) {
    try {
      return await page.evaluate(async ([p, opts]) => {
        const init = { method: opts.method || (opts.body || opts.pdf ? 'POST' : 'GET') };
        if (opts.pdf) {
          const bytes = Uint8Array.from(atob(opts.pdf), (c) => c.charCodeAt(0));
          const f = new FormData(); f.append('file', new Blob([bytes], { type: 'application/pdf' }), 'Lease.pdf'); init.body = f;
        } else if (opts.body) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(opts.body); }
        const r = await fetch('/api' + p, init); return r.json();
      }, [p, opts]);
    } catch (e) { if (i === 4) throw e; await page.waitForTimeout(3000); }
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
const focused = (s) => s.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: 'body' };
  const box = el.classList.contains('sg-vh') && el.closest('label') ? el.closest('label') : el;
  const r = box.getBoundingClientRect();
  const before = getComputedStyle(box, '::before');
  const hit = before.content !== 'none' && before.width !== 'auto' ? { hw: Math.round(parseFloat(before.width)), hh: Math.round(parseFloat(before.height)) } : {};
  const labelled = el.getAttribute('aria-labelledby');
  const name = el.getAttribute('aria-label') || (labelled && labelled.split(' ').map((id) => document.getElementById(id)?.textContent).join(' ')) || (el.labels && el.labels[0]?.textContent) || el.textContent?.trim().slice(0, 80);
  const group = el.closest('[role=group][aria-label]')?.getAttribute('aria-label');
  const visible = getComputedStyle(el).outlineStyle !== 'none' || getComputedStyle(el).boxShadow !== 'none';
  return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name, required: el.getAttribute('aria-required'), group, w: Math.round(r.width), h: Math.round(r.height), ...hit, ring: visible, dialog: !!el.closest('[role=dialog]') };
});
async function tabTo(s, test, what, max = 80, back = false) {
  for (let i = 0; i < max; i++) {
    await s.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const f = await focused(s);
    if (test(f)) { say(`  Tab x${i + 1} to ${what}: ${JSON.stringify(f)}`); return f; }
  }
  throw new Error('could not reach ' + what + ' with Tab');
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/signup');
  const email = `kb-${STAMP}@example.org`;
  await api(p, '/auth/signup', { body: { name: 'Rosa Sender', email, password: 'correct horse battery 42', phone: `+4474${String(Date.now()).slice(-8)}` } });
  // Confirmed the way the link in the email does it, in this browser.
  const confirm = (await mail(email, (x) => x.link?.includes('verify-email'))).link;
  await api(p, '/auth/verify', { body: { token: new URL(confirm).searchParams.get('token') } });
  await p.waitForTimeout(1500);
  const file = await api(p, '/files', { pdf: PDF });
  const to = `kb-s-${STAMP}@example.org`;
  const r = await api(p, '/envelopes', { body: { subject: 'Garden lease for the community plot', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: to }], fields: [
    { id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 },
    { id: 'g', document_id: 'd', recipient_id: 'r', type: 'text', page: 0, x: 0.5, y: 0.6, w: 0.3, h: 0.04, required: true, label: 'Plot number' },
    { id: 'c', document_id: 'd', recipient_id: 'r', type: 'checkbox', page: 0, x: 0.1, y: 0.7, w: 0.03, h: 0.02, required: false, label: 'Send me news' },
  ] } });
  const sent = await api(p, `/envelopes/${r.envelope.id}/send`, { body: {} });
  if (sent.error) throw new Error(sent.error);
  const link = (await mail(to, (x) => x.link?.includes('/sign/'))).link;

  const c = await browser.newContext({ viewport: { width: W, height: W < 800 ? 844 : 900 } });
  const s = await c.newPage();
  await s.goto(link);
  await s.getByRole('checkbox').first().waitFor({ timeout: 60000 });
  say(`width ${W}: consent`);
  await tabTo(s, (f) => f.tag === 'input' && /agree|consent|electronic/i.test(f.name || '') , 'the consent tick');
  await s.keyboard.press('Space');
  await tabTo(s, (f) => f.tag === 'button' && /^(Continue|Start|Agree)/i.test(f.name || ''), 'Continue');
  await s.keyboard.press('Enter');
  await s.locator('.sg-doc .field.fill').first().waitFor({ timeout: 60000 });
  await s.waitForTimeout(1500);
  await s.screenshot({ path: path.join(OUT, `kbd-${W}-1-document.png`) });
  say('document');
  // What a screen reader is told about each field on the page: its name and the group (the page) around it.
  const names = await s.evaluate(() => [...document.querySelectorAll('.sg-doc .field.fill')].map((el) => {
    const c = el.matches('button, input, textarea, select') ? el : el.querySelector('button, input, textarea, select');
    return `${c?.getAttribute('aria-label') || c?.textContent?.trim()}${c?.getAttribute('aria-required') ? ` (aria-required ${c.getAttribute('aria-required')})` : ''} [group: ${el.closest('[role=group][aria-label]')?.getAttribute('aria-label')}]`;
  }));
  for (const n of names) say(`  field: ${n}`);
  // Next: the first field (the signature) gets the focus and its dialog opens.
  await tabTo(s, (f) => f.tag === 'button' && f.name === 'Next', 'Next');
  await s.keyboard.press('Enter');
  await s.waitForTimeout(1200);
  let f = await focused(s);
  say(`  after Next: ${JSON.stringify(f)}`);
  await s.screenshot({ path: path.join(OUT, `kbd-${W}-2-adopt.png`) });
  if (!f.dialog) throw new Error('Next did not open the signature dialog with the focus in it');
  // Type the name (it may be filled in already) and adopt it.
  const box = await s.locator('[role=dialog] input[type=text]').first();
  if (!(await box.inputValue().catch(() => ''))) {
    await tabTo(s, (x) => x.tag === 'input', 'the name box');
    await s.keyboard.type('Sam Signer');
  }
  await tabTo(s, (x) => x.tag === 'button' && x.dialog && /^(Sign|Adopt|Use)/.test(x.name || ''), 'the dialog main button');
  await s.keyboard.press('Enter');
  await s.waitForTimeout(1500);
  f = await focused(s);
  say(`  after adopting: ${JSON.stringify(f)}`);
  // Next again: the text field.
  if (!((f.tag === 'input' || f.tag === 'textarea') && /Plot number/.test(f.name || ''))) {
    await tabTo(s, (x) => x.tag === 'button' && x.name === 'Next', 'Next', 80, true).catch(() => tabTo(s, (x) => x.tag === 'button' && x.name === 'Next', 'Next'));
    await s.keyboard.press('Enter');
    await s.waitForTimeout(1000);
    f = await focused(s);
    say(`  after Next: ${JSON.stringify(f)}`);
  }
  await s.screenshot({ path: path.join(OUT, `kbd-${W}-3-text.png`) });
  if (f.dialog) {
    // A sheet on a phone: type, then its own Done/Next.
    await s.keyboard.type('42');
    await tabTo(s, (x) => x.tag === 'button' && x.dialog && /^(Done|Next|Save)/.test(x.name || ''), 'the sheet button');
    await s.keyboard.press('Enter');
  } else {
    if (!((f.tag === 'input' || f.tag === 'textarea') && /Plot number/.test(f.name || ''))) throw new Error('Next did not land on the text field: ' + JSON.stringify(f));
    await s.keyboard.type('42');
  }
  await s.waitForTimeout(800);
  // The optional tick box: Tab reaches it and Space ticks it.
  const tick = await tabTo(s, (x) => x.tag === 'input' && /Send me news/.test(x.name || ''), 'the optional tick box', 80).catch(() => tabTo(s, (x) => x.tag === 'input' && /Send me news/.test(x.name || ''), 'the optional tick box', 80, true));
  await s.keyboard.press('Space');
  await tabTo(s, (x) => x.tag === 'button' && /^Finish/.test(x.name || ''), 'Finish', 80).catch(() => tabTo(s, (x) => x.tag === 'button' && /^Finish/.test(x.name || ''), 'Finish', 80, true));
  await s.keyboard.press('Enter');
  await s.waitForTimeout(2500);
  f = await focused(s);
  say(`  after Finish: ${JSON.stringify(f)}`);
  await s.screenshot({ path: path.join(OUT, `kbd-${W}-4-after-finish.png`) });
  if (f.dialog) {
    await tabTo(s, (x) => x.tag === 'button' && x.dialog && /^(Finish|Sign|Confirm)/.test(x.name || ''), 'the review main button', 40).catch(() => tabTo(s, (x) => x.tag === 'button' && x.dialog && /^(Finish|Sign|Confirm)/.test(x.name || ''), 'the review main button', 40, true));
    await s.keyboard.press('Enter');
    await s.waitForTimeout(3000);
  }
  const done = await s.evaluate(() => document.body.innerText.slice(0, 400));
  await s.screenshot({ path: path.join(OUT, `kbd-${W}-5-done.png`) });
  const status = await api(p, `/envelopes/${r.envelope.id}`);
  const rec = (status.envelope?.recipients || status.recipients || []).find((x) => x.email === to);
  say(`done screen: ${done.replace(/\s+/g, ' ').slice(0, 200)}`);
  say(`server says: ${rec?.status} ${status.envelope?.status}`);
  fs.writeFileSync(path.join(OUT, `kbd-${W}.log`), log.join('\n'));
  await browser.close();
  if (rec?.status !== 'completed' && rec?.status !== 'signed') process.exit(2);
})().catch((e) => { console.error(e); fs.writeFileSync(path.join(OUT, `kbd-${W}.log`), log.join('\n') + '\nFAILED ' + e.message); process.exit(1); });
