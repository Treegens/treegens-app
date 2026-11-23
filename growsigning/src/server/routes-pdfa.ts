// Settings, Records and data: "Archive format (PDF/A)" (src/server/pdfa.ts). Admins switch it on or off; off by
// default. Listed only once the people who run the server set VERAPDF_CMD: without the checker there is nothing to
// switch on, and the setting answers so.
import { route } from './router.ts';
import { bad } from './util.ts';
import { run, get } from './db.ts';
import { t, SOURCE_LOCALE } from '../lib/i18n.ts';
import { record } from './seclog.ts';
import { accountWantsPdfa, pdfaAvailable } from './pdfa.ts';

// available: whether this server can make PDF/A at all. on: the account's switch. notice: one plain line while the
// switch is on and something on the server stands in the way: the checker was taken away (the card stays, so the
// admin learns it and can switch it off), or the account's last check could not be done.
function notice(accountId: string, available: boolean, on: boolean): string | null {
  if (!on) return null;
  if (!available) return t(SOURCE_LOCALE, 'pdfa.setting.gone');
  const last = get("SELECT pdfa, pdfa_note, pdfa_code FROM envelopes WHERE account_id=? AND pdfa IS NOT NULL ORDER BY completed_at DESC, rowid DESC LIMIT 1", accountId);
  return last?.pdfa === 'not' && SERVER_TROUBLE.has(last.pdfa_code) ? t(SOURCE_LOCALE, 'pdfa.setting.trouble', { why: last.pdfa_note }) : null;
}
const SERVER_TROUBLE = new Set(['slow', 'checker_down', 'busy']);
const answer = (accountId: string) => {
  const available = pdfaAvailable();
  const on = accountWantsPdfa(accountId);
  return { available, on, notice: notice(accountId, available, on) };
};

route('GET', '/account/pdfa', (c) => answer(c.account.id), 'admin');

route('PUT', '/account/pdfa', async (c) => {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change this setting. An owner or an admin can, signed in to the app, under Settings, Records and data. Nothing was changed.', 403);
  const b = await c.body();
  if (typeof b?.on !== 'boolean') throw bad('Send "on" as true or false. Nothing was changed.');
  if (b.on && !pdfaAvailable()) throw bad('This server cannot make PDF/A files, because the people who run it have not set up the check. Ask them to install veraPDF, or leave this off. Nothing was changed.', 409);
  const was = accountWantsPdfa(c.account.id);
  run('UPDATE accounts SET pdfa_on=? WHERE id=?', b.on ? 1 : 0, c.account.id);
  if (was !== b.on) record('settings.changed', { c, about: ['account', c.account.id], details: { settings: { archive_format_pdfa: { from: was, to: b.on } } } });
  return answer(c.account.id);
}, 'admin');
