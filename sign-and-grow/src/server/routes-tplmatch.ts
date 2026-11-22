// "This looks like your template ... Use it?" (src/server/tplmatch.ts): the match for an upload, the template's
// people and fields when the sender says yes, and the account's level in Settings, Sending.
import { route } from './router.ts';
import { bad, str } from './util.ts';
import { run } from './db.ts';
import { record } from './seclog.ts';
import { bestMatch, fieldsFor, matchPercent } from './tplmatch.ts';
import { MATCH_CHOICES } from '../lib/tplcombine.ts';

// The best template for this file, or null when none is alike enough, when the file has no words, or when the only
// alike templates are ones this person may not use. Nothing changes.
route('GET', '/files/:id/template-match', (c) => ({ match: bestMatch(c, c.params.id) }));

// The template's people and its fields for this file, placed on its pages, with new ids, for the editor to add to the
// draft. "document_id" is the file's id on the draft. Nothing is saved here: the editor's own save does that.
route('POST', '/files/:id/template-match/use', async (c) => {
  const b = await c.body();
  if (!b?.template_id || typeof b.template_id !== 'string') throw bad('Send "template_id", the template whose fields to use. Nothing was changed.');
  if (!b?.document_id || typeof b.document_id !== 'string') throw bad('Send "document_id", the id the file has on your draft. Nothing was changed.');
  return fieldsFor(c, c.params.id, b.template_id, b.document_id);
});

route('GET', '/account/template-match', (c) => ({ percent: matchPercent(c.account.id), choices: MATCH_CHOICES }), 'admin');

route('PUT', '/account/template-match', async (c) => {
  const b = await c.body();
  const p = Number(b?.percent);
  if (!(MATCH_CHOICES as readonly number[]).includes(p) || typeof b?.percent !== 'number')
    throw bad(`"percent" is ${str(JSON.stringify(b?.percent ?? null), 40)}, and it has to be one of ${MATCH_CHOICES.join(', ')}, written as a number. Nothing was changed.`);
  const was = matchPercent(c.account.id);
  run('UPDATE accounts SET tpl_match_percent=? WHERE id=?', p, c.account.id);
  if (was !== p) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: { template_match_percent: { from: was, to: p } } } });
  return { percent: matchPercent(c.account.id), choices: MATCH_CHOICES };
}, 'admin');
