// Click-to-agree: the team's agreements, the page visitors accept on (also inside a frame on the team's own website),
// the API a website's server uses, the list of acceptances with its CSV, and the certificate. The rules are in
// clickwrap.ts and the words in src/lib/clickwrap.ts.
import { route, pdfResponse, type Ctx } from './router.ts';
import { all, get, run, readBlob } from './db.ts';
import { bad, baseUrl, id, isEmail, now, rateLimit, rateWait, sha256, str, token } from './util.ts';
import { sendMail } from './mail.ts';
import { showsTrees } from './tenantpolicy.ts';
import { ABUSE_REASONS } from './envelopes.ts';
import {
  acceptanceView, addressKey, certificatePdf, cleanUrl, closedWhy, CLOSED_TEXT, copyClaim, csvOf, emailCopy, linkWhy, loadAgreement, mayHaveReceipt, minVersion, pageUrl, publish, readView, readWho,
  receiptOf, recordAcceptance, statusFor, tellOwnerClosed, usage, versionOf, viewToken, LABEL_MAX, NAME_MAX, TERMS_MAX_CHARS,
} from './clickwrap.ts';
import { CLICKWRAP_PER_ADDRESS_HOUR, CLICKWRAP_PER_ADDRESS_AGREEMENT_HOUR, CLICKWRAP_PRESSES_PER_ADDRESS_HOUR } from '../lib/policy.ts';
import { CLICK_LAW, EMBED_CAN, EMBED_CANNOT, NOT_A_SIGNATURE, recordedBefore, recordShows, iframeSnippet, scriptSnippet, whoSnippet, WHO_FIELDS } from '../lib/clickwrap.ts';

// ---- The team's agreements (admins: they speak for the organisation's website) -----------------------------------

// draft, live, closed or not taking acceptances (with why, for the team only).
function stateOf(cw: any) {
  const why = closedWhy(cw);
  return { state: !cw.current_version ? 'draft' : !cw.active ? 'closed' : why ? 'stopped' : 'live', why: cw.current_version && cw.active ? why : null };
}

route('GET', '/clickwraps', (c) => {
  const start = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  return {
    usage: usage(c.account.id), not_a_signature: NOT_A_SIGNATURE,
    agreements: all(`SELECT k.id, k.name, k.slug, k.active, k.current_version, k.signed_only, k.updated_at, k.created_at,
        (SELECT COUNT(*) FROM clickwrap_acceptances a WHERE a.clickwrap_id=k.id) accepted, (SELECT COUNT(*) FROM clickwrap_acceptances a WHERE a.clickwrap_id=k.id AND a.at >= ?) accepted_month
      FROM clickwraps k WHERE k.account_id=? ORDER BY k.created_at DESC`, start, c.account.id)
      .map((k) => ({ ...k, active: !!k.active, signed_only: !!k.signed_only, url: pageUrl(k.slug), ...stateOf(get('SELECT * FROM clickwraps WHERE id=?', k.id)) })),
  };
}, 'admin');

// The draft's fields, checked the same way when an agreement is made and when it is changed. Only what the call names
// is changed. Nothing here is a version: publishing makes one.
function draftChanges(b: any, cw: any, accountId: string): Record<string, any> {
  const set: Record<string, any> = {};
  if (b.name !== undefined) {
    const name = str(b.name, 1000).trim();
    if (!name) throw bad('Give the terms a name, such as "Terms of service". Visitors see it as the title. Nothing was saved.');
    if (name.length > NAME_MAX) throw bad(`The name can be up to ${NAME_MAX} characters long. Nothing was saved.`);
    set.name = name;
  }
  if (b.text !== undefined) {
    const text = str(b.text, TERMS_MAX_CHARS + 1);
    if (text.length > TERMS_MAX_CHARS) throw bad(`Terms written here can be up to ${TERMS_MAX_CHARS.toLocaleString('en-US')} characters long. Put longer terms in a PDF. Nothing was saved.`);
    set.draft_text = text;
  }
  if (b.file_id !== undefined) {
    if (b.file_id === null || b.file_id === '') set.draft_file_id = null;
    else {
      const f = get('SELECT id FROM files WHERE id=? AND account_id=?', str(b.file_id, 80), accountId);
      if (!f) throw bad('That file is not one of the files uploaded to this account. Upload the PDF with POST /files first. Nothing was saved.');
      set.draft_file_id = f.id;
    }
  }
  if (b.format !== undefined) {
    if (b.format !== 'text' && b.format !== 'pdf') throw bad('"format" is "text" for terms written here or "pdf" for an uploaded PDF. Nothing was saved.');
    set.draft_format = b.format;
  } else if (set.draft_file_id && !cw) set.draft_format = 'pdf';
  for (const [k, col, what] of [['checkbox', 'draft_checkbox', 'next to the box'], ['button', 'draft_button', 'on the button']] as const) {
    if (b[k] === undefined) continue;
    const s = str(b[k], 1000).trim();
    if (s.length > LABEL_MAX) throw bad(`The words ${what} can be up to ${LABEL_MAX} characters long. Nothing was saved.`);
    set[col] = s || null;
  }
  // Yes and no are true and false, never "false" in quotes (the same rule as everywhere in the API).
  for (const [k, col] of [['scroll', 'draft_scroll'], ['signed_only', 'signed_only']] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw bad(`"${k}" is true or false, without quotes. Nothing was saved.`);
    set[col] = b[k] ? 1 : 0;
  }
  return set;
}

route('POST', '/clickwraps', async (c) => {
  const b = await c.body();
  const set = draftChanges({ ...b, name: b.name ?? '' }, null, c.account.id);
  const cid = id('cwk');
  run('INSERT INTO clickwraps (id, account_id, created_by, slug, name, secret, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', cid, c.account.id, c.user.id, token(9), set.name, token(32), now(), now());
  const rest = Object.keys(set).filter((k) => k !== 'name');
  if (rest.length) run(`UPDATE clickwraps SET ${rest.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...rest.map((k) => set[k]), cid);
  return { id: cid, url: pageUrl(get('SELECT slug FROM clickwraps WHERE id=?', cid).slug) };
}, 'admin');

route('GET', '/clickwraps/:id', (c) => {
  const cw = loadAgreement(c.params.id, c.account.id);
  const file = cw.draft_file_id ? get('SELECT id, name, pages, size, scan_pages FROM files WHERE id=?', cw.draft_file_id) : null;
  const need = minVersion(cw);
  const origin = baseUrl();
  return {
    agreement: { id: cw.id, name: cw.name, slug: cw.slug, url: pageUrl(cw.slug), active: !!cw.active, signed_only: !!cw.signed_only, current_version: cw.current_version || null, counts_from_version: need || null, created_at: cw.created_at, updated_at: cw.updated_at, ...stateOf(cw) },
    // The key a website signs its links with. Only admins reach this route, and it is never in a page a visitor sees.
    secret: cw.secret,
    draft: { format: cw.draft_format, text: cw.draft_text || '', file, checkbox: cw.draft_checkbox || '', button: cw.draft_button || '', scroll: !!cw.draft_scroll },
    versions: all(`SELECT v.number, v.title, v.format, v.terms_sha256, v.pages, v.checkbox, v.button, v.scroll, v.note, v.ask_again, v.published_by, v.published_at,
        (SELECT COUNT(*) FROM clickwrap_acceptances a WHERE a.version_id=v.id) accepted FROM clickwrap_versions v WHERE v.clickwrap_id=? ORDER BY v.number DESC`, cw.id)
      .map((v) => ({ ...v, scroll: !!v.scroll, ask_again: !!v.ask_again })),
    // People whose newest acceptance is of a version that no longer counts.
    to_accept_again: need > 1 ? get(`SELECT COUNT(*) n FROM (SELECT COALESCE(person_id, lower(email), id) who, MAX(version) best FROM clickwrap_acceptances WHERE clickwrap_id=? GROUP BY who) WHERE best < ?`, cw.id, need).n : 0,
    usage: usage(c.account.id),
    use: { page: pageUrl(cw.slug), iframe: iframeSnippet(origin, cw.slug), script: scriptSnippet(origin, cw.slug), sign: whoSnippet(origin, cw.slug), who_fields: WHO_FIELDS, embed_can: EMBED_CAN, embed_cannot: EMBED_CANNOT },
    law: CLICK_LAW, not_a_signature: NOT_A_SIGNATURE,
  };
}, 'admin');

route('PATCH', '/clickwraps/:id', async (c) => {
  const cw = loadAgreement(c.params.id, c.account.id);
  const b = await c.body();
  const set = draftChanges(b, cw, c.account.id);
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') throw bad('"active" is true or false, without quotes. Nothing was saved.');
    if (b.active && !cw.current_version) throw bad('Publish the terms first: there is nothing to open yet. Nothing was saved.', 409);
    set.active = b.active ? 1 : 0;
  }
  if (!Object.keys(set).length) return { changed: false };
  run(`UPDATE clickwraps SET ${Object.keys(set).map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...Object.values(set), now(), cw.id);
  // A change to the draft is not shown to anyone until it is published: the page keeps showing the version that is live.
  return { changed: true, published: false, ...stateOf(get('SELECT * FROM clickwraps WHERE id=?', cw.id)) };
}, 'admin');

route('POST', '/clickwraps/:id/publish', async (c) => {
  const cw = loadAgreement(c.params.id, c.account.id);
  const b = await c.body();
  if (b.ask_again !== undefined && typeof b.ask_again !== 'boolean') throw bad('"ask_again" is true or false, without quotes. Nothing was published.');
  return publish(cw, c.user, b.note, b.ask_again !== false);
}, 'admin');

// A new key. Every link a website signed with the old one stops working at once, so the answer says so.
route('POST', '/clickwraps/:id/secret', (c) => {
  const cw = loadAgreement(c.params.id, c.account.id);
  const secret = token(32);
  run('UPDATE clickwraps SET secret=?, updated_at=? WHERE id=?', secret, now(), cw.id);
  return { secret, note: 'Links your website signed with the old key stop working now. Put the new key on your website\'s server. Acceptances recorded before stay as they are.' };
}, 'admin');

// Records belong to the account until the account is deleted, so terms someone accepted cannot be deleted, only closed.
route('DELETE', '/clickwraps/:id', (c) => {
  const cw = loadAgreement(c.params.id, c.account.id);
  const n = get('SELECT COUNT(*) n FROM clickwrap_acceptances WHERE clickwrap_id=?', cw.id).n;
  if (n) throw bad(`${n} ${n === 1 ? 'acceptance is' : 'acceptances are'} recorded for these terms, and records are kept for as long as the account exists, so the terms cannot be deleted. Close them instead: the page stops taking acceptances and the records stay.`, 409);
  // A page someone reported keeps its terms until a person has looked at them: deleting it would leave the review
  // queue with nothing to judge.
  if (get("SELECT 1 x FROM abuse_reports WHERE clickwrap_id=? AND status='open'", cw.id))
    throw bad('Someone reported these terms, and the people who review reports have not looked at them yet, so they cannot be deleted until then. Close them instead: the page stops at once. Nothing was deleted.', 409, { code: 'reported' });
  run('DELETE FROM clickwraps WHERE id=?', cw.id);
}, 'admin');

// ---- For a website's own server (any member's key) -----------------------------------------------------------------

// The internet address, browser and page of a visitor are for the owner and the admins, as in the list of
// acceptances: a member, or a key with the "send" scope, is told whether and how someone accepted, without them.
const seesVisitors = (c: Ctx) => c.admin && (c.auth?.via === 'session' || c.auth?.scope === 'admin');
const forCaller = (c: Ctx, a: any) => (!a || seesVisitors(c) ? a : { ...a, ip: undefined, user_agent: undefined, page_url: undefined, given_ip: undefined, given_user_agent: undefined });

// Records an acceptance the website collected itself. It is marked as recorded by the website through the API, with
// who did it, everywhere it is shown: GrowSigning did not see the click. Only with an API key: it is the website's server
// that says who accepted, never a person in a browser, who could otherwise record "acceptances" for anybody.
route('POST', '/clickwraps/:id/acceptances', async (c) => {
  if (c.auth?.via !== 'api_key') throw bad('Acceptances are recorded through the API by your website\'s server, with an API key (Settings, API and webhooks), not from a browser. Nothing was recorded.', 403, { code: 'api_key_only' });
  const cw = loadAgreement(c.params.id, c.account.id);
  const b = await c.body();
  const v = versionOf(cw);
  const why = closedWhy(cw, v);
  if (why) throw bad(`${why} Nothing was recorded.`, 409, { code: 'closed' });
  if (b.version != null && Number(b.version) !== v.number) throw bad(`These terms are at version ${v.number} now, and the call says version ${str(b.version, 20)}. An acceptance is only recorded for the version that is live. Show the person version ${v.number} first. Nothing was recorded.`, 409, { code: 'terms_changed' });
  const p = b.person && typeof b.person === 'object' ? b.person : {};
  const person = { id: str(p.id ?? '', 200).trim() || null, name: str(p.name ?? '', 200).trim() || null, email: str(p.email ?? '', 254).trim() || null };
  if (!person.id && !person.email) throw bad('Say who accepted: "person": {"id": your own id for them, "name", "email"}. id or email is needed. Nothing was recorded.');
  if (person.email && !isEmail(person.email)) throw bad(`"${str(person.email, 80)}" is not an email address. Leave it out or give a real one. Nothing was recorded.`);
  const { row, already } = await recordAcceptance({
    cw, v, identity: 'api', person, via: 'api', page_url: cleanUrl(b.page_url), ip: c.ip, ua: c.ua, given_ip: str(b.ip ?? '', 64).trim() || null, given_ua: str(b.user_agent ?? '', 400).trim() || null,
    recorded_by: `${c.actor.name}, with an API key`,
  });
  return { acceptance: forCaller(c, acceptanceView(row)), already };
});

route('GET', '/clickwraps/:id/status', (c) => {
  const s = statusFor(loadAgreement(c.params.id, c.account.id), { person_id: c.q.get('person_id') || '', email: c.q.get('email') || '' });
  return { ...s, latest: forCaller(c, s.latest) };
});

// ---- Looking acceptances up (admins) ---------------------------------------------------------------------------------

function filtered(c: Ctx) {
  const w = ['a.account_id=?'];
  const p: any[] = [c.account.id];
  const q = c.q;
  if (q.get('agreement')) (w.push('a.clickwrap_id=?'), p.push(q.get('agreement')));
  if (q.get('version')) {
    if (!/^\d+$/.test(q.get('version')!)) throw bad('"version" is a whole number, such as 2.');
    w.push('a.version=?'), p.push(Number(q.get('version')));
  }
  for (const [k, ok] of [['via', ['hosted', 'embed', 'api']], ['identity', ['website', 'typed', 'api']]] as const) {
    const v = q.get(k);
    if (!v) continue;
    if (!(ok as readonly string[]).includes(v)) throw bad(`"${k}" is one of: ${ok.join(', ')}.`);
    w.push(`a.${k}=?`), p.push(v);
  }
  const text = str(q.get('q') || '', 200).trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    w.push("(a.name LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR a.person_id LIKE ? ESCAPE '\\' OR a.id = ?)"), p.push(like, like, like, text);
  }
  for (const [k, op, add] of [['from', '>=', 0], ['to', '<', 864e5]] as const) {
    const v = q.get(k);
    if (!v) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`"${k}" is a day written as YYYY-MM-DD, such as 2026-11-20. Days are counted in UTC.`);
    w.push(`a.at ${op} ?`), p.push(new Date(Date.parse(`${v}T00:00:00Z`) + add).toISOString());
  }
  return { where: w.join(' AND '), params: p };
}

route('GET', '/clickwrap-acceptances', (c) => {
  const { where, params } = filtered(c);
  const limit = Math.min(200, Math.max(1, Number(c.q.get('limit')) || 50));
  const before = Number(c.q.get('before')) || 0;
  const rows = all(`SELECT a.rowid n, a.*, (SELECT title FROM clickwrap_versions v WHERE v.id=a.version_id) version_title FROM clickwrap_acceptances a WHERE ${where}${before ? ' AND a.rowid < ?' : ''} ORDER BY a.rowid DESC LIMIT ?`, ...params, ...(before ? [before] : []), limit + 1);
  const total = get(`SELECT COUNT(*) n FROM clickwrap_acceptances a WHERE ${where}`, ...params).n;
  return { total, acceptances: rows.slice(0, limit).map((r) => acceptanceView(r)), next_before: rows.length > limit ? rows[limit - 1].n : null };
}, 'admin');

route('GET', '/clickwrap-acceptances/export', (c) => {
  const { where, params } = filtered(c);
  const rows = all(`SELECT a.*, (SELECT title FROM clickwrap_versions v WHERE v.id=a.version_id) version_title FROM clickwrap_acceptances a WHERE ${where} ORDER BY a.rowid DESC LIMIT 100000`, ...params);
  return new Response(csvOf(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store', 'content-disposition': `attachment; filename="acceptances-${now().slice(0, 10)}.csv"` } });
}, 'admin');

const oneOf = (c: Ctx) => {
  const r = get('SELECT * FROM clickwrap_acceptances WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!r) throw bad('That acceptance does not exist, or it belongs to another account.', 404);
  return r;
};
route('GET', '/clickwrap-acceptances/:id', (c) => {
  const r = oneOf(c);
  return { acceptance: acceptanceView(r), shows: recordShows(r.identity, r.via), law: CLICK_LAW };
}, 'admin');
route('GET', '/clickwrap-acceptances/:id/certificate', async (c) => pdfResponse(await certificatePdf(oneOf(c)), `acceptance-${c.params.id}`), 'admin');

// ---- The page visitors accept on -------------------------------------------------------------------------------------

const agreementAt = (slug: string) => {
  const cw = get('SELECT * FROM clickwraps WHERE slug=?', str(slug, 80));
  if (!cw) throw bad('There are no terms at this address. Check the link, or ask the website that sent you here.', 404);
  return cw;
};

route('GET', '/public/agree/:slug', async (c) => {
  rateLimit(`cwview:${addressKey(c.ip)}`, 600, 3600_000);
  const cw = agreementAt(c.params.slug);
  const v = versionOf(cw);
  const why = closedWhy(cw, v);
  // A closed page prints neither the terms nor the account's name: what closed it may be that they read like a scam.
  if (why) {
    if (v) await tellOwnerClosed(cw, why);
    return { closed: true, text: CLOSED_TEXT };
  }
  const person = readWho(cw, c.q.get('who'), c.q.get('sig'));
  // The page prints the name the website signed in ("You accept as ..."), so it is read with the terms.
  const lure = linkWhy(cw, v, person);
  if (lure) {
    await tellOwnerClosed(cw, lure);
    return { closed: true, text: CLOSED_TEXT };
  }
  if (!person && cw.signed_only) return { closed: true, signed_only: true, text: 'These terms can only be accepted through a link from the website that asked you to accept them. Go back to that website and follow its link from there. Nothing was recorded.' };
  const a = get('SELECT name, brand_color, brand_logo FROM accounts WHERE id=?', cw.account_id);
  // Someone the website names who accepted before is told what they accepted and what changed since.
  const mine = person ? (person.id ? all("SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND person_id=? AND identity != 'typed' ORDER BY version DESC, at DESC", cw.id, person.id)
    : all("SELECT * FROM clickwrap_acceptances WHERE clickwrap_id=? AND person_id IS NULL AND lower(email)=lower(?) AND identity != 'typed' ORDER BY version DESC, at DESC", cw.id, person.email)) : [];
  const best = mine[0];
  const need = minVersion(cw);
  // Never the receipt: whoever opens this link is told that the person accepted, and only the browser that accepted
  // holds the way to the copy (it keeps the receipt it was given in the answer to its press).
  // A person whose earlier version still counts is shown what they accepted, never the newer text under "You have
  // accepted these terms": the page gets that version's words (or its name, for a PDF) and the notes of what changed.
  const kept = best && best.version >= need && best.version !== v.number ? get('SELECT title, format, body FROM clickwrap_versions WHERE id=?', best.version_id) : null;
  const already = best && best.version >= need ? {
    id: best.id, version: best.version, at: best.at, email: copyOffered(best),
    ...(kept ? { title: kept.title, format: kept.format, text: kept.format === 'text' ? kept.body : null, changes: all('SELECT number, note FROM clickwrap_versions WHERE clickwrap_id=? AND number > ? ORDER BY number', cw.id, best.version) } : {}),
  } : null;
  const earlier = best && !already ? { version: best.version, at: best.at, changes: all('SELECT number, note FROM clickwrap_versions WHERE clickwrap_id=? AND number > ? ORDER BY number', cw.id, best.version) } : null;
  const identity = person ? 'website' : 'typed';
  const words = recordShows(identity, c.q.get('embed') ? 'embed' : 'hosted');
  return {
    closed: false, slug: cw.slug, account: { name: a.name, color: a.brand_color, logo: a.brand_logo }, trees: showsTrees(cw.account_id),
    version: { number: v.number, title: v.title, format: v.format, text: v.format === 'text' ? v.body : null, pages: v.pages, checkbox: v.checkbox, button: v.button, scroll: !!v.scroll, sha256: v.terms_sha256, published_at: v.published_at, pdf: v.format === 'pdf' ? `/api/public/agree/${cw.slug}/terms?v=${v.number}` : null },
    identity, person, already, earlier, recorded: recordedBefore(identity, a.name), shows: words.shows, not: words.not, law: CLICK_LAW,
    view: viewToken(v.id, Date.now(), c.ip, c.ua),
  };
}, 'public');

// The PDF of the terms that are live, for the page to show. A version that is no longer live is not served here.
route('GET', '/public/agree/:slug/terms', (c) => {
  const cw = agreementAt(c.params.slug);
  const v = versionOf(cw);
  if (!v || v.format !== 'pdf' || closedWhy(cw, v)) throw bad(CLOSED_TEXT, 404);
  if (c.q.get('v') && Number(c.q.get('v')) !== v.number) throw bad(`These terms are at version ${v.number} now. Load the page again.`, 409, { code: 'terms_changed' });
  return pdfResponse(readBlob(v.file_sha256), v.title, true);
}, 'public');

// Typed-in acceptances from one address (an IPv6 /64) in an hour, over every agreement and on one: a page anyone can
// open must not be a way to fill an account's records from one machine. Only what was recorded counts, and people the
// website names are not counted at all (it vouched for them), so the eleventh colleague in an office, or someone after
// a few presses without the box ticked, is not turned away. Asked before recording, counted in the same step as it.
function typedRoom(cw: any, ip: string) {
  const at = addressKey(ip);
  const wait = Math.max(rateWait(`cwtyped:${at}`, CLICKWRAP_PER_ADDRESS_HOUR), rateWait(`cwtyped:${cw.id}:${at}`, CLICKWRAP_PER_ADDRESS_AGREEMENT_HOUR));
  if (wait) {
    const minutes = Math.max(1, Math.ceil(wait / 60_000));
    throw bad(`Many people have already typed their details into these terms from your internet address in the last hour. Several people can share one address (an office, a school, a phone network), and this limit keeps a stranger from filling the records. Nothing was recorded. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}, or ask the website for a link that names you.`, 429, { code: 'address_limit', retry_minutes: minutes });
  }
  return () => (rateLimit(`cwtyped:${at}`, Infinity, 3600_000), rateLimit(`cwtyped:${cw.id}:${at}`, Infinity, 3600_000));
}

route('POST', '/public/agree/:slug/accept', async (c) => {
  // Presses of any kind from one address: far above what a shared address needs, against a page being hammered.
  rateLimit(`cwtry:${addressKey(c.ip)}`, CLICKWRAP_PRESSES_PER_ADDRESS_HOUR, 3600_000);
  const cw = agreementAt(c.params.slug);
  const b = await c.body();
  const v = versionOf(cw);
  const why = closedWhy(cw, v);
  if (why) {
    if (v) await tellOwnerClosed(cw, why);
    throw bad(CLOSED_TEXT, 503, { code: 'closed' });
  }
  const shown = readView(b.view, v, c.ip, c.ua);
  if (b.agree !== true) throw bad(`Tick "${v.checkbox}" first, then press "${v.button}". Nothing was recorded.`, 400, { code: 'not_ticked' });
  if (v.scroll && b.scrolled !== true) throw bad('Scroll to the end of the terms first: these terms ask to be read to the end before they are accepted. Nothing was recorded.', 400, { code: 'not_scrolled' });
  let person = readWho(cw, b.who, b.sig);
  const lure = linkWhy(cw, v, person);
  if (lure) {
    await tellOwnerClosed(cw, lure);
    throw bad(CLOSED_TEXT, 503, { code: 'closed' });
  }
  const identity = person ? 'website' : 'typed';
  if (!person) {
    if (cw.signed_only) throw bad('These terms can only be accepted through a link from the website that asked you to accept them. Go back to that website and follow its link from there. Nothing was recorded.', 403, { code: 'signed_only' });
    const name = str(b.name, 200).trim();
    const email = str(b.email, 254).trim();
    if (!name || !isEmail(email)) throw bad('Type your name and your email address. Nothing was recorded.', 400, { code: 'who_missing' });
    person = { id: null, name, email };
  }
  const onRecorded = identity === 'typed' ? typedRoom(cw, c.ip) : undefined;
  const via = b.embed === true ? 'embed' : 'hosted';
  const { row, already } = await recordAcceptance({
    cw, v, identity, person, via, page_url: cleanUrl(b.page_url), ip: c.ip, ua: c.ua, shown_ms: shown.open, view_match: shown.match, onRecorded,
    // Whether the button was covered only means something inside a frame on another website: on our own page
    // nothing is around the terms, so nothing is kept for it there, whatever a client sends.
    scrolled: v.scroll ? true : null, unobscured: via === 'embed' && typeof b.unobscured === 'boolean' ? b.unobscured : null, view: str(b.view, 200),
  }, true);
  // The receipt only to the browser that accepted (mayHaveReceipt): somebody else pressing with the same signed link
  // learns that the person accepted already, and nothing more.
  const mine = !already || mayHaveReceipt(row, b.view);
  return { acceptance: { id: row.id, version: row.version, at: row.at, sha256: row.terms_sha256 }, ...(mine ? { receipt: receiptOf(row.id) } : {}), already, email: mine && copyOffered(row) };
}, 'public');

// The visitor's own copy, by the receipt their browser was given. Nobody else holds it.
const byReceipt = (receipt: any) => {
  const r = get('SELECT * FROM clickwrap_acceptances WHERE receipt_hash=?', sha256(str(receipt, 100)));
  if (!r) throw bad('We cannot find that acceptance. The link may be from a record that was deleted with its account.', 404);
  return r;
};
// Whether the page offers "Email me a copy": only for an address the website signed in, and only once (copyClaim).
const copyOffered = (r: any) => r.identity === 'website' && !!r.email && !get('SELECT 1 x FROM clickwrap_copies WHERE acceptance_id=?', r.id);
route('POST', '/public/agree/receipt/email', async (c) => {
  rateLimit(`cwmail:${c.ip}`, 5, 3600_000);
  const r = byReceipt((await c.body()).receipt);
  const no = copyClaim(r);
  if (no) throw bad(no.message, no.status, { code: no.code });
  const { status, to } = await emailCopy(r);
  return { sent: status === 'sent', status, to };
}, 'public');
route('GET', '/public/agree/receipt/:receipt/certificate', async (c) => {
  rateLimit(`cwcert:${c.ip}`, 30, 3600_000);
  const r = byReceipt(c.params.receipt);
  return pdfResponse(await certificatePdf(r), `acceptance-${r.id}`);
}, 'public');

// "Report this page", like "Report this email" on a signing email. Anyone can open the page and type anything, so a
// report never counts towards pausing the account (via_form, as for public forms): a person in the operator queue
// reads it and decides. The page itself stays as it is until then.
route('POST', '/public/agree/:slug/report', async (c) => {
  rateLimit(`report:${c.ip}`, 10, 3600_000);
  const cw = agreementAt(c.params.slug);
  const b = await c.body();
  const reason = ABUSE_REASONS.includes(b?.reason) ? b.reason : 'other';
  const email = isEmail(str(b?.email, 254).trim()) ? str(b.email, 254).trim() : '';
  const reporter = email || `a visitor at ${c.ip}`;
  if (get('SELECT 1 x FROM abuse_reports WHERE clickwrap_id=? AND lower(reporter)=lower(?)', cw.id, reporter)) return { ok: true, already: true };
  run('INSERT INTO abuse_reports (id, envelope_id, account_id, reporter, reason, detail, ip, at, via_form, clickwrap_id) VALUES (?,?,?,?,?,?,?,?,?,?)', id('abr'), '', cw.account_id, reporter, reason, str(b?.detail, 2000) || null, c.ip, now(), 1, cw.id);
  const to = process.env.ABUSE_EMAIL || process.env.SUPPORT_EMAIL;
  const account = get('SELECT name FROM accounts WHERE id=?', cw.account_id);
  if (to)
    await sendMail({ to, subject: `Report: click-to-agree page "${cw.name}"`, heading: 'A visitor reported a click-to-agree page', ...(email ? { replyTo: email } : {}),
      lines: [`The page ${pageUrl(cw.slug)} ("${cw.name}") of the account ${account?.name} (${cw.account_id}).`, `Reported by ${reporter} as: ${reason}.`, ...(b?.detail ? [`They wrote: ${str(b.detail, 2000)}`] : []),
        'Anyone can open such a page and type anything, so the report does not count towards the automatic pause. A person should look at it.'],
      cta: { label: 'Open the review queue', url: `${baseUrl()}/app/operator` } });
  return { ok: true };
}, 'public');

