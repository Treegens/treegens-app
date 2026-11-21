// Ready-made templates: the list, a preview of one, and making a normal template of one (src/server/starters.ts).
import { route, pdfResponse } from './router.ts';
import { get } from './db.ts';
import { bad, rateLimit } from './util.ts';
import { loadEnvelope, publicEnvelope } from './envelopes.ts';
import { mayUse } from './tplroles.ts';
import { STARTERS, starterById, asksOf, starterNote, cleanAsk } from '../lib/starters/index.ts';
import { renderStarter, starterValues, makeFromStarter, madeFrom, previewValues } from './starters.ts';

const find = (sid: string) => {
  const s = starterById(sid);
  if (!s) throw bad(`There is no ready-made template called "${String(sid).slice(0, 60)}". GET /api/starters lists them.`, 404);
  return s;
};

// The account's name, unless it is still the one made at sign-up ("Ana Silva's workspace"): that is a person, not an organisation.
const orgGuess = (account: any, user: any): string => {
  const name = cleanAsk(account?.name);
  return !name || (user?.name && name === `${user.name}'s workspace`) || /'s workspace$/.test(name) ? '' : name;
};

route('GET', '/starters', (c) => {
  const made = madeFrom(c.account.id);
  return {
    organisation: orgGuess(c.account, c.user),
    starters: STARTERS.map((s) => ({
      id: s.id, title: s.title, purpose: s.purpose, written: s.written, place: s.place, reviewed_by: s.reviewedBy || null, note: starterNote(s),
      roles: [...s.roles].sort((a, b) => a.order - b.order).map((r) => r.name),
      asks: asksOf(s).map(({ key, label, max, example }) => ({ key, label, max, example: example || null })),
      // Templates already made from it that this person may use, so picking it twice by mistake is easy to see.
      made: (made.get(s.id) || []).filter((t) => {
        const tpl = get('SELECT * FROM envelopes WHERE id=?', t.id);
        return tpl && mayUse(c, tpl);
      }).slice(0, 3),
    })),
  };
});

// The PDF as it would be made, with whatever is written in so far (?organisation=...&partner=...). Empty words show
// as their label in brackets, and so does a word that reads like a brand. Nothing is saved.
route('GET', '/starters/:id/preview', async (c) => {
  const s = find(c.params.id);
  rateLimit(`starter-preview:${c.user.id}`, 120, 60 * 60_000);
  // A word that reads like a brand ("PayPal Billing") is printed as its label in brackets: making it is refused anyway.
  const { pdf } = await renderStarter(s, previewValues(s, c.q));
  return pdfResponse(pdf, s.title, true);
});

// A normal template in the account, made from the starter, owned by the person who picked it, for everyone on the team.
route('POST', '/starters/:id/use', async (c) => {
  const s = find(c.params.id);
  rateLimit(`starter-use:${c.user.id}`, 30, 60 * 60_000);
  const values = starterValues(s, await c.body());
  const eid = await makeFromStarter(c.account, c.user.id, c.actor, s, values);
  return { template: publicEnvelope(loadEnvelope(eid)), note: starterNote(s), edit_url: `/app/templates/${eid}/edit` };
});
