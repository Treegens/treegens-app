// POST /sign/:token/locale: the signer chose the language of the signing page in its header menu. Saved on them, so
// their emails and their next visit follow it, and written to the audit trail. Authorised by the signing link, after
// the access code and the one-time code like every other change (find and look in routes-sign.ts).
import { route } from './router.ts';
import { run, get } from './db.ts';
import { rateLimit } from './util.ts';
import { audit } from './envelopes.ts';
import { find, look } from './routes-sign.ts';
import { chosenLocale, signerLanguage } from './locales.ts';
import { notePageLanguage } from './signlang.ts';
import { languageWords } from '../lib/i18n.ts';

route('POST', '/sign/:token/locale', async (c) => {
  find(c);
  const b = await c.body().catch(() => ({}));
  const { e, r, actor } = look(c);
  // A language that is not switched on is refused, naming the ones that are (chosenLocale in locales.ts). null or ""
  // goes back to "as their browser asks". Checked before anything is counted, so a wrong request uses up nothing.
  const tag = chosenLocale(b?.locale ?? b?.language, 'The language ("locale")', 'Nothing was changed.');
  const shown = signerLanguage({ locale: tag }, c.req);
  // Nothing is saved, and nothing is written to the record, in three cases; the page changes in this tab all the same
  // and says why the choice is not kept (src/components/sign/lang.tsx):
  //  - one member of a signing group shares the group's row with the others, so the choice is theirs alone;
  //  - someone who has finished: the certificate keeps the language they read when they signed, never a later one;
  //  - a document that is no longer out for signing (completed, voided, declined, expired): its record is closed.
  if (r.member) return { ok: true, saved: false, why: 'group', language: shown };
  if (r.completed_at) return { ok: true, saved: false, why: 'finished', language: shown };
  if (e.status !== 'sent') return { ok: true, saved: false, why: 'closed', language: shown };
  if ((r.locale ?? null) !== tag) {
    // Counted per person and connection, and per person in all: someone with a forwarded link cannot use up the
    // signer's own changes from one connection, and the record gets at most 40 lines an hour however many they use.
    rateLimit(`locale:${r.id}:${c.ip}`, 20, 3600_000);
    rateLimit(`locale:${r.id}`, 40, 3600_000);
    run('UPDATE recipients SET locale=? WHERE id=?', tag, r.id);
    audit(e.id, actor, 'Chose the language of the page', `${r.name} chose to read the page in ${tag ? languageWords(tag) : 'the language their browser asks for'}.`);
  }
  notePageLanguage(r.id, tag || signerLanguage({ locale: null }, c.req).locale);
  return { ok: true, saved: true, language: signerLanguage(get('SELECT locale FROM recipients WHERE id=?', r.id), c.req) };
}, 'public');
