import crypto from 'node:crypto';
import { all, get, run, tx } from './db.ts';
import { bad, id, now, sha256, str } from './util.ts';
import { audit, hasNotPaid, nameRefusal, type Actor } from './envelopes.ts';
import { readPng, cleanPng, decodePng } from './png.ts';
import { STAMP_IS, STAMP_FROM, STAMP_PNG_MAX_BYTES, STAMP_OUT_MAX_SIDE, STAMP_OUT_MIN_SIDE, STAMPS_PER_ACCOUNT, STAMP_DEFAULT_MM, STAMP_MIN_MM, STAMP_MAX_MM, STAMP_NAME_MAX } from '../lib/stamps.ts';
import { isInk, validSeed, TILT_MAX, INK_WORD, type Ink } from '../lib/stampink.ts';
import { whoIs } from '../lib/groups.ts';

// Stamps: a company stamp or seal put on the page next to a signature, printed like ink (multiply, slightly less
// than full opacity) on the signing screen and in the signed PDF. The picture is turned into an impression in the
// browser (src/lib/stampink.ts) and comes here as a transparent PNG. Here: checking and keeping those pictures, the
// account's own stamps under Settings, and a stamp field on an envelope.
//
// A stamp field holds, as its value, the SHA-256 of its impression in stamp_images. Two kinds:
//  - a recipient's stamp (recipient_id set): put on by that person when they sign, from a picture, a photo, or a
//    saved stamp of their own account. Like a signature: kept by "Finish later", placed again when they are asked
//    to sign again. A recipient who only stamps counts like any other signer who finishes.
//  - the sender's stamp (no recipient_id): one of the account's stamps, chosen in the editor ("stamp_id"). It is
//    part of what is printed, so once somebody has finished it only changes with the sign-again choice
//    (printedStamp, used by printedView in envelopes.ts).
// Changing or deleting a stamp under Settings never changes a document it is already on: the field keeps the
// picture it was put on with.
//
// What a stamp is said to be, everywhere: a picture of a stamp that a person put on the document. Nothing here
// checks that they may use it, and it is not a certified electronic seal (STAMP_IS in src/lib/stamps.ts).

const ACTS = (role: string) => role === 'signer' || role === 'inperson' || role === 'witness';
export const isStampField = (f: any) => f?.type === 'stamp';
/** A stamp field of the sender's own: no recipient puts it on. */
export const isSenderStamp = (f: any) => f?.type === 'stamp' && (f.recipient_id == null || f.recipient_id === '');
/** The sender's stamp as part of what is printed: the fingerprint of its picture. Used by printedView, seenView and askView. */
export const printedStamp = (f: any): string => (isSenderStamp(f) ? String(f.value ?? '') : '');

const SHA = /^[0-9a-f]{64}$/;

// ---- Pictures ------------------------------------------------------------------------------------------------

const KIND_OF: [RegExp, string][] = [[/^data:image\/svg/i, 'an SVG drawing'], [/^data:application\/pdf/i, 'a PDF'], [/^data:image\/jpe?g/i, 'a JPEG picture'], [/^data:image\/webp/i, 'a WebP picture'], [/^data:image\/gif/i, 'a GIF picture']];

/** The bytes of a PNG sent as a data URL, or the reason in words why it is not one. */
function pngBytes(v: any, what: string): Buffer {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw bad(`${what} has no picture. Send "image" as a PNG data URL, which starts with data:image/png;base64, Nothing was saved.`);
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) {
    const kind = KIND_OF.find(([re]) => re.test(s))?.[1];
    throw bad(`${what} is ${kind || 'not a PNG picture'}. A stamp is kept as a PNG whose paper is see-through, made from a photo or a design by the stamp screen in the app (Settings, Stamps, or Add a stamp on the signing page). Through the API, send that PNG as a data URL. Nothing was saved.`);
  }
  const b64 = m[1].replace(/\s+/g, '');
  if (b64.length > Math.ceil((STAMP_PNG_MAX_BYTES * 4) / 3) + 8) throw bad(`${what} is larger than ${STAMP_PNG_MAX_BYTES / 1e6} MB, the most a stamp can be. At most ${STAMP_OUT_MAX_SIDE} pixels on its longer side is plenty for a sharp print. Nothing was saved.`, 413);
  return Buffer.from(b64, 'base64');
}

/**
 * Checks a stamp impression and keeps it once, by the fingerprint of its PNG. Only what draws the picture is kept:
 * text, dates and camera notes inside the file are left out, so nothing but the pixels is stored or printed. It must
 * be an 8-bit PNG with see-through paper and some ink. Anything else is refused in words, and nothing is saved.
 */
export function saveStampImage(v: any, what = 'The stamp'): { sha: string; width: number; height: number; bytes: number } {
  const raw = pngBytes(v, what);
  if (raw.length > STAMP_PNG_MAX_BYTES) throw bad(`${what} is ${(raw.length / 1e6).toFixed(1)} MB, and a stamp can be up to ${STAMP_PNG_MAX_BYTES / 1e6} MB. Make it smaller: at most ${STAMP_OUT_MAX_SIDE} pixels on its longer side is plenty. Nothing was saved.`, 413);
  const info = readPng(raw);
  if (!info) throw bad(`${what} is not a whole PNG picture. It may have been cut short on the way. Make it again and send it once more. Nothing was saved.`);
  const { width: w, height: h } = info;
  if (Math.max(w, h) < STAMP_OUT_MIN_SIDE) throw bad(`${what} is only ${w} by ${h} pixels, too small to print as a stamp. Use a picture at least ${STAMP_OUT_MIN_SIDE} pixels across. Nothing was saved.`);
  if (w > STAMP_OUT_MAX_SIDE || h > STAMP_OUT_MAX_SIDE) throw bad(`${what} is ${w} by ${h} pixels, and a stamp can be up to ${STAMP_OUT_MAX_SIDE} on each side. Make it smaller and send it again. Nothing was saved.`);
  const px = decodePng(raw, STAMP_OUT_MAX_SIDE * STAMP_OUT_MAX_SIDE);
  if (!px) throw bad(`${what} must be an 8-bit PNG with a see-through background (RGBA, not interlaced). Pictures with a palette or 16 bits per channel are not taken. The stamp screen in the app makes the right kind. Nothing was saved.`);
  let clear = 0, ink = 0;
  for (let i = 3; i < px.data.length; i += 4) {
    if (px.data[i] < 64) clear++;
    else if (px.data[i] > 128) ink++;
  }
  if (clear < w * h * 0.05) throw bad(`${what} has no see-through background, so it would print as a box with its paper around it, not like ink. Send the impression: a PNG where everything that is not ink is see-through. The stamp screen in the app (Settings, Stamps) makes one from a photo or a design. Nothing was saved.`);
  if (ink < Math.max(20, w * h * 0.003)) throw bad(`${what} is see-through almost everywhere: there is no ink in it to print. Nothing was saved.`);
  const png = cleanPng(info, raw);
  const sha = sha256(png);
  run('INSERT OR IGNORE INTO stamp_images (sha256, png, width, height, bytes, at) VALUES (?,?,?,?,?,?)', sha, png, w, h, png.length, now());
  return { sha, width: w, height: h, bytes: png.length };
}

/** The PNG of a stamp impression, or null. */
export function stampPng(sha: any): Buffer | null {
  if (!SHA.test(String(sha ?? ''))) return null;
  const r = get('SELECT png FROM stamp_images WHERE sha256=?', sha);
  return r ? Buffer.from(r.png) : null;
}
export const stampSize = (sha: any): { width: number; height: number } | null => (SHA.test(String(sha ?? '')) ? get('SELECT width, height FROM stamp_images WHERE sha256=?', sha) : null);

/** A stamp picture as an answer: never cached by anyone but this browser, and the same address always means the same picture. */
export const pngResponse = (png: Buffer) =>
  new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });

/**
 * Takes away every picture that nothing points at any more: no stamp field, no stamp of an account. Called when
 * envelopes, accounts or stamps are deleted (removeUnusedBlobs in routes-trust.ts, DELETE /stamps/:id), and by the timer.
 */
export function pruneStampImages(): number {
  return Number(run(`DELETE FROM stamp_images WHERE sha256 NOT IN (SELECT value FROM fields WHERE type='stamp' AND value IS NOT NULL)
    AND sha256 NOT IN (SELECT image_sha FROM stamps)`).changes);
}

// ---- How a stamp looks ---------------------------------------------------------------------------------------

export type StampLook = { ink: Ink; seed: number; tilt: number; texture: number };
/** The settings an impression was made with, checked. They are kept with it, so it can be made again the same way. */
export function lookOf(b: any, what: string): StampLook {
  const ink = b?.ink == null || b.ink === '' ? 'blue' : b.ink;
  if (!isInk(ink)) throw bad(`${what}: the ink "${str(ink, 30)}" is not one we have. Use one of: blue, red, purple, black, green. Nothing was saved.`);
  const seed = b?.seed == null || b.seed === '' ? 1 + crypto.randomInt(2147483645) : Number(b.seed);
  if (!validSeed(seed)) throw bad(`${what}: "seed" must be a whole number from 1 to 2147483646. Nothing was saved.`);
  const tilt = b?.tilt == null || b.tilt === '' ? 0 : Number(b.tilt);
  if (!Number.isFinite(tilt) || Math.abs(tilt) > TILT_MAX) throw bad(`${what}: "tilt" is in degrees, from -${TILT_MAX} to ${TILT_MAX}. Nothing was saved.`);
  const texture = b?.texture == null || b.texture === '' ? 0.5 : Number(b.texture);
  if (!Number.isFinite(texture) || texture < 0 || texture > 1) throw bad(`${what}: "texture" goes from 0 (even ink) to 1 (a well-worn stamp). Nothing was saved.`);
  return { ink, seed, tilt: Math.round(tilt * 10) / 10, texture: Math.round(texture * 100) / 100 };
}

function sizeMm(v: any, d: number, what: string): number {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < STAMP_MIN_MM || n > STAMP_MAX_MM) throw bad(`${what}: the real size is in millimetres across, from ${STAMP_MIN_MM} to ${STAMP_MAX_MM}. A round company seal is about 38 to 45. Nothing was saved.`);
  return Math.round(n * 10) / 10;
}

// ---- The account's stamps ------------------------------------------------------------------------------------

export const accountStamps = (accountId: string) =>
  all('SELECT s.*, i.width, i.height FROM stamps s JOIN stamp_images i ON i.sha256=s.image_sha WHERE s.account_id=? ORDER BY s.created_at, s.id', accountId);
export const accountStamp = (accountId: string, stampId: any) =>
  get('SELECT s.*, i.width, i.height FROM stamps s JOIN stamp_images i ON i.sha256=s.image_sha WHERE s.account_id=? AND s.id=?', accountId, str(stampId, 60));

/** A stamp as the screens and the API show it. The picture is fetched by its own address, with the session. */
export const publicStamp = (s: any) => ({
  id: s.id, name: s.name, ink: s.ink, seed: s.seed, tilt: s.tilt, texture: s.texture, size_mm: s.size_mm, image_sha256: s.image_sha, width: s.width, height: s.height,
  image_url: `/api/stamps/${s.id}/image?v=${String(s.image_sha).slice(0, 16)}`, created_by: s.created_by, created_at: s.created_at, updated_by: s.updated_by, updated_at: s.updated_at,
});

function nameOf(b: any, account: any, stampId: string | null, was?: string): string {
  const name = str(b?.name, 400).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw bad('Give the stamp a name, such as "Company stamp" or "Received", so your team can tell the stamps apart. Nothing was saved.');
  if (name.length > STAMP_NAME_MAX) throw bad(`A stamp's name can be up to ${STAMP_NAME_MAX} characters, and this one has ${name.length}. Nothing was saved.`);
  // A stamp's name is printed on the certificate and in the audit trail that recipients get. An account the checks
  // still apply to is held to the same rule as any other name it types (nameRefusal in envelopes.ts). Pictures are
  // not read: the fake-payment-notice rules are about words.
  if (name !== was && hasNotPaid(account)) {
    const no = nameRefusal([name]);
    if (no) throw bad(`${no} Nothing was saved.`, 422);
  }
  if (get('SELECT 1 x FROM stamps WHERE account_id=? AND lower(name)=lower(?) AND id IS NOT ?', account.id, name, stampId))
    throw bad(`Your team already has a stamp called "${name}". Choose another name, so nobody picks the wrong one. Nothing was saved.`, 409);
  return name;
}

export function createStamp(account: any, user: any, b: any) {
  return tx(() => {
    const n = get('SELECT COUNT(*) n FROM stamps WHERE account_id=?', account.id).n;
    if (n >= STAMPS_PER_ACCOUNT) throw bad(`Your team has ${n} stamps, which is as many as an account can keep. Delete one you no longer use under Settings, Stamps, and add this one then. Nothing was saved.`, 409);
    const name = nameOf(b, account, null);
    const look = lookOf(b, `The stamp "${name}"`);
    const size = sizeMm(b?.size_mm, STAMP_DEFAULT_MM, `The stamp "${name}"`);
    const img = saveStampImage(b?.image, `The picture of "${name}"`);
    const sid = id('stp');
    const t = now();
    run('INSERT INTO stamps (id, account_id, name, image_sha, ink, seed, tilt, texture, size_mm, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      sid, account.id, name, img.sha, look.ink, look.seed, look.tilt, look.texture, size, user?.name || null, t, user?.name || null, t);
    return accountStamp(account.id, sid);
  });
}

/** A new name, a new real size, or a new picture. Documents that already carry the stamp keep the picture they have. */
export function updateStamp(account: any, user: any, stampId: string, b: any) {
  return tx(() => {
    const s = accountStamp(account.id, stampId);
    if (!s) throw bad('That stamp is not in your account any more. Someone may have deleted it. Load the page again.', 404);
    const name = b?.name === undefined ? s.name : nameOf(b, account, s.id, s.name);
    const size = sizeMm(b?.size_mm, s.size_mm, `The stamp "${name}"`);
    let img = { sha: s.image_sha };
    let look: StampLook = { ink: s.ink, seed: s.seed, tilt: s.tilt, texture: s.texture };
    if (b?.image !== undefined) {
      look = lookOf(b, `The stamp "${name}"`);
      img = saveStampImage(b.image, `The picture of "${name}"`);
    }
    run('UPDATE stamps SET name=?, image_sha=?, ink=?, seed=?, tilt=?, texture=?, size_mm=?, updated_by=?, updated_at=? WHERE id=?', name, img.sha, look.ink, look.seed, look.tilt, look.texture, size, user?.name || null, now(), s.id);
    // Where the old picture is already on a document, it stays: those documents are not changed.
    const kept = img.sha !== s.image_sha ? get("SELECT COUNT(DISTINCT envelope_id) n FROM fields WHERE type='stamp' AND stamp_id=? AND value=?", s.id, s.image_sha).n : 0;
    return { stamp: accountStamp(account.id, s.id), kept };
  });
}

export function deleteStamp(account: any, stampId: string) {
  const s = accountStamp(account.id, stampId);
  if (!s) throw bad('That stamp is not in your account any more. Someone may have deleted it already.', 404);
  const kept = get("SELECT COUNT(DISTINCT envelope_id) n FROM fields WHERE type='stamp' AND stamp_id=? AND value IS NOT NULL", s.id).n;
  run('DELETE FROM stamps WHERE id=?', s.id);
  pruneStampImages();
  return { kept };
}

// ---- Stamp fields --------------------------------------------------------------------------------------------

export type StampMeta = { name: string | null; ink: Ink; seed: number; tilt: number; texture: number; size_mm?: number | null; from: 'account' | 'upload' | 'camera' | 'sender'; at: string; by: string | null; stamp_id?: string | null };
export function metaOf(f: any): StampMeta | null {
  try {
    const m = JSON.parse(f?.stamp_meta || 'null');
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/**
 * What a stamp field holds once a draft, a template or a correction is saved. The editor and the API send the field
 * as it is; this decides its value, so nothing a caller sends can put a picture on a page by itself.
 *  - A recipient's stamp keeps what that person put on, as long as the field is still theirs.
 *  - The sender's stamp is one of the account's stamps ("stamp_id"). The same stamp as before keeps the picture it
 *    was put on with; another stamp, or "stamp_refresh": true, takes that stamp's picture as it is now.
 */
export function stampOnSave(f: any, old: any, rid: string | null, accountId: string, which: string, by?: Actor) {
  if (rid) {
    const keep = !!old && old.type === 'stamp' && old.recipient_id === rid && !!old.value;
    return keep ? { value: old.value, stamp_id: old.stamp_id ?? null, meta: old.stamp_meta ?? null, readonly: 0, required: f.required === false || f.required === 0 ? 0 : 1 } : { value: null, stamp_id: null, meta: null, readonly: 0, required: f.required === false || f.required === 0 ? 0 : 1 };
  }
  const sid = f.stamp_id == null || f.stamp_id === '' ? null : str(f.stamp_id, 60);
  if (!sid) return { value: null, stamp_id: null, meta: null, readonly: 1, required: 0 };
  if (old && isSenderStamp(old) && old.stamp_id === sid && old.value && f.stamp_refresh !== true) return { value: old.value, stamp_id: sid, meta: old.stamp_meta, readonly: 1, required: 0 };
  const s = get('SELECT * FROM stamps WHERE id=? AND account_id=?', sid, accountId);
  if (!s) throw bad(`${which}, a stamp field, names the stamp "${str(sid, 60)}", which this account does not have${old?.stamp_id === sid ? ' any more: it was deleted under Settings' : ''}. Use the id of one of your stamps (GET /stamps), or leave "stamp_id" out to choose one later. Nothing was saved.`);
  const meta: StampMeta = { name: s.name, ink: s.ink, seed: s.seed, tilt: s.tilt, texture: s.texture, size_mm: s.size_mm, from: 'sender', at: now(), by: by?.name || null, stamp_id: s.id };
  return { value: s.image_sha, stamp_id: s.id, meta: JSON.stringify(meta), readonly: 1, required: 0 };
}

/** Copies the stamp of the sender with every copy: a template, a clone, a bulk send, a public form. fmap: old field id to new. */
export function copyStamps(src: any, fmap: Map<string, string>) {
  for (const f of src.fields || []) if (isSenderStamp(f) && fmap.has(f.id)) run('UPDATE fields SET value=?, stamp_id=?, stamp_meta=?, readonly=1, required=0 WHERE id=?', f.value ?? null, f.stamp_id ?? null, f.stamp_meta ?? null, fmap.get(f.id));
}

const docName = (e: any, f: any) => (e.documents.length > 1 ? e.documents.find((d: any) => d.id === f.document_id)?.name : '');
/** Where a field is, in words: "page 2" or "page 2 of "Lease"". */
export const stampWhere = (e: any, f: any) => `page ${Number(f.page) + 1}${docName(e, f) ? ` of "${docName(e, f)}"` : ''}`;
const ts = (s: any) => String(s ?? '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
/** The stamp in words: its name, where it came from, its ink. */
export function stampSaid(m: StampMeta | null): string {
  if (!m) return 'a stamp';
  const from = STAMP_FROM[m.from] || 'a picture';
  return `${m.name ? `the stamp "${m.name}"` : 'a stamp'} (${from}, ${INK_WORD[m.ink]?.toLowerCase() || 'one'} ink)`;
}

/** Why an envelope cannot be sent because of a stamp field, in words, or null. */
export function stampProblem(e: any): string | null {
  const empty = e.fields.find((f: any) => isSenderStamp(f) && !f.value);
  if (empty) return `The stamp on ${stampWhere(e, empty)} has no stamp chosen yet. Select it in the editor and choose one of your team's stamps, or remove it.`;
  for (const f of e.fields.filter((f: any) => f.type === 'stamp' && f.recipient_id)) {
    const r = e.recipients.find((x: any) => x.id === f.recipient_id);
    if (r && !ACTS(r.role)) return `${r.name || 'A recipient'} has a stamp field on ${stampWhere(e, f)}, but only someone who signs can put a stamp on the page. Give the field to a signer, or remove it.`;
  }
  return null;
}

/** The record of the sender's stamps when the envelope is sent: one line for each. */
export function stampsSent(e: any, actor: Actor) {
  for (const f of e.fields.filter((f: any) => isSenderStamp(f) && f.value))
    audit(e.id, actor, 'Stamp put on by the sender', `The sender put ${stampSaid(metaOf(f))} on ${stampWhere(e, f)}. Fingerprint of the picture (SHA-256): ${f.value}.`);
}

/** The record of a recipient's stamps when they finish: who put which stamp on which field, when, and its fingerprint. */
export function stampsFinished(e: any, r: any, actor: Actor) {
  for (const f of e.fields.filter((f: any) => f.recipient_id === r.id && f.type === 'stamp' && f.value)) {
    const m = metaOf(f);
    audit(e.id, actor, 'Stamp put on', `${whoIs(r)} put ${stampSaid(m)} on ${stampWhere(e, f)}${f.label ? `, in the field "${str(f.label, 80)}"` : ''}${m?.at ? `, at ${ts(m.at)}` : ''}. Fingerprint of the picture (SHA-256): ${f.value}.`);
  }
}

/** What the certificate lists under a person who finished: each stamp they put on. */
export function stampCertLines(e: any, r: any): [string, string][] {
  if (r.status !== 'completed') return [];
  return e.fields.filter((f: any) => f.recipient_id === r.id && f.type === 'stamp' && f.value).map((f: any) => {
    const m = metaOf(f);
    return ['Stamp', `${m?.name ? `"${m.name}"` : 'A stamp'}, ${STAMP_FROM[m?.from || 'upload'] || 'a picture'}, on ${stampWhere(e, f)}${m?.at ? `, put on ${ts(m.at)}` : ''}. Picture SHA-256 ${f.value}`];
  });
}
/** And under the envelope: the sender's own stamps. */
export const senderStampCertLines = (e: any): [string, string][] =>
  e.fields.filter((f: any) => isSenderStamp(f) && f.value).map((f: any) => {
    const m = metaOf(f);
    return ['Sender\'s stamp', `${m?.name ? `"${m.name}"` : 'A stamp'}, a saved stamp of the account, on ${stampWhere(e, f)}. Picture SHA-256 ${f.value}`];
  });
/** One sentence on what a stamp is, for a certificate that lists any. */
export const stampCertNote = (e: any): string | null => (e.fields.some((f: any) => f.type === 'stamp' && f.value) ? STAMP_IS : null);

/** What a correction did to the sender's stamp, in words for the people who have to look again. Null when nothing. */
export function senderStampChange(e: any, o: any, f: any, where: (f: any, x: any) => string, a: any, b: any): string | null {
  if (!o && f) return `The sender put ${stampSaid(metaOf(f))} on ${where(f, b)}.`;
  if (o && !f) return `The sender's stamp was taken off ${where(o, a)}.`;
  if (o.value !== f.value) {
    const was = metaOf(o)?.name, is = metaOf(f)?.name;
    return was && is && was !== is ? `The sender's stamp on ${where(f, b)} changed from "${was}" to "${is}".` : f.value ? `The sender's stamp on ${where(f, b)} has a new picture${is ? ` of "${is}"` : ''}.` : `The sender's stamp was taken off ${where(f, b)}.`;
  }
  const at = (x: any) => [x.document_id, x.page, Math.round(x.x * 1e6), Math.round(x.y * 1e6), Math.round(x.w * 1e6), Math.round(x.h * 1e6)].join();
  return at(o) !== at(f) ? `The sender's stamp was moved or resized on ${where(f, b)}.` : null;
}

/** How a stamp on someone else's part of the page is shown to a signer: its picture by the signing link, and its name. */
export function stampSeen(token: string, f: any) {
  const m = metaOf(f);
  return { image: `/api/sign/${token}/stamp-image/${f.value}`, stamp: { name: m?.name || null, ink: m?.ink || null, from: m?.from || null } };
}

// ---- The evidence pack and the export ------------------------------------------------------------------------

const safe = (s: any) => String(s ?? '').replace(/[^\w .-]+/g, '_').trim().slice(0, 50) || 'stamp';
const csvRow = (cells: any[]) => cells.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');

/** Every stamp on an envelope as a PNG with its fingerprint, and an index, for the evidence pack. */
export function stampEvidence(e: any): { name: string; data: Buffer }[] {
  const on = e.fields.filter((f: any) => f.type === 'stamp' && f.value);
  if (!on.length) return [];
  const out: { name: string; data: Buffer }[] = [];
  const rows = [csvRow(['file', 'put_on_by', 'stamp', 'from', 'ink', 'page', 'document', 'put_on_at', 'sha256'])];
  const seen = new Set<string>();
  for (const f of on) {
    const png = stampPng(f.value);
    const file = `stamps/${String(f.value).slice(0, 16)}.png`;
    if (png && !seen.has(f.value)) (seen.add(f.value), out.push({ name: file, data: png }));
    const m = metaOf(f);
    const who = f.recipient_id ? e.recipients.find((r: any) => r.id === f.recipient_id) : null;
    rows.push(csvRow([png ? file : '(picture no longer stored)', who ? whoIs(who) : 'the sender', m?.name || '', STAMP_FROM[m?.from || ''] || '', m?.ink || '', Number(f.page) + 1, e.documents.find((d: any) => d.id === f.document_id)?.name, m?.at || '', f.value]));
  }
  out.push({ name: 'stamps/index.csv', data: Buffer.from('﻿' + rows.join('\r\n')) });
  return out;
}

/** The account's own stamps for the export: each picture and an index. */
export function stampExport(accountId: string): { name: string; data: Buffer }[] {
  const list = accountStamps(accountId);
  if (!list.length) return [];
  const rows = [csvRow(['file', 'name', 'ink', 'seed', 'tilt', 'texture', 'size_mm', 'created_by', 'created_at', 'updated_at', 'sha256'])];
  const out: { name: string; data: Buffer }[] = [];
  for (const s of list) {
    const png = stampPng(s.image_sha);
    const file = `stamps/${safe(s.name)} ${s.id.slice(-6)}.png`;
    if (png) out.push({ name: file, data: png });
    rows.push(csvRow([file, s.name, s.ink, s.seed, s.tilt, s.texture, s.size_mm, s.created_by, s.created_at, s.updated_at, s.image_sha]));
  }
  out.push({ name: 'stamps/index.csv', data: Buffer.from('﻿' + rows.join('\r\n')) });
  return out;
}
