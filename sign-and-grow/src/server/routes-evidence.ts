import { route } from './router.ts';
import { get } from './db.ts';
import { bad, str, rateLimit, parseCode, sha256 } from './util.ts';
import { loadEnvelope } from './envelopes.ts';
import { lookupEnvelope, disputeEnvelope, disputeReplaced, disputesFor, evidencePack } from './evidence.ts';
import { find } from './routes-sign.ts';
import { memberForCode } from './groups.ts';
import { mine } from './routes-envelopes.ts';
import { zipStream } from './zip.ts';

// The public side of what happens around a certificate (src/server/evidence.ts): the lookup by envelope ID, and
// "I did not sign this, or this was not me" from the check page and from the signing page.

// From the check page, with the security code of an email we sent. The code is enough, as for a report: someone who
// says it was not them should not have to open a link they distrust. It works for a completed document too.
route('POST', '/public/check/dispute', async (c) => {
  rateLimit(`dispute:${c.ip}`, 10, 3600_000);
  const b = await c.body();
  const code = parseCode(b.code);
  if (code.length !== 12) throw bad('Security codes are 12 letters and numbers, like ABCD-EFGH-JKLM. Check the email and try again.');
  const row = get('SELECT id, envelope_id FROM recipients WHERE check_code=? AND token IS NOT NULL', code);
  // A member of a group has a code of their own (groups.ts). Only the member who took the document on acted in a
  // name; for the others nothing was signed in theirs, and they are told who did act.
  const member = row ? null : memberForCode(code);
  if (member) {
    const e = loadEnvelope(member.envelope_id);
    if (member.claimed_by && member.claimed_by !== member.member.id) throw bad(`${member.group_name} acted on this document through another member, ${e.recipients.find((x: any) => x.id === member.id)?.name || 'a colleague'}, so nothing was signed in your name. If you think that was wrong, write to us on the help page with the topic "I am named on a document I did not sign".`, 409, { code: 'nothing_signed' });
    return disputeEnvelope(e, member, b, { name: `Someone holding the email to ${member.email}`, ip: c.ip, ua: c.ua }, 'check');
  }
  if (!row) {
    // A real email whose link was replaced since: the person it was sent to can always dispute with it, also after
    // the sender put another address in their place (disputeReplaced in evidence.ts). The latest one, if the same
    // code was ever retired twice.
    const old = get('SELECT * FROM retired_tokens WHERE check_code=? ORDER BY retired_at DESC LIMIT 1', code);
    if (old) return disputeReplaced(old, b, { name: '', ip: c.ip, ua: c.ua }, 'check');
    // A document deleted before anyone disputed it: nothing is left to mark (an open dispute stops a deletion).
    throw bad(get('SELECT 1 x FROM forgotten_codes WHERE code_hash=?', sha256(code)) ? 'That code is from an email we really sent, but the document it was about was deleted before anyone disputed it, so nothing is left to mark. Write to us on the help page with the topic "I am named on a document I did not sign", and a person will look.'
      : 'We do not recognise that security code. Check that you typed it exactly as it appears in the email.', 404);
  }
  const e = loadEnvelope(row.envelope_id);
  const r = e.recipients.find((x: any) => x.id === row.id);
  return disputeEnvelope(e, r, b, { name: `Someone holding the email to ${r.email || r.name}`, ip: c.ip, ua: c.ua }, 'check');
}, 'public');

// "Download evidence pack" on the envelope page (evidencePack in evidence.ts). For whoever may open the envelope,
// also an admin looking at one its sender removed from their lists, like the download. Not for a draft: nothing
// has happened to it that needs evidence.
route('GET', '/envelopes/:id/evidence', async (c) => {
  const e = mine(c, c.params.id, 'envelope', { removed: true });
  if (e.status === 'draft') throw bad('This envelope has not been sent, so there is no record to put in an evidence pack yet.');
  const { entries, name } = await evidencePack(e, c.user ? `${c.user.name} <${c.user.email}>` : 'an API key');
  return new Response(zipStream(entries), { headers: { 'content-type': 'application/zip', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="${name.replace(/[^\w .()-]+/g, '_')}"` } });
});

// The disputes on an envelope, for whoever may open it: when, under which name, how they reached us, what they
// wrote, and whether a person at Sign&Grow has closed it. Never the internet address or browser (disputesFor).
route('GET', '/envelopes/:id/disputes', (c) => {
  const e = mine(c, c.params.id, 'envelope', { removed: true });
  return { disputes: disputesFor(e.id) };
});

// From the signing page, with the link. No access code or one-time code is asked for first: someone whose name was
// used may never have been given the code, and saying "this was not me" opens nothing.
route('POST', '/sign/:token/dispute', async (c) => {
  // A link that was replaced since (the address was changed, the document was passed on through it): the person it
  // was sent to can still say it was not them, like with the security code of that email (disputeReplaced).
  const old = get('SELECT * FROM retired_tokens WHERE token=?', c.params.token);
  if (!old) find(c, false);
  rateLimit(`dispute:${c.ip}`, 10, 3600_000);
  const b = await c.body();
  if (old) return disputeReplaced(old, b, { name: '', ip: c.ip, ua: c.ua }, 'sign');
  const { e, r, actor } = find(c, false);
  return disputeEnvelope(e, r, b, actor, 'sign');
}, 'public');

// For the holder of a paper copy: the envelope ID printed at the foot of every page is all they have. What the
// answer may say, and why, is at lookupEnvelope. A wrong ID answers 404 in words. IDs are long and random, so
// trying them is pointless, and the limit keeps anyone from making a sport of it.
route('GET', '/public/verify/:id', async (c) => {
  rateLimit(`lookup:${c.ip}`, 60, 3600_000);
  const wanted = str(c.params.id, 80).trim();
  if (!/^env_[A-Za-z0-9_-]{8,40}$/.test(wanted)) throw bad('That is not an envelope ID. It starts with env_ and stands at the foot of every page of the signed PDF, after "Envelope ID". Type it exactly as printed.', 400);
  const found = await lookupEnvelope(wanted);
  if (!found.found) throw bad('We hold no completed or sent envelope with that ID. Check that you typed it exactly as printed, letter for letter: capitals count. A document deleted more than a year ago is not known here any more.', 404);
  return found;
}, 'public');
