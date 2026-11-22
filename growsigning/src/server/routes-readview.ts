// POST /sign/:token/view: the signing page says which way the document is shown to this person ("page" or "easy",
// src/lib/readview.ts). The first use of each is written to the audit trail and kept on the person, so the
// certificate can say which views they used (pdf.ts, viewsLine). Authorised by the signing link, after the access
// code and the one-time code like every other request that changes something (find and look in routes-sign.ts).
import { route } from './router.ts';
import { run, get } from './db.ts';
import { rateLimit, bad } from './util.ts';
import { audit } from './envelopes.ts';
import { find, look } from './routes-sign.ts';
import { isReadView, viewsOf, VIEW_ACTION, viewDetail, READ_VIEWS } from '../lib/readview.ts';

route('POST', '/sign/:token/view', async (c) => {
  find(c);
  const b = await c.body().catch(() => ({}));
  const { e, r, actor } = look(c);
  if (!isReadView(b?.view)) throw bad(`"view" is one of ${READ_VIEWS.map((v) => `"${v}"`).join(' or ')}. Nothing was recorded.`);
  // Nothing is written in four cases, the same as for the language of the page (routes-signlang.ts):
  //  - one member of a signing group shares the group's row with the others, so it would not be theirs alone;
  //  - someone who has finished: the certificate keeps the views they used up to signing;
  //  - someone whose turn has not come, who cannot open the document yet;
  //  - a document that is no longer out for signing: its record is closed.
  if (r.member) return { ok: true, saved: false, why: 'group' };
  if (r.completed_at) return { ok: true, saved: false, why: 'finished' };
  if (e.status !== 'sent') return { ok: true, saved: false, why: 'closed' };
  if (r.status === 'pending') return { ok: true, saved: false, why: 'not_yet' };
  rateLimit(`view:${r.id}:${c.ip}`, 60, 3600_000);
  const had = viewsOf(get('SELECT views_used v FROM recipients WHERE id=?', r.id)?.v);
  if (had.includes(b.view)) return { ok: true, saved: true, first: false };
  // Written only when this request is the one that adds the view, so two at the same moment write one audit line.
  const next = READ_VIEWS.filter((v) => v === b.view || had.includes(v)).join(',');
  const changed = run('UPDATE recipients SET views_used=? WHERE id=? AND COALESCE(views_used,\'\')=?', next, r.id, had.join(',')).changes;
  if (!changed) return { ok: true, saved: true, first: false };
  audit(e.id, actor, VIEW_ACTION[b.view as 'page' | 'easy'], viewDetail(r.name, b.view));
  return { ok: true, saved: true, first: true };
}, 'public');
