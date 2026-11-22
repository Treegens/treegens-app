// Signing inside a customer's website and the sender screen inside their app (embed.ts): the list of websites, the
// sender screen's link, and opening and closing that screen. The signing link for a frame is
// POST /envelopes/{id}/recipient-view with "frame_origin" (routes-envelopes.ts).
import { route } from './router.ts';
import { bad, rateLimit } from './util.ts';
import { mine } from './routes-envelopes.ts';
import { originsOf, addOrigin, removeOrigin, makeSenderView, openSenderView, endSenderView } from './embed.ts';
import { EMBED_ORIGINS_MAX } from '../lib/embed.ts';

const listed = (accountId: string) => ({ origins: originsOf(accountId), max: EMBED_ORIGINS_MAX });

route('GET', '/account/embed-origins', (c) => listed(c.account.id), 'admin');
route('POST', '/account/embed-origins', async (c) => {
  const b = await c.body();
  addOrigin(c, b.origin);
  return listed(c.account.id);
}, 'admin');
route('DELETE', '/account/embed-origins', (c) => {
  removeOrigin(c, c.q.get('origin'));
  return listed(c.account.id);
}, 'admin');

route('POST', '/envelopes/:id/sender-view', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  // The screen acts as the person the draft belongs to, as their own browser would.
  return makeSenderView(e, e.sender_id, b);
});

route('POST', '/embed/sender/open', async (c) => {
  // A link is a long random secret, so guessing is hopeless; the limit only keeps a loop from filling the log.
  rateLimit(`sender-view:${c.ip}`, 60, 3600_000);
  const b = await c.body();
  return openSenderView(b.ticket);
}, 'public');

route('POST', '/embed/sender/close', (c) => {
  if (c.auth?.via !== 'embed' || !c.auth.viewId) throw bad('This is for the sender screen inside an app. Nothing was closed.', 403);
  return endSenderView(c.auth.viewId);
});
