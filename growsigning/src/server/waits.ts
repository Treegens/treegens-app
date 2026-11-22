// "Wait before this person": in a signing order, a person can be asked a set time after the step before them has
// finished, from 1 hour to 30 days (wait_hours on their row). The rules here are read by envelopes.ts where it saves
// recipients (saveWaits), copies an envelope (copyWait), checks a send (assertWaitsFit) and asks the next person
// (waitsNow, in advance). The timer asks advance again once a wait is over (waitsDue in timing.ts).
//
// It is a wait the sender chose, nothing more: the product does not call it a cooling-off period or say what it
// means in law.
import { run } from './db.ts';
import { bad, now, str } from './util.ts';
import { WAIT_MAX_HOURS, WAIT_MIN_HOURS, waitWords, atWords } from '../lib/timing.ts';
import { audit } from './envelopes.ts';

const SYSTEM = { name: 'System' };

/** The hours asked for one person, checked. undefined: nothing was said. */
function hoursOf(v: unknown, whom: string): number | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 0 || v === '0') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < WAIT_MIN_HOURS || n > WAIT_MAX_HOURS)
    throw bad(`The wait before ${whom} is "${str(String(v), 20)}", and a wait is a whole number of hours from ${WAIT_MIN_HOURS} to ${WAIT_MAX_HOURS} (30 days), or 0 for none. Change "wait_hours" and save again. Nothing was saved.`);
  return n;
}

/** Called by writeContent after the recipients are written. A row that says nothing keeps what it had. */
export function saveWaits(asked: { rid: string; r: any; i: number }[], before: Map<string, any>) {
  for (const { rid, r, i } of asked) {
    const h = hoursOf(r?.wait_hours, `recipient ${i + 1}${r?.name ? ` (${str(r.name, 120)})` : ''}`);
    if (h === undefined) continue;
    if ((before.get(rid)?.wait_hours ?? 0) !== h) run('UPDATE recipients SET wait_hours=? WHERE id=?', h, rid);
  }
}

/** A template's waits go with everything made from it, and with every copy. */
export function copyWait(from: any, newId: string) {
  if (from?.wait_hours > 0) run('UPDATE recipients SET wait_hours=? WHERE id=?', from.wait_hours, newId);
}

const counts = (e: any, r: any) => !!e.ordered && r.role !== 'witness' && r.wait_hours > 0;

/** The waits that apply, by place in the order: the first step has none (Send later is for that). */
function stepWaits(e: any): Map<number, number> {
  const out = new Map<number, number>();
  const orders = [...new Set<number>(e.recipients.filter((r: any) => r.role !== 'witness').map((r: any) => r.routing_order))].sort((a, b) => a - b);
  for (const r of e.recipients) if (counts(e, r) && r.routing_order !== orders[0]) out.set(r.routing_order, Math.max(out.get(r.routing_order) || 0, r.wait_hours));
  return out;
}

/** When this person may be asked, or null when there is nothing to wait for (now or any more). */
export function waitUntil(e: any, r: any): number | null {
  if (!counts(e, r)) return null;
  const before = e.recipients.filter((x: any) => x.role !== 'witness' && x.routing_order < r.routing_order);
  if (!before.length || before.some((x: any) => x.status !== 'completed')) return null;
  const done = Math.max(...before.map((x: any) => Date.parse(x.completed_at || '') || 0));
  if (!done) return null;
  const at = done + r.wait_hours * 3600_000;
  return at > Date.now() ? at : null;
}

/**
 * True while this person's wait runs. The record says once that they wait, and until when, so the sender's page and
 * the full record never leave a gap that looks like a fault.
 */
export function waitsNow(e: any, r: any): boolean {
  const at = waitUntil(e, r);
  if (at === null) return false;
  if (!r.wait_noted_at && run('UPDATE recipients SET wait_noted_at=? WHERE id=? AND wait_noted_at IS NULL', now(), r.id).changes)
    audit(e.id, SYSTEM, 'Waits before the next person', `${r.name} is asked after a wait of ${waitWords(r.wait_hours)}, which the sender chose: at ${atWords(new Date(at).toISOString())} UTC.`);
  return true;
}

/**
 * Waits that add up to the deadline or more would leave the last person no time to sign: refused when it is sent, in
 * words that say which way out there is.
 */
export function assertWaitsFit(e: any) {
  const total = [...stepWaits(e).values()].reduce((a, b) => a + b, 0);
  const days = Number(e.expire_days) || 0;
  if (total > 0 && days > 0 && total >= days * 24)
    throw bad(`The waits between steps add up to ${waitWords(total)}, and the deadline is ${days} day${days === 1 ? '' : 's'} after sending, so the last person would have no time left to sign. Shorten a wait, or give a later deadline under More options. Nothing was sent.`, 400, { code: 'waits_too_long' });
}

/**
 * The same rule for a correction to an envelope that is out: when a wait changed, the waits still to come (and what
 * is left of one running now) have to end before the deadline. Measured from now. A correction that changes no wait
 * is never refused here.
 */
export function assertWaitsFitNow(before: any, after: any) {
  if (!after?.expires_at || !after.ordered) return;
  const was = new Map<string, number>(before.recipients.map((r: any) => [r.id, Number(r.wait_hours) || 0]));
  if (!after.recipients.some((r: any) => (Number(r.wait_hours) || 0) !== (was.get(r.id) ?? 0) && r.wait_hours > 0)) return;
  const steps = stepWaits(after);
  let left = 0;
  for (const [order, hours] of steps) {
    const people = after.recipients.filter((r: any) => r.routing_order === order && r.role !== 'witness');
    // A step someone of which was asked already has nothing more to wait for.
    if (people.some((r: any) => r.status !== 'pending')) continue;
    const running = people.map((r: any) => waitUntil(after, r)).filter((x: number | null): x is number => x !== null);
    left += running.length ? Math.max(...running) - Date.now() : hours * 3600_000;
  }
  if (left > 0 && Date.now() + left >= Date.parse(after.expires_at))
    throw bad(`The waits still to come add up to ${waitWords(Math.ceil(left / 3600_000))}, and the deadline is ${atWords(after.expires_at, 'UTC')} UTC, so the last person would have no time left to sign. Shorten a wait, or give more time first. Nothing was changed.`, 400, { code: 'waits_too_long' });
}
