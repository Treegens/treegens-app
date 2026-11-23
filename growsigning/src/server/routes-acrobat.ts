// The routes of the automatic Adobe Acrobat check (src/server/acrobat.ts). Two for the program on the operators'
// computer, with ACROBAT_CHECK_TOKEN as "Authorization: Bearer <token>", and two for the operator page. Without the
// setting, or without the right token, the program's routes answer 404 exactly as a route that does not exist.
import { route, json, clientIp, type Ctx } from './router.ts';
import { HttpError, bad, rateLimit, rateWait } from './util.ts';
import { get, readBlob } from './db.ts';
import { isOperator } from './routes-trust.ts';
import {
  acrobatToken, acrobatAuthorized, makeSample, storeReport, acrobatState, keptScreenshot, ACROBAT_PER_HOUR, ACROBAT_BODY_MAX, ACROBAT_SCREENSHOT_MAX, ACROBAT_SCREENSHOT_PIXELS, ACROBAT_COLOURS, type Report,
} from './acrobat.ts';

const hidden = () => new HttpError(404, 'Not found');

/**
 * Only the program with the token gets past this. A missing or wrong token always answers 404, however often it is
 * tried, so it neither shows that the route exists nor uses up the program's allowance from a shared address. Wrong
 * tries are counted on their own only to say so in the log; the token is at least 32 characters, so guessing it is
 * not a way in. Calls with the right token are limited per address and route (429).
 */
function gate(c: Ctx, which: string) {
  if (!acrobatToken()) throw hidden();
  const ip = clientIp(c.req);
  if (!acrobatAuthorized(c.req)) {
    const key = `acrobat-wrong:${ip}`;
    const before = rateWait(key, ACROBAT_PER_HOUR);
    rateLimit(key, Infinity, 3600_000);
    if (!before && rateWait(key, ACROBAT_PER_HOUR)) console.error(`[acrobat] ${ACROBAT_PER_HOUR} calls without the right ACROBAT_CHECK_TOKEN from ${ip} within an hour. They all got 404.`);
    throw hidden();
  }
  rateLimit(`acrobat-${which}:${ip}`, ACROBAT_PER_HOUR, 3600_000);
}

/** The body as text, refused past `max` bytes whatever the request says its length is. */
async function readCapped(req: Request, max: number): Promise<string> {
  const said = Number(req.headers.get('content-length') || 0);
  const tooBig = () => bad(`The body is larger than ${max} bytes. Nothing was stored.`, 413, { code: 'too_large' });
  if (said > max) throw tooBig();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

route('GET', '/ops/acrobat-check/sample', async (c) => {
  gate(c, 'sample');
  // A GET carries no body; anything more than a few bytes is not this program.
  if (Number(c.req.headers.get('content-length') || 0) > 1024) throw bad('This call takes no body.', 413, { code: 'too_large' });
  const force = c.q.has('tsa') ? String(c.q.get('tsa') || '').slice(0, 300) : null;
  const r = await makeSample(force, c.ip);
  if (!r.ok) return json({ error: r.error, code: r.code, ...(r.alerted != null ? { alerted: r.alerted } : {}) }, r.status);
  return new Response(new Uint8Array(r.bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="growsigning-acrobat-check-${r.id}.pdf"`,
      'cache-control': 'no-store',
      'x-check-id': r.id,
      'x-tsa-host': r.host,
      'x-tsa-trusted': r.trusted ? 'true' : 'false',
      'x-tsa-time': r.time,
      'x-content-type-options': 'nosniff',
    },
  });
}, 'public');

const field = (message: string, name: string) => bad(`${message} Nothing was stored.`, 400, { field: name });
const text = (v: any, name: string, max: number, required = true): string => {
  if (v == null && !required) return '';
  if (typeof v !== 'string') throw field(`"${name}" must be text.`, name);
  if (v.length > max) throw field(`"${name}" can be at most ${max} characters.`, name);
  // Control characters other than tabs and line breaks are not something Acrobat shows.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) throw field(`"${name}" holds control characters.`, name);
  return v.trim();
};

function screenshotOf(v: any, checkId: string): Buffer | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw field('"screenshot_png_base64" must be base64 text.', 'screenshot_png_base64');
  const b64 = v.replace(/^data:image\/png;base64,/i, '').replace(/\s+/g, '');
  if (b64.length > Math.ceil(ACROBAT_SCREENSHOT_MAX / 3) * 4) throw field(`The screenshot can be at most ${ACROBAT_SCREENSHOT_MAX} bytes.`, 'screenshot_png_base64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4) throw field('"screenshot_png_base64" is not base64.', 'screenshot_png_base64');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > ACROBAT_SCREENSHOT_MAX) throw field(`The screenshot can be at most ${ACROBAT_SCREENSHOT_MAX} bytes.`, 'screenshot_png_base64');
  const kept = keptScreenshot(bytes, checkId);
  if (!kept) throw field(`The screenshot is not a whole PNG file of the usual kind (8 bits per colour, no palette, not interlaced) of at most ${ACROBAT_SCREENSHOT_PIXELS} pixels.`, 'screenshot_png_base64');
  return kept;
}

route('POST', '/ops/acrobat-check/result', async (c) => {
  gate(c, 'result');
  const raw = await readCapped(c.req, ACROBAT_BODY_MAX);
  let b: any;
  try {
    b = JSON.parse(raw);
  } catch {
    throw bad('Send a JSON body.');
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Send a JSON body.');
  const checkId = typeof b.check_id === 'string' ? b.check_id.trim() : '';
  if (!/^acr_[A-Za-z0-9_-]{8,40}$/.test(checkId)) throw field('"check_id" must be the X-Check-Id of a sample.', 'check_id');
  const row = get('SELECT * FROM acrobat_checks WHERE id=?', checkId);
  if (!row) throw bad('No sample has this check id. It may be older than the last 60 checks.', 404, { code: 'unknown_check' });
  if (row.reported_at) throw bad('This check was reported already. Each check is reported once: fetch a new sample.', 409, { code: 'already_reported' });
  const colour = b.banner_colour;
  if (!ACROBAT_COLOURS.includes(colour)) throw field(`"banner_colour" must be one of: ${ACROBAT_COLOURS.join(', ')}.`, 'banner_colour');
  if (!Array.isArray(b.panel_lines)) throw field('"panel_lines" must be a list of the lines in the signature panel.', 'panel_lines');
  if (b.panel_lines.length > 60) throw field('"panel_lines" can hold at most 60 lines.', 'panel_lines');
  const report: Report = {
    check_id: checkId,
    banner_text: text(b.banner_text, 'banner_text', 500),
    banner_colour: colour,
    panel_lines: b.panel_lines.map((l: any, i: number) => text(l, `panel_lines[${i}]`, 500)).filter(Boolean),
    acrobat_version: text(b.acrobat_version, 'acrobat_version', 100),
    os: text(b.os, 'os', 100),
    notes: text(b.notes, 'notes', 2000, false),
    screenshot: screenshotOf(b.screenshot_png_base64, checkId),
  };
  const done = await storeReport(row, report);
  if (!done) throw bad('This check was reported already. Each check is reported once: fetch a new sample.', 409, { code: 'already_reported' });
  return { verdict: done.verdict, alerted: done.alerted, why: done.why, late: done.late };
}, 'public');

// ---- The operator card -------------------------------------------------------------------------------------------

const operator = (c: Ctx) => {
  if (!isOperator(c.user)) throw hidden();
};

route('GET', '/operator/acrobat-check', (c) => {
  operator(c);
  return acrobatState();
});

route('GET', '/operator/acrobat-check/:id/screenshot', (c) => {
  operator(c);
  const r = get('SELECT screenshot_sha256 FROM acrobat_checks WHERE id=?', c.params.id);
  if (!r?.screenshot_sha256) throw hidden();
  return new Response(new Uint8Array(readBlob(r.screenshot_sha256)), {
    headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" },
  });
});
