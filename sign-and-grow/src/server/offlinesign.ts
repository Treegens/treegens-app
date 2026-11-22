// Signing in person where there is no signal (research/docusign-gaps.json, batch "offline-inperson"). A field worker
// gets one person's part ready on their own device while it still has a connection. Later, with no signal, the host
// unlocks it with a PIN, hands the device over, and the person reads, agrees, fills in and finishes on it. The result
// waits on the device, encrypted, until the device has signal again (src/components/sign/offlineInPerson.ts).
//
// What the server does here:
// - prepare: makes one "copy got ready" row for one person who signs in person, on an envelope that is out, by the
//   host's own signed-in browser, and answers what the device keeps: the signing page's data and the files. One
//   envelope per device: getting another one ready on the same browser ends the earlier copy.
// - finish: takes the result back, by the signing link like every other Finish. It is accepted only while that copy
//   is still the one got ready, at most OFFLINE_DAYS days old, and only if the envelope is exactly as it was then
//   (its content version). Otherwise nothing is signed and the host is told, plainly, that the person signs again.
// - the record: when it was got ready, the device's clock when the person finished (never checked, and said so),
//   and when the server received it. The certificate says the same (offlineCertLines, printed by pdf.ts).
//
// Nothing about the document is checked or changed on the device: the server is where it is signed, at the moment
// it receives the result. Until then nothing is signed, and the device says so.
import { get, all, run, readBlob } from './db.ts';
import { bad, id, now, str } from './util.ts';
import { audit, completeRecipient, okImage } from './envelopes.ts';
import { isSupplement } from './supplements.ts';
import { ownAtConsent } from './disclosure.ts';
import { consentLine } from './locales.ts';
import { notePageLanguage } from './signlang.ts';
import { validZone } from '../lib/dates.ts';
import { OFFLINE_DAYS, OFFLINE_FIELD_TYPES, OFFLINE_WORDS } from '../lib/offlinesign.ts';
import type { Ctx } from './router.ts';

const DAY = 864e5;

/** The kinds of things a person's part can ask for that need a connection, said as the reason it cannot be got ready. */
export function needsSignal(e: any, r: any, gate: string | null): string | null {
  const name = r.name || 'This person';
  if (r.access_code) return `${name} types an access code to open the document, and that is checked by GrowSigning. Host it with a connection instead.`;
  if (gate) return `${name} types a code we send them, which needs a connection. Host it with a connection instead.`;
  if (r.group_name) return 'A group signs this, and who takes it on is decided by GrowSigning. Host it with a connection instead.';
  if (e.recipients.some((x: any) => x.role === 'witness' && (!x.witness_for || x.witness_for === r.id))) return `${name} has a witness, who signs with their own link. Host it with a connection instead.`;
  if (e.documents.some(isSupplement)) return 'This document comes with files to read, which are opened from GrowSigning. Host it with a connection instead.';
  const mine = e.fields.filter((f: any) => f.recipient_id === r.id);
  const odd = mine.find((f: any) => !OFFLINE_FIELD_TYPES.includes(f.type));
  if (odd) return `${name}'s part has a ${String(odd.label || odd.type).replace(/_/g, ' ')} field, which needs a connection. Host it with a connection instead.`;
  if (mine.some((f: any) => f.show_when || f.formula || f.date_from)) return `${name}'s part has fields that change with other answers, which needs a connection. Host it with a connection instead.`;
  if (!mine.some((f: any) => f.type === 'signature' || f.type === 'initials')) return `${name}'s part has nothing to sign. Host it with a connection instead.`;
  return null;
}

/** The copy got ready for this person that a result may come back for, or null. */
const readyFor = (prepId: string, recipientId: string) => get("SELECT * FROM offline_preps WHERE id=? AND recipient_id=?", prepId, recipientId);

/** Ends every copy still waiting on this browser (one envelope per device), saying why. */
export function endOnSession(sessionId: string, why: string) {
  run("UPDATE offline_preps SET state='ended', ended_at=?, ended_why=? WHERE session_id=? AND state='ready'", now(), why, sessionId);
}

/**
 * Gets one person's part ready on the host's device. `found` is the signing link's look (look in routes-sign.ts),
 * `view` what the signing page would be given (signView, quietly: nothing noted, marked or locked by it).
 */
export function prepare(c: Ctx, e: any, r: any, found: any, view: any) {
  if (c.auth?.via !== 'session' || !c.auth.sessionId) throw bad('Getting a document ready to sign without signal works in the app on your own device only, not with an API key. Open the envelope in the app on that device.', 403, { code: 'session_only' });
  if (r.role !== 'inperson') throw bad('Only someone who signs in person, on your device, can sign without signal. Other people sign with their own link and need a connection.', 409, { code: 'not_in_person' });
  if (e.status !== 'sent') throw bad('This envelope is not out for signing, so there is nothing to get ready. Send it first.', 409, { code: 'not_out' });
  if (r.status !== 'sent' && r.status !== 'viewed') throw bad(r.status === 'completed' ? `${r.name} has already signed. There is nothing left to get ready.` : `It is not ${r.name}'s turn yet. Get it ready once the people before them have finished.`, 409, { code: 'not_their_turn' });
  if (found.locked) throw bad(needsSignal(e, { ...r, access_code: r.access_code || '1' }, null)!, 409, { code: 'needs_signal' });
  const why = needsSignal(e, r, found.gate);
  if (why) throw bad(why, 409, { code: 'needs_signal' });
  if (view?.locked !== false || !Array.isArray(view?.fields)) throw bad('This document cannot be got ready right now. Open it with a connection to see why.', 409, { code: 'needs_signal' });
  const sid = c.auth.sessionId;
  // One envelope per device: an earlier copy on this browser, for whoever, ends here.
  endOnSession(sid, 'Another document was got ready on the same device.');
  // And one device per person: a copy for this person on another device ends too, so only one result can come back.
  run("UPDATE offline_preps SET state='ended', ended_at=?, ended_why=? WHERE recipient_id=? AND state='ready'", now(), 'It was got ready again on another device.', r.id);
  const pid = id('ofl');
  const at = now();
  const until = new Date(Date.now() + OFFLINE_DAYS * DAY).toISOString();
  run('INSERT INTO offline_preps (id, envelope_id, recipient_id, user_id, session_id, content_version, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)', pid, e.id, r.id, c.user.id, sid, e.content_version, at, until);
  audit(e.id, c.actor, 'Got ready to sign in person without a connection', `${r.name}, on ${c.user.name}'s device. The copy on that device is kept for ${OFFLINE_DAYS} days at most.`);
  const files = view.documents.map((d: any) => {
    const doc = e.documents.find((x: any) => x.id === d.id);
    let data: Uint8Array | null = null;
    try {
      data = doc ? readBlob(doc.sha256) : null;
    } catch {
      data = null;
    }
    if (!data) throw bad('A file of this document could not be read, so nothing was got ready. Try again in a moment.', 500);
    return { id: d.id, name: d.name, pages: d.pages, sha256: d.sha256, pdf: Buffer.from(data).toString('base64') };
  });
  return { prep_id: pid, created_at: at, expires_at: until, token: r.token, host: c.user.name, view, files };
}

/** The device's clock as it was sent: a moment we can write down, or null. It is never checked and never trusted. */
const deviceMoment = (v: unknown): string | null => {
  const s = str(v, 40);
  const t = Date.parse(s);
  return s && Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * The result coming back, by the signing link (`found` is look in routes-sign.ts). Signs nothing unless the copy is
 * the one got ready, in time, and the envelope has not changed since.
 */
export async function finishOffline(c: Ctx, found: any, b: any) {
  const { e, r } = found;
  const prep = readyFor(str(b?.prep_id, 60), r.id);
  if (!prep) throw bad(OFFLINE_WORDS.unknown(r.name), 404, { code: 'offline_unknown' });
  if (prep.state === 'signed' || r.status === 'completed') {
    if (prep.state === 'signed') return { ok: true, already: true };
    throw bad(`${r.name} has already finished this document, so this copy was not needed. Nothing was signed twice.`, 409, { code: 'already_finished' });
  }
  const end = (why: string, code: string, said: string) => {
    run("UPDATE offline_preps SET state='ended', ended_at=?, ended_why=? WHERE id=? AND state='ready'", now(), why, prep.id);
    if (prep.state === 'ready') audit(e.id, found.actor, 'Signing without a connection not accepted', `${r.name}. ${why} Nothing was signed.`);
    throw bad(said, 409, { code });
  };
  if (prep.state !== 'ready') throw bad(OFFLINE_WORDS.ended(r.name, prep.ended_why || ''), 409, { code: 'offline_ended' });
  if (Date.parse(prep.expires_at) < Date.now()) end(`The copy was more than ${OFFLINE_DAYS} days old.`, 'offline_too_old', OFFLINE_WORDS.tooOld(r.name));
  if (e.status !== 'sent' || (r.status !== 'sent' && r.status !== 'viewed')) end('The envelope was no longer open for this person.', 'offline_closed', OFFLINE_WORDS.closed(r.name));
  if (Number(e.content_version) !== Number(prep.content_version)) end('The document was changed after the copy was got ready.', 'offline_changed', OFFLINE_WORDS.changed(r.name));
  const deviceAt = deviceMoment(b?.device_at);
  const received = now();
  // Agreeing came first on the device. It is recorded now, saying where and when the device said it happened.
  const consent = b?.consent || {};
  const own = ownAtConsent(e, r, consent, c.req);
  notePageLanguage(r.id, consent.page_language);
  const zone = validZone(consent.tz);
  if (zone && zone !== r.tz) run('UPDATE recipients SET tz=? WHERE id=?', zone, r.id);
  const first = !r.consent_at;
  if (first) {
    run('UPDATE recipients SET consent_at=? WHERE id=?', received, r.id);
    r.consent_at = received;
    audit(e.id, found.actor, 'Agreed to electronic records and signatures', `${r.name}. On the host's device without a connection. ${own.note}${consentLine(consent)}`);
  }
  own.record(found.actor, first, consentLine(consent));
  const body = { values: b?.values || {}, signature_png: okImage(b?.signature_png) ? b.signature_png : undefined, initials_png: okImage(b?.initials_png) ? b.initials_png : undefined, version: prep.content_version, tz: consent.tz };
  // Claimed before anything waits, so two results sent at once (two tabs, a retry) are one Finish.
  const claimed = run("UPDATE offline_preps SET state='sending' WHERE id=? AND state='ready'", prep.id).changes;
  if (!claimed) return { ok: true, already: true };
  try {
    await completeRecipient(e, r, body, found.actor);
  } catch (err) {
    run("UPDATE offline_preps SET state='ready' WHERE id=? AND state='sending'", prep.id);
    throw err;
  }
  // Received when the Finish was recorded: the same moment as "Completed" on the certificate.
  const done = get('SELECT completed_at FROM recipients WHERE id=?', r.id)?.completed_at || received;
  run("UPDATE offline_preps SET state='signed', device_at=?, received_at=? WHERE id=?", deviceAt, done, prep.id);
  audit(e.id, found.actor, 'Signed in person without a connection', `${r.name}. ${OFFLINE_WORDS.record(deviceAt, done)}`);
  const after = get('SELECT status FROM envelopes WHERE id=?', e.id);
  return { ok: true, envelope_status: after?.status, received_at: done };
}

/** Lines for the certificate under this person, from what the server recorded. Empty for everyone else. */
export function offlineCertLines(e: any, r: any, ts: (s: any) => string): [string, string][] {
  if (r?.role !== 'inperson' || r.status !== 'completed') return [];
  const p = get("SELECT device_at, received_at FROM offline_preps WHERE envelope_id=? AND recipient_id=? AND state='signed' ORDER BY received_at DESC LIMIT 1", e.id, r.id);
  if (!p) return [];
  return [['Without a connection', OFFLINE_WORDS.record(p.device_at, p.received_at, ts)]];
}

/** The copies of this envelope still waiting on a device, for the envelope page. */
export const waitingOn = (envelopeId: string) =>
  all("SELECT p.id, p.recipient_id, p.created_at, p.expires_at, u.name host FROM offline_preps p LEFT JOIN users u ON u.id=p.user_id WHERE p.envelope_id=? AND p.state='ready' AND p.expires_at > ? ORDER BY p.created_at", envelopeId, now());

/** Ends a copy from the envelope page (a lost phone, say): a result that comes back for it later signs nothing. */
export function cancel(c: Ctx, e: any, prepId: string) {
  const p = get("SELECT * FROM offline_preps WHERE id=? AND envelope_id=?", prepId, e.id);
  if (!p) throw bad('That copy was not found. It may have ended already.', 404);
  if (p.state !== 'ready') return { ok: true };
  run("UPDATE offline_preps SET state='ended', ended_at=?, ended_why=? WHERE id=? AND state='ready'", now(), `${c.user.name} cancelled it.`, p.id);
  const r = e.recipients.find((x: any) => x.id === p.recipient_id);
  audit(e.id, c.actor, 'Copy for signing without a connection cancelled', `${r?.name || 'Someone who signs in person'}. A result sent from that device later is not accepted.`);
  return { ok: true };
}

/** The host hands the device over: the account locks in this browser, as when the signing page opens (handover.ts). */
export function lockForHandOver(c: Ctx, prepId: string) {
  const p = get("SELECT * FROM offline_preps WHERE id=? AND session_id=?", str(prepId, 60), c.auth?.sessionId || '');
  if (!p) throw bad('That copy is not on this device any more. Nothing was changed.', 404);
  const r = get('SELECT name FROM recipients WHERE id=?', p.recipient_id);
  run('UPDATE sessions SET locked_at=?, locked_note=?, unlock_tries=0 WHERE id=? AND locked_at IS NULL', now(), JSON.stringify({ envelope_id: p.envelope_id, signer: str(r?.name, 120) }), c.auth!.sessionId);
  return { ok: true };
}

