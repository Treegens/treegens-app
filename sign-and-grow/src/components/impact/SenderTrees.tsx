'use client';
// Trees on the sender's side: the second sentence of the box at the review step, and the envelope page after
// sending. The server decides what is true of this envelope (GET /api/envelopes/:id/impact, src/server/impact.ts);
// the words are in src/lib/impactwords.ts.
import { useEffect, useRef, useState } from 'react';
import { api, useLoad } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { reviewPlus, senderWords, TREES_PER_SIGNATURE } from '@/lib/impactwords';
import { Mangroves } from './Mangroves';

/** At the review step, after "This saves 15 pages of paper from a tree.": only when every signature will be a paid one. */
export function ReviewPlus({ envelopeId, people }: { envelopeId: string; people: number }) {
  // Asked again when the number of people changes: the answer is about the draft as it is saved.
  const [d] = useLoad(() => api(`/envelopes/${envelopeId}/impact`), [envelopeId, people]);
  const line = reviewPlus(!!d?.plus);
  return line ? <> {line}</> : null;
}

/**
 * On the envelope page. While the envelope is out: what it saves and what its signatures plant. The first time an
 * account sends anything, the picture plays once above those words, in place, with a Close button.
 */
export function SenderTrees({ envelopeId, status, bare }: { envelopeId: string; status: string; bare?: boolean }) {
  const live = status === 'sent' || status === 'completed';
  const [d] = useLoad(() => (live ? api(`/envelopes/${envelopeId}/impact`) : Promise.resolve(null)), [envelopeId, status]);
  const [closed, setClosed] = useState(false);
  const [said, setSaid] = useState('');
  const small = useRef<HTMLDivElement>(null);
  const s = d?.sent;
  const first = !!s?.celebrate && !closed && !bare;
  const w = s ? senderWords(s) : null;
  useEffect(() => {
    if (!first) return;
    api(`/envelopes/${envelopeId}/impact/seen`, { method: 'POST' }).catch(() => {});
    setSaid(w?.title || '');
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"], dialog[open]') && close();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [first, envelopeId]);
  function close() {
    setClosed(true);
    setTimeout(() => small.current?.focus(), 0);
  }
  if (!s || !w) return null;
  if (first)
    return (
      <section className="card imp-first imp-wide" aria-label="Your first send">
        <div className="imp-tap" onClick={close}><Mangroves trees={s.paid > 0 ? 10 : 0} /></div>
        <div role="status" aria-live="polite">{said && <h2 className="serif" id="imp-h">{w.title}</h2>}</div>
        <p>{w.promise}</p>
        {w.saving && <p>{w.saving}</p>}
        <div className="imp-acts"><button type="button" className="btn" onClick={close}>Close</button></div>
      </section>
    );
  // After the first time: one quiet line, and only when there is something true to say about trees or paper.
  const done = status === 'completed';
  const plants = s.paid > 0 ? (done ? `Its signatures plant ${(s.paid * TREES_PER_SIGNATURE).toLocaleString('en')} mangroves with Treegens.` : w.promise) : '';
  const saving = !w.saving ? '' : done ? w.saving.replace('This saves', 'This saved') : w.saving;
  if (!saving && !plants) return null;
  // Inside a card the page already has (the one that says everyone finished): the words alone.
  if (bare) return <> {saving}{saving && plants ? ' ' : ''}{plants}</>;
  return (
    <div className="card imp-sender" ref={small} tabIndex={-1}>
      <Mark size={26} label="" />
      <div>
        <p><b>{saving}</b>{saving && plants ? ' ' : ''}{plants}</p>
        {s.planted >= 10 && <p className="small muted">{w.count}</p>}
      </div>
    </div>
  );
}
