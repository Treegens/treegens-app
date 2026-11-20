// Browser test of the whole product against a production build. Run `npm run build` first, then `npm run test:e2e`.
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsign-e2e-'));
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

const shot = async (page, name, full = false) => shots && page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full });
const outbox = async () => (await (await fetch(`${BASE}/api/dev/outbox`)).json()).emails;

try {
  await ready();
  const pdf = await makePdf();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Landing
  await page.goto(BASE);
  await page.getByRole('heading', { name: /Trees grow/ }).waitFor();
  await shot(page, '01-landing', true);

  // Sign up
  await page.goto(`${BASE}/signup`);
  await page.getByLabel('Your name').fill('Jimi Sender');
  await page.getByLabel('Email').fill('jimi@example.org');
  await page.getByLabel(/Password/).fill('plant-more-trees');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/app');
  await page.getByRole('heading', { name: /Hello, Jimi/ }).waitFor();

  // New envelope: upload, recipients
  await page.getByRole('link', { name: 'Send for signature' }).click();
  await page.waitForURL('**/edit');
  await page.locator('input[type=file]').setInputFiles(pdf);
  await page.getByLabel('Document name').waitFor();
  await page.getByRole('button', { name: 'Add recipient' }).click();
  await page.getByLabel('Recipient name').fill('Ada Sponsor');
  await page.getByLabel('Recipient email').fill('ada@example.org');
  await page.getByRole('button', { name: 'Add recipient' }).click();
  await page.getByLabel('Recipient name').nth(1).fill('Cee Copy');
  await page.getByLabel('Recipient email').nth(1).fill('cee@example.org');
  await page.getByLabel('Role', { exact: true }).nth(1).selectOption('cc');
  await shot(page, '02-editor-add', true);

  // Place fields
  await page.getByRole('button', { name: 'Next' }).click();
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
  // Drag the signature field a little, then nudge with the keyboard.
  const sig = page.locator('.field.edit', { hasText: 'Signature' });
  const sb = await sig.boundingBox();
  await page.mouse.move(sb.x + 20, sb.y + 10);
  await page.mouse.down();
  await page.mouse.move(sb.x + 60, sb.y + 20, { steps: 5 });
  await page.mouse.up();
  const moved = await sig.boundingBox();
  assert.ok(Math.abs(moved.x - sb.x - 40) < 3, 'field can be dragged');
  await page.locator('.pdfpage').nth(1).scrollIntoViewIfNeeded();
  await shot(page, '03-editor-fields');

  // Review and send
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByText(/Sending this digitally saves about 4 sheets/).waitFor();
  await shot(page, '04-editor-review', true);
  await page.getByRole('button', { name: 'Send' }).last().click();
  await page.waitForURL(/\/app\/envelopes\/env_[^/]+\?sent=1/);
  await page.getByText('Waiting for others').first().waitFor();
  const envId = page.url().match(/env_[A-Za-z0-9_-]+/)[0];

  // Signer opens the emailed link on a phone
  const mail = (await outbox()).find((m) => m.to_email === 'ada@example.org' && m.link?.includes('/sign/'));
  assert.ok(mail, 'signer got an email');
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const sp = await phone.newPage();
  sp.on('pageerror', (e) => errors.push('signer: ' + e));
  await sp.goto(mail.link);
  await sp.getByText(/I agree to use electronic records/).click();
  await sp.getByRole('button', { name: 'Continue' }).click();
  await sp.locator('.pdfpage canvas').first().waitFor();
  assert.equal(await sp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scroll on a phone');
  await shot(sp, '05-sign-mobile');
  await sp.getByRole('button', { name: 'Next' }).click();
  await sp.getByLabel('Seedlings pledged').fill('2,500');
  await sp.getByRole('button', { name: 'Next' }).click();
  await sp.getByRole('button', { name: /Sign/ }).first().click();
  await sp.getByRole('dialog').getByLabel('Full name').fill('Ada Sponsor');
  await shot(sp, '06-adopt-mobile');
  await sp.getByRole('button', { name: 'Adopt and sign' }).click();
  await sp.locator('.field.fill img').waitFor();
  await sp.getByRole('button', { name: 'Finish' }).click();
  await sp.getByRole('heading', { name: /All done/ }).waitFor();
  await sp.getByText(/sheets of paper/).first().waitFor();
  await shot(sp, '07-done-mobile', true);

  // Sender sees it completed, downloads and verifies
  await page.reload();
  await page.getByText('Completed', { exact: true }).first().waitFor();
  await page.getByText('Chain intact').waitFor();
  await shot(page, '08-detail', true);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download with certificate' }).click()]);
  const signed = path.join(OUT, 'signed.pdf');
  await dl.saveAs(signed);
  const parsed = await PDFDocument.load(fs.readFileSync(signed));
  assert.ok(parsed.getPageCount() >= 3);

  await page.goto(`${BASE}/verify`);
  await page.locator('input[type=file]').setInputFiles(signed);
  await page.getByText('Authentic and unchanged').waitFor();
  await shot(page, '09-verify', true);
  const tampered = path.join(OUT, 'tampered.pdf');
  fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(signed), Buffer.from('\n')]));
  await page.locator('input[type=file]').setInputFiles(tampered);
  await page.getByText('No match').waitFor();

  // Save as template, create a PowerForm, sign it as a walk-in
  await page.goto(`${BASE}/app/envelopes/${envId}`);
  await page.getByRole('button', { name: 'Save as template' }).click();
  await page.waitForURL('**/app/templates/*/edit');
  await page.getByLabel('Role name').first().fill('Sponsor');
  await page.getByLabel('Recipient name').first().fill('');
  await page.getByLabel('Recipient email').first().fill('');
  await page.getByRole('button', { name: /Review/ }).click();
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

  // Bulk send from the template
  await page.goto(`${BASE}/app/bulk`);
  await page.getByLabel('Template').selectOption({ index: 1 });
  await page.getByLabel(/Recipients/).fill('Bo One,bo@example.org\nCy Two,cy@example.org');
  await page.getByRole('button', { name: 'Send 2 envelopes' }).click();
  await page.getByText('2 envelopes sent').waitFor();

  // Other pages render
  for (const [url, text] of [['/app/reports', 'Envelopes per month'], ['/app/impact', 'How we count'], ['/app/settings', 'Your signature'], ['/app/contacts', 'ada@example.org'], ['/app/envelopes', 'Mangrove'], ['/impact', 'Fewer printers'], ['/developers', 'API reference'], ['/app/inbox', 'Inbox']]) {
    await page.goto(BASE + url);
    await page.getByText(text).first().waitFor();
    if (url === '/app/reports') await shot(page, '10-reports', true);
    if (url === '/app/impact') await shot(page, '11-impact', true);
  }
  await page.goto(`${BASE}/app`);
  await page.getByRole('heading', { name: /Hello/ }).waitFor();
  await shot(page, '12-home', true);

  assert.deepEqual(errors, [], 'no browser errors');
  await browser.close();
  console.log('E2E OK');
} catch (e) {
  console.error(e);
  console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  stop();
  setTimeout(() => process.exit(), 500);
}
