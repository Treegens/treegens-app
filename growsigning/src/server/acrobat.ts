// The automatic Adobe Acrobat check. A program on a computer of the people who run the server (a desktop agent that
// can work Adobe Acrobat Reader) asks for a small sample PDF, opens it in Acrobat, reads the blue, yellow or red bar
// at the top, and reports what it saw. The sample carries a document time stamp made exactly as a completed document
// gets one (addDocTimeStamp in ltv.ts, with TSA_URL and TSA_TRUST), so a blue "Signed and all signatures are valid"
// means Acrobat still trusts the time stamps our completed documents carry. The server decides pass or fail itself
// from what was reported, and tells the operators when it fails, when no time-stamp service answers, when a sample
// is never reported on, and when no check has come for too long. Routes: routes-acrobat.ts.
//
// What it covers: the sample's only signature is a document time stamp, which is what a completed document carries
// on a server without a seal (finalpipe.ts stampOnly). With a server seal on, completed documents also carry the
// seal and its certificate, and this check does not test how Acrobat shows that (acrobatState says so as seal_on).
//
// The program calls in with ACROBAT_CHECK_TOKEN. Nothing here calls out except the time-stamp services already in
// TSA_URL. The sample holds no customer data.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { all, get, run, dataDir, saveBlob } from './db.ts';
import { id, now, isEmail, baseUrl, safeEqual, sha256 } from './util.ts';
import { sendMail } from './mail.ts';
import { seal } from './colcrypt.ts';
import { tsaUrls } from './tsa.ts';
import { sealState } from './sealkey.ts';
import { readPng, cleanPng, crc32 } from './png.ts';
import { addDocTimeStamp } from './ltv.ts';

/** How often the program is expected to check, in days. The card shows the day the next one is due. */
export const ACROBAT_EVERY_DAYS = 1;
/** No check for longer than this, after the first one ever, and the operators are told once. */
export const ACROBAT_SILENT_DAYS = 2;
/** A sample that was fetched and not reported on within this long is a missed check. */
export const ACROBAT_REPORT_HOURS = 2;
/** How many checks (and their screenshots) are kept. Older ones are deleted by the timer. */
export const ACROBAT_KEEP = 60;
/** Calls an hour from one address with the right token, to each of the two routes. Wrong tries never count here. */
export const ACROBAT_PER_HOUR = 30;
/** Samples made in any 24 hours, from all addresses together. The program needs at most 4 a day. */
export const ACROBAT_SAMPLES_PER_DAY = 40;
/** Fail alerts emailed in one UTC day. Later fails that day are kept and shown on the operator page only. */
export const ACROBAT_FAIL_ALERTS_PER_DAY = 5;
/** The shortest token that turns the routes on. A shorter one counts as unset, with a warning in the log. */
export const ACROBAT_TOKEN_MIN = 32;
/** The largest screenshot in pixels once unpacked (a 4K screen is about 8.3 million). */
export const ACROBAT_SCREENSHOT_PIXELS = 10_000_000;
/** The largest screenshot, decoded. */
export const ACROBAT_SCREENSHOT_MAX = 1_500_000;
/** The largest body of a report: the screenshot as base64 and the words around it. */
export const ACROBAT_BODY_MAX = 2_200_000;
/** The words Acrobat shows in its blue bar when every signature in the file is valid. */
export const ACROBAT_PASS_WORDS = 'Signed and all signatures are valid';
export const ACROBAT_COLOURS = ['blue', 'yellow', 'red', 'none', 'other'] as const;

let warnedShort = '';
/** The setting, as given. Empty when unset or shorter than ACROBAT_TOKEN_MIN: then the routes answer 404. */
export function acrobatToken(): string {
  const t = (process.env.ACROBAT_CHECK_TOKEN || '').trim();
  if (!t || t.length >= ACROBAT_TOKEN_MIN) return t;
  if (warnedShort !== t) {
    warnedShort = t;
    console.error(`[acrobat] ACROBAT_CHECK_TOKEN is shorter than ${ACROBAT_TOKEN_MIN} characters, so the Acrobat check is off (its routes answer 404). Make one with: openssl rand -hex 32`);
  }
  return '';
}

/**
 * Whether a request carries the token, as "Authorization: Bearer <token>" and nowhere else. Compared as SHA-256
 * digests with a timing-safe check, so neither the length nor the content of the token leaks through the time taken.
 */
export function acrobatAuthorized(req: Request): boolean {
  const want = acrobatToken();
  if (!want) return false;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.headers.get('authorization') || '');
  if (!m) return false;
  return safeEqual(sha256(m[1]), sha256(want));
}

/** The host of a service address, or null when it cannot be read. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};
/** The hosts of the time-stamp services in TSA_URL, in order. */
export const tsaHosts = (): string[] => [...new Set(tsaUrls().map(hostOf).filter((h): h is string => !!h))];

// ---- The sample ------------------------------------------------------------------------------------------------

/** The lines on the sample's page: text, size, bold. An empty text is a gap. */
export function sampleLines(checkId: string, at: Date, hosts: string[]): [string, number, boolean][] {
  const iso = at.toISOString();
  return [
    ['GrowSigning Acrobat check', 22, true],
    ['', 0, false],
    [`Made on ${iso.slice(0, 10)} at ${iso.slice(11, 19)} UTC.`, 12, false],
    [`Check id: ${checkId}`, 12, false],
    [`Time-stamp services in use: ${hosts.length ? hosts.join(', ') : 'none'}`, 12, false],
    ['', 0, false],
    ['This file holds no customer data.', 14, true],
    ['', 0, false],
    ['It was made by the GrowSigning server for an automatic check. Its only signature is a document time', 12, false],
    ['stamp, added the same way a completed document without a server seal gets one. Opened in Adobe', 12, false],
    [`Acrobat Reader, the bar at the top should be blue and say "${ACROBAT_PASS_WORDS}".`, 12, false],
  ];
}

/** A one-page PDF that says what it is, made in memory. No customer data goes into it. */
export async function acrobatSamplePdf(checkId: string, at: Date, hosts: string[]): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.setTitle('GrowSigning Acrobat check');
  d.setAuthor('GrowSigning');
  d.setCreator('GrowSigning');
  d.setProducer('GrowSigning');
  d.setSubject(`Acrobat check ${checkId}`);
  d.setCreationDate(at);
  d.setModificationDate(at);
  const page = d.addPage([595.28, 841.89]);
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  // Helvetica here writes only plain Latin letters: anything else in a host name is left out, not drawn wrong.
  const plain = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');
  let y = 760;
  for (const [text, size, strong] of sampleLines(checkId, at, hosts)) {
    if (!text) {
      y -= 10;
      continue;
    }
    page.drawText(plain(text), { x: 60, y, size, font: strong ? bold : font, color: rgb(0.1, 0.1, 0.1) });
    y -= size + 10;
  }
  return Buffer.from(await d.save({ useObjectStreams: false }));
}

export type SampleResult =
  | { ok: true; id: string; bytes: Buffer; host: string; trusted: boolean; tsaName: string; time: string }
  | { ok: false; status: number; error: string; code: string; alerted?: boolean };

/**
 * Makes a sample with its document time stamp and keeps a small row about it. `forceHost`: ask only the service in
 * TSA_URL with this host. When no service gives a time stamp, the operators are told, once a day.
 */
export async function makeSample(forceHost: string | null, ip: string): Promise<SampleResult> {
  const urls = tsaUrls();
  let ask = urls;
  if (forceHost != null) {
    const want = forceHost.trim().toLowerCase();
    ask = urls.filter((u) => hostOf(u) === want);
    if (!want || !ask.length)
      return { ok: false, status: 400, code: 'tsa_not_listed', error: `"tsa" must be the host of one of the time-stamp services in TSA_URL: ${tsaHosts().join(', ') || 'none is set'}. Nothing was made.` };
  }
  const at = new Date();
  // A cap over all addresses together, so a token holder on many addresses cannot make samples (and alerts) without end.
  const made = get('SELECT COUNT(*) n FROM acrobat_checks WHERE created_at > ?', new Date(at.getTime() - 86400_000).toISOString())?.n || 0;
  if (made >= ACROBAT_SAMPLES_PER_DAY)
    return { ok: false, status: 429, code: 'too_many_samples', error: `${made} samples were made in the last 24 hours, which is the most this server makes. Try again tomorrow. Nothing was made.` };
  const checkId = id('acr');
  const hosts = ask.map(hostOf).filter((h): h is string => !!h);
  let stamped: Awaited<ReturnType<typeof addDocTimeStamp>>;
  try {
    if (!ask.length) throw new Error('no time-stamp service is set (TSA_URL is empty)');
    const pdf = await acrobatSamplePdf(checkId, at, hosts);
    stamped = await addDocTimeStamp(pdf, ask);
  } catch (e: any) {
    const why = String(e?.message || e).slice(0, 1000);
    // One mark a day for each thing asked: all the services, or the one service named with ?tsa=. A backup that is
    // down then does not use up the mark of a real outage later the same day.
    const forced = forceHost != null && ask.length > 0;
    const alerted = forced
      ? await tellOnce(`down:${at.toISOString().slice(0, 10)}:${hosts[0]}`, `The time-stamp service ${hosts[0]} did not answer the Acrobat check`,
        [`The Acrobat check asked only ${hosts[0]} for a time stamp at ${at.toISOString()}, and it gave none: ${why}.`,
          `Completed documents still use the other services in TSA_URL (${tsaHosts().filter((h) => h !== hosts[0]).join(', ') || 'none is set'}) in order, so they are only affected if those fail too. You are told about this service once a day while it goes on.`])
      : await tellOnce(`down:${at.toISOString().slice(0, 10)}:all`, 'No time-stamp service answered the Acrobat check',
        [`The Acrobat check asked for a sample PDF at ${at.toISOString()} and no time-stamp service gave a time stamp: ${why}.`,
          `Services asked: ${hosts.join(', ') || 'none'}.`,
          'Completed documents are getting no time stamp from these services either while this lasts. Look at TSA_URL and at the services themselves. You are told about this once a day while it goes on.']);
    return { ok: false, status: 503, code: 'tsa_down', error: `No time-stamp service gave a time stamp, so no sample was made: ${why}`, alerted };
  }
  run('INSERT INTO acrobat_checks (id, created_at, tsa_host, tsa_name, tsa_time, trusted, forced, pdf_sha256, ip) VALUES (?,?,?,?,?,?,?,?,?)',
    checkId, at.toISOString(), stamped.host, stamped.tsaName, stamped.time, stamped.trusted, forceHost != null, sha256(stamped.bytes), ip);
  run('INSERT OR IGNORE INTO acrobat_marks (key, at) VALUES (?,?)', 'first_check', at.toISOString());
  return { ok: true, id: checkId, bytes: stamped.bytes, host: stamped.host, trusted: stamped.trusted, tsaName: stamped.tsaName, time: stamped.time };
}

// ---- The report ------------------------------------------------------------------------------------------------

export type Report = {
  check_id: string; banner_text: string; banner_colour: (typeof ACROBAT_COLOURS)[number]; panel_lines: string[];
  acrobat_version: string; os: string; notes: string; screenshot: Buffer | null;
};

/**
 * Words Acrobat uses when something is wrong with a signature. Any of them in the bar or the panel fails the check,
 * even next to the pass words. ("Document has not been modified" is a good line, so "modified" is not here.)
 */
const WARNING_WORDS = /\b(invalid|problems?|unknown|revoked|altered|corrupted|untrusted|not trusted|could not be verified|cannot be verified|errors?)\b/i;

/**
 * The server's own verdict. Pass only for a blue bar with Acrobat's words for "every signature is valid", no warning
 * words in the bar or the panel, and a time stamp the server itself could check against TSA_TRUST.
 */
export function verdictOf(r: { banner_text: string; banner_colour: string; panel_lines?: string[] }, row?: { trusted?: any }): { verdict: 'pass' | 'fail'; why: string[] } {
  const why: string[] = [];
  if (!r.banner_text.toLowerCase().includes(ACROBAT_PASS_WORDS.toLowerCase())) why.push(`the bar does not say "${ACROBAT_PASS_WORDS}"`);
  if (r.banner_colour !== 'blue') why.push(`the bar is ${r.banner_colour === 'none' ? 'not there' : r.banner_colour}, not blue`);
  const warnBar = WARNING_WORDS.exec(r.banner_text);
  if (warnBar) why.push(`the bar also says "${warnBar[0]}"`);
  const warnLine = (r.panel_lines || []).find((l) => WARNING_WORDS.test(l));
  if (warnLine) why.push(`the signature panel says "${warnLine.slice(0, 200)}"`);
  if (row && !row.trusted) why.push('the server could not check this time stamp against TSA_TRUST (set TSA_TRUST=bundled)');
  return { verdict: why.length ? 'fail' : 'pass', why };
}

/**
 * The screenshot as the server keeps it: the pixels only, written again (cleanPng), so nothing packed after the
 * picture or in its other chunks is kept, and a picture too large to unpack is refused. A text chunk with the check
 * id makes the bytes this check's own, so the file never shares its fingerprint with a customer's file in the blob
 * store. Null when it is not an 8-bit PNG without a palette of at most ACROBAT_SCREENSHOT_PIXELS.
 */
export function keptScreenshot(bytes: Uint8Array, checkId: string): Buffer | null {
  const info = readPng(bytes);
  if (!info) return null;
  const clean = cleanPng(info, ACROBAT_SCREENSHOT_PIXELS);
  if (!clean) return null;
  const data = Buffer.from(`Comment\0GrowSigning Acrobat check ${checkId}`, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write('tEXt', 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  // IEND is always the last 12 bytes of what cleanPng writes.
  return Buffer.concat([clean.subarray(0, clean.length - 12), head, data, crc, clean.subarray(clean.length - 12)]);
}

export const checkLink = (checkId: string) => `${baseUrl()}/app/operator#acrobat-${checkId}`;

/** Stores a report on a check that was not reported on before, decides, and on a fail tells the operators at once. */
export async function storeReport(row: any, r: Report): Promise<{ verdict: 'pass' | 'fail'; alerted: boolean; why: string[]; late: boolean } | null> {
  const { verdict, why } = verdictOf(r, row);
  // A report after the missed-check alarm still counts, and says it came late.
  const late = !!row.missed_alerted_at;
  let shot: string | null = null;
  if (r.screenshot) shot = saveBlob(r.screenshot);
  const t = now();
  const done = run(`UPDATE acrobat_checks SET reported_at=?, verdict=?, banner_text=?, banner_colour=?, panel_lines=?, acrobat_version=?, os=?, notes=?,
      screenshot_sha256=?, screenshot_size=? WHERE id=? AND reported_at IS NULL`,
    t, verdict, r.banner_text, r.banner_colour, JSON.stringify(r.panel_lines), r.acrobat_version, r.os, r.notes, shot, r.screenshot?.length ?? null, r.check_id);
  if (!Number(done.changes)) {
    if (shot) forgetShot(shot);
    return null;
  }
  let alerted = false;
  // The first ACROBAT_FAIL_ALERTS_PER_DAY fails of a UTC day are told at once; later ones only show on the card.
  const day = t.slice(0, 10);
  let slot = 0;
  if (verdict === 'fail') {
    for (let n = 1; n <= ACROBAT_FAIL_ALERTS_PER_DAY && !slot; n++) if (Number(run('INSERT OR IGNORE INTO acrobat_marks (key, at) VALUES (?,?)', `fail:${day}:${n}`, t).changes)) slot = n;
  }
  if (slot) {
    alerted = await tell(`Adobe Acrobat did not show the time stamp as valid`, [
      `The Acrobat check ${r.check_id} failed: ${why.join(', and ')}.`,
      `Bar (${r.banner_colour}): ${r.banner_text || '(no words)'}`,
      ...(r.panel_lines.length ? ['Signature panel:', ...r.panel_lines.map((l) => `  ${l}`)] : ['Signature panel: nothing reported.']),
      `Time-stamp service: ${row.tsa_host}${row.tsa_name ? ` (${row.tsa_name})` : ''}${row.trusted ? ', checked against TSA_TRUST' : ', not checked against TSA_TRUST'}.`,
      `Acrobat ${r.acrobat_version || 'version not given'} on ${r.os || 'a system not given'}.`,
      ...(r.notes ? [`Notes from the program: ${r.notes}`] : []),
      ...(late ? [`This report came after the missed-check alarm for it (more than ${ACROBAT_REPORT_HOURS} hours after the sample was fetched).`] : []),
      `The sample was made at ${row.created_at}. Completed documents without a server seal carry their time stamp the same way, so customers may see the same in Acrobat. Open the check: ${checkLink(r.check_id)}`,
      ...(slot === ACROBAT_FAIL_ALERTS_PER_DAY ? [`This is fail alert ${slot} today, the most sent in one day. Further fails today are kept on the operator page and not emailed.`] : []),
    ], checkLink(r.check_id));
    run('UPDATE acrobat_checks SET alerted=? WHERE id=?', alerted, r.check_id);
  }
  return { verdict, alerted, why, late };
}

// ---- Telling the operators ---------------------------------------------------------------------------------------

const operatorAddresses = () => [...new Set([process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];

// Like the other automatic alerts (sealkey.ts, filestore.ts): a line in the server log, an item in the operator
// queue, and an email to SUPPORT_EMAIL and OPERATOR_EMAILS. True once it is filed.
async function tell(subject: string, lines: string[], link = `${baseUrl()}/app/operator#acrobat-check`): Promise<boolean> {
  console.error(`\n[acrobat] ${subject}\n[acrobat] ${lines.join('\n[acrobat] ')}\n`);
  try {
    const to = operatorAddresses();
    const text = `${subject}\n\n${lines.join('\n')}`.slice(0, 5000);
    run("INSERT INTO support_requests (id, email, name, topic, message, status, at) VALUES (?,?,?,'other',?,'open',?)",
      id('sup'), to[0] || 'acrobat-check@localhost', 'GrowSigning (automatic alert)', seal('support_requests.message', text), now());
    for (const t of to) await sendMail({ to: t, subject, heading: subject, lines, cta: { label: 'Open the Acrobat check', url: link } }).catch((x: any) => console.error('[acrobat] could not email the operators', x?.message));
    if (!to.length) console.error('[acrobat] NOBODY WAS TOLD BY EMAIL (set SUPPORT_EMAIL or OPERATOR_EMAILS). The alert is in the operator queue.');
    return true;
  } catch (x: any) {
    console.error('[acrobat] could not file the alert', x?.message);
    return false;
  }
}

/** Tells the operators only when nothing was told under `key` before (kept in the database, so a restart does not repeat it). */
async function tellOnce(key: string, subject: string, lines: string[], link?: string): Promise<boolean> {
  if (!Number(run('INSERT OR IGNORE INTO acrobat_marks (key, at) VALUES (?,?)', key, now()).changes)) return false;
  return tell(subject, lines, link);
}

// ---- The timer ---------------------------------------------------------------------------------------------------

function forgetShot(sha: string) {
  if (!/^[0-9a-f]{64}$/.test(sha)) return;
  // keptScreenshot makes the bytes this check's own, so no customer file should share them. Still, the blob store is
  // shared and content-addressed: anything else that points at the same bytes keeps the file (the same checks as
  // dropBlobs in records.ts, plus scan photos and stamp pictures' sources).
  if (get('SELECT 1 x FROM acrobat_checks WHERE screenshot_sha256=?', sha) || get('SELECT 1 x FROM files WHERE sha256=? OR original_sha256=?', sha, sha)
    || get('SELECT 1 x FROM envelopes WHERE final_sha256=?', sha) || get('SELECT 1 x FROM earlier_signatures WHERE copy_sha256=?', sha)
    || get('SELECT 1 x FROM final_copies WHERE sha256=?', sha) || get('SELECT 1 x FROM emails WHERE col_find(payload) LIKE ?', `%${sha}%`)
    || get('SELECT 1 x FROM clickwrap_versions WHERE file_sha256=?', sha) || get('SELECT 1 x FROM imported_files WHERE sha256=?', sha)
    || get('SELECT 1 x FROM scan_photos WHERE sha256=?', sha)) return;
  fs.rmSync(path.join(dataDir(), 'blobs', sha), { force: true });
}

/** Keeps the last ACROBAT_KEEP checks and their screenshots. Returns how many were deleted. */
export function tidyAcrobatChecks(): number {
  const old = all('SELECT id, screenshot_sha256 FROM acrobat_checks ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?', ACROBAT_KEEP);
  for (const o of old) {
    run('DELETE FROM acrobat_checks WHERE id=?', o.id);
    if (o.screenshot_sha256) forgetShot(o.screenshot_sha256);
  }
  return old.length;
}

/**
 * Silence is a failure too. A sample fetched and not reported on within ACROBAT_REPORT_HOURS, and no check at all for
 * more than ACROBAT_SILENT_DAYS after the first one ever, are each told once. Then the tidy-up.
 */
export async function acrobatTick(at = Date.now()): Promise<{ missed: number; silent: boolean; deleted: number }> {
  const before = new Date(at - ACROBAT_REPORT_HOURS * 3600_000).toISOString();
  const missed = all('SELECT * FROM acrobat_checks WHERE reported_at IS NULL AND missed_alerted_at IS NULL AND created_at < ? ORDER BY created_at', before);
  if (missed.length) {
    for (const m of missed) run('UPDATE acrobat_checks SET missed_alerted_at=? WHERE id=?', now(), m.id);
    await tell(missed.length === 1 ? 'An Acrobat check was started and never reported' : `${missed.length} Acrobat checks were started and never reported`, [
      `A sample PDF was fetched and no result came within ${ACROBAT_REPORT_HOURS} hours:`,
      ...missed.map((m) => `  ${m.id}, fetched at ${m.created_at}, time stamp by ${m.tsa_host}`),
      'The program that opens it in Adobe Acrobat may have stopped, or Acrobat may not have opened the file. Look at the computer it runs on.',
    ], checkLink(missed[missed.length - 1].id));
  }
  let silent = false;
  const first = get("SELECT at FROM acrobat_marks WHERE key='first_check'");
  if (first) {
    const last = get('SELECT id, created_at FROM acrobat_checks ORDER BY created_at DESC, id DESC LIMIT 1');
    const since = last?.created_at || first.at;
    if (Date.parse(since) < at - ACROBAT_SILENT_DAYS * 86400_000) {
      silent = await tellOnce(`silent:${last?.id || 'none'}`, `No Acrobat check for more than ${ACROBAT_SILENT_DAYS} days`, [
        `The last Acrobat check was at ${since}. One is expected every day.`,
        'The program that opens the sample in Adobe Acrobat has stopped calling in. Look at the computer it runs on, and at ACROBAT_CHECK_TOKEN on both sides.',
      ]);
    }
  }
  return { missed: missed.length, silent, deleted: tidyAcrobatChecks() };
}

// ---- The operator card -------------------------------------------------------------------------------------------

const shape = (r: any, at: number) => {
  let lines: string[] = [];
  try {
    lines = JSON.parse(r.panel_lines || '[]');
  } catch {}
  return {
    id: r.id, created_at: r.created_at, tsa_host: r.tsa_host, tsa_name: r.tsa_name, tsa_time: r.tsa_time, trusted: !!r.trusted, forced: !!r.forced,
    reported_at: r.reported_at, verdict: r.verdict || (Date.parse(r.created_at) < at - ACROBAT_REPORT_HOURS * 3600_000 ? 'missed' : 'waiting'),
    banner_text: r.banner_text, banner_colour: r.banner_colour, panel_lines: lines, acrobat_version: r.acrobat_version, os: r.os, notes: r.notes,
    screenshot: !!r.screenshot_sha256, alerted: !!r.alerted,
  };
};

const sealOn = () => {
  try {
    return !!sealState().on;
  } catch {
    return false;
  }
};

/** What the operator card shows. Never the token: only whether it is set. */
export function acrobatState(at = Date.now()) {
  const last = get('SELECT * FROM acrobat_checks WHERE reported_at IS NOT NULL ORDER BY reported_at DESC, id DESC LIMIT 1');
  const checks = all('SELECT * FROM acrobat_checks ORDER BY created_at DESC, id DESC LIMIT 10');
  const first = get("SELECT at FROM acrobat_marks WHERE key='first_check'")?.at || null;
  const newest = checks[0]?.created_at || first;
  const plus = (days: number) => (newest ? new Date(Date.parse(newest) + days * 86400_000).toISOString() : null);
  return {
    on: !!acrobatToken(), tsa_hosts: tsaHosts(), seal_on: sealOn(), every_days: ACROBAT_EVERY_DAYS, first_at: first,
    next_expected_at: plus(ACROBAT_EVERY_DAYS), alarm_at: plus(ACROBAT_SILENT_DAYS),
    last: last ? shape(last, at) : null, checks: checks.map((c) => shape(c, at)),
  };
}
