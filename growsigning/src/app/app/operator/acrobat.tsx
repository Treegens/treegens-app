'use client';
// The "Adobe Acrobat check" card on /app/operator (GET /api/operator/acrobat-check, src/server/routes-acrobat.ts):
// what Acrobat showed the last time the program on our computer opened a sample, its screenshot, the last 10 checks
// and when the next one is due. The route answers 404 to anyone who is not an operator, and then nothing is drawn.
// The token itself is never sent to the page: only whether it is set.
import { useEffect, useRef } from 'react';
import { api, useLoad, fmtDate } from '@/components/ui';

type Check = {
  id: string; created_at: string; tsa_host: string; tsa_name: string | null; trusted: boolean; forced: boolean; reported_at: string | null;
  verdict: 'pass' | 'fail' | 'waiting' | 'missed'; banner_text: string | null; banner_colour: string | null; panel_lines: string[];
  acrobat_version: string | null; os: string | null; notes: string | null; screenshot: boolean; alerted: boolean;
};
type State = { on: boolean; seal_on?: boolean; tsa_hosts: string[]; every_days: number; next_expected_at: string | null; alarm_at: string | null; last: Check | null; checks: Check[] };

const WORDS: Record<Check['verdict'], string> = { pass: 'Passed', fail: 'Failed', waiting: 'Waiting for the result', missed: 'No result came' };

export function AcrobatCheckCard() {
  const [d] = useLoad<State | null>(() => api('/operator/acrobat-check').catch(() => null));
  const list = useRef<HTMLDetailsElement>(null);
  // The links in alert emails end in #acrobat-<check id>. The card draws only after its data loads, after the browser
  // has already looked for that spot, so it is found here: the check's line (opening the list), or else the card.
  useEffect(() => {
    if (!d || typeof location === 'undefined' || !location.hash.startsWith('#acrobat-')) return;
    let el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (el && list.current?.contains(el)) list.current.open = true;
    if (!el) el = document.getElementById('acrobat-check');
    el?.scrollIntoView({ block: 'start' });
  }, [d]);
  if (!d) return null;
  const last = d.last;
  return (
    <div className="card" id="acrobat-check" data-feature="acrobat-check">
      <h2>Adobe Acrobat check</h2>
      <div className="muted small">
        A program on our own computer opens a sample PDF with a document time stamp in Adobe Acrobat Reader and reports the bar at the top. It passes only when the bar is blue and says &quot;Signed and all signatures are valid&quot;.
        {d.on ? '' : ' ACROBAT_CHECK_TOKEN is not set on this server (or is shorter than 32 characters), so the program cannot call in.'}
        {d.seal_on ? ' Completed documents on this server also carry a server seal. This check does not cover how Acrobat shows the seal, only the time stamp.' : ''}
      </div>
      {!last && <p className="small" style={{ marginTop: 10 }}>No result yet.</p>}
      {last && (
        <div style={{ marginTop: 10 }} id={`acrobat-${last.id}`}>
          <div className="row between wrap">
            <b>{WORDS[last.verdict]}</b>
            <span className="muted small">{fmtDate(last.reported_at, true)}</span>
          </div>
          <div className="small">Bar ({last.banner_colour}): {last.banner_text || 'no words'}</div>
          <div className="small">Time stamp by {last.tsa_host}{last.trusted ? ', checked against TSA_TRUST' : ''}. Acrobat {last.acrobat_version || 'version not given'} on {last.os || 'a system not given'}.</div>
          {last.panel_lines.length > 0 && <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{last.panel_lines.join('\n')}</pre>}
          {last.notes && <div className="small">Notes: {last.notes}</div>}
          {last.screenshot && (
            <a href={`/api/operator/acrobat-check/${encodeURIComponent(last.id)}/screenshot`} target="_blank" rel="noreferrer">
              <img src={`/api/operator/acrobat-check/${encodeURIComponent(last.id)}/screenshot`} alt="What Acrobat showed for the last check" style={{ maxWidth: '100%', height: 'auto', marginTop: 8, border: '1px solid var(--line, #ddd)' }} />
            </a>
          )}
        </div>
      )}
      <p className="small" style={{ marginTop: 10 }}>
        {d.next_expected_at
          ? <>Next check expected by {fmtDate(d.next_expected_at, true)}. If none has come by {fmtDate(d.alarm_at, true)}, you are emailed.</>
          : <>No check has been made yet. One is expected {d.every_days === 1 ? 'every day' : `every ${d.every_days} days`} once the program runs.</>}
      </p>
      {d.checks.length > 0 && (
        <details ref={list}>
          <summary className="small">{d.checks.length === 1 ? 'The last check' : `The last ${d.checks.length} checks`}</summary>
          <ul className="small">
            {d.checks.map((c) => (
              <li key={c.id} id={c.id === last?.id ? undefined : `acrobat-${c.id}`}>
                {fmtDate(c.created_at, true)}: {WORDS[c.verdict]}, {c.tsa_host}{c.forced ? ' (asked for this service)' : ''}{c.banner_text ? `, "${c.banner_text}"` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
