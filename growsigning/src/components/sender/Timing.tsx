'use client';
import { useId, useState } from 'react';
import { api, toast } from '@/components/ui';
import { Dialog } from './Dialog';
import { explain } from './lib';
import { SEND_LATER_MAX_DAYS, SEND_LATER_MIN_MINUTES, atWordsHere, fromLocalInput, sendAtProblem, toLocalInput, waitRunning, goesOutWords } from '@/lib/timing';
export { timingRow, scheduledHome } from '@/lib/timing';

// Send later, and pause and resume, on the document page (research/ux-notes.json "ds-timing"). A draft with a time
// says when it goes out and has Send now as its main button; Change the time and Do not send at that time are in More. An
// envelope that is out has Pause in More; while paused, Resume is the main button.

/** The two lines of the draft card for a draft with a time, or null for an ordinary draft. */
export function scheduledWords(e: any): { line: string; sub: string; warn: boolean } | null {
  if (e?.kind !== 'envelope' || e.status !== 'draft' || !e.send_at) return null;
  if (e.send_error) return { line: `Not sent at ${atWordsHere(e.send_at)}: ${String(e.send_error).replace(/\s+$/, '')}`, sub: 'Nothing went out to anyone. Put that right, then press Send now, or choose Change the time in More.', warn: true };
  return { line: `Sends at ${atWordsHere(e.send_at)}.`, sub: 'Nothing has gone out yet. It goes out soon after that time, by itself. You can send it now, or change the time in More.', warn: false };
}

/** The person a wait the sender chose is holding back, and when they are asked, for the page's status sentence. */
export function waitNow(e: any): { name: string; when: string } | null {
  const w = waitRunning(e);
  return w ? { name: w.name, when: goesOutWords(w.at) } : null;
}

/** The line on the card of an envelope that is out and paused. */
export function pausedWords(e: any): string {
  if (e?.status !== 'sent' || !e.paused_at) return '';
  const day = atWordsHere(e.paused_at).replace(/^.* on /, '');
  return `Paused by ${e.paused_by || 'you'} on ${day}. No reminders go out while it is paused, and the deadline moves on by the time it is paused.`;
}

export async function sendNow(id: string) {
  await api(`/envelopes/${id}/send`, { method: 'POST', body: {} });
  toast('Sent.');
}
export async function pauseIt(id: string) {
  await api(`/envelopes/${id}/pause`, { method: 'POST' });
  toast('Paused. Nobody can sign it until you resume it.');
}
export async function resumeIt(id: string) {
  const r = await api(`/envelopes/${id}/resume`, { method: 'POST' });
  toast(r?.expires_at ? `Resumed. The deadline moved on to ${atWordsHere(r.expires_at)}, and whoever's turn it is was emailed.` : 'Resumed. Whoever\'s turn it is was emailed.');
}
export async function keepAsDraft(id: string) {
  await api(`/envelopes/${id}/send-later`, { method: 'DELETE' });
  toast('It will not go out by itself. It stays a draft, and nothing was sent.');
}

/** Change the time a draft goes out. */
export function ChangeTimeDialog({ envelope, onClose, onDone }: { envelope: any; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [value, setValue] = useState(toLocalInput(envelope.send_at && Date.parse(envelope.send_at) > Date.now() ? envelope.send_at : new Date(Date.now() + 864e5).toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const at = fromLocalInput(value);
  const problem = at ? sendAtProblem(at) : 'Pick a day and a time.';
  async function save() {
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      await api(`/envelopes/${envelope.id}/send-later`, { body: { send_at: at } });
      toast(`It goes out soon after ${atWordsHere(at)}.`);
      onDone();
    } catch (e: any) {
      setError(explain(e, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Change the time" onClose={onClose}>
      <label className="f" htmlFor={`${id}-at`}>
        <span>Day and time <span className="hint">(your time, at least {SEND_LATER_MIN_MINUTES} minutes and up to {SEND_LATER_MAX_DAYS} days ahead)</span></span>
        <input id={`${id}-at`} type="datetime-local" data-autofocus="" value={value} style={{ maxWidth: 260, minHeight: 44 }}
          min={toLocalInput(new Date(Date.now() + (SEND_LATER_MIN_MINUTES + 1) * 60_000).toISOString())} max={toLocalInput(new Date(Date.now() + SEND_LATER_MAX_DAYS * 864e5).toISOString())}
          onChange={(e) => (setValue(e.target.value), setError(''))} aria-invalid={!!error} aria-describedby={`${id}-says`} />
      </label>
      <p className="sn-preview" id={`${id}-says`} aria-live="polite">{at && !problem ? <>It goes out soon after <b>{atWordsHere(at)}</b>, by itself.</> : problem}</p>
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save the time'}</button>
      </div>
    </Dialog>
  );
}
