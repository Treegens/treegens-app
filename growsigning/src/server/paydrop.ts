// Small pieces of the payment link (src/server/routes-paylink.ts) that other parts of the server call without
// loading its routes: how an address is named in the audit trail, and what happens to a link when the person who
// set it leaves the team.
import { all, run } from './db.ts';
import { now, sha256 } from './util.ts';
import { audit, type Actor } from './envelopes.ts';
import { payLabel } from '../lib/paylink.ts';

/**
 * How the audit trail names a payment address: the first 16 characters of the SHA-256 of the address exactly as it
 * is stored. The audit trail is printed in the certificate inside the signed PDF, which goes out attached to every
 * "Completed" email (to copies and approvers too), and it is in every export and evidence pack. A Pay link in there
 * would go out under our name to people who were never meant to be asked for money, and a PDF reader makes it
 * clickable. The fingerprint still ties each line to one address: the envelope page shows both.
 */
export const payPrint = (url: string): string => sha256(String(url)).slice(0, 16);

/**
 * A payment link is personal: it leads to the page of the person who set it. When that person leaves the team (they
 * leave, an admin removes them, or they close their login), every link they set in that account is taken off, on
 * envelopes and templates alike, also on envelopes made from their template, which carry their name (pay_set_by).
 * Otherwise the envelopes handed over would keep asking for money for someone who is gone, under the name of the
 * colleague who took them over. Each envelope's audit trail says so, and so does its page. Called by handOver in
 * src/server/routes-trust.ts, inside its transaction, before the envelopes change hands. Answers how many went.
 */
export function dropPayLinksOf(accountId: string, from: { id: string; name: string }, actor: Actor, why: string): number {
  // A link saved before pay_set_by was kept counts as its sender's.
  const rows = all('SELECT id, kind, pay_url, pay_kind FROM envelopes WHERE account_id=? AND pay_url IS NOT NULL AND (pay_set_by=? OR (pay_set_by IS NULL AND sender_id=?))', accountId, from.id, from.id);
  const t = now();
  const note = `The payment link ${from.name} set was taken off: ${why.replace(/[.\s]+$/, '')}, and a payment link belongs to the person who set it. Nobody is shown it any more.`;
  for (const e of rows) {
    run('UPDATE envelopes SET pay_url=NULL, pay_kind=NULL, pay_set_by=?, pay_gone_at=?, pay_gone_note=? WHERE id=?', from.id, t, note, e.id);
    if (e.kind === 'envelope') audit(e.id, actor, 'Payment link taken off', `"${payLabel(e.pay_kind)}" (address fingerprint ${payPrint(e.pay_url)}) is no longer shown to anyone. ${note}`);
  }
  return rows.length;
}
