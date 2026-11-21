// Settings, Records and data: "Archive format (PDF/A)" (src/server/pdfa.ts). Admins switch it on or off; off by
// default. Listed only once the people who run the server set VERAPDF_CMD: without the checker there is nothing to
// switch on, and the setting answers so.
import { route } from './router.ts';
import { bad } from './util.ts';
import { run } from './db.ts';
import { record } from './seclog.ts';
import { accountWantsPdfa, pdfaAvailable } from './pdfa.ts';

// available: whether this server can make PDF/A at all. on: the account's switch.
route('GET', '/account/pdfa', (c) => ({ available: pdfaAvailable(), on: accountWantsPdfa(c.account.id) }), 'admin');

route('PUT', '/account/pdfa', async (c) => {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change this setting. An owner or an admin can, signed in to the app, under Settings, Records and data. Nothing was changed.', 403);
  const b = await c.body();
  if (typeof b?.on !== 'boolean') throw bad('Send "on" as true or false. Nothing was changed.');
  if (b.on && !pdfaAvailable()) throw bad('This server cannot make PDF/A files, because the people who run it have not set up the check. Ask them to install veraPDF, or leave this off. Nothing was changed.', 409);
  const was = accountWantsPdfa(c.account.id);
  run('UPDATE accounts SET pdfa_on=? WHERE id=?', b.on ? 1 : 0, c.account.id);
  if (was !== b.on) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: { archive_format_pdfa: { from: was, to: b.on } } } });
  return { available: pdfaAvailable(), on: accountWantsPdfa(c.account.id) };
}, 'admin');
