'use client';
// Trees on the sender's side: the second sentence of the box at the review step, and the envelope page after
// sending. The server decides what is true of this envelope (GET /api/envelopes/:id/impact, src/server/impact.ts);
// the words are in src/lib/impactwords.ts.
//
// Nothing here is a card of its own. The first send ever plays its picture inside the "Sent." card at the top of
// the page (sender/AfterSend.tsx), where it is on the screen of a phone and of a desktop alike; every send says its
// paper as the last sentence of the card that says who the document is waiting on.
import { useEffect, useRef, useState } from 'react';
import { api, useLoad } from '@/components/ui';
import { plantedLine, reviewPlus, senderWords, TREES_PER_SIGNATURE } from '@/lib/impactwords';
import { Mangroves } from './Mangroves';

/** At the review step, before "This saves 15 pages of paper from a tree.": when every signature of the draft plants trees. */
export function ReviewPlus({ envelopeId, people }: { envelopeId: string; people: number }) {
  // Asked again when the number of people changes: the answer is about the draft as it is saved.
  const [d] = useLoad(() => api(`/envelopes/${envelopeId}/impact`), [envelopeId, people]);
  const line = reviewPlus(!!d?.plus);
  return line ? <><b>{line}</b>{' '}</> : null;
}

// The envelope page asks once for the two places that draw from the answer.
const asked = new Map<string, Promise<any>>();
const ask = (id: string, status: string) => {
  const key = `${id}:${status}`;
  if (!asked.has(key)) {
    asked.set(key, api(`/envelopes/${id}/impact`).catch(() => null));
    setTimeout(() => asked.delete(key), 5000);
  }
  return asked.get(key)!;
};
function useSent(envelopeId: string, status: string) {
  const live = status === 'sent' || status === 'completed';
  const [d] = useLoad(() => (live ? ask(envelopeId, status) : Promise.resolve(null)), [envelopeId, status]);
  return d?.sent || null;
}

/**
 * The heading of the "Sent." card. Every time but one it is the word "Sent." The first time an account sends
 * anything, the picture plays above it, small, and the heading says so. It starts when it is on the screen, and that
 * is when the server is told it was shown. There is nothing to close: it is part of a card that is there anyway. A
 * tap on the picture or Escape takes the picture away for someone who would rather not see it.
 */
export function SentHead({ envelopeId, id }: { envelopeId: string; id: string }) {
  const s = useSent(envelopeId, 'sent');
  const [closed, setClosed] = useState(false);
  const [go, setGo] = useState(false);
  const pic = useRef<HTMLDivElement>(null);
  const first = !!s?.celebrate;
  const w = s ? senderWords(s) : null;
  useEffect(() => {
    if (!first || !pic.current) return;
    const start = () => {
      setGo(true);
      api(`/envelopes/${envelopeId}/impact/seen`, { method: 'POST' }).catch(() => {});
    };
    if (typeof IntersectionObserver === 'undefined') return start();
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (io.disconnect(), start()), { threshold: 0.4 });
    io.observe(pic.current);
    return () => io.disconnect();
  }, [first, envelopeId]);
  useEffect(() => {
    if (!first || closed) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"], dialog[open]') && setClosed(true);
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [first, closed]);
  // `first` stays true while this page is open (the answer is not asked again), so the words stay after the picture.
  if (!first || !w) return <h2 id={id}>Sent.</h2>;
  return (
    <>
      {!closed && <div className="imp-tap imp-sentpic" ref={pic} onClick={() => setClosed(true)}><Mangroves trees={s.counted > 0 ? TREES_PER_SIGNATURE : 0} go={go} /></div>}
      {/* A heading that changes is not read out by itself: the one sentence is said once, after the region exists. */}
      <h2 id={id}>{w.title}</h2>
      <span className="imp-vh" role="status">{go ? w.title : ''}</span>
      {w.promise && <p className="imp-promise">{w.promise}</p>}
    </>
  );
}

/**
 * On the envelope page, inside a card the page already has. While the envelope is out (`line`): one short sentence
 * on the paper, and what its signatures plant when that is true. Once everyone finished: the same in the past.
 * Nothing at all when there is nothing true to say.
 */
export function SenderTrees({ envelopeId, status, line }: { envelopeId: string; status: string; line?: boolean }) {
  const s = useSent(envelopeId, status);
  if (!s) return null;
  const w = senderWords(s);
  const done = status === 'completed';
  const plants = s.counted < 1 ? '' : done ? plantedLine(Number(s.here) || 0) : w.promise;
  const paper = done ? w.saved : w.saving;
  if (!paper && !plants) return null;
  const words = `${paper}${paper && plants ? ' ' : ''}${plants}`;
  return line ? <p className="sn-now-sub" data-feature="impact">{words}</p> : <> {words}</>;
}
