// Share links, with plans switched on: the page behind growsigning.com/<name> tells whoever opens it how many trees
// their signature plants, the same number as the invitation email and the signing page (src/server/impact.ts).
// A file of its own because plans are switched on by the environment, before the server starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_share_links';
const { boot, Client, signUp, simple } = await import('./helpers.ts');
const { PRICING } = await import('../src/lib/impact.ts');
await boot();

test('whoever opens a share link is told that their signature plants trees', async () => {
  const c = await signUp('Tina Trees', 'tina@trees.example', '203.0.113.90');
  const e = await simple(c, 'sam@trees.example', { subject: 'Tree doc', send: true });
  assert.equal((await c.put(`/envelopes/${e.id}/share-link`, {})).status, 200);
  const page = (await Object.assign(new Client(), { ip: '198.51.100.200' }).get('/public/share/tree-doc')).data;
  assert.equal(page.state, 'open');
  assert.equal(page.plants, PRICING.treesPerSignature);
  assert.equal(page.plants, 5);
});

test('the line stays in view on every step of "Who are you?", also while the person waits for the code', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src/components/share/WhoAreYou.tsx'), 'utf8');
  assert.match(src, /<OpenTreesLine trees=\{open\.plants\} \/>/);
  assert.ok(!/!who && <OpenTreesLine/.test(src));
});
