import { route } from './router.ts';
import { rateLimit } from './util.ts';
import { find, look } from './routes-sign.ts';
import { storeUpload } from './routes-envelopes.ts';
import { stepView, nameNext, editorChange, finishStep, noteStepUpload } from './agents.ts';
import { isStepRole } from '../lib/recipienttypes.ts';
import { bad } from './util.ts';

// People who change the envelope on their turn (src/server/agents.ts): "Can change the document" and "Chooses who
// comes next". Everything is authorised by the signing link, plus the access code and the one-time code when the
// sender set them, like every other /sign route. A handler that reads a body looks the link up again on the next line.

route('GET', '/sign/:token/step', (c) => {
  const { e, r } = find(c);
  return stepView(e, r);
}, 'public');

// "Chooses who comes next": names or changes the people after them.
route('POST', '/sign/:token/step/people', async (c) => {
  find(c);
  const b = await c.body();
  const { e, r, actor } = look(c);
  return nameNext(e, r, b, actor);
}, 'public');

// "Can change the document": a new file to replace one with. Kept for this envelope and this link only.
route('POST', '/sign/:token/step/files', async (c) => {
  const first = find(c);
  if (first.r.role !== 'editor' || first.e.status !== 'sent' || (first.r.status !== 'sent' && first.r.status !== 'viewed'))
    throw bad('Only the person who can change the document can upload a file here, on their turn.', 403);
  rateLimit(`stepfile:${first.r.id}`, 20, 3600_000);
  const f = await storeUpload(c, first.e.account_id);
  const { r } = look(c);
  noteStepUpload(f.id, r);
  return { file: { id: f.id, name: f.name, pages: f.pages } };
}, 'public');

// "Can change the document": files, the people after them and their fields, through the sender's Edit rules.
route('POST', '/sign/:token/step/change', async (c) => {
  find(c);
  const b = await c.body();
  const { e, r, actor } = look(c);
  return editorChange(e, r, b, actor);
}, 'public');

// Either role finishes their step. Nothing is signed.
route('POST', '/sign/:token/step/finish', async (c) => {
  find(c);
  await c.body().catch(() => ({}));
  const { e, r, actor } = look(c);
  if (!isStepRole(r.role)) throw bad('This link is for someone who signs. Use Finish on the document instead.', 403);
  await finishStep(e, r, actor);
  return { finished: true };
}, 'public');
