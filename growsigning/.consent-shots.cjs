// usage: node shots.cjs <base> <prefix> <appdir>
const [base, prefix, appdir] = process.argv.slice(2);
const path = require('path');
const { chromium } = require('playwright');
const { PDFDocument } = require(path.join(appdir, 'node_modules/pdf-lib'));
(async () => {
  let cookie = '';
  const call = async (method, url, body, form) => {
    const r = await fetch(`${base}/api${url}`, { method, headers: { cookie, ...(body && !form ? { 'content-type': 'application/json' } : {}) }, body: form ? body : body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
    const t = r.headers.get('content-type') || '';
    return { status: r.status, data: t.includes('json') ? await r.json() : null };
  };
  const email = `sender${Date.now()}@example.org`;
  let r = await call('POST', '/auth/signup', { name: 'Jimi Sender', email, password: 'correct horse battery' });
  if (r.status !== 200) throw new Error('signup ' + JSON.stringify(r.data));
  const out = (await (await fetch(`${base}/api/dev/outbox`)).json()).emails;
  const m = out.find((x) => x.to_email === email);
  const html = await (await fetch(`${base}/api/dev/outbox?id=${m.id}`)).text();
  const code = (html.match(/\b(\d{6})\b/) || [])[1];
  const tok = ((m.link || '').match(/token=([^&]+)/) || [])[1];
  r = tok ? await call('POST', '/auth/verify', { token: tok }) : { status: 0 };
  if (r.status !== 200) { r = await call('POST', '/auth/verify-code', { code }); }
  console.log('verify', r.status, JSON.stringify(r.data).slice(0, 200), m.link);
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText('Tree planting agreement', { x: 72, y: 700 });
  const f = new FormData();
  f.append('file', new Blob([await d.save()], { type: 'application/pdf' }), 'Agreement.pdf');
  r = await call('POST', '/files', f, true);
  if (r.status !== 200) throw new Error('file ' + JSON.stringify(r.data));
  const semail = `sam${Date.now()}@example.com`;
  r = await call('POST', '/envelopes', { subject: 'Tree planting agreement', message: 'Please sign.', documents: [{ id: 'd', file_id: r.data.id }], recipients: [{ id: 'r', role: 'signer', name: 'Sam Signer', email: semail }], fields: [{ id: 'f', document_id: 'd', recipient_id: 'r', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06 }] });
  if (r.status !== 200) throw new Error('env ' + JSON.stringify(r.data));
  const id = r.data.envelope.id;
  r = await call('POST', `/envelopes/${id}/send`, {});
  if (r.status !== 200) throw new Error('send ' + JSON.stringify(r.data));
  const out2 = (await (await fetch(`${base}/api/dev/outbox`)).json()).emails;
  const link = out2.find((x) => x.to_email === semail && /\/sign\//.test(x.link || '')).link;
  console.log('link', link);
  const browser = await chromium.launch();
  const res = {};
  for (const [name, w, h] of [['phone-390x844', 390, 844], ['desktop-1440x900', 1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(link);
    await page.locator('.sg-agree input').waitFor();
    await page.waitForTimeout(600);
    res[name] = await page.evaluate(() => {
      const tick = document.querySelector('.sg-agree input');
      const range = document.createRange();
      range.setStart(document.body, 0); range.setEndBefore(tick.closest('label'));
      const n = (s) => (s.trim().match(/\S+/g) || []).length;
      const card = document.querySelector('.sg-consent');
      const btn = document.querySelector('.sg-continue').getBoundingClientRect();
      return { wordsBeforeTick: n(range.toString()), wordsInCard: n(card.innerText), agree: tick.closest('label').innerText.trim(), continueBottom: Math.round(btn.bottom), viewport: innerHeight, scrolls: document.documentElement.scrollHeight > innerHeight };
    });
    await page.screenshot({ path: path.join(appdir, 'research', `${prefix}-${name}.png`) });
    if (process.argv[5] === 'after') {
      await page.locator('.sg-how summary').click();
      await page.waitForTimeout(300);
      res[name].details = await page.locator('.sg-how').innerText();
      await page.screenshot({ path: path.join(appdir, 'research', `${prefix}-${name}-details-open.png`), fullPage: true });
      await page.locator('.sg-how summary').click();
      // without ticking: refused
      await page.locator('.sg-continue').click();
      res[name].refusedWithoutTick = await page.locator('#sg-agree-err').innerText();
      await page.locator('.sg-agree input').check();
      await page.locator('.sg-continue').click();
      await page.locator('.sg-consent').waitFor({ state: 'detached' });
      await page.waitForTimeout(800);
      res[name].afterAgree = 'document open';
      await page.screenshot({ path: path.join(appdir, 'research', `${prefix}-${name}-agreed.png`) });
    }
    await ctx.close();
  }
  if (process.argv[5] === 'after') {
    const ev = await call('GET', `/envelopes/${id}`);
    const audit = (ev.data.audit || ev.data.envelope?.audit || []).filter((a) => /Agreed/.test(a.action));
    res.audit = audit.map((a) => `${a.action}: ${a.detail} [ip ${a.ip}] ${a.at}`);
  }
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
