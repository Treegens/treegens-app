'use client';
// Key dates (sidebar More, only when the account switched it on): completed documents with the dates and amounts
// the AI found and the sender checked, the nearest date first (GET /api/key-dates, src/server/airepo.ts). One filter,
// "With a date in the next N days" (end, notice or renewal), a calendar file of the checked dates once there is one,
// and Remind me on each document.
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, useLoad } from '@/components/ui';
import { KEY_DATES, REMIND_ME, REMIND_DAYS_DEFAULT, REMIND_KINDS, WITHIN_CHOICES, NOT_LEGAL, termSentence, dayWords, autoLine } from '@/lib/keydates';

export default function KeyDatesPage() {
  return <Suspense fallback={<div className="muted" role="status">Loading…</div>}><KeyDatesList /></Suspense>;
}

function KeyDatesList() {
  const params = useSearchParams();
  const router = useRouter();
  const within = params.get('within') || '';
  const [d, reload, err] = useLoad<any>(() => api(`/key-dates${within ? `?within=${encodeURIComponent(within)}` : ''}`), [within]);
  const [said, setSaid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  async function remind(id: string) {
    setBusy(id);
    try {
      await api(`/envelopes/${id}/key-dates-reminder`, { method: 'PUT', body: { days: REMIND_DAYS_DEFAULT } });
      setSaid({ ...said, [id]: `Saved. We email you ${REMIND_DAYS_DEFAULT} days before. Change the days on the document's page.` });
      reload();
    } catch (e: any) {
      setSaid({ ...said, [id]: e?.status ? e.message : 'That did not reach GrowSigning. Check your connection and try again.' });
    } finally {
      setBusy('');
    }
  }
  if (err && !d) return (
    <div className="stack" data-feature="ds-ai-repo">
      <h1 className="serif">{KEY_DATES}</h1>
      <div className="notice err" role="alert">{err?.message || 'Key dates could not be loaded. Reload the page to try again.'}</div>
    </div>
  );
  if (!d) return <div className="muted" role="status">Loading…</div>;
  const docs: any[] = d.documents || [];
  return (
    <div className="stack" data-feature="ds-ai-repo">
      <div className="pagehead row between wrap" style={{ marginBottom: 0, gap: 8 }}>
        <h1 className="serif">{KEY_DATES}</h1>
        {d.calendar && <a className="btn sm" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href="/api/key-dates/calendar.ics" download>Download a calendar file</a>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>{NOT_LEGAL}</p>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <label htmlFor="kd-within" className="small">Show</label>
        <select id="kd-within" value={within} style={{ minHeight: 44 }} onChange={(ev) => router.replace(ev.target.value ? `/app/key-dates?within=${ev.target.value}` : '/app/key-dates', { scroll: false })}>
          <option value="">All documents with key dates</option>
          {WITHIN_CHOICES.map((n) => <option key={n} value={n}>With a date in the next {n} days</option>)}
        </select>
      </div>
      {d.waiting > 0 && d.setting?.auto && <p className="muted small" role="status" style={{ margin: 0 }}>{d.waiting} completed document{d.waiting === 1 ? ' is' : 's are'} waiting to be read. The AI reads a few at a time.</p>}
      {docs.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>{within ? `No document with a checked end, notice or renewal date in the next ${within} days.` : 'No key dates yet.'}</p>
          {!within && <p className="muted small" style={{ marginBottom: 0 }}>{autoLine(!!d.setting?.auto, !!d.setting?.older)}</p>}
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack">
          {docs.map((x) => {
            const checked = x.terms.filter((t: any) => t.status === 'confirmed');
            const canRemind = checked.some((t: any) => REMIND_KINDS.includes(t.kind) && t.day);
            const name = x.subject || 'Untitled';
            return (
              <li key={x.id} className="card" data-item="">
                <Link href={`/app/envelopes/${x.id}`}><b>{name}</b></Link>
                <div className="small">
                  {x.coming?.length ? x.coming.map((t: any) => termSentence(t.kind, t.day)).join('. ') : x.next ? termSentence(x.next.kind, x.next.day) : checked.length ? checked.map((t: any) => termSentence(t.kind, t.value)).slice(0, 2).join('. ') : 'No checked dates yet.'}
                </div>
                {x.to_check > 0 && <div className="small muted">{x.to_check} found by AI, still to check. <Link href={`/app/envelopes/${x.id}`}>Check {x.to_check === 1 ? 'it' : 'them'}</Link></div>}
                <div className="muted small">Completed {x.completed_at ? dayWords(String(x.completed_at).slice(0, 10)) : ''}{x.sender ? ` · sent by ${x.sender}` : ''}</div>
                {said[x.id] ? <p className="small" role="status" style={{ marginBottom: 0 }}>{said[x.id]}</p>
                  : x.reminder ? <div className="small muted">We email you {x.reminder.days} day{x.reminder.days === 1 ? '' : 's'} before.</div>
                  : canRemind && <button type="button" className="btn sm" style={{ minHeight: 44, marginTop: 6 }} disabled={busy === x.id} onClick={() => void remind(x.id)} aria-label={`${REMIND_ME} about ${name}`}>{REMIND_ME}</button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
