// What the person's role allows (perm.ts): 'see_all' here, where this file once asked for an admin.
import { can } from './perm.ts';
import { all, get } from './db.ts';
import { bad } from './util.ts';
import { customFilter } from './customfields.ts';
import type { Ctx } from './router.ts';
import { impactOf } from '../lib/impact.ts';
import { REPORT_STATUSES, REPORT_MAX_DAYS, REPORT_CSV_HEAD, defaultPeriod, readDay, median, type ReportStatus } from '../lib/reports.ts';

// Reports: which documents get finished, how long that takes, and which stall, for a period and a few filters
// (GET /reports, GET /reports/csv in routes-reports.ts, and the monthly email).
//
// What is counted. Envelopes, not templates or drafts, that were sent in the period (sent_at, in UTC days). A
// completed envelope its sender deleted from their lists (hidden_at) is counted nowhere, the same as in the lists,
// the search, the export and GET /reports/summary, so every number matches the list it would lead to. The paper it
// saved was saved all the same, so GET /impact still counts it. A member sees only what they sent; an admin sees
// every sender of the account and the table by sender.

export type Filters = { from: string; to: string; status: ReportStatus | ''; sender: string; template: string; folder: string; field: string; value: string };
export type Row = { key: string; name: string; sent: number; completed: number; declined: number; voided: number; expired: number; waiting: number; median_hours: number | null };

const WITHOUT = 'Sent without a template';
const GONE = 'A template that was deleted';

/** Reads the filters of a request. Anything left out takes its default: the last 30 days, every status, everyone the caller may see. */
export function readFilters(q: URLSearchParams, c: Pick<Ctx, 'admin' | 'user'>, today = new Date()): Filters {
  const def = defaultPeriod(today);
  const rawFrom = q.get('from'), rawTo = q.get('to');
  const from = rawFrom ? readDay(rawFrom) : def.from;
  const to = rawTo ? readDay(rawTo) : def.to;
  if (!from) throw bad(`"${String(rawFrom).slice(0, 40)}" is not a day we can read for "from". Write it as year-month-day, like ${def.from}.`);
  if (!to) throw bad(`"${String(rawTo).slice(0, 40)}" is not a day we can read for "to". Write it as year-month-day, like ${def.to}.`);
  if (from > to) throw bad(`The first day (${from}) comes after the last day (${to}). Swap them and try again.`);
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 + 1 > REPORT_MAX_DAYS) throw bad(`One report covers up to ${REPORT_MAX_DAYS} days. Choose a shorter period.`);
  const status = (q.get('status') || '').trim();
  if (status && !(REPORT_STATUSES as readonly string[]).includes(status)) throw bad(`"${status.slice(0, 40)}" is not a status a report knows. Use one of ${REPORT_STATUSES.join(', ')}, or leave it out for all of them.`);
  const sender = (q.get('sender') || '').trim();
  // A member sees their own sending only. Asking for a colleague is refused in words, never answered with zeros.
  if (sender && !can(c, 'see_all') && sender !== c.user.id) throw bad('Only the admins of the account can see what other people sent. Leave out "sender" to see your own.', 403);
  return { from, to, status: status as ReportStatus | '', sender, template: (q.get('template') || '').trim(), folder: (q.get('folder') || '').trim(), field: (q.get('field') || '').trim(), value: (q.get('value') || '').trim() };
}

// The WHERE of everything a report counts, for this caller and these filters, on envelopes "e".
function scope(c: Pick<Ctx, 'admin' | 'user' | 'account'>, f: Filters, withStatus = true): [string, any[]] {
  const where = ["e.account_id=?", "e.kind='envelope'", 'e.sent_at IS NOT NULL', 'e.hidden_at IS NULL', 'e.sent_at >= ?', 'e.sent_at < ?'];
  const p: any[] = [c.account.id, `${f.from}T00:00:00.000Z`, new Date(Date.parse(`${f.to}T00:00:00Z`) + 86400_000).toISOString()];
  if (!can(c, 'see_all')) (where.push('e.sender_id=?'), p.push(c.user.id));
  else if (f.sender) (where.push('e.sender_id=?'), p.push(f.sender));
  if (withStatus && f.status) (where.push('e.status=?'), p.push(f.status));
  if (f.template === 'none') where.push('e.template_id IS NULL');
  else if (f.template) (where.push('e.template_id=?'), p.push(f.template));
  if (f.folder) (where.push('e.folder=?'), p.push(f.folder));
  // A custom field and its value, the same filter as the envelope list (customfields.ts).
  if (f.field) customFilter(new URLSearchParams({ field: f.field, value: f.value }), where, p);
  return [where.join(' AND '), p];
}

const hoursOf = (r: any) => (r.status === 'completed' && r.completed_at ? (Date.parse(r.completed_at) - Date.parse(r.sent_at)) / 3600_000 : NaN);

function rowOf(key: string, name: string, list: any[]): Row {
  const n = (s: string) => list.filter((r) => r.status === s).length;
  return { key, name, sent: list.length, completed: n('completed'), declined: n('declined'), voided: n('voided'), expired: n('expired'), waiting: n('sent'), median_hours: median(list.map(hoursOf)) };
}

function groupBy(list: any[], key: (r: any) => string, name: (k: string, first: any) => string): Row[] {
  const by = new Map<string, any[]>();
  for (const r of list) by.set(key(r), [...(by.get(key(r)) || []), r]);
  return [...by.entries()].map(([k, l]) => rowOf(k, name(k, l[0]), l)).sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
}

/** The whole report for one caller: totals, the tables by template and (for admins) by sender, and what the filters can choose from. */
export function buildReport(c: Pick<Ctx, 'admin' | 'user' | 'account'>, f: Filters) {
  const [where, p] = scope(c, f);
  const list = all(`SELECT e.id, e.status, e.sent_at, e.completed_at, e.template_id, e.sender_id, e.sheets, t.subject template_name, t.id template_found, u.name sender_name
    FROM envelopes e LEFT JOIN envelopes t ON t.id=e.template_id AND t.account_id=e.account_id AND t.kind='template' LEFT JOIN users u ON u.id=e.sender_id WHERE ${where}`, ...p);
  const totals = rowOf('all', 'All documents', list);
  const templates = groupBy(list, (r) => r.template_id || 'none', (k, r) => (k === 'none' ? WITHOUT : r.template_found ? r.template_name || 'Untitled template' : GONE));
  const senders = can(c, 'see_all') ? groupBy(list, (r) => r.sender_id, (_k, r) => r.sender_name || 'A person no longer on the team') : [];
  const months = [...groupBy(list, (r) => r.sent_at.slice(0, 7), (k) => k)].sort((a, b) => a.key.localeCompare(b.key)).map((m) => ({ month: m.key, sent: m.sent, completed: m.completed }));
  const byStatus = Object.fromEntries(REPORT_STATUSES.map((s) => [s, list.filter((r) => r.status === s).length]));
  const sheets = list.filter((r) => r.status === 'completed').reduce((n, r) => n + (r.sheets || 0), 0);
  return { from: f.from, to: f.to, filters: f, totals, templates, senders, months, byStatus, impact: impactOf(sheets), may_see_senders: !!can(c, 'see_all'), choices: choices(c, f) };
}

// What the filters can be set to: the templates, folders and (for admins) senders of what the caller can see. Only
// names of what the caller sent or may see, because a folder or template name can say something by itself.
function choices(c: Pick<Ctx, 'admin' | 'user' | 'account'>, f: Filters) {
  const own = can(c, 'see_all') ? '' : ' AND e.sender_id=?';
  const p = can(c, 'see_all') ? [c.account.id] : [c.account.id, c.user.id];
  const base = `FROM envelopes e WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at IS NOT NULL AND e.hidden_at IS NULL${own}`;
  const templates = all(`SELECT DISTINCT e.template_id id, t.subject name FROM envelopes e LEFT JOIN envelopes t ON t.id=e.template_id AND t.account_id=e.account_id AND t.kind='template'
    WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at IS NOT NULL AND e.hidden_at IS NULL AND e.template_id IS NOT NULL${own}`, ...p)
    .map((r) => ({ id: r.id, name: r.name ?? GONE })).sort((a, b) => a.name.localeCompare(b.name));
  const folders = all(`SELECT DISTINCT e.folder ${base} AND e.folder IS NOT NULL AND e.folder != '' ORDER BY e.folder`, ...p).map((r) => r.folder);
  const senders = can(c, 'see_all') ? all(`SELECT DISTINCT u.id, u.name FROM envelopes e JOIN users u ON u.id=e.sender_id WHERE e.account_id=? AND e.kind='envelope' AND e.sent_at IS NOT NULL AND e.hidden_at IS NULL ORDER BY u.name`, c.account.id) : [];
  void f;
  return { templates, folders, senders, statuses: REPORT_STATUSES };
}

// A spreadsheet runs a cell that starts with =, +, - or @ as a formula: such a value gets a ' in front.
const cell = (v: any) => {
  const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (r: Row) => (r.sent ? Math.round((r.completed / r.sent) * 100) : '');
const hrs = (r: Row) => (r.median_hours == null ? '' : r.median_hours.toFixed(1));
const line = (table: string, r: Row) => [table, r.name, r.sent, r.completed, pct(r), hrs(r), r.declined, r.voided, r.expired, r.waiting].map(cell).join(',');

/** The CSV of what the Reports page shows for the same filters: the totals, a row per template and, for admins, per sender. */
export function reportCsv(report: ReturnType<typeof buildReport>): string {
  const rows = [REPORT_CSV_HEAD.map(cell).join(','), line('All', report.totals), ...report.templates.map((r) => line('Template', r)), ...report.senders.map((r) => line('Sender', r))];
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/** Whether a member may ask for this account's monthly report: admins and the owner only. */
export const mayGetMonthly = (accountId: string, userId: string) => !!get("SELECT 1 x FROM memberships WHERE account_id=? AND user_id=? AND role IN ('owner','admin')", accountId, userId);
