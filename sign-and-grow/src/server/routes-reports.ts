import { route } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, baseUrl, now } from './util.ts';
import { sendMail } from './mail.ts';
import { buildReport, readFilters, reportCsv, mayGetMonthly, type Row } from './reports.ts';
import { impactOf } from '../lib/impact.ts';
import { durationText } from '../lib/reports.ts';

// Reports: the routes. What is counted and how is in reports.ts.

// GET /reports: the report for a period and filters. ?from=&to= (YYYY-MM-DD, UTC days, default the last 30 days),
// ?status=, ?sender= (admins), ?template= (an id, or "none"), ?folder=, ?field=&value= (a custom field).
route('GET', '/reports', (c) => buildReport(c, readFilters(c.q, c)));

// The same numbers as a CSV file, for the same filters: the totals and the tables, with a few more columns.
route('GET', '/reports/csv', (c) => {
  const r = buildReport(c, readFilters(c.q, c));
  return new Response(reportCsv(r), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="report-${r.from}-to-${r.to}.csv"` } });
});

// The counts of everything the caller can see, for Home and older API clients. A completed envelope its sender
// deleted is counted nowhere here, so these numbers match the lists they link to. The paper it saved was saved all
// the same, so GET /impact and the public totals still count it.
route('GET', '/reports/summary', (c) => {
  const scope = `${c.admin ? '' : ' AND sender_id=?'} AND hidden_at IS NULL`;
  const p = c.admin ? [c.account.id] : [c.account.id, c.user.id];
  const byStatus = Object.fromEntries(all(`SELECT status, COUNT(*) n FROM envelopes WHERE account_id=? AND kind='envelope'${scope} GROUP BY status`, ...p).map((r) => [r.status, r.n]));
  const done = get(`SELECT COUNT(*) n, AVG((julianday(completed_at) - julianday(sent_at)) * 24) hours, COALESCE(SUM(sheets),0) sheets FROM envelopes WHERE account_id=? AND kind='envelope' AND status='completed'${scope}`, ...p);
  const months = all(`SELECT substr(sent_at,1,7) month, COUNT(*) sent, SUM(status='completed') completed FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL${scope} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, ...p).reverse();
  const senders = c.admin ? all("SELECT u.name, COUNT(*) sent, SUM(e.status='completed') completed FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at IS NOT NULL AND e.hidden_at IS NULL GROUP BY u.id ORDER BY sent DESC LIMIT 20", c.account.id) : [];
  const sent = Object.entries(byStatus).reduce((n, [k, v]) => n + (k === 'draft' ? 0 : (v as number)), 0);
  return { byStatus, sent, completed: done.n, avgHours: done.hours, completionRate: sent ? done.n / sent : null, months, senders, impact: impactOf(done.sheets) };
});

// ---- The monthly report email ----------------------------------------------------------------------------------
// For the owner and admins who ask for it (Settings, Profile, Emails about your documents): on the first day of each
// month (or the second or third, when the timer did not run before), last month's numbers for the whole account. It
// names templates, never team members or the people documents were sent to.

// "may": an owner or admin of a team (two people or more) that has sent something, or who has it on. Before the first
// send there is nothing to report, and a person working alone sees the same numbers on the Reports page, so Settings
// does not offer it to them (one choice fewer on the screen where most people change their name).
route('GET', '/reports/monthly', (c) => {
  const admin = mayGetMonthly(c.account.id, c.user.id);
  const on = admin && !!get('SELECT 1 x FROM report_monthly WHERE account_id=? AND user_id=?', c.account.id, c.user.id);
  const sent = !!get("SELECT 1 x FROM envelopes WHERE account_id=? AND kind='envelope' AND sent_at IS NOT NULL LIMIT 1", c.account.id);
  const team = get('SELECT COUNT(*) n FROM memberships WHERE account_id=?', c.account.id).n >= 2;
  return { may: admin && (on || (sent && team)), on };
});
route('PUT', '/reports/monthly', async (c) => {
  const b = await c.body();
  if (typeof b?.on !== 'boolean') throw bad('Send "on": true to get the monthly report by email, or "on": false to stop it. Nothing was changed.');
  if (!mayGetMonthly(c.account.id, c.user.id)) throw bad('The monthly report is for the owner and the admins of the account, because it counts what the whole team sent. Nothing was changed.', 403);
  if (b.on) run('INSERT OR IGNORE INTO report_monthly (account_id, user_id, on_at) VALUES (?,?,?)', c.account.id, c.user.id, now());
  else run('DELETE FROM report_monthly WHERE account_id=? AND user_id=?', c.account.id, c.user.id);
  return { on: b.on };
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;
const rowLine = (r: Row) => `${r.name}: ${many(r.sent, 'sent', 'sent')}, ${r.completed} finished${r.declined ? `, ${r.declined} declined` : ''}${r.waiting ? `, ${r.waiting} still waiting` : ''}${r.median_hours != null ? `, half finished within ${durationText(r.median_hours)}` : ''}.`;

/**
 * The timer (cron.ts): on the first three days of a month (so a day the timer did not run is caught up), each owner or
 * admin who asked gets last month's report once. Someone who is no longer an admin, whose address is not confirmed,
 * or who is closing their login gets nothing. A month in which nothing was sent sends no email. Answers how many went.
 */
export async function monthlyReports(at = new Date()): Promise<number> {
  if (at.getUTCDate() > 3) return 0;
  const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 0));
  const month = first.toISOString().slice(0, 7);
  const from = first.toISOString().slice(0, 10), to = last.toISOString().slice(0, 10);
  let sent = 0;
  const due = all(`SELECT m.account_id, m.user_id FROM report_monthly m JOIN accounts a ON a.id=m.account_id JOIN users u ON u.id=m.user_id
    WHERE (m.last_month IS NULL OR m.last_month < ?) AND m.on_at < ? AND a.closing_at IS NULL AND u.closing_at IS NULL AND u.email_verified=1`, month, `${at.toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  for (const d of due) {
    // Marked first, so a mail server that fails or a second timer running at the same moment never sends it twice.
    if (!run('UPDATE report_monthly SET last_month=? WHERE account_id=? AND user_id=? AND (last_month IS NULL OR last_month < ?)', month, d.account_id, d.user_id, month).changes) continue;
    if (!mayGetMonthly(d.account_id, d.user_id)) continue;
    const account = get('SELECT * FROM accounts WHERE id=?', d.account_id);
    const user = get('SELECT * FROM users WHERE id=?', d.user_id);
    // One account whose report cannot be built never stops the others, or the rest of the timer.
    let r: ReturnType<typeof buildReport>;
    try {
      r = buildReport({ admin: true, user, account }, { from, to, status: '', sender: '', template: '', folder: '', field: '', value: '' });
    } catch (e: any) {
      console.error('[reports] monthly report', d.account_id, e?.message);
      continue;
    }
    if (!r.totals.sent) continue;
    // The link opens the account the browser is in; someone in more than one account is told which one to choose.
    const several = get('SELECT COUNT(*) n FROM memberships WHERE user_id=?', d.user_id).n > 1;
    const t = r.totals;
    const stalls = r.templates.filter((x) => x.sent >= 3 && x.completed / x.sent < 0.5).slice(0, 3);
    try {
      await sendMail({
        to: user.email, subject: `${account.name}: your report for ${monthName(month)}`, heading: `${monthName(month)} at ${account.name}`,
        lines: [
          `Your team sent ${many(t.sent, 'document')} in ${monthName(month)}. ${t.completed} ${t.completed === 1 ? 'is' : 'are'} finished${t.declined ? `, ${t.declined} declined` : ''}${t.voided ? `, ${t.voided} cancelled` : ''}${t.expired ? `, ${t.expired} ran out of time` : ''}${t.waiting ? `, and ${t.waiting} ${t.waiting === 1 ? 'is' : 'are'} still waiting for someone` : ''}.`,
          ...(t.median_hours != null ? [`Half of the finished ones were finished within ${durationText(t.median_hours)} of being sent.`] : []),
          ...(r.templates.length ? ['By template, most sent first:', ...r.templates.slice(0, 5).map(rowLine)] : []),
          ...(stalls.length ? [`Fewer than half were finished from ${stalls.map((x) => `"${x.name}"`).join(', ')}. The Reports page shows which are still waiting.`] : []),
          'Counted by the day each document was sent, in world time (UTC), so a late-evening send may count on the next day. Documents a sender deleted from their lists are not counted.',
          ...(several ? [`You are in more than one account. If Reports opens another one, switch to ${account.name} first.`] : []),
        ],
        cta: { label: 'Open Reports', url: `${baseUrl()}/app/reports?from=${from}&to=${to}` },
        footnote: 'You get this because you switched it on in Settings, Profile, Emails about your documents. Switch it off there at any time.',
      });
      sent++;
    } catch (e: any) {
      console.error('[reports] monthly email', e?.message);
    }
  }
  return sent;
}
