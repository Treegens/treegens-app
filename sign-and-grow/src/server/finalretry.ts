// The signed PDF of a completed envelope is made when the last person finishes (buildFinal in envelopes.ts). When that
// fails, the timer tries again (cronTick). This file decides which envelopes it tries and what happens to one that
// keeps failing, so that one envelope whose signed PDF cannot be made never holds up the others:
//   - Each failed try is counted (final_tries) and pushes the next one further out (final_due_at). The timer takes
//     the envelopes that are due, those never tried first, then the one that has waited longest.
//   - After FINAL_TRIES failures it stops trying every few minutes, and the sender and the people who run the server
//     are told, once (final_told_at). It still tries once a day, so a file put back from a backup gets its signed PDF
//     after all, and the sender is told when it is ready.
//   - While storing files is stopped (a key that does not fit the files there, see filestore.ts) nothing is tried and
//     nothing is counted: no PDF could be stored, and that is a setting of the server, not a fault of the envelope.
//     Its signed PDF is made once storing works again.
import path from 'node:path';
import { all, run, dataDir } from './db.ts';
import { storeState } from './filestore.ts';
import { notifySender } from './envelopes.ts';
import { id, now, isEmail, baseUrl } from './util.ts';
import { sendMail } from './mail.ts';

export const FINAL_TRIES = 5;
export const FINALS_PER_TICK = 5;
const DAY = 864e5;
// 10 minutes after the first failure, then 20, 40 and 80, then once a day.
const waitAfter = (tries: number) => (tries >= FINAL_TRIES ? DAY : 10 * 60_000 * 2 ** Math.max(0, tries - 1));
const stopped = () => !!storeState(path.join(dataDir(), 'blobs')).stop;

/** The completed envelopes whose signed PDF the timer should try to make now. One that was purged has none on purpose (records.ts). */
export function finalsDue(at = new Date().toISOString()): string[] {
  if (stopped()) return [];
  return all(`SELECT id FROM envelopes WHERE status='completed' AND kind='envelope' AND final_sha256 IS NULL AND purged_at IS NULL AND (final_due_at IS NULL OR final_due_at <= ?)
    ORDER BY final_due_at IS NOT NULL, final_due_at LIMIT ?`, at, FINALS_PER_TICK).map((r) => r.id);
}

/** After a try that failed: count it, and after the last one tell the sender and the operators, once. */
export async function finalFailed(e: any, err: any) {
  if (err?.data?.code === 'storage_stopped' || stopped()) return;
  const tries = (e.final_tries || 0) + 1;
  run('UPDATE envelopes SET final_tries=?, final_due_at=? WHERE id=?', tries, new Date(Date.now() + waitAfter(tries)).toISOString(), e.id);
  if (tries < FINAL_TRIES || e.final_told_at) return;
  if (!run('UPDATE envelopes SET final_told_at=? WHERE id=? AND final_told_at IS NULL', now(), e.id).changes) return;
  const damaged = err?.data?.code === 'file_damaged';
  await notifySender(e, 'always', `Signed PDF delayed: ${e.subject}`, 'We could not make the signed PDF yet', [
    `Everyone has finished "${e.subject}", and that stands. Every signature and every step is recorded.`,
    `What we could not make is the signed PDF with its certificate of completion: a file it is made from could not be read from our storage${damaged ? ', because the stored copy failed its check' : ''}. We tried ${tries} times.`,
    'The people who run GrowSigning have been told, and they can put the file back from a backup. We try again once a day, and we email you as soon as the signed PDF is ready.',
    'The people who signed were told it would follow shortly. Nothing they did is lost. If they ask, tell them it is delayed.',
  ]);
  tellOperators(e, tries, err);
}

/** After the signed PDF was made at last, for an envelope whose sender had been told it was stuck. */
export async function finalMadeLate(e: any) {
  if (!e.final_told_at) return;
  await notifySender(e, 'always', `Signed PDF ready: ${e.subject}`, 'The signed PDF is ready', [
    `We could make the signed PDF of "${e.subject}" with its certificate of completion after all. It is on the envelope page.`,
    'The people who signed can download it with their own links.',
  ]);
}

// Like the alerts about stored files (filestore.ts): in the operator queue, by email to SUPPORT_EMAIL and
// OPERATOR_EMAILS when they are set, and in the log.
function tellOperators(e: any, tries: number, err: any) {
  const subject = `A signed PDF cannot be made: envelope ${e.id}`;
  const lines = [`Envelope ${e.id} (account ${e.account_id}) is completed, but its signed PDF could not be made in ${tries} tries.`,
    `The last error: ${String(err?.data?.code || err?.message || err).slice(0, 300)}.`,
    'If a stored file failed its check, the alert about that file names it: put it back from a backup. The timer tries this envelope once a day and emails the sender when the PDF is made. The sender was told it is delayed.'];
  console.error(`\n[pdf] ${subject}\n[pdf] ${lines.join('\n[pdf] ')}\n`);
  try {
    const to = [...new Set([process.env.SUPPORT_EMAIL || '', ...(process.env.OPERATOR_EMAILS || '').split(',')].map((s) => s.trim().toLowerCase()).filter(isEmail))];
    run("INSERT INTO support_requests (id, email, name, topic, message, account_id, envelope_id, status, at) VALUES (?,?,?,'other',?,?,?,'open',?)",
      id('sup'), to[0] || 'files-alert@localhost', 'GrowSigning (automatic alert)', `${subject}\n\n${lines.join('\n')}`.slice(0, 5000), e.account_id, e.id, now());
    for (const t of to) sendMail({ to: t, subject, heading: subject, lines, cta: { label: 'Open the queue', url: `${baseUrl()}/app/operator` } }).catch((x) => console.error('[pdf] could not email the operators', x?.message));
    if (!to.length) console.error('[pdf] NOBODY WAS TOLD BY EMAIL (set SUPPORT_EMAIL or OPERATOR_EMAILS). The alert is in the operator queue.');
  } catch (x: any) {
    console.error('[pdf] could not file the alert', x?.message);
  }
}
