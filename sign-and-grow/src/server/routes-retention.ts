// The routes of keeping closed envelopes for a set time, and of legal holds. The rules are in src/server/records.ts.
import { route } from './router.ts';
import { all, get } from './db.ts';
import { bad, now, str, HttpError } from './util.ts';
import { mine } from './routes-envelopes.ts';
import { isOperator } from './routes-trust.ts';
import {
  policyOf, setPolicy, retentionFacts, keepIt, askPurge, cancelPurge, placeHold, liftHold, operatorLift, holdView, activeHolds,
  retentionLog, retentionCsv, isHeld,
} from './records.ts';
import { dataPlace } from '../lib/dataplace.ts';
import { retentionStays, LEVEL_NAME, removesAt, PURGE_LEVELS, RETENTION_NOTICE_DAYS } from '../lib/retention.ts';

// The account's rule, for everyone in it: a member's envelopes are kept by it too, so they may read it. The holds,
// the queue and the record are for the admins.
route('GET', '/account/retention', (c) => {
  const policy = policyOf(c.account.id);
  const templates = all(`SELECT id, subject, retention_days days FROM envelopes WHERE account_id=? AND kind='template' ${c.admin ? '' : 'AND retention_days IS NOT NULL '}ORDER BY subject`, c.account.id);
  return {
    policy, templates, notice_days: RETENTION_NOTICE_DAYS,
    levels: PURGE_LEVELS.map((l) => ({ id: l, name: LEVEL_NAME[l], removes: removesAt(l) })),
    stays: retentionStays(dataPlace().backups),
    may_change: c.admin,
    ...(c.admin ? {
      holds: activeHolds([c.account.id]).map((h) => ({ ...holdView(h, true), subject: h.envelope_id ? get('SELECT subject FROM envelopes WHERE id=?', h.envelope_id)?.subject ?? null : null })),
      // What the timer has announced or someone asked for, soonest first.
      queue: all(`SELECT q.envelope_id id, e.subject, q.goes_at, COALESCE(q.asked_level, q.level) level, q.asked_by, q.asked_at FROM retention_queue q JOIN envelopes e ON e.id=q.envelope_id
        WHERE q.account_id=? AND q.goes_at IS NOT NULL AND e.purged_at IS NULL ORDER BY q.goes_at LIMIT 200`, c.account.id),
      folders: all("SELECT DISTINCT folder FROM envelopes WHERE account_id=? AND kind='envelope' AND folder IS NOT NULL AND folder != '' ORDER BY folder", c.account.id).map((r) => r.folder),
      // Whether the deletion record has a line yet: Settings offers the download only then.
      has_record: !!get('SELECT 1 x FROM retention_log WHERE account_id=? LIMIT 1', c.account.id),
    } : {}),
  };
});

route('PUT', '/account/retention', async (c) => setPolicy(c, await c.body()), 'admin');

// The disposition record: every rule change, keep, hold, purge and refused attempt. ?format=csv for the file.
route('GET', '/account/retention/log', (c) => {
  if (c.q.get('format') === 'csv')
    return new Response(retentionCsv(c.account.id), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="deletion-record-${now().slice(0, 10)}.csv"` } });
  return { lines: retentionLog(c.account.id, Math.min(1000, Number(c.q.get('limit')) || 200)) };
}, 'admin');

// A hold on a folder (or on one envelope, by its id). Admins only, checked by placeHold so the words say so.
route('POST', '/account/retention/holds', async (c) => {
  const b = await c.body();
  if (b.envelope_id) mine(c, str(b.envelope_id), 'envelope', { removed: true });
  return placeHold(c, { envelopeId: b.envelope_id ? str(b.envelope_id) : null, folder: b.folder, reason: b.reason, matter: b.matter });
});
route('DELETE', '/account/retention/holds/:id', async (c) => liftHold(c, c.params.id, (await c.body()).reason));

route('POST', '/envelopes/:id/hold', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope', { removed: true });
  return placeHold(c, { envelopeId: e.id, reason: b.reason, matter: b.matter });
});
// Lifts the hold on this envelope itself. One that only its folder's hold covers is lifted with that hold.
route('DELETE', '/envelopes/:id/hold', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope', { removed: true });
  const own = get('SELECT id FROM legal_holds WHERE envelope_id=? AND lifted_at IS NULL', e.id);
  if (!own) {
    const other = (isHeld([e.id]).get(e.id) || [])[0];
    if (other) throw bad(`This document is on hold because its folder "${other.folder}" is on hold. Lift that hold under Settings, Your data, if it may go.`, 409, { code: 'folder_hold', hold_id: other.id });
    throw bad('This document is not on hold, so there is nothing to lift. Leave it as it is.', 409);
  }
  return liftHold(c, own.id, b.reason);
});

// "Keep it", "Purge now" and calling a purge off: the sender, or an admin (also on one its sender removed from their lists).
route('POST', '/envelopes/:id/keep', async (c) => {
  const b = await c.body();
  return keepIt(c, mine(c, c.params.id, 'envelope', { removed: true }), b.reason);
});
route('POST', '/envelopes/:id/purge', async (c) => {
  const b = await c.body();
  return askPurge(c, mine(c, c.params.id, 'envelope', { removed: true }), b.level);
});
route('DELETE', '/envelopes/:id/purge', (c) => cancelPurge(c, mine(c, c.params.id, 'envelope', { removed: true })));
route('GET', '/envelopes/:id/retention', (c) => retentionFacts(c, mine(c, c.params.id, 'envelope', { removed: true })));

// ---- The people who run the server ---------------------------------------------------------------------------------

const operator = (c: any) => {
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
};
// The holds that are on, in every account: what an operator needs to find the one a court order or a legal duty names.
route('GET', '/operator/holds', (c) => {
  operator(c);
  return { holds: all('SELECT h.*, a.name account_name FROM legal_holds h JOIN accounts a ON a.id=h.account_id WHERE h.lifted_at IS NULL ORDER BY h.set_at LIMIT 500') };
});
// Two people: the first call asks, a call by a different operator within 7 days lifts it (operatorLift in records.ts).
route('POST', '/operator/holds/:id/lift', async (c) => {
  operator(c);
  const b = await c.body();
  return operatorLift(c.params.id, { name: c.user.name, email: c.user.email }, b.reason);
});
