// What the person's role allows (perm.ts): 'stamps' here, where this file once asked for an admin.
import { can } from './perm.ts';
import { route, type Ctx } from './router.ts';
import { get, run, tx } from './db.ts';
import { bad, now, str, rateLimit, rateWait } from './util.ts';
// Refusals the signing page shows carry a code, so it can say them in the signer's language (signlang.ts).
import { refuse } from './signlang.ts';
import { sameEmail } from './credits.ts';
import { find, look } from './routes-sign.ts';
import { mine } from './routes-envelopes.ts';
import { notOpen, shownVersion, changedSince } from './envelopes.ts';
import { accountStamps, accountStamp, publicStamp, createStamp, updateStamp, deleteStamp, saveStampImage, stampPng, pngResponse, lookOf, isSenderStamp, stampSize, metaOf, type StampMeta } from './stamps.ts';
import { onShownDoc } from './visibility.ts';
import { STAMP_IS_TEAM, STAMP_IS_YOU, STAMPS_PER_ACCOUNT, STAMP_UPLOADS_PER_LINK_HOUR, STAMP_UPLOADS_PER_ADDRESS_HOUR, stampTurn } from '../lib/stamps.ts';

// Stamps (src/server/stamps.ts). The account's own stamps, kept by admins under Settings and used by everyone on the
// team; and putting a stamp on a field from a signing link, which is authorised by that link like the rest of the
// signing page (routes-sign.ts).

const ACTS = (role: string) => role === 'signer' || role === 'inperson' || role === 'witness';

// ---- The account's stamps ------------------------------------------------------------------------------------

route('GET', '/stamps', (c) => ({
  stamps: accountStamps(c.account.id).map(publicStamp), max: STAMPS_PER_ACCOUNT, may_change: can(c, 'stamps'), what_a_stamp_is: STAMP_IS_TEAM,
}));

route('POST', '/stamps', async (c) => {
  const b = await c.body();
  return { stamp: publicStamp(createStamp(c.account, c.user, b)) };
}, 'admin');

route('PUT', '/stamps/:id', async (c) => {
  const b = await c.body();
  const { stamp, kept } = updateStamp(c.account, c.user, c.params.id, b);
  return { stamp: publicStamp(stamp), kept_on_documents: kept };
}, 'admin');

route('DELETE', '/stamps/:id', (c) => {
  const { kept } = deleteStamp(c.account, c.params.id);
  return { ok: true, kept_on_documents: kept };
}, 'admin');

route('GET', '/stamps/:id/image', (c) => {
  const s = accountStamp(c.account.id, c.params.id);
  const png = s && stampPng(s.image_sha);
  if (!png) throw bad('That stamp is not in your account any more.', 404);
  return pngResponse(png);
});

// The picture of a stamp on one envelope, for the people who can open that envelope in the app: its sender, and the
// account's admins. A picture a signer uploaded is shown to nobody else.
route('GET', '/envelopes/:id/stamp-image/:sha', (c) => {
  const e = mine(c, c.params.id, undefined, { removed: true });
  if (!e.fields.some((f: any) => f.type === 'stamp' && f.value === c.params.sha)) throw bad('That stamp is not on this envelope.', 404);
  const png = stampPng(c.params.sha);
  if (!png) throw bad('That stamp picture is no longer stored.', 404);
  return pngResponse(png);
});

// ---- From a signing link -------------------------------------------------------------------------------------

// The signed-in person's own saved stamps, when the signing link is theirs: the address they are signed in with is
// the address the document went to, and they are not signing in person on someone else's device. Otherwise none.
function savedFor(c: Ctx, r: any): { stamps: any[]; why: string | null } {
  if (r.role === 'inperson') return { stamps: [], why: 'in person' };
  if (!c.auth || c.auth.via !== 'session') return { stamps: [], why: 'signed out' };
  if (!sameEmail(c.user.email, r.email)) return { stamps: [], why: 'another address' };
  return { stamps: accountStamps(c.account.id), why: null };
}

route('GET', '/sign/:token/stamps', (c) => {
  const { r } = find(c);
  const { stamps, why } = savedFor(c, r);
  return { stamps: stamps.map(publicStamp), account: why ? null : c.account.name, why_none: why, what_a_stamp_is: STAMP_IS_YOU };
}, 'public');

// Putting a stamp on one of this person's stamp fields: a picture made on this screen ("image", a PNG whose paper is
// see-through, with the settings it was made with), or one of the saved stamps of their own account ("stamp_id").
// One picture per field: a new one takes the old one's place. Kept like an answer, so "Finish later" keeps it.
route('POST', '/sign/:token/stamp', async (c) => {
  find(c);
  const b = await c.body();
  // Looked up again after the body is in, on the line after the wait: see checkedBody in routes-sign.ts.
  const { e, r, actor } = look(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  const shown = shownVersion(r, b);
  if (shown != null && shown !== e.content_version) throw changedSince(e);
  if (!r.consent_at) throw refuse('consent_first');
  if (!ACTS(r.role)) throw refuse('stamp_signers_only', 403);
  const f = e.fields.find((x: any) => x.id === b.field_id && x.recipient_id === r.id && x.type === 'stamp');
  if (!f) throw refuse('stamp_field_gone', 404);
  let meta: StampMeta, sha: string, stampId: string | null = null;
  if (b.same_as != null && b.same_as !== '') {
    // The stamp this person already put on another of their own stamp fields of this document: the same picture
    // and settings again, so both prints are the same stamp. Nothing is uploaded, so it does not count as a picture.
    const src = e.fields.find((x: any) => x.id === b.same_as && x.id !== f.id && x.recipient_id === r.id && x.type === 'stamp' && x.value);
    const was = src ? metaOf(src) : null;
    if (!src || !was) throw refuse('stamp_before_gone', 404);
    sha = src.value;
    stampId = src.stamp_id || null;
    meta = { ...was, at: now(), by: actor.name };
  } else if (b.stamp_id != null && b.stamp_id !== '') {
    const { why } = savedFor(c, r);
    if (why) throw why === 'in person' ? refuse('stamp_saved_in_person', 403) : refuse('stamp_saved_other_account', 403, { email: r.email });
    const s = accountStamp(c.account.id, b.stamp_id);
    if (!s) throw refuse('stamp_saved_gone', 404);
    sha = s.image_sha;
    stampId = s.id;
    meta = { name: s.name, ink: s.ink, seed: s.seed, tilt: s.tilt, texture: s.texture, turn: stampTurn(s.turn), size_mm: s.size_mm, from: 'account', at: now(), by: actor.name, stamp_id: s.id };
  } else {
    // A picture from a stranger's link: images only, a size limit, and a limit on how many in an hour.
    const per = `stamp:${r.id}`, ip = `stampip:${c.ip}`;
    const wait = Math.max(rateWait(per, STAMP_UPLOADS_PER_LINK_HOUR), rateWait(ip, STAMP_UPLOADS_PER_ADDRESS_HOUR));
    if (wait) throw refuse('stamp_wait', 429, { minutes: Math.ceil(wait / 60_000) });
    rateLimit(per, Infinity, 3600_000);
    rateLimit(ip, Infinity, 3600_000);
    const look = lookOf(b, 'The stamp');
    meta = { name: null, ...look, from: b.from === 'camera' ? 'camera' : 'upload', at: now(), by: actor.name };
    sha = '';
  }
  tx(() => {
    if (!sha) sha = saveStampImage(b.image, 'The stamp').sha;
    run('UPDATE fields SET value=?, stamp_id=?, stamp_meta=? WHERE id=? AND envelope_id=?', sha, stampId, JSON.stringify(meta), f.id, e.id);
    run('UPDATE recipients SET touched_at=? WHERE id=?', now(), r.id);
  });
  return { field_id: f.id, value: sha, image_url: `/api/sign/${c.params.token}/stamp-image/${sha}`, size: stampSize(sha), turn: stampTurn(meta), stamp: { name: meta.name, ink: meta.ink, from: meta.from }, what_a_stamp_is: STAMP_IS_YOU };
}, 'public');

route('DELETE', '/sign/:token/stamp/:field', async (c) => {
  const { e, r } = find(c);
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) throw notOpen(e, r);
  const f = e.fields.find((x: any) => x.id === c.params.field && x.recipient_id === r.id && x.type === 'stamp');
  if (!f) throw refuse('stamp_field_gone', 404);
  run('UPDATE fields SET value=NULL, stamp_id=NULL, stamp_meta=NULL WHERE id=?', f.id);
  return { ok: true };
}, 'public');

// A stamp picture on this envelope, for a person on it: their own, the sender's, or that of someone who has
// finished (what the signing page shows them anyway). Never a picture from another envelope, whatever its address.
route('GET', '/sign/:token/stamp-image/:sha', (c) => {
  const { e, r } = find(c);
  const sha = str(c.params.sha, 64);
  const by = new Map<string, any>(e.recipients.map((x: any) => [x.id, x]));
  // Only from a file this link shows: one the person was not shown is not theirs to open (visibility.ts).
  const may = e.fields.some((f: any) => f.type === 'stamp' && f.value === sha && onShownDoc(e, f.document_id) && (f.recipient_id === r.id || isSenderStamp(f) || by.get(f.recipient_id)?.status === 'completed'));
  const png = may ? stampPng(sha) : null;
  if (!png) throw refuse('stamp_not_yours', 404);
  return pngResponse(png);
}, 'public');
