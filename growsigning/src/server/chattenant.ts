// Which account a help chat question belongs to when it comes from one of an account's public pages: a form
// (/f/<slug>, powerforms) or an agreement page (/agree/<slug>, clickwraps). Those pages link to /help?form=<slug>,
// and the help dialog there sends that slug with its question, so the account's switch 'AI answers in the help chat'
// (src/server/tenantpolicy.ts) holds for the people who fill in its forms too, as it does for its signers (gov-G20).
// An unknown slug belongs to nobody, and the server's own rule decides, as for any visitor.
import { get } from './db.ts';

export function accountOfForm(slug: string | null | undefined): string | null {
  const s = String(slug || '').trim().slice(0, 120);
  if (!s) return null;
  return get('SELECT account_id x FROM powerforms WHERE slug=?', s)?.x || get('SELECT account_id x FROM clickwraps WHERE slug=?', s)?.x || null;
}
