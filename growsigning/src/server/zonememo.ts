// Which time zone a deadline in an email is written in, for someone whose device has not told us its zone on this
// document yet (it does that when they open the link). Until then the first invitation said the moment in UTC.
//
// The same address may have told us its zone on an earlier document from the same sender, in the same account.
// That zone is the reader's own, and the sender's earlier record already shows it, so nobody learns anything new.
// It is never taken from another sender or another account, and never used for an email that goes to someone else
// (in person, the email goes to the host) or for nobody (a link the sender hands over). The moment is the same
// whichever zone it is written in, and the zone is always named, so a zone that is out of date (the person moved)
// gives a different clock time, never a different deadline. The email then still says that the signing page shows
// the person's own time, because this document has not been told it yet.
import { get } from './db.ts';
import { validZone } from '../lib/dates.ts';

export function zoneForEmail(e: any, r: any): string | null {
  const own = validZone(r?.tz);
  if (own) return own;
  if (!e?.sender_id || !e?.account_id || !r?.email || r.role === 'inperson' || r.link_by_sender) return null;
  const row = get(
    `SELECT x.tz FROM recipients x JOIN envelopes v ON v.id = x.envelope_id
      WHERE x.email = ? AND x.id <> ? AND v.sender_id = ? AND v.account_id = ? AND x.tz IS NOT NULL AND x.tz <> ''
      ORDER BY COALESCE(x.consent_at, x.viewed_at, x.sent_at, v.created_at) DESC LIMIT 1`,
    r.email, r.id || '', e.sender_id, e.account_id,
  );
  return validZone(row?.tz);
}
