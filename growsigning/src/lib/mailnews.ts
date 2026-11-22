// What the mail provider told us about an email (POST /mail/events, src/server/bounces.ts), in the words that the
// pages and the server's emails and answers both use. Pure functions with no imports, so either side can load them.

/** "3 May", by the calendar in UTC, so an email and a page written on the same day say the same day. */
export const bounceDay = (at: string): string => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : 'an earlier day';
};

/** The domain of an address, for "the mail server of example.com". */
export const domainOf = (email: string): string => String(email || '').split('@').pop() || '';

/** An address at which an email of the account came back for good, as GET and POST answers carry it. */
export type BouncedAddress = { email: string; bounced_at?: string; at?: string; reason: string };

/** The warning at send time: "x@y.z bounced on 3 May: no such mailbox. Check the address." */
export const bouncedLine = (b: BouncedAddress): string => `${b.email} bounced on ${bounceDay(b.at || b.bounced_at || '')}: ${b.reason}. Check the address.`;

/**
 * What the app asks before something goes to an address that bounced before. The sender decides: nothing is
 * refused for good and nobody is dropped without them knowing.
 */
export function sendAnywayAsk(list: BouncedAddress[]): { title: string; body: string } {
  return {
    title: list.length === 1 ? 'This address bounced before' : `${list.length} addresses bounced before`,
    body: `${list.map(bouncedLine).join(' ')} Nothing has been sent yet. If the address is right and the mailbox works now, send anyway. Otherwise go back and correct it.`,
  };
}
