import { route } from './router.ts';
import { bad, rateLimit } from './util.ts';
import { mine } from './routes-envelopes.ts';
import { delegationOn, setSwitch, myDelegation, saveDelegation, stopDelegation, setOnlyNamed, awayFor } from './delegation.ts';

// Someone who signs for a person while they are away: the routes. What it is and how it behaves is in delegation.ts.

const yes = (v: any) => {
  if (v === true || v === false) return v;
  throw bad('Send "on": true or false. Nothing was changed.');
};

// The admins' switch, in Settings, Team. Off by default.
route('GET', '/account/delegation', (c) => ({ on: delegationOn(c.account.id) }), 'admin');
route('PUT', '/account/delegation', async (c) => setSwitch(c, yes((await c.body())?.on)), 'admin');

// A person's own delegate, in Settings, Away and sharing.
route('GET', '/me/delegate', (c) => myDelegation(c));
route('PUT', '/me/delegate', async (c) => saveDelegation(c, await c.body()));
route('DELETE', '/me/delegate', (c) => stopDelegation(c));

// The sender's "Only the person named may sign", on a draft or an envelope that is out.
route('PUT', '/envelopes/:id/only-named', async (c) => {
  const on = yes((await c.body())?.on);
  // Its sender, or an admin who sees every document (mine in routes-envelopes.ts).
  return setOnlyNamed(c, mine(c, c.params.id, 'envelope'), on);
});

// Step 3: who among the people on this draft is away today and named someone to sign for them. The editor sends the
// people as it has them now, so the answer is right before the draft is saved. Empty when the account does not allow
// delegates. Only names, never a delegate's address.
route('POST', '/envelopes/:id/away', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  rateLimit(`away:${c.user?.id || c.ip}`, 120, 3600_000);
  if (b?.people !== undefined && !Array.isArray(b.people)) throw bad('Send "people" as a list of { name, email, role }. Nothing was looked up.');
  return { away: awayFor(e, Array.isArray(b?.people) ? b.people : e.recipients) };
});
