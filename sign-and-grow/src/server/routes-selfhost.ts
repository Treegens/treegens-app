// Routes for running the product yourself. GET /api/health is for monitoring (src/server/selfhost.ts says what it
// checks and what it never says). It needs no login, because a monitor has none.
import { route, json } from './router.ts';
import { health } from './selfhost.ts';

route('GET', '/health', () => {
  const h = health();
  return json(h, h.ok ? 200 : 503);
}, 'public');
