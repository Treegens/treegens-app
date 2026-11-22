// The editor without dragging (WCAG 2.5.7): a field type chosen with the keyboard lands on the page, and the arrow
// keys move it. node tests/a11y/keyboard-editor.cjs http://localhost:3851
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3851';
const STAMP = Date.now();
const PDF = fs.readFileSync(path.join(__dirname, 'sample.pdf')).toString('base64');

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

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/signup');
  const email = `ke-${STAMP}@example.org`;
  await api(p, '/auth/signup', { body: { name: 'Rosa Sender', email, password: 'correct horse battery 42' } });
  // Confirmed the way the link in the email does it, in this browser.
  const confirm = (await mail(email, (x) => x.link?.includes('verify-email'))).link;
  await api(p, '/auth/verify', { body: { token: new URL(confirm).searchParams.get('token') } });
  await p.waitForTimeout(1500);
  const file = await api(p, '/files', { pdf: PDF });
  const d = await api(p, '/envelopes', { body: { subject: 'Draft', documents: [{ id: 'd', file_id: file.id }], recipients: [{ id: 'r', role: 'signer', name: 'Dan Draft', email: `dd-${STAMP}@example.org` }] } });
  await p.goto(`${BASE}/app/envelopes/${d.envelope.id}/edit`);
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: 'Next', exact: true }).first().focus();
  await p.keyboard.press('Enter');
  await p.locator('[data-doc] .pdfpage').first().waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
  // Tab to the Signature field type and press Enter: no mouse.
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    await p.keyboard.press('Tab');
    found = await p.evaluate(() => /^Signature$/.test(document.activeElement?.textContent?.trim() || ''));
  }
  if (!found) throw new Error('Tab did not reach the Signature field type');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(800);
  await p.waitForTimeout(2500); // the editor saves on its own
  const placed = (await api(p, `/envelopes/${d.envelope.id}`)).envelope.fields;
  if (placed.length !== 1) throw new Error(`Enter on Signature placed ${placed.length} fields`);
  // The new field is selected: the arrow keys move it.
  for (let i = 0; i < 5; i++) await p.keyboard.press('Shift+ArrowRight');
  await p.waitForTimeout(3000);
  const moved = (await api(p, `/envelopes/${d.envelope.id}`)).envelope.fields[0];
  const dx = moved.x - placed[0].x;
  console.log(`placed at x=${placed[0].x.toFixed(3)} y=${placed[0].y.toFixed(3)}; after 5 x Shift+Right x=${moved.x.toFixed(3)} (moved ${dx.toFixed(3)})`);
  await p.screenshot({ path: path.resolve(__dirname, '../out/a11y-editor-keyboard.png') }).catch(() => {});
  await browser.close();
  if (!(dx > 0.04)) process.exit(2);
})().catch((e) => { console.error(e); process.exit(1); });
