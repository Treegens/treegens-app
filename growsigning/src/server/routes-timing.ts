// Send later, pause and resume (timing.ts). Sending later can also be asked with "send_at" on POST /envelopes/:id/send.
import { route } from './router.ts';
import { loadEnvelope, publicEnvelope } from './envelopes.ts';
import { mine } from './routes-envelopes.ts';
import { scheduleSend, cancelSchedule, pauseEnvelope, resumeEnvelope } from './timing.ts';
import { noteSentBy } from './shares.ts';

// Set or change the time a draft goes out by itself: { "send_at": "2027-03-20T09:00:00Z" }, 5 minutes to 30 days ahead.
route('POST', '/envelopes/:id/send-later', async (c) => {
  const b = await c.body();
  const e = mine(c, c.params.id, 'envelope');
  const at = scheduleSend(e, b?.send_at, c.actor);
  // Whoever set the time is who sent it, also when it leaves later by itself (shares.ts).
  noteSentBy(c, e.id);
  return { send_at: at, envelope: publicEnvelope(loadEnvelope(e.id)) };
});

// Take the time off: it stays a draft.
route('DELETE', '/envelopes/:id/send-later', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  cancelSchedule(e, c.actor);
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
});

route('POST', '/envelopes/:id/pause', (c) => {
  const e = mine(c, c.params.id, 'envelope');
  // paused_by is the person's name, for the sender's page; the record has who pressed it as for any action.
  pauseEnvelope(e, c.actor, c.user?.name || c.actor.name);
  return { envelope: publicEnvelope(loadEnvelope(e.id)) };
});

route('POST', '/envelopes/:id/resume', async (c) => {
  const e = mine(c, c.params.id, 'envelope');
  const r = await resumeEnvelope(e, c.actor);
  return { ...r, envelope: publicEnvelope(loadEnvelope(e.id)) };
});
