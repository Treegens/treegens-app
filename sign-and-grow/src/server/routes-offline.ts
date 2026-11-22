// Signing in person where there is no signal (src/server/offlinesign.ts says what and why). Routes:
//  - POST /envelopes/:id/offline: the host's own browser gets one in-person signer's part ready for the device.
//  - GET /envelopes/:id/offline: the copies of this envelope still waiting on a device.
//  - DELETE /envelopes/:id/offline/:prep: ends one (a lost phone), so a result from it later signs nothing.
//  - POST /offline/:prep/hand-over: the host hands the device over; the account locks in that browser.
//  - POST /sign/:token/offline-finish: the result comes back by the signing link once the device has signal.
import { route } from './router.ts';
import { bad, rateLimit, str } from './util.ts';
import { mine } from './routes-envelopes.ts';
import { find, look, signView } from './routes-sign.ts';
import { can } from './perm.ts';
import { prepare, finishOffline, waitingOn, cancel, lockForHandOver } from './offlinesign.ts';

/** The envelope, for its sender or an admin who sees the whole account. A colleague it is shared with gets no links. */
function hostOf(c: any) {
  const e = mine(c, c.params.id, 'envelope');
  if (e.sender_id !== c.user.id && !can(c, 'see_all')) throw bad('Only the sender of this envelope can get it ready to sign without signal.', 403, { code: 'not_sender' });
  return e;
}

route('POST', '/envelopes/:id/offline', async (c) => {
  const body = await c.body().catch(() => ({}));
  rateLimit(`offline:${c.user.id}`, 30, 3600_000);
  const e = hostOf(c);
  const r = e.recipients.find((x: any) => x.id === str(body.recipient_id, 80));
  if (!r || !r.token) throw bad('That person is not on this envelope, or it has not been sent yet.', 404);
  // What the signing link would give, looked at quietly: nothing is marked viewed and the account is not locked yet.
  const lc: any = { ...c, params: { token: r.token } };
  const found = look(lc, false);
  return prepare(c, found.e, found.r, found, signView(lc, found, true));
});

route('GET', '/envelopes/:id/offline', (c) => ({ waiting: waitingOn(hostOf(c).id) }));

route('DELETE', '/envelopes/:id/offline/:prep', (c) => cancel(c, hostOf(c), c.params.prep));

route('POST', '/offline/:prep/hand-over', (c) => {
  if (c.auth?.via !== 'session') throw bad('Only the app on the device itself can hand it over.', 403);
  return lockForHandOver(c, c.params.prep);
});

route('POST', '/sign/:token/offline-finish', async (c) => {
  find(c);
  const b = await c.body().catch(() => ({}));
  // Looked at again after the body is in, as every Finish does (routes-sign.ts).
  return finishOffline(c, look(c), b);
}, 'public');
