// The deletion record of an account as a PDF to print or file: GET /account/retention/log?format=pdf (admins), next to
// the CSV. The same lines as the CSV (retention_log, src/server/records.ts), in words: the files deleted first, each
// with the fingerprint of its signed PDF, then everything else on the record in the order it happened. It is drawn
// on the same sheet as the other records we print (sheetPdf in pdf.ts) and says what it is and what it is not: a list
// written by this software, checked by nobody outside it, that does not reach copies people saved or the backups of
// the people who run the server.
import { all, get } from './db.ts';
import { now } from './util.ts';
import { sheetPdf } from './pdf.ts';
import { dayText } from '../lib/dates.ts';
import { LEVEL_NAME, type PurgeLevel } from '../lib/retention.ts';

/** What each kind of line says, as the start of its entry. */
export const DELETION_WHAT: Record<string, string> = {
  policy: 'Deletion schedule changed',
  template_period: 'Period of a template changed',
  keep: 'Kept past its date',
  hold: 'Put on hold',
  hold_lifted: 'Hold lifted',
  override_asked: 'Asked to end a hold',
  refused: 'Refused',
  purge_asked: 'Deletion asked for',
  purge_cancelled: 'Deletion called off',
  noticed: 'Announced by email',
  purged: 'Files deleted',
};

/** What the record is and is not, in the PDF and in the README. */
export const DELETION_PDF_SAYS = 'This is the deletion record GrowSigning keeps for this account: every change to the deletion schedule, every keep, hold and deletion of files, and every attempt the software refused. Lines are never changed. It is written by this software and nobody outside it has checked it. Deleting here does not reach copies that people saved, or the backups of the people who run this server.';

/** At most this many lines go into one PDF; the CSV holds every line. */
export const DELETION_PDF_MAX_LINES = 5000;

const when = (iso: string) => `${dayText(iso)} ${String(iso).slice(11, 16)} UTC`;

export async function deletionRecordPdf(accountId: string): Promise<{ pdf: Uint8Array; lines: number }> {
  const account = get('SELECT id, name FROM accounts WHERE id=?', accountId);
  const total = get('SELECT COUNT(*) n FROM retention_log WHERE account_id=?', accountId).n as number;
  const rows = all('SELECT id, at, what, envelope_id, level, sha256, who, detail FROM retention_log WHERE account_id=? ORDER BY id LIMIT ?', accountId, DELETION_PDF_MAX_LINES);
  const deleted = rows.filter((r) => r.what === 'purged');
  const rest = rows.filter((r) => r.what !== 'purged');
  const made = now();
  const pdf = await sheetPdf('Deletion record', `Deletion record · ${account?.name || accountId} · made ${when(made)}`, (s) => {
    s.h2('Account');
    s.kv('Account', account?.name || '-');
    s.kv('Account ID', accountId);
    s.kv('Made', when(made));
    s.kv('Lines', total > rows.length ? `${rows.length} of ${total}, the oldest first. The CSV download holds every line.` : String(total));
    s.kv('Files deleted', String(deleted.length));
    s.text(DELETION_PDF_SAYS, { size: 8.5, gap: 4 });

    s.h2('Files deleted');
    if (!deleted.length) s.text('No files have been deleted under this account.', { size: 9 });
    for (const r of deleted) {
      s.need(70);
      s.text(`${when(r.at)} · Document ${r.envelope_id || '-'}`, { size: 9.5, bold: true });
      s.kv('What went', LEVEL_NAME[r.level as PurgeLevel] || r.level || '-');
      s.kv('Signed PDF (SHA-256)', r.sha256 || 'None: it was never completed');
      s.kv('By', r.who || 'The deletion schedule');
      if (r.detail) s.kv('Why', r.detail);
      s.rule(4);
    }

    s.h2('Everything else on the record');
    if (!rest.length) s.text('Nothing else yet.', { size: 9 });
    for (const r of rest) {
      s.need(40);
      s.text(`${when(r.at)} · ${DELETION_WHAT[r.what] || r.what}${r.envelope_id ? ` · Document ${r.envelope_id}` : ''}`, { size: 9, bold: true });
      const said = [r.who ? `By ${r.who}.` : '', r.detail || ''].filter(Boolean).join(' ');
      if (said) s.text(said, { size: 8.5, gap: 3 });
    }
  });
  return { pdf, lines: rows.length };
}
