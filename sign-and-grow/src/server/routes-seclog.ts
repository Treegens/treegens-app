// The security record of an account (seclog.ts): the screen under Settings, Security, its CSV, what it shares and
// which alerts are on, and the call a security system pulls it with. Admins only, and admin-scope keys; a "send" key
// and a member get 403 from the router. Switching alerts off needs a person (PERSON_ONLY in router.ts).
import { route, json } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, now, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';
import { eventView, screenView, filterSql, csvLine, CSV_HEAD, emailsOn, alertsOff, verifySecurityChain, securityWords, record, oncePerHour, type Filter } from './seclog.ts';
import { SECURITY_ALERTS, SECURITY_ALERT_LIST, SECURITY_PAGE_MAX, SECURITY_SEARCH_MAX, isSecurityKind, type SecurityAlert } from '../lib/seclog.ts';
import { webhookHostsRule } from '../lib/outside.ts';
import { securityLogDays } from '../lib/policy.ts';

const SCREEN_PAGE = 100;
const CSV_MAX = 100_000;

// The filters of the screen and the CSV, checked: a filter that cannot be read is said, never quietly dropped.
function filterOf(q: URLSearchParams): Filter {
  const kinds = (q.get('kind') || '').split(',').map((k) => k.trim()).filter(Boolean);
  const unknown = kinds.find((k) => !isSecurityKind(k));
  if (unknown) throw bad(`"${unknown.slice(0, 60)}" is not a kind of event in the security record. Leave "kind" out for every kind, or use a name from the list in /api/openapi.json.`);
  const when = (name: string) => {
    const v = q.get(name);
    if (!v) return null;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) throw bad(`"${name}" has to be a date and time like 2026-11-20T00:00:00Z. "${v.slice(0, 40)}" is not one.`);
    return new Date(t).toISOString();
  };
  return { kinds, person: (q.get('person') || '').slice(0, 80) || null, from: when('from'), to: when('to'), q: (q.get('q') || '').trim().slice(0, SECURITY_SEARCH_MAX) || null };
}

// For a security system: every line of the account in the order it was written, after the cursor, up to
// SECURITY_PAGE_MAX at a time. Keep next_after and ask again with it; an empty page keeps the same cursor.
route('GET', '/account/security-events', (c) => {
  const rawAfter = (c.q.get('after') || '0').trim();
  if (!/^\d{1,15}$/.test(rawAfter)) throw bad('"after" is the next_after of the page before: a whole number. Leave it out to start from the oldest line kept.');
  const rawLimit = c.q.get('limit');
  const limit = rawLimit == null || rawLimit === '' ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > SECURITY_PAGE_MAX) throw bad(`"limit" is how many lines to give at once: a whole number from 1 to ${SECURITY_PAGE_MAX}.`);
  const after = Number(rawAfter);
  const rows = all('SELECT * FROM security_events WHERE account_id=? AND seq > ? ORDER BY seq LIMIT ?', c.account.id, after, limit + 1);
  const page = rows.slice(0, limit);
  const emails = emailsOn(c.account.id);
  return { events: page.map((r) => eventView(r, emails)), next_after: String(page.length ? page[page.length - 1].seq : after), has_more: rows.length > limit, days: securityLogDays(), note: securityWords() };
}, 'admin');

// For the screen: newest first, with the filters, a page at a time (next_before goes further back).
route('GET', '/account/security-events/view', (c) => {
  const [where, p] = filterSql(c.account.id, filterOf(c.q));
  const rawBefore = (c.q.get('before') || '').trim();
  if (rawBefore && !/^\d{1,15}$/.test(rawBefore)) throw bad('"before" is the next_before of the page before: a whole number. Leave it out to start from the newest line.');
  const before = Number(rawBefore) || 0;
  const rows = all(`SELECT * FROM security_events WHERE ${where}${before ? ' AND seq < ?' : ''} ORDER BY seq DESC LIMIT ${SCREEN_PAGE + 1}`, ...p, ...(before ? [before] : []));
  const page = rows.slice(0, SCREEN_PAGE);
  return { events: page.map(screenView), next_before: rows.length > SCREEN_PAGE ? page[page.length - 1].seq : null };
}, 'admin');

// The same lines as a CSV file, newest first, as filtered on the screen. An admin who is signed in gets the names
// the screen shows them. An API key gets people by their id, and by name and email address only when the account
// sends those to its security system (PATCH /account/security, "emails").
route('GET', '/account/security-events/csv', (c) => {
  const [where, p] = filterSql(c.account.id, filterOf(c.q));
  const n = get(`SELECT COUNT(*) n FROM security_events WHERE ${where}`, ...p).n;
  if (n > CSV_MAX) throw bad(`These filters match ${n} lines, and one download holds up to ${CSV_MAX}. Choose fewer days or one kind of event, and download the rest separately.`, 413);
  const emails = emailsOn(c.account.id);
  const named = c.auth?.via !== 'api_key';
  const lines = [CSV_HEAD.map((h) => `"${h}"`).join(','), ...all(`SELECT * FROM security_events WHERE ${where} ORDER BY seq DESC`, ...p).map((r) => csvLine(r, emails, named))];
  return new Response('﻿' + lines.join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="security-record-${now().slice(0, 10)}.csv"` } });
}, 'admin');

// What the screen needs around the list: how long lines are kept, the alerts, what leaves the app, whether the chain
// of fingerprints is whole, the webhooks that receive the record, and the people to filter by.
route('GET', '/account/security', (c) => {
  const a = get('SELECT * FROM accounts WHERE id=?', c.account.id);
  const off = alertsOff(a);
  const chain = verifySecurityChain(a.id);
  return {
    days: securityLogDays(), note: securityWords(),
    alerts: SECURITY_ALERT_LIST.map((k) => ({ id: k, label: SECURITY_ALERTS[k], on: !off.includes(k) })),
    emails: !!a.security_log_emails,
    // `why`: "line" (a line does not match) or "missing" (the newest lines are gone). `checked`: the newest lines looked at.
    chain: { whole: chain.ok, lines: chain.lines, checked: chain.checked, head: chain.head || null, broken_at: chain.broken_at, why: chain.why },
    // null: any public https address. A list: the only hosts this server sends to. Empty: it sends to none (src/lib/outside.ts).
    webhook_hosts: webhookHostsRule(),
    webhooks: all('SELECT id, url, events, created_at FROM webhooks WHERE account_id=? AND active=1', a.id).filter((h) => String(h.events).split(',').includes('security.event')).map((h) => ({ id: h.id, host: hostOf(h.url), created_at: h.created_at })),
    people: all('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY u.name COLLATE NOCASE', a.id),
    pull_url: `${baseUrl()}/api/account/security-events`,
  };
}, 'admin');
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};

// Alerts on or off, and whether names and email addresses leave the app with the record. Whatever the body leaves out
// stays as it is. Every change is a line in the record itself, and switching an alert off is emailed to the other
// admins, so one admin cannot quietly silence what would report them.
route('PATCH', '/account/security', async (c) => {
  const b = await c.body();
  const a = get('SELECT * FROM accounts WHERE id=?', c.account.id);
  const off = new Set(alertsOff(a));
  const was = new Set(off);
  if (b.alerts !== undefined) {
    if (!b.alerts || typeof b.alerts !== 'object' || Array.isArray(b.alerts)) throw bad('"alerts" is an object of alert names and true or false, like {"api_key_created": false}. Nothing was changed.');
    for (const [k, v] of Object.entries(b.alerts)) {
      if (!(k in SECURITY_ALERTS)) throw bad(`"${k.slice(0, 60)}" is not one of the alerts. Use one of: ${SECURITY_ALERT_LIST.join(', ')}. Nothing was changed.`);
      if (typeof v !== 'boolean') throw bad(`The alert "${k}" takes true (on) or false (off), written without quotes. Nothing was changed.`);
      if (v) off.delete(k as SecurityAlert);
      else off.add(k as SecurityAlert);
    }
  }
  if (b.emails !== undefined && typeof b.emails !== 'boolean') throw bad('"emails" takes true or false, written without quotes. Nothing was changed.');
  const emails = b.emails === undefined ? !!a.security_log_emails : b.emails;
  run('UPDATE accounts SET security_alerts_off=?, security_log_emails=? WHERE id=?', off.size ? JSON.stringify([...off]) : null, emails ? 1 : 0, a.id);
  const settings: Record<string, unknown> = {};
  for (const k of SECURITY_ALERT_LIST) if (was.has(k) !== off.has(k)) settings[`alert_${k}`] = { from: !was.has(k), to: !off.has(k) };
  if (emails !== !!a.security_log_emails) settings.security_log_emails = { from: !!a.security_log_emails, to: emails };
  if (Object.keys(settings).length) record('settings.changed', { c, details: { settings } });
  const silenced = SECURITY_ALERT_LIST.filter((k) => off.has(k) && !was.has(k));
  // Said to the other admins at most once an hour for each alert: switching one off and on again and again is one
  // email, and if it is still off when the hour is over the timer says so once more (sendHeldAlerts in seclog.ts).
  const tell = silenced.filter((k) => oncePerHour(a.id, `off:${k}`));
  if (tell.length)
    for (const m of all("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.role IN ('owner','admin') AND m.user_id!=?", a.id, c.user.id))
      await sendMail({ to: m.email, about: c.user.id, subject: `${c.user.name} switched off ${tell.length === 1 ? 'a security alert' : 'security alerts'} of ${a.name}`, heading: 'A security alert was switched off',
        lines: [`${c.user.name} switched off ${tell.length === 1 ? 'this alert' : 'these alerts'} under Settings, Security:`, tell.map((k) => SECURITY_ALERTS[k]).join('\n'),
          'What they are about is still written to the security record, but nobody is emailed about it any more. If that was not agreed, switch them on again there.'],
        cta: { label: 'Open Settings, Security', url: `${baseUrl()}/app/settings?tab=security` } });
  return json({ ok: true, alerts: SECURITY_ALERT_LIST.map((k) => ({ id: k, label: SECURITY_ALERTS[k], on: !off.has(k) })), emails });
}, 'admin');
