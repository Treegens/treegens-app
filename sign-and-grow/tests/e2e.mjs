// Browser test of the whole product against a production build. Run `npm run build` first, then `npm run test:e2e`.
// Each section is tried on its own, so one run reports everything that is broken instead of stopping at the first.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { PDFDocument, StandardFonts } from 'pdf-lib';

const PORT = 3411;
const BASE = `http://localhost:${PORT}`;
const OUT = path.resolve('tests/out');
const shots = process.env.SHOTS === '1';
fs.mkdirSync(OUT, { recursive: true });

async function makePdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < 2; p++) {
    const page = d.addPage([612, 792]);
    page.drawText(p === 0 ? 'Mangrove Restoration Agreement' : 'Signatures', { x: 72, y: 700, size: 22, font: bold });
    const lines = p === 0
      ? ['This agreement is made between the Planting Partner and the Sponsor.', 'The Sponsor agrees to fund the planting and care of mangrove seedlings', 'along the agreed stretch of coastline for a period of three years.', '', 'Number of seedlings pledged: ______________________']
      : ['Signed by the Sponsor:', '', '', '', 'Date:'];
    lines.forEach((l, i) => page.drawText(l, { x: 72, y: 650 - i * 24, size: 12, font }));
  }
  const file = path.join(OUT, 'agreement.pdf');
  fs.writeFileSync(file, await d.save());
  return file;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'growsigning-e2e-'));
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], { env: { ...process.env, DATA_DIR: dataDir, DEV_OUTBOX: '1', APP_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (b) => (log += b));
server.stderr.on('data', (b) => (log += b));
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/me`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start\n' + log);
}

const outbox = async () => (await (await fetch(`${BASE}/api/dev/outbox`)).json()).emails;
const mailFor = async (to, test) => (await outbox()).find((m) => m.to_email === to && test(m));
const mailHtml = async (id) => (await fetch(`${BASE}/api/dev/outbox?id=${id}`)).text();

const failures = [];
const errors = [];
let page, ctx, browser, pdf, envId;
const shot = async (p, name, full = false) => shots && p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });

async function section(name, fn, p = () => page) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${String(e?.message || e).split('\n').slice(0, 6).join('\n      ')}`);
    try {
      await p().screenshot({ path: path.join(OUT, `fail-${name.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
    } catch {}
  }
}
// Calls the API as the logged-in sender, for setting up situations faster than clicking through them.
const asSender = (pathname, body, method) => page.evaluate(async ([pathname, body, method]) => {
  const r = await fetch(`/api${pathname}`, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [pathname, body, method]);

try {
  await ready();
  pdf = await makePdf();
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

  await section('landing page', async () => {
    await page.goto(BASE);
    await page.getByRole('heading', { name: /Trees grow/ }).waitFor();
    await page.getByText(/\$9/).first().waitFor();
    await page.getByText(/mangrove/i).first().waitFor();
    await shot(page, '01-landing', true);
  });

  await section('sign up and confirm email', async () => {
    await page.goto(`${BASE}/signup`);
    await page.getByLabel('Your name').fill('Jimi Sender');
    await page.getByLabel('Email').fill('jimi@example.org');
    await page.getByLabel(/Password/).fill('plant-more-trees');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/app');
    await page.getByText(/Confirm your email/).waitFor();
    const m = await mailFor('jimi@example.org', (x) => x.link?.includes('verify-email'));
    await page.goto(m.link);
    await page.getByText('Email confirmed').waitFor();
    await page.goto(`${BASE}/app`);
    await page.getByRole('heading', { name: /Jimi/ }).waitFor();
    assert.equal(await page.getByText(/Confirm your email/).count(), 0);
  });

  await section('create an envelope, place fields, send', async () => {
    await page.getByRole('link', { name: 'Send for signature' }).click();
    await page.waitForURL('**/edit');
    await page.locator('input[type=file]').first().setInputFiles(pdf);
    await page.getByLabel('Document name').waitFor();
    await page.getByRole('button', { name: 'Add recipient' }).click();
    await page.getByLabel('Recipient name').fill('Ada Sponsor');
    await page.getByLabel('Recipient email').fill('ada@example.org');
    await page.getByRole('button', { name: 'Add recipient' }).click();
    await page.getByLabel('Recipient name').nth(1).fill('Cee Copy');
    await page.getByLabel('Recipient email').nth(1).fill('cee@example.org');
    await page.getByLabel('Role', { exact: true }).nth(1).selectOption('cc');
    await shot(page, '02-editor-add', true);

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.locator('.pdfpage canvas').first().waitFor();
    const place = async (tool, pageIndex, x, y) => {
      await page.locator('.palette').getByRole('button', { name: tool, exact: true }).click();
      const el = page.locator('.pdfpage').nth(pageIndex);
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      await page.mouse.click(b.x + b.width * x, b.y + b.height * y);
    };
    await place('Text', 0, 0.56, 0.305);
    await page.getByLabel(/^Label/).fill('Seedlings pledged');
    await place('Signature', 1, 0.3, 0.23);
    await place('Date signed', 1, 0.25, 0.305);
    assert.equal(await page.locator('.field.edit').count(), 3);
    // Undo and redo.
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.field.edit').count(), 2, 'undo removes the last field');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await page.locator('.field.edit').count(), 3, 'redo brings it back');
    await page.locator('.pdfpage').nth(1).scrollIntoViewIfNeeded();
    await shot(page, '03-editor-fields');

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText(/saves about 4 sheets/).waitFor();
    await shot(page, '04-editor-review', true);
    await page.getByRole('button', { name: 'Send', exact: true }).last().click();
    await page.waitForURL(/\/app\/envelopes\/env_[^/?]+/);
    envId = page.url().match(/env_[A-Za-z0-9_-]+/)[0];
    await page.getByText(/Waiting on Ada Sponsor/).first().waitFor();
    await shot(page, '05-envelope-out', true);
  });

  let signLink;
  await section('the invitation says who sent it and carries a security code that checks out', async () => {
    const m = await mailFor('ada@example.org', (x) => x.link?.includes('/sign/'));
    assert.ok(m, 'signer got an email');
    signLink = m.link;
    const html = await mailHtml(m.id);
    assert.match(html, /Jimi Sender \(jimi@example\.org\)/);
    const code = /letter-spacing:1px[^>]*>([A-Z0-9-]{14})</.exec(html)?.[1];
    assert.ok(code, 'security code in the email');
    const p = await (await browser.newContext()).newPage();
    await p.goto(`${BASE}/check`);
    await p.getByRole('textbox').first().fill(code);
    await p.getByRole('button', { name: /Check/ }).click();
    await p.getByText(/Genuine/).first().waitFor();
    await p.getByText('Jimi Sender').first().waitFor();
    await shot(p, '06-check-code', true);
    await p.getByRole('textbox').first().waitFor().catch(() => {});
    await p.close();
  });

  await section('correct the envelope after sending, without voiding it', async () => {
    await page.goto(`${BASE}/app/envelopes/${envId}`);
    await page.getByRole('link', { name: /Edit envelope/ }).click();
    await page.waitForURL('**/edit');
    await page.getByText(/already out/i).first().waitFor();
    await page.getByLabel('Recipient name').nth(1).fill('Cee Copy-Corrected');
    await page.getByRole('button', { name: /Step 3/ }).click();
    await page.getByText(/What happens when you save/).waitFor();
    await shot(page, '07-correct-review', true);
    await page.getByRole('button', { name: 'Save changes' }).last().click();
    await page.waitForURL(new RegExp(`/app/envelopes/${envId}(\\?|$)`));
    await page.getByText('Cee Copy-Corrected').first().waitFor();
    assert.equal((await asSender(`/envelopes/${envId}`)).data.envelope.status, 'sent', 'still out, not voided');
  });

  await section('sign on a phone', async () => {
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const sp = await phone.newPage();
    sp.setDefaultTimeout(15000);
    sp.on('pageerror', (e) => errors.push('signer: ' + e));
    await sp.goto(signLink);
    await sp.getByText('Jimi Sender').first().waitFor();
    await sp.getByText(/I agree to use electronic records/).click();
    await sp.getByRole('button', { name: 'Continue' }).click();
    await sp.locator('.pdfpage canvas').first().waitFor();
    assert.equal(await sp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scroll on a phone');
    await shot(sp, '08-sign-mobile');
    await sp.getByRole('button', { name: 'Next', exact: true }).click();
    await sp.getByRole('dialog').getByLabel('Seedlings pledged').fill('2,500');
    await sp.waitForTimeout(400); // let the sheet finish sliding in before the picture
    await shot(sp, '09-sign-sheet');
    await sp.getByRole('dialog').getByRole('button', { name: 'Next' }).click();
    await sp.getByRole('button', { name: /Sign here/ }).click();
    await sp.getByRole('dialog').getByLabel('Full name').fill('Ada Sponsor');
    await sp.getByRole('button', { name: 'Adopt and sign' }).click();
    await sp.locator('.field.fill img').waitFor();
    // Autosave: what was typed survives a reload.
    await sp.waitForTimeout(2500);
    await sp.reload();
    await sp.locator('.pdfpage canvas').first().waitFor();
    assert.match(await sp.locator('body').innerText(), /2,500/, 'typed answer came back after reload');
    // Nothing required is left, so "Check before you finish" opens by itself once the pages are drawn. Nobody has
    // to find the Finish button, and nobody leaves with everything filled in and nothing signed.
    await sp.getByRole('dialog').getByText(/You are signing as/).waitFor();
    await sp.waitForTimeout(400);
    await shot(sp, '10-sign-review');
    await sp.getByRole('button', { name: 'Finish and send' }).click();
    await sp.getByRole('heading', { name: /All done/ }).waitFor();
    await sp.getByText(/sheets of paper/).first().waitFor();
    assert.equal(await sp.getByText(/Create a free account/).count(), 0, 'no sign-up pitch after signing');
    await shot(sp, '11-done-mobile', true);
    await phone.close();
  });

  let signed;
  await section('completed: record intact, download, verify, tamper check', async () => {
    await page.goto(`${BASE}/app/envelopes/${envId}`);
    await page.getByText('Completed', { exact: true }).first().waitFor();
    await page.getByText('Record intact').waitFor();
    await shot(page, '12-detail-done', true);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download with certificate' }).click()]);
    signed = path.join(OUT, 'signed.pdf');
    await dl.saveAs(signed);
    assert.ok((await PDFDocument.load(fs.readFileSync(signed))).getPageCount() >= 3);
    await page.goto(`${BASE}/verify`);
    await page.locator('input[type=file]').setInputFiles(signed);
    await page.getByText('Unchanged since signing finished').waitFor();
    const tampered = path.join(OUT, 'tampered.pdf');
    fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(signed), Buffer.from('\n')]));
    await page.locator('input[type=file]').setInputFiles(tampered);
    await page.getByText('No match').waitFor();
  });

  await section('no dead ends: unknown link, replaced link, lost email', async () => {
    const p = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
    await p.goto(`${BASE}/sign/this-is-not-a-real-link`);
    await p.getByText(/do not recognise/i).first().waitFor();
    await p.getByRole('textbox').first().fill('ada@example.org');
    await p.getByRole('button').filter({ hasText: /send|email|find/i }).first().click();
    await p.getByText(/sent|on its way|check your inbox/i).first().waitFor();
    assert.ok(await mailFor('ada@example.org', (m) => m.subject === 'Your documents on GrowSigning'), 'documents list emailed');
    await shot(p, '13-unknown-link', true);

    // A second envelope whose recipient address gets corrected: the old link offers the new one.
    const file = (await asSender(`/envelopes/${envId}`)).data.envelope.documents[0].file_id;
    const made = await asSender('/envelopes', { subject: 'Second agreement', send: true, documents: [{ id: 'd', file_id: file }], recipients: [{ id: 'r', role: 'signer', name: 'Ben Partner', email: 'ben@example.org' }], fields: [{ document_id: 'd', recipient_id: 'r', type: 'signature', page: 1, x: 0.2, y: 0.2, w: 0.25, h: 0.06 }] });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const old = (await mailFor('ben@example.org', (m) => m.link?.includes('/sign/'))).link;
    const rid = made.data.envelope.recipients[0].id;
    await asSender(`/envelopes/${made.data.envelope.id}/correct`, { recipient_id: rid, name: 'Ben Partner', email: 'ben.partner@example.org' });
    await p.goto(old);
    await p.getByText(/replaced by a newer one/i).first().waitFor();
    await p.getByRole('button', { name: /Email me the current link/ }).click();
    await p.getByText(/sent|on its way/i).first().waitFor();
    assert.ok(await mailFor('ben.partner@example.org', (m) => m.link?.includes('/sign/')));
    await shot(p, '14-replaced-link', true);
    await p.close();
  });

  await section('sender pages: who is holding things up, more time, export', async () => {
    await page.goto(`${BASE}/app/envelopes`);
    await page.getByText('Second agreement').first().waitFor();
    await page.getByText(/Waiting on/).first().waitFor();
    await shot(page, '15-list', true);
    await page.getByText('Second agreement').first().click();
    await page.waitForURL(/\/app\/envelopes\/env_/);
    await page.getByRole('button', { name: 'Give more time' }).first().click();
    await page.getByRole('dialog').waitFor();
    await shot(page, '16-more-time');
    await page.keyboard.press('Escape');
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/export');
      return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'application/zip');
    assert.ok(res.bytes > 1000);
  });

  await section('template, public form, bulk send', async () => {
    await page.goto(`${BASE}/app/envelopes/${envId}`);
    await page.getByRole('button', { name: 'Save as template' }).click();
    await page.waitForURL('**/app/templates/*/edit');
    await page.getByLabel('Role name').first().fill('Sponsor');
    await page.getByLabel('Recipient name').first().fill('');
    await page.getByLabel('Recipient email').first().fill('');
    await page.getByRole('button', { name: /Step 3/ }).click();
    await page.getByRole('button', { name: 'Save template' }).last().click();
    await page.waitForURL('**/app/templates');
    await page.goto(`${BASE}/app/powerforms`);
    await page.getByLabel('Template').selectOption({ index: 1 });
    await page.getByLabel('Name shown to signers').fill('Sponsor a mangrove');
    await page.getByRole('button', { name: 'Create' }).click();
    const href = await page.getByRole('link', { name: 'Open' }).getAttribute('href');
    const walk = await (await browser.newContext()).newPage();
    await walk.goto(BASE + href);
    await walk.getByLabel('Your full name').fill('Walt Walkin');
    await walk.getByLabel(/Your email/).fill('walt@example.org');
    await walk.getByRole('button', { name: 'Continue to sign' }).click();
    await walk.waitForURL('**/sign/**');
    await walk.getByText(/I agree to use electronic records/).waitFor();
    await walk.close();

    const tpl = (await asSender('/envelopes?kind=template')).data.envelopes[0];
    await page.goto(`${BASE}/app/bulk?template=${tpl.id}`);
    await page.getByRole('textbox').filter({ hasNot: page.locator('[type=file]') }).first().waitFor();
    await page.locator('textarea').first().fill('Sponsor name,Sponsor email\nBo One,bo@example.org\nCy Two,cy@example.org');
    await shot(page, '17-bulk', true);
    await page.getByRole('button', { name: /Send 2 envelopes/ }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: /Send/ });
    if (await confirm.count()) await confirm.first().click();
    await page.getByText(/2 (envelopes )?sent|Sent 2/i).first().waitFor();
  });

  await section('plan and settings', async () => {
    await page.goto(`${BASE}/app/settings?tab=billing`);
    await page.getByRole('heading', { name: 'The rules', exact: true }).waitFor();
    await page.getByText(/\$9 a month/).first().waitFor();
    await page.getByText(/plants 10 mangrove trees/).first().waitFor();
    // The code GROWalition makes the plan free.
    await page.getByLabel('Code').fill('growalition');
    await page.getByRole('button', { name: 'Apply code' }).click();
    await page.getByText(/Your plan is free with the code GROWalition/).waitFor();
    await shot(page, '18-plan-free-code', true);
    for (const [tab, text] of [['notifications', 'When everyone has finished'], ['team', 'depends on one person'], ['data', 'Take everything with you'], ['developers', 'API keys'], ['profile', 'Your signature']]) {
      await page.goto(`${BASE}/app/settings?tab=${tab}`);
      await page.getByText(text).first().waitFor();
    }
  });

  await section('help, trust and other pages', async () => {
    await page.goto(`${BASE}/help`);
    await page.getByText('Find my documents').first().waitFor();
    await page.getByText('Find my subscription').first().waitFor();
    await shot(page, '19-help', true);
    // The contact form reaches a person without logging in.
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(`${BASE}/help`);
    await anon.getByLabel('Your name').fill('Stuck Signer');
    await anon.getByLabel(/^Email address/).last().fill('stuck@example.org');
    await anon.getByLabel(/What happened/).fill('I cannot open the document I was sent and the sender is away.');
    await anon.getByRole('button', { name: /Send/ }).last().click();
    await anon.getByText(/reference/i).first().waitFor();
    await anon.close();
    assert.ok(await mailFor('stuck@example.org', (m) => /We got your message/.test(m.subject)));

    for (const [url, text] of [['/security', /never need an account/i], ['/impact', /mangrove/i], ['/developers', 'API reference'], ['/app/reports', 'Envelopes per month'], ['/app/impact', 'How we count'], ['/app/contacts', 'ada@example.org'], ['/app/inbox', 'Inbox'], ['/app/templates', 'Templates'], ['/app', /Jimi/]]) {
      await page.goto(BASE + url);
      await page.getByText(text).first().waitFor();
      if (url === '/security') await shot(page, '20-security', true);
      if (url === '/app') await shot(page, '21-home', true);
    }
    const spec = await (await fetch(`${BASE}/api/openapi.json`)).json();
    assert.equal(spec.openapi, '3.0.3');
  });

  await section('no errors in the browser console', async () => {
    assert.deepEqual(errors, []);
  });

  await browser.close();
  console.log(failures.length ? `\nE2E FAILED: ${failures.length} section(s): ${failures.join('; ')}` : '\nE2E OK');
  if (failures.length) process.exitCode = 1;
} catch (e) {
  console.error(e);
  console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  stop();
  setTimeout(() => process.exit(), 500);
}
