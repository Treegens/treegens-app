'use client';
// "History" on the document page, folded: what happened, oldest first, with the emails about the document in the
// same list (each says what became of it, so there is no second list of emails). The page shows no internet
// addresses, fingerprints or what a device reported about its clock: those are in the download
// "Full record for disputes" (src/lib/envelopepage.ts decides what is left out).
import { fmtDate } from '@/components/ui';
import { historyLines } from '@/lib/envelopepage';
import { redactedNote } from '@/lib/retention';
import { BackNews, deliveredLine } from './MailNews';
import { dayTime } from './lib';
import { Fold } from './More';
import type { Delivery } from './Recipients';
import { dayText } from '@/lib/dates';

const MAIL_STATUS: Record<string, string> = { sent: 'Handed to the mail server', outbox: 'Not delivered, no mail server set up', failed: 'Could not be sent', queued: 'Waiting to go out' };

/** What became of one email, in a sentence. A refused one says whether a next try is coming. */
export function mailState(d: Delivery): string {
  if (d.status === 'sent') return `${deliveredLine(d) || MAIL_STATUS.sent}.`;
  if (d.status === 'failed') return `${d.next_try_at ? 'Not sent yet' : MAIL_STATUS.failed}${d.error ? `: ${d.error}` : ''}. ${d.next_try_at ? `We try again around ${dayTime(d.next_try_at)}.` : 'We have stopped trying.'}`;
  return `${MAIL_STATUS[d.status] || d.status}.`;
}

export function History({ audit, deliveries, chain, fullRecordHref }: { audit: any[]; deliveries: Delivery[]; chain: { ok: boolean; redacted?: number; redacted_on?: any }; fullRecordHref?: string | null }) {
  const lines = historyLines(audit, deliveries.map((d) => ({ at: d.at, subject: d.subject, to_email: d.to_email, state: mailState(d), bad: d.status === 'failed' || d.status === 'outbox' })));
  const back = new Map(deliveries.map((d, i) => [`m${i}`, d]));
  return (
    <Fold title="History" count={lines.length} id="history"
      note={<span className={`badge ${chain.ok ? 'completed' : 'declined'}`}>{chain.ok ? (chain.redacted ? 'Record intact, some details removed' : 'Record intact') : 'Record was altered'}</span>}>
      {chain.ok && !!chain.redacted && <p className="muted small" role="note">{redactedNote(dayText(chain.redacted_on))}</p>}
      {!chain.ok && <p className="notice err" role="alert">A line of this record does not match the one before it, so something changed it after it was written. Download the full record and write to us through Help.</p>}
      {lines.length === 0 && <p className="muted small">Nothing has happened yet.</p>}
      <ol className="sn-history" role="list">
        {lines.map((l) => (
          <li key={l.key}>
            <div className="row between wrap" style={{ rowGap: 0 }}><b className="small">{l.title}</b><span className="muted small">{fmtDate(l.at, true)}</span></div>
            <div className={`small${l.bad ? ' sn-bad' : ' muted'}`}>{l.detail}{l.mail && back.get(l.key) ? <BackNews d={back.get(l.key)!} /> : null}</div>
            {l.who && <div className="muted small">{l.who}</div>}
            {l.removed && <span className="badge ret-audit-mark">Details removed {dayText(l.removed)}</span>}
          </li>
        ))}
      </ol>
      {fullRecordHref && <p className="muted small" style={{ marginBottom: 0 }}>Internet addresses and the fingerprint of every line are kept, and are in the <a href={fullRecordHref}>full record for disputes</a>.</p>}
    </Fold>
  );
}
