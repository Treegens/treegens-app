'use client';
// Signing on paper, on the signing page (research/ux-notes.json, ds-paper). Only where the sender's account switched
// on "People may sign on paper" (recipient.paper_sign from src/server/paper.ts); with nothing set up none of this is
// drawn and the page is as it always was.
//
//   - Other actions has one entry, "Sign on paper instead". With the account's own consent text it holds two choices,
//     "Print it and send a photo" and "Ask <sender> to send it by post" (sign/Withdraw.tsx); without, it opens the
//     print and send steps straight away.
//   - Someone the sender asked to sign on paper only gets those steps as their screen, with no electronic signing.
//   - After sending, the person's screen says it waits for the sender to check it.
import { useRef, useState } from 'react';
import { Dialog } from './Dialog';
import { StateCard } from './parts';
import { PaperDialog } from './Withdraw';
import { t } from '@/lib/i18n';
import { shrinkPhoto, isPicture } from '@/components/editor/photos';
import { fmtDate } from '@/components/ui';

// off: the sender asked again, and paper has since been switched off for the account: they sign on screen now.
// mail: whether an "Ask again" is emailed to them (not to an address that marked our email as spam).
export type PaperSign = { way: 'may' | 'only'; state: 'waiting' | 'asked_again' | 'accepted' | null; sent_at: string | null; pages: number | null; reason?: string; code: string; max_mb: number; off?: boolean; mail?: boolean };

/** Which screen of its own signing on paper takes, if any: the waiting card, or "on paper only". */
export const paperFirst = (ps: PaperSign | null | undefined, stage: string): '' | 'waiting' | 'only' =>
  !ps || (stage !== 'consent' && stage !== 'sign') ? '' : ps.state === 'waiting' ? 'waiting' : ps.way === 'only' ? 'only' : '';

/** Whether Other actions offers "Sign on paper instead" for printing it: not while a scan waits or once accepted. */
export const offersPrint = (ps: PaperSign | null | undefined): boolean => !!ps && !ps.off && ps.state !== 'waiting' && ps.state !== 'accepted';

/**
 * Other actions with "Sign on paper instead" for printing it (sign/actions.ts keeps the one order and the cap): the list
 * as it is when the entry is already there or printing is not offered; otherwise the same list asked with paper on.
 */
export const withPrint = <K extends string>(keys: K[], ps: PaperSign | null | undefined, withPaper: () => K[]): K[] => (offersPrint(ps) && !keys.includes('paper' as K) ? withPaper() : keys);

const pagesWords = (lang: string, n: number | null) => (n === 1 ? t(lang, 'sign.paper.pages_one') : t(lang, 'sign.paper.pages_many', { count: n ?? 0 }));

/** The three steps: print, sign by hand, send the photos. Used in the dialog and on the "on paper only" screen. */
export function PaperSteps({ base, ps, sender, lang, onSent }: { base: string; ps: PaperSign; sender: { name: string }; lang: string; onSent: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const total = files.reduce((n, f) => n + f.size, 0);
  const send = async () => {
    setError('');
    if (total > ps.max_mb * 1_000_000) return setError(t(lang, 'sign.paper.too_big', { mb: ps.max_mb }));
    setBusy(true);
    try {
      const form = new FormData();
      // A phone photo is made smaller first, as it is for the sender's own uploads. It is never cleaned or changed:
      // what was written on the paper is what the sender sees.
      for (const f of files) {
        const ready = isPicture(f) ? await shrinkPhoto(f) : f;
        form.append('file', ready, ready.name);
      }
      const res = await fetch(`/api${base}/paper`, { method: 'POST', body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Already waiting (a second tap): the page then shows how it stands now.
        if (res.status === 409 && data.code === 'paper_waiting') return onSent();
        throw new Error(data.error || '');
      }
      onSent();
    } catch (e: any) {
      setError(`${e?.message || 'Something went wrong on our side.'} ${t(lang, 'sign.paper.not_sent')}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack sg-paper-steps" data-feature="ds-paper">
      {ps.state === 'asked_again' && (
        <div className="notice warn" role="note">
          <b>{t(lang, 'sign.paper.asked_again', { sender: sender.name })}</b>
          {ps.reason && <p className="sg-quote" style={{ margin: '6px 0 0', overflowWrap: 'anywhere' }}><span className="muted small">{t(lang, 'sign.paper.their_reason')}:</span> {ps.reason}</p>}
        </div>
      )}
      <div>
        <h2 className="sg-paper-h">{t(lang, 'sign.paper.step_print')}</h2>
        <a className="btn lg" href={`/api${base}/paper/print`} download style={{ minHeight: 44 }}>{t(lang, 'sign.paper.download')}</a>
        <p className="muted small" style={{ margin: '6px 0 0' }}>{t(lang, 'sign.paper.code', { code: ps.code })}</p>
      </div>
      <div>
        <h2 className="sg-paper-h">{t(lang, 'sign.paper.step_sign')}</h2>
        <p style={{ margin: 0 }}>{t(lang, 'sign.paper.step_sign_hint')}</p>
      </div>
      <div>
        <h2 className="sg-paper-h">{t(lang, 'sign.paper.step_send')}</h2>
        {/* The button below is the control: the hidden input takes no Tab stop and is not read out twice. */}
        <input ref={input} id="sg-paper-files" type="file" className="sg-vh" tabIndex={-1} aria-hidden="true" multiple accept="application/pdf,image/jpeg,image/png" aria-describedby="sg-paper-files-hint"
          onChange={(e) => (setFiles(Array.from(e.target.files || [])), setError(''))} />
        <button type="button" className="btn lg" style={{ minHeight: 44 }} onClick={() => input.current?.click()}>{t(lang, 'sign.paper.choose_files')}</button>
        <p className="muted small" id="sg-paper-files-hint" style={{ margin: '6px 0 0' }}>{t(lang, 'sign.paper.files_hint', { mb: ps.max_mb })}</p>
        {files.length > 0 && <p className="small" role="status" style={{ margin: '6px 0 0', overflowWrap: 'anywhere' }}>{t(lang, 'sign.paper.chosen', { count: files.length, names: files.map((f) => f.name).join(', ') })}</p>}
      </div>
      {error && <div className="notice err sg-problem" role="alert">{error}</div>}
      <div className="actions">
        <button type="button" className="btn primary lg" disabled={!files.length || busy} onClick={() => void send()} style={{ minHeight: 44 }}>
          {busy ? t(lang, 'sign.paper.sending') : t(lang, 'sign.paper.send', { sender: sender.name })}
        </button>
      </div>
    </div>
  );
}

/**
 * "Sign on paper instead" from Other actions. With the account's own consent text (`byPost`), first the two choices;
 * otherwise the print and send steps at once. Without paper_sign it is the dialog that was there before (Withdraw.tsx).
 */
export function PaperChoice({ base, ps, byPost, sender, lang, note, onClose, onDone, onSent }: {
  base: string; ps: PaperSign | null | undefined; byPost: boolean; sender: { name: string }; lang: string; note?: string; onClose: () => void; onDone: () => void; onSent: () => void;
}) {
  const [pick, setPick] = useState<'' | 'print' | 'post'>(offersPrint(ps) && !byPost ? 'print' : !offersPrint(ps) ? 'post' : '');
  if (pick === 'post') return <PaperDialog base={base} sender={sender} lang={lang} note={note} onClose={onClose} onDone={onDone} />;
  if (pick === 'print' && ps)
    return (
      <Dialog title={t(lang, 'sign.paper.title')} onClose={onClose}>
        <PaperSteps base={base} ps={ps} sender={sender} lang={lang} onSent={onSent} />
      </Dialog>
    );
  return (
    <Dialog title={t(lang, 'sign.paper.title')} onClose={onClose}>
      <p>{t(lang, 'sign.paper.choose')}</p>
      <div className="stack" role="group" aria-label={t(lang, 'sign.paper.choose')}>
        <button type="button" className="btn lg" style={{ minHeight: 44, justifyContent: 'flex-start', textAlign: 'left' }} onClick={() => setPick('print')} aria-describedby="sg-paper-print-hint">{t(lang, 'sign.paper.print_photo')}</button>
        <span className="muted small" id="sg-paper-print-hint">{t(lang, 'sign.paper.print_photo_hint')}</span>
        <button type="button" className="btn lg" style={{ minHeight: 44, justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => setPick('post')}>{t(lang, 'sign.paper.by_post', { sender: sender.name })}</button>
      </div>
      <div className="actions"><button type="button" className="btn" onClick={onClose}>{t(lang, 'sign.paper.back')}</button></div>
    </Dialog>
  );
}

/** The person's own screen while their scan waits, or when the sender asked them to sign on paper only. */
export function PaperScreen({ kind, base, ps, sender, email, subject, lang, onSent }: { kind: 'waiting' | 'only'; base: string; ps: PaperSign; sender: { name: string }; email?: string | null; subject?: string; lang: string; onSent: () => void }) {
  if (kind === 'waiting')
    return (
      <StateCard tone="wait" title={t(lang, 'sign.paper.waiting_title', { sender: sender.name })}>
        <p>{t(lang, 'sign.paper.waiting_body', { pages: pagesWords(lang, ps.pages), when: fmtDate(ps.sent_at || '', true), sender: sender.name })}</p>
        {email && ps.mail !== false ? <p className="muted" style={{ overflowWrap: 'anywhere' }}>{t(lang, 'sign.paper.waiting_mail', { email })}</p> : <p className="muted">{t(lang, 'sign.paper.waiting_nomail')}</p>}
      </StateCard>
    );
  return (
    <div className="card sg-state" data-feature="ds-paper">
      <h1 className="serif" id="sg-h1" tabIndex={-1}>{t(lang, 'sign.paper.only_title', { sender: sender.name, doc: subject || 'this document' })}</h1>
      <p>{t(lang, 'sign.paper.only_lead')}</p>
      <PaperSteps base={base} ps={ps} sender={sender} lang={lang} onSent={onSent} />
    </div>
  );
}

/**
 * On the consent and signing screens, where the person lands from the email: the sender asked for the photos again,
 * with their reason, and one button that opens the steps (or, with paper switched off since, that they sign on
 * screen). In place, not a popup. Nothing when they were not asked again.
 */
export function PaperAskedNote({ ps, sender, lang, onOpen }: { ps: PaperSign | null | undefined; sender: { name: string }; lang: string; onOpen: () => void }) {
  if (ps?.state !== 'asked_again') return null;
  return (
    <div className="notice warn sg-top" role="note" data-feature="ds-paper">
      <b>{ps.off ? t(lang, 'sign.paper.asked_off', { sender: sender.name }) : t(lang, 'sign.paper.asked_note', { sender: sender.name })}</b>
      {ps.reason && <p className="sg-quote" style={{ margin: '6px 0 0', overflowWrap: 'anywhere' }}><span className="muted small">{t(lang, 'sign.paper.their_reason')}:</span> {ps.reason}</p>}
      {!ps.off && <p style={{ margin: '8px 0 0' }}><button type="button" className="btn" style={{ minHeight: 44 }} onClick={onOpen}>{t(lang, 'sign.paper.send_again')}</button></p>}
    </div>
  );
}
