/**
 * Small helpers shared by the admin*.e2e.mjs suites. Not a suite itself (the runner only loads
 * files that end in .e2e.mjs).
 */
import zlib from 'node:zlib';

/** Monday 09:00 UTC. The starter hours are Monday to Friday, 09:00 to 17:00 in the owner's zone. */
export const MONDAY = '2026-11-16T09:00:00.000Z';

/** The sidebar link of a dashboard page (desktop widths). */
export function navLink(page, name) {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
}

/** Goes to a dashboard page through the sidebar and waits for its heading. */
export async function openPage(page, name, heading = name) {
  await navLink(page, name).click();
  await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
}

/** Every toast on screen. A toast is a list item with the role "status" (or "alert" for an error). */
export function toasts(page) {
  return page.getByRole('list', { name: 'Notifications' }).locator('li');
}

/** A toast with this title (string or RegExp) is on screen. Returns its list item. */
export async function expectToast(page, title, { timeout } = {}) {
  const item = toasts(page).filter({ hasText: title }).first();
  await item.waitFor({ timeout });
  return item;
}

/** Closes every toast, so the next expectToast cannot match an old one. */
export async function clearToasts(page) {
  const list = page.getByRole('list', { name: 'Notifications' });
  await list.getByRole('button', { name: 'Dismiss' }).evaluateAll((buttons) => buttons.forEach((button) => button.click()));
  await list.locator('li').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
}

/**
 * What a form control says is wrong with it: the text of the alert it points at with
 * aria-describedby, and only when the control itself is marked invalid. Empty string = fine.
 */
export async function fieldProblem(control) {
  return control.evaluate((el) => {
    if (el.getAttribute('aria-invalid') !== 'true') return '';
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    return ids
      .map((id) => document.getElementById(id))
      .filter((node) => node && node.getAttribute('role') === 'alert')
      .map((node) => node.textContent.trim())
      .join(' ');
  });
}

/** Waits until the control reports this problem (string contained, or RegExp). */
export async function expectFieldProblem(s, control, expected, label = 'field problem') {
  await s.eventually(async () => {
    const text = await fieldProblem(control);
    if (expected instanceof RegExp) s.expect(text, label).toMatch(expected);
    else s.expect(text, label).toContain(expected);
  });
}

/** The sticky "unsaved changes" bar of a dashboard page. */
export function saveBar(page) {
  return page.getByRole('region', { name: 'Unsaved changes' });
}

/** Presses the save button of the save bar and waits for the bar to go away. */
export async function saveAndWait(page, label) {
  const bar = saveBar(page);
  await bar.getByRole('button', { name: label }).click();
  await bar.waitFor({ state: 'hidden' });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real, decodable PNG of one colour: pngImage(64, 64, [222, 80, 40]). */
export function pngImage(width, height, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A file for locator.setInputFiles(). */
export function pngFile(name, width, height, rgb) {
  return { name, mimeType: 'image/png', buffer: pngImage(width, height, rgb) };
}

/** "rgb(20, 83, 45)" for "#14532d", the way getComputedStyle writes colours. */
export function rgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
}

/** Local wall time of an ISO instant in a zone, as "HH:MM". */
export function wallTime(iso, zone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** Local date of an ISO instant in a zone, as "YYYY-MM-DD". */
export function wallDate(iso, zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** The wall times ("HH:MM") offered on one local date, from a list of ISO starts. */
export function timesOn(starts, date, zone) {
  return starts.filter((iso) => wallDate(iso, zone) === date).map((iso) => wallTime(iso, zone));
}

// ───────────────────────── the public booking page ─────────────────────────

/** Waits until the month on screen has loaded its times. */
export async function calendarReady(page) {
  await page.locator('table.bw-cal__grid:not([aria-busy="true"])').waitFor();
}

/** Opens the public page of an event type and waits for its calendar. */
export async function openBookingPage(s, page, slug, query = '') {
  await page.goto(s.url(`/${slug}${query}`));
  await calendarReady(page);
}

/** Days of the month on screen that can be picked, as "YYYY-MM-DD". */
export async function openDays(page) {
  await calendarReady(page);
  return page.locator('button.bw-day.is-open').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-day')));
}

/**
 * What the public page offers on one day: picks the day and returns the start times (UTC ISO
 * strings, in the order shown). An empty list when the day cannot be picked.
 */
export async function offeredTimes(page, day) {
  await calendarReady(page);
  const button = page.locator(`button.bw-day[data-day="${day}"]`);
  await button.waitFor();
  if (!(await button.evaluate((el) => el.classList.contains('is-open')))) return [];
  await button.click();
  await page.locator(`button.bw-day.is-selected[data-day="${day}"]`).waitFor();
  await page.locator('button.bw-slot').first().waitFor();
  const starts = await page.locator('button.bw-slot').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-start')));
  // The page keeps a start as epoch milliseconds.
  return starts.map((value) => new Date(/^\d+$/.test(value) ? Number(value) : value).toISOString());
}

/** "09:00" … every `step` minutes from `from` up to, not including, `to`. */
export function timeRange(from, to, step) {
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const out = [];
  for (let m = minutes(from); m < minutes(to); m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}
