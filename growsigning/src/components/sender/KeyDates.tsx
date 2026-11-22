'use client';
// The page of a completed document: its key dates, folded and closed until asked for (src/server/airepo.ts, GET
// /api/envelopes/{id}/key-dates). Only when Key dates is on for the account. A date or amount the AI found says so,
// with its page and the words it came from, and is used only once the sender confirms or corrects it. This fold is
// the one place on the page for them: the page leaves the checked ones out of Details (onDetails gives their names),
// so the same date is never shown twice. "Remind me" appears once there is a checked end, notice or renewal date.
import { useEffect, useState } from 'react';
import { api } from '@/components/ui';
import { Fold } from './More';
import {
  KEY_DATES, FIND_BUTTON, REMIND_ME, CHECKED, NOT_LEGAL, TERM_KINDS, TERM_NAMES, DATE_KINDS, REMIND_KINDS, REMIND_DAYS_DEFAULT, REMIND_DAYS_MAX,
  foundLine, termSentence, usedLine, type TermKind,
} from '@/lib/keydates';

const TALL = { minHeight: 44 };

export function KeyDates({ envelope: e, on, onChanged, onDetails }: { envelope: any; on: boolean; onChanged?: () => void; onDetails?: (names: string[]) => void }) {
  const shown = on && e.kind === 'envelope' && e.status === 'completed' && !e.purged_at;
  const [d, setD0] = useState<any>(null);
  const [error, setError] = useState('');
  const setD = (r: any) => {
    setD0(r);
    onDetails?.((r?.terms || []).map((t: any) => t.detail).filter(Boolean));
  };
  // Loaded with the page (closed fold or not), so Details can leave the checked dates to this fold from the start.
  useEffect(() => {
    if (!shown) return;
    api(`/envelopes/${e.id}/key-dates`).then(setD).catch((err) => setError(err?.status ? err.message : 'The key dates could not be loaded. Reload the page to try again.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id, shown]);
  if (!shown) return null;
  return (
    <div data-feature="ds-ai-repo">
      <Fold title={KEY_DATES}>
        <KeyDatesInside id={e.id} d={d} setD={setD} loadError={error} onChanged={onChanged} />
      </Fold>
    </div>
  );
}

function KeyDatesInside({ id, d, setD, loadError, onChanged }: { id: string; d: any; setD: (r: any) => void; loadError: string; onChanged?: () => void }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<TermKind>('end');
  const [days, setDays] = useState(String(REMIND_DAYS_DEFAULT));
  async function act(what: string, path: string, method: string, body?: any, done?: string) {
    setBusy(what);
    setError('');
    setSaid('');
    try {
      const r = await api(path, { method, body });
      setD(r);
      setEditing(null);
      setAdding(false);
      if (r.message) setSaid(r.message);
      else if (done) setSaid(done);
      onChanged?.();
    } catch (err: any) {
      setError(err?.status ? err.message : 'That did not reach GrowSigning. Check your connection and try again.');
    } finally {
      setBusy('');
    }
  }
  if (!d) return loadError ? <p className="notice err" role="alert">{loadError}</p> : <p className="muted small" role="status">Loading…</p>;
  const terms: any[] = d.terms || [];
  const confirmed = terms.filter((t) => t.status === 'confirmed');
  const remindable = confirmed.some((t) => REMIND_KINDS.includes(t.kind) && t.day);
  const inputFor = (k: TermKind, label: string, idFor: string) => DATE_KINDS.includes(k)
    ? <input id={idFor} type="date" value={typed} onChange={(ev) => setTyped(ev.target.value)} style={TALL} aria-label={label} />
    : <input id={idFor} type="text" value={typed} maxLength={100} onChange={(ev) => setTyped(ev.target.value)} style={TALL} aria-label={label} />;
  return (
    <div className="kd">
      <p className="muted small" style={{ marginTop: 0 }}>{d.note || NOT_LEGAL}</p>
      {terms.length > 0 && (
        <ul className="kd-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {terms.map((t) => (
            <li key={t.id} data-item="" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <div><b>{termSentence(t.kind, t.value)}</b></div>
              <div className="muted small">
                {t.status === 'confirmed' ? `${CHECKED}${t.corrected ? ', corrected' : ''}.` : foundLine(t.page)}
                {t.quote && <span style={{ display: 'block' }}>&ldquo;{t.quote}&rdquo;</span>}
              </div>
              {editing === t.id ? (
                <form className="row wrap" style={{ gap: 8, marginTop: 6 }} onSubmit={(ev) => (ev.preventDefault(), void act(t.id, `/envelopes/${id}/key-dates/${t.id}`, 'PUT', { value: typed }, usedLine(t.kind, 'Saved')))}>
                  {inputFor(t.kind, `Correct ${TERM_NAMES[t.kind as TermKind].toLowerCase()}`, `kd-fix-${t.id}`)}
                  <button type="submit" className="btn sm" style={TALL} disabled={!!busy || !typed.trim()}>Save</button>
                  <button type="button" className="btn sm" style={TALL} onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
                  {t.status !== 'confirmed' && <button type="button" className="btn sm" style={TALL} disabled={!!busy} onClick={() => void act(t.id, `/envelopes/${id}/key-dates/${t.id}`, 'PUT', {}, usedLine(t.kind, 'Confirmed'))} aria-label={`Confirm: ${termSentence(t.kind, t.value)}`}>Confirm</button>}
                  <button type="button" className="btn sm" style={TALL} disabled={!!busy} onClick={() => (setEditing(t.id), setTyped(t.value))} aria-label={`Correct: ${termSentence(t.kind, t.value)}`}>Correct</button>
                  <button type="button" className="btn sm" style={TALL} disabled={!!busy} onClick={() => void act(t.id, `/envelopes/${id}/key-dates/${t.id}`, 'DELETE', undefined, 'Removed.')} aria-label={`Remove: ${termSentence(t.kind, t.value)}`}>Remove</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {said && <p className="small" role="status" style={{ color: 'var(--green)' }}>{said}</p>}
      {error && <p className="notice err" role="alert">{error}</p>}
      {remindable && (
        d.reminder ? (
          <p className="small">
            We email you {d.reminder.days} day{d.reminder.days === 1 ? '' : 's'} before each checked end, notice and renewal date.{' '}
            <button type="button" className="btn sm" style={TALL} disabled={!!busy} onClick={() => void act('remind', `/envelopes/${id}/key-dates-reminder`, 'PUT', { days: null }, 'Reminders stopped.')}>Stop reminders</button>
          </p>
        ) : (
          <form className="row wrap" style={{ gap: 8, alignItems: 'center', marginTop: 10 }} onSubmit={(ev) => (ev.preventDefault(), void act('remind', `/envelopes/${id}/key-dates-reminder`, 'PUT', { days: Number(days) }, 'Saved. We will email you.'))}>
            <label htmlFor="kd-days" className="small">Email me</label>
            <input id="kd-days" type="number" inputMode="numeric" min={1} max={REMIND_DAYS_MAX} value={days} onChange={(ev) => setDays(ev.target.value)} style={{ ...TALL, width: 80 }} />
            <span className="small">days before</span>
            <button type="submit" className="btn sm" style={TALL} disabled={!!busy}>{REMIND_ME}</button>
          </form>
        )
      )}
      {adding ? (
        <form className="row wrap" style={{ gap: 8, marginTop: 10 }} onSubmit={(ev) => (ev.preventDefault(), void act('add', `/envelopes/${id}/key-dates`, 'POST', { kind, value: typed }, usedLine(kind, 'Added')))}>
          <label htmlFor="kd-kind" className="sr-only">What it is</label>
          <select id="kd-kind" value={kind} onChange={(ev) => (setKind(ev.target.value as TermKind), setTyped(''))} style={TALL}>
            {TERM_KINDS.map((k) => <option key={k} value={k}>{TERM_NAMES[k]}</option>)}
          </select>
          {inputFor(kind, TERM_NAMES[kind], 'kd-add-value')}
          <button type="submit" className="btn sm" style={TALL} disabled={!!busy || !typed.trim()}>Add</button>
          <button type="button" className="btn sm" style={TALL} onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          <button type="button" className="btn sm" style={TALL} disabled={!!busy} onClick={() => void act('find', `/envelopes/${id}/key-dates/find`, 'POST')}>{busy === 'find' ? 'Reading the document…' : terms.length ? 'Find them again' : FIND_BUTTON}</button>
          <button type="button" className="btn sm" style={TALL} disabled={!!busy} onClick={() => (setAdding(true), setTyped(''))}>Add a date or amount</button>
        </div>
      )}
    </div>
  );
}
