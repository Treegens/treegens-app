'use client';
// The signing page: "Summary (written by AI, check it)", one link above the document, only when the sender switched a
// plain summary on for this document (GET /api/sign/:token says ai_summary). Closed at the start; opening it asks for
// the summary (POST /api/sign/:token/summary), which is written once per file and shown in a panel above the
// document with its warning. Close and Escape put the focus back on the link, so nobody loses their place. It never replaces the document and never changes what is signed.
import { useRef, useState } from 'react';
import { SUMMARY_LINK, SUMMARY_WARNING, SUMMARY_DOWN } from '@/lib/aiassist';

type Doc = { id: string; name: string; text: string | null; none?: boolean };

export function SummaryLink({ base, offered, many }: { base: string; offered: boolean; many: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<{ warning: string; documents: Doc[]; note?: string } | null>(null);
  const [err, setErr] = useState('');
  const link = useRef<HTMLButtonElement>(null);
  if (!offered) return null;
  const close = () => {
    setOpen(false);
    link.current?.focus();
  };
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || d || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await fetch(`/api${base}/summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setErr(j?.error || SUMMARY_DOWN);
      else setD(j);
    } catch {
      setErr(SUMMARY_DOWN);
    }
    setBusy(false);
  };
  return (
    <div className="sg-summary" data-feature="ds-ai-assist" onKeyDown={(e) => {
      if (open && e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    }}>
      <button ref={link} type="button" className="sg-link" style={{ minHeight: 44 }} aria-expanded={open} aria-controls="sg-summary-panel" onClick={toggle}>{SUMMARY_LINK}</button>
      {open && (
        <aside id="sg-summary-panel" className="card sg-summary-panel" aria-label="Summary">
          <p className="small" style={{ margin: '0 0 8px' }}><b>{d?.warning || SUMMARY_WARNING}</b></p>
          {busy && <p className="muted small" role="status">Writing the summary. This can take a few seconds.</p>}
          {err && <p className="small" role="status">{err}</p>}
          {d?.documents.map((x) => (
            <div key={x.id}>
              {many && <h3 style={{ fontSize: 15, margin: '8px 0 4px' }}>{x.name}</h3>}
              {x.text ? <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{x.text}</div>
                : <p className="muted small">{x.none ? 'This file has no text we could summarise. Read the document itself.' : SUMMARY_DOWN}</p>}
            </div>
          ))}
          <button type="button" className="btn sm" style={{ minHeight: 44, marginTop: 10 }} onClick={close}>Close the summary</button>
        </aside>
      )}
    </div>
  );
}
