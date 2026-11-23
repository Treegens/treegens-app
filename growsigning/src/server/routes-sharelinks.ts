import { route, type Ctx } from './router.ts';
import { bad, rateLimit } from './util.ts';
import { get } from './db.ts';
import { mine, assertMayRunForm } from './routes-envelopes.ts';
import { audit } from './envelopes.ts';
import { shareLinkOf, saveShareLink, suggestShareName, sharePage, shareCode, shareCheck, shareLinksAuto, autoShareLink } from './sharelinks.ts';
import { SHARE_LOOKUPS_PER_MINUTE, SHARE_CODE_ASKS_PER_HOUR, SHARE_CODE_TRIES_PER_TEN_MINUTES, SHARE_CHANGES_PER_HOUR } from '../lib/policy.ts';

// Share links (sharelinks.ts): the sender's side (see it, name it, switch it off) and the public page at /<name>.

// ---- The sender ----------------------------------------------------------------------------------------------------

// A link is for a document that is out for signing. Before that there is nobody to pick, and after it the link only
// says that the document is closed, so there is nothing left to name.
const out = (e: any) => e.status === 'sent';
function envelopeAnswer(e: any) {
  // SHARE_LINKS_AUTO=1: a sent document gets its link the first time its sender looks, unless it ever had one.
  if (shareLinksAuto() && out(e) && !get("SELECT 1 x FROM share_links WHERE kind='envelope' AND target_id=?", e.id)) autoShareLink('envelope', e.id, e.account_id, e.subject);
  const link = shareLinkOf('envelope', e.id);
  return { share_link: link, suggestion: link ? null : suggestShareName('envelope', e.id, e.subject), can_share: out(e) };
}
route('GET', '/envelopes/:id/share-link', (c) => envelopeAnswer(mine(c, c.params.id, 'envelope')));

route('PUT', '/envelopes/:id/share-link', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  if (e.status === 'draft') throw bad('A share link is made once the document is sent. Send it first.', 409);
  // A closed document: its link can still be switched off, so that the address stops saying anything about the
  // document. Nothing else is left to change.
  const offOnly = b.active === false && (b.name === undefined || b.name === null || b.name === '') && !!shareLinkOf('envelope', e.id);
  if (!out(e) && !offOnly) throw bad('This document is closed, so its share link no longer takes anyone to it. You can still switch the link off.', 409);
  rateLimit(`share-change:${c.account.id}`, SHARE_CHANGES_PER_HOUR, 3600_000);
  const before = shareLinkOf('envelope', e.id);
  const link = saveShareLink('envelope', e.id, e.account_id, e.subject, { name: b.name, active: b.active });
  if (!before) audit(e.id, c.actor, 'Share link made', `/${link.name}. Whoever opens it picks their name and proves it with a code sent to their address.`);
  else if (before.name !== link.name) audit(e.id, c.actor, 'Share link renamed', `From /${before.name} to /${link.name}. The old address stopped working.`);
  if (before && before.active !== link.active) audit(e.id, c.actor, link.active ? 'Share link switched on' : 'Share link switched off', `/${link.name}`);
  return { share_link: link, suggestion: null, can_share: out(e) };
});

function formFor(c: Ctx, doing: string) {
  const p = get('SELECT * FROM powerforms WHERE id=? AND account_id=?', c.params.id, c.account.id);
  if (!p) throw bad('That PowerForm does not exist any more. It may have been deleted already.', 404);
  if (doing) assertMayRunForm(c, get('SELECT * FROM envelopes WHERE id=?', p.template_id), doing);
  return p;
}
const formAnswer = (p: any) => {
  const link = shareLinkOf('form', p.id);
  return { share_link: link, suggestion: link ? null : suggestShareName('form', p.id, p.name), can_share: true };
};
route('GET', '/powerforms/:id/share-link', (c) => formAnswer(formFor(c, '')));
route('PUT', '/powerforms/:id/share-link', async (c) => {
  const b = await c.body();
  const p = formFor(c, 'change the share link of this PowerForm');
  rateLimit(`share-change:${c.account.id}`, SHARE_CHANGES_PER_HOUR, 3600_000);
  saveShareLink('form', p.id, p.account_id, p.name, { name: b.name, active: b.active });
  return formAnswer(p);
});

// ---- The page at /<name> -------------------------------------------------------------------------------------------

// A limit for each internet address. An address we cannot tell apart (no proxy in front, TRUSTED_PROXY_HOPS=0) would
// put every visitor in one bucket, so there the bucket is ten times as large: still a stop for a script.
export const perCaller = (what: string, ip: string, max: number, windowMs: number) =>
  ip && ip !== 'unknown' ? rateLimit(`${what}:${ip}`, max, windowMs) : rateLimit(`${what}:everyone`, max * 10, windowMs);

// Asked by the page itself (src/app/[name]/page.tsx reads sharelinks.ts directly) and by anyone's program. Counted
// for each internet address, so names cannot be tried by the thousand.
route('GET', '/public/share/:name', (c) => {
  perCaller('share-look', c.ip, SHARE_LOOKUPS_PER_MINUTE, 60_000);
  const page = sharePage(c.params.name);
  if (page.state === 'none') throw bad('Nothing is at this address.', 404, { state: 'none' });
  return page;
}, 'public');

// "Send me the code": to the address the sender gave for the name that was picked. Never says the address.
route('POST', '/public/share/:name/code', async (c) => {
  const b = await c.body();
  perCaller('share-code', c.ip, SHARE_CODE_ASKS_PER_HOUR, 3600_000);
  return shareCode(c.params.name, b.person, c.actor);
}, 'public');

// The code somebody typed. Right: where that person's own signing page is. Wrong tries are counted by the code
// itself (five end it, signercode.ts) and here for each internet address.
route('POST', '/public/share/:name/code/check', async (c) => {
  const b = await c.body();
  perCaller('share-check', c.ip, SHARE_CODE_TRIES_PER_TEN_MINUTES, 600_000);
  const { url, cookies } = await shareCheck(c.params.name, b.person, b.code, c.actor, c.secure);
  c.cookies.push(...cookies);
  return { ok: true, url };
}, 'public');
