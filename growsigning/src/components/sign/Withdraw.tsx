'use client';
// Other actions, "Sign on paper instead" (research/ux-notes.json, ds-consent-own and ds-paper, merged): for now one
// choice, "Ask <sender> to send it by post", which stops signing electronically. The dialog is the plain confirmation:
// it says what happens, and one button does it. The person's part then closes like a decline, with a reason the
// software writes, and the sender is emailed (askForPaper in src/server/disclosure.ts). There is no second step.
//
// The entry is in Other actions only when the account has its own consent text (the text says how to get paper, so
// asking for it here is what that text offers). Printing it and sending a photo comes with the paper batch.
import { useState } from 'react';
import { api } from '@/components/ui';
import { Dialog } from './Dialog';
import { t } from '@/lib/i18n';

export function PaperDialog({ base, sender, lang, note, onClose, onDone }: { base: string; sender: { name: string }; lang: string; note?: string; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/decline/paper`, { body: {} });
      onDone();
    } catch (e: any) {
      // A second tap, or a document that closed meanwhile: the page then shows how it stands now.
      if (e?.status === 409) return onDone();
      setError(`${e?.message || 'Something went wrong on our side.'} ${t(lang, 'sign.paper.failed')}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t(lang, 'sign.paper.title')} onClose={onClose}>
      {/* A group's document closes for the whole group: the same note as Decline gives (GroupNotice.tsx). */}
      {note && <div className="notice warn" role="note">{note}</div>}
      <p>{t(lang, 'sign.paper.lead', { sender: sender.name })}</p>
      <p className="muted">{t(lang, 'sign.paper.stops', { sender: sender.name })}</p>
      {error && <div className="notice err sg-problem" role="alert">{error}</div>}
      <div className="actions sg-paper-actions">
        <button type="button" className="btn" onClick={onClose}>{t(lang, 'sign.paper.back')}</button>
        <button type="button" className="btn sg-danger sg-paper-go" disabled={busy} onClick={() => void ask()}>
          {busy ? t(lang, 'sign.paper.busy') : t(lang, 'sign.paper.by_post', { sender: sender.name })}
        </button>
      </div>
    </Dialog>
  );
}
