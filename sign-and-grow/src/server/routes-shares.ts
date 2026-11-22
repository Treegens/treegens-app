import { route } from './router.ts';
import { bad, str } from './util.ts';
import { can } from './perm.ts';
import { sharesOf, giveShare, endShare, moveEnvelopes, moveAllOf, moveCountOf, setSendFor, sendsFor } from './shares.ts';

// Working for a colleague: the routes. What it is and how it behaves is in shares.ts.

// Settings, Away and sharing: shares given and received (and, for an admin of the team, all of them).
route('GET', '/me/shares', (c) => sharesOf(c));
route('POST', '/me/shares', async (c) => giveShare(c, await c.body()));
// Ends one at once: the person who shared, the colleague, or an admin of the team.
route('DELETE', '/me/shares/:id', (c) => endShare(c, c.params.id));

// The envelope page's "Move to a colleague", and the same for several envelopes or templates at once.
route('POST', '/envelopes/:id/move', async (c) => moveEnvelopes(c, [c.params.id], (await c.body())?.to));
route('POST', '/envelopes/move', async (c) => {
  const b = await c.body();
  return moveEnvelopes(c, b?.ids, b?.to);
});

// Settings, Team: how many documents and templates that would move, asked before moving them.
route('GET', '/account/members/:id/move-documents', (c) => {
  if (!can(c, 'team')) throw bad('Only an admin of the account can move all of a member\'s documents. Ask an admin of your team.', 403);
  return moveCountOf(c, str(c.params.id, 80));
}, 'admin');
// Settings, Team: everything one member sent and every template of theirs, to another member.
route('POST', '/account/members/:id/move-documents', async (c) => {
  if (!can(c, 'team')) throw bad('Only an admin of the account can move all of a member\'s documents. Ask an admin of your team.', 403);
  return moveAllOf(c, str(c.params.id, 80), (await c.body())?.to);
}, 'admin');

// Step 3's "Send for <name>": a draft this person made becomes the colleague's ("on_behalf_of"), or theirs again ("").
route('POST', '/envelopes/:id/send-for', async (c) => setSendFor(c, c.params.id, await c.body()));
// Whom this person may send for today, for step 3.
route('GET', '/me/sends-for', (c) => ({ people: sendsFor(c) }));
