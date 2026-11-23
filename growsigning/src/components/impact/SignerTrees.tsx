'use client';
// Trees on the signing page: the first thing a person reads when they open their link, one line next to Finish, and
// the finished screen. The server decides everything that is a claim (GET /api/sign/:token/impact,
// src/server/impact.ts): whether this signature plants trees, whether it is the person's first, and the counts. This file only draws, with the words of src/lib/impactwords.ts.
import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/ui';
import { Mark } from '@/components/Brand';
import { IMPACT } from '@/lib/impact';
import { finishLine, openLine, OPEN_UNDER, signerWords } from '@/lib/impactwords';
import { Mangroves } from './Mangroves';

// The toolbar and the phone's bottom bar both show the line: one question to the server for the two of them.
const asked = new Map<string, Promise<any>>();
const ask = (base: string) => {
  if (!asked.has(base)) asked.set(base, api(`${base}/impact`).catch(() => (asked.delete(base), null)));
  return asked.get(base)!;
};

/**
 * The first screen, above everything legal: a leaf, "When you sign, 5 trees are planted." and who plants them.
 * Nothing at all for someone whose signature plants none, or where tree words are switched off. `onShown` tells the
 * screen around it that words were added, so it can count its words again (ConsentTop.tsx).
 */
export function OpenTrees({ base, show, onShown }: { base: string; show: boolean; onShown?: () => void }) {
  const [trees, setTrees] = useState(0);
  useEffect(() => {
    let live = true;
    if (show) ask(base).then((d) => live && setTrees(Number(d?.finish) || 0));
    return () => void (live = false);
  }, [base, show]);
  const line = show ? openLine(trees) : '';
  useEffect(() => {
    if (line) onShown?.();
  }, [line]);
  return <OpenTreesLine trees={show ? trees : 0} />;
}

/** The same two lines for a page that already knows the number: a public form before the person has a link of their own. */
export function OpenTreesLine({ trees }: { trees: number }) {
  const line = openLine(Number(trees) || 0);
  if (!line) return null;
  return (
    <div className="sg-open-trees" data-feature="impact">
      <Mark size={30} label="" />
      <p><b>{line}</b><span>{OPEN_UNDER}</span></p>
    </div>
  );
}

/** Next to Finish: "5 trees will be planted when you finish." For everyone whose signature plants trees. */
export function TreeLine({ base, show }: { base: string; show: boolean }) {
  const [trees, setTrees] = useState(0);
  useEffect(() => {
    let live = true;
    if (show) ask(base).then((d) => live && setTrees(Number(d?.finish) || 0));
    return () => void (live = false);
  }, [base, show]);
  const line = show ? finishLine(trees) : '';
  return line ? <span className="sg-tree">{line}</span> : null;
}

const num = (v: number, d = 0) => v.toLocaleString('en', { maximumFractionDigits: d });

// Water stands behind "How we work this out", as estimates, with the link to where the numbers come from.
// It opens in a new tab: someone who has just signed is not carried off to a page with buttons to sign up.
function How({ sheets }: { sheets: number }) {
  const [open, setOpen] = useState(false);
  return (
    <details data-fold className="imp-how small" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>How we work this out</summary>
      {open && <p>An estimate: one paper copy of every page for each person on the document. Making that paper would take about {num(sheets * IMPACT.litresWaterPerSheet)} litres of water. <a href="/impact" target="_blank" rel="noreferrer">Where these numbers come from<span className="sg-vh"> (opens in a new tab)</span></a></p>}
    </details>
  );
}

/**
 * The finished screen. The first time a person signs here, the picture plays once, in place, with one big line. It
 * covers nothing, it can be closed with its button, with Escape or with a tap on the picture, and the server remembers
 * that it was shown. Every later time, and for anyone who does not sign, it is one small card.
 */
export function SignerDone({ base, impact }: { base: string; impact: any }) {
  const [d, setD] = useState<any>(undefined);
  const [closed, setClosed] = useState(false);
  const [go, setGo] = useState(false);
  const [said, setSaid] = useState('');
  const card = useRef<HTMLElement>(null);
  const small = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    asked.delete(base); // asked again after Finish: the answer is a different one now
    api(`${base}/impact`).then((r) => live && setD(r?.done || null)).catch(() => live && setD(null));
    return () => void (live = false);
  }, [base]);
  const first = !!d?.celebrate && !closed;
  // The picture starts when it is on the screen, not while it is still below the fold, and that is when the server
  // is told it was shown.
  useEffect(() => {
    if (!first || !card.current) return;
    const start = () => {
      setGo(true);
      api(`${base}/impact/seen`, { method: 'POST' }).catch(() => {});
    };
    if (typeof IntersectionObserver === 'undefined') return start();
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (io.disconnect(), start()), { threshold: 0.4 });
    io.observe(card.current);
    return () => io.disconnect();
  }, [first, base]);
  // Escape closes it, unless a dialog is open: that one is closed first.
  useEffect(() => {
    if (!first) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"], dialog[open]') && close();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  });
  const sheets = Math.round(Number(d?.sheets ?? impact?.sheets) || 0);
  const w = d ? signerWords({ trees: d.trees, first: d.first, total: d.total, sheets }) : null;
  // One sentence for a screen reader, put in after the region exists so it is read out.
  useEffect(() => {
    if (first && w) setSaid(w.title);
  }, [first, w?.announce]);
  function close() {
    setClosed(true);
    // The button that had the focus is gone: the small card that took its place has it now.
    setTimeout(() => small.current?.focus(), 0);
  }
  if (d === undefined) return null;
  if (first && w)
    return (
      <section className="card imp-first" ref={card} aria-label="Trees">
        {/* A tap on the picture closes it too. It is no keyboard stop: Close and Escape are there for that. */}
        <div className="imp-tap" onClick={close}><Mangroves trees={d.trees} go={go} /></div>
        {/* The one sentence a screen reader is told: the heading, put in once the region exists. */}
        <div role="status" aria-live="polite">{said && <h2 className="serif" id="imp-h">{w.title}</h2>}</div>
        {w.under && <p>{w.under}</p>}
        {w.count && <p>{w.count}</p>}
        {/* Nothing about plans or who pays on a screen a signer reads; "How we work this out" is on the card that
            stays after Close. */}
        <div className="imp-acts"><button type="button" className="btn" onClick={close}>Close</button></div>
      </section>
    );
  if (!sheets && !d?.trees) return null;
  // Someone who does not sign (an approver, a viewer, a copy) reads about the paper and nothing about trees.
  const line = w ? w.line : `This document saved ${num(sheets)} ${sheets === 1 ? 'page' : 'pages'} of paper from a tree.`;
  return (
    <div className="card imp-small" ref={small} tabIndex={-1}>
      <Mark size={28} label="" />
      <div>
        <b>{line}</b>
        {w?.count && <p>{w.count}</p>}
        {sheets > 0 && <How sheets={sheets} />}
      </div>
    </div>
  );
}
