// Switches for senders and admins: the account's (owners and admins, Settings, Sending) and one envelope's own.
// The rules are in switches.ts.
import { route } from './router.ts';
import { bad } from './util.ts';
import { record } from './seclog.ts';
import { loadEnvelope } from './envelopes.ts';
import { mine, assertMayChange } from './routes-envelopes.ts';
import { accountSwitches, saveAccountSwitches, envelopeSwitches, saveEnvelopeSwitches } from './switches.ts';
import { WAYS_NOTE } from '../lib/switches.ts';

const view = (accountId: string) => ({ ...accountSwitches(accountId), sign_ways_note: WAYS_NOTE });

route('GET', '/account/switches', (c) => view(c.account.id), 'admin');

route('PUT', '/account/switches', async (c) => {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change these settings. That needs an owner or an admin signed in to the app, under Settings, Sending. Nothing was changed.', 403);
  const changed = saveAccountSwitches(c.account.id, await c.body());
  if (Object.keys(changed).length) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: changed } });
  return view(c.account.id);
}, 'admin');

route('GET', '/envelopes/:id/switches', (c) => envelopeSwitches(mine(c, c.params.id, 'envelope')));

route('PUT', '/envelopes/:id/switches', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  assertMayChange(c, e);
  return saveEnvelopeSwitches(loadEnvelope(e.id), b, c.actor);
});
