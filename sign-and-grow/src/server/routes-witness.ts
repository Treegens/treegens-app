import { route } from './router.ts';
import { rateLimit } from './util.ts';
import { find, look } from './routes-sign.ts';
import { nameWitness, makeStatement, notPresent } from './witness.ts';

// A witness for one signer (src/server/witness.ts). Everything here is authorised by the signing link, plus the access
// code and the one-time code when the sender set them, like every other /sign route. Each handler reads the body and
// then looks the link up again on the next line, with nothing waited for in between (see checkedBody in routes-sign.ts).

// The signer names their witness, or names another one after the first said they were not there.
route('POST', '/sign/:token/witness', async (c) => {
  find(c);
  const b = await c.body();
  const { e, r, actor } = look(c);
  // Each name is an email to a new person in the sender's name. The total for one witness place is capped as well.
  rateLimit(`witness:${r.id}`, 12, 3600_000);
  return { witness: (await nameWitness(e, r, b, actor)).witness };
}, 'public');

// The witness ticks the statement on their first screen, as their own words.
route('POST', '/sign/:token/witness-statement', async (c) => {
  find(c);
  const b = await c.body();
  const { e, r, actor } = look(c);
  return makeStatement(e, r, b?.statement, actor);
}, 'public');

// "I was not there": nothing is signed, the signer and the sender are told, and the document stays unwitnessed.
route('POST', '/sign/:token/not-present', async (c) => {
  find(c);
  const b = await c.body();
  const { e, r, actor } = look(c);
  rateLimit(`absent:${r.id}`, 3, 3600_000);
  return notPresent(e, r, b?.note, actor);
}, 'public');
