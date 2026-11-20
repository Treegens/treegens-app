'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../ui';
import { paperWarnings, PAPER_HELP, PAPER_TAIL, STAMP_ZONES, stampNote, type PaperWarning } from '@/lib/paperwork';

// The check before sending, as the sender sees it on the review step. Some documents often need ink on paper, a
// witness, a notary or a qualified signature, depending on the country. When the subject, a document's name or a
// document's text names such a document, this says which word it saw and where, and links to the help page. It is
// a reminder: it never switches the Send button off, and it says so. The words are in src/lib/paperwork.ts.
//
// The subject and the names are read here, as they stand on screen. The text inside the files is only on the
// server, which is asked once the draft has been saved (the editor saves before it shows this step).
export function PaperCheck({ envelopeId, subject, docs, sending }: { envelopeId: string; subject: string; docs: { id: string; name: string; file_id: string }[]; sending: boolean }) {
  const [fromText, setFromText] = useState<PaperWarning[]>([]);
  const files = docs.map((d) => d.file_id).join(',');
  useEffect(() => {
    let on = true;
    api(`/envelopes/${envelopeId}/warnings`).then((r) => on && setFromText((r.warnings || []).filter((w: PaperWarning) => w.where === 'document text'))).catch(() => {});
    return () => {
      on = false;
    };
  }, [envelopeId, files]);
  const names = docs.map((d) => d.name).join('\n');
  const found = useMemo(() => {
    const here = paperWarnings({ subject, documents: docs.map((d) => ({ name: d.name })) });
    // One line for each kind of document. What stands in the subject or a name is said before what is in the text.
    return [...here, ...fromText.filter((w) => !here.some((h) => h.kind === w.kind))];
  }, [subject, names, fromText]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stamp duty is a matter of where the sender is, and the clock of their own device is the only hint there is.
  const [stamp, setStamp] = useState<'India' | 'Indonesia' | null>(null);
  useEffect(() => {
    try {
      setStamp(STAMP_ZONES[Intl.DateTimeFormat().resolvedOptions().timeZone] || null);
    } catch {
      /* a browser that will not say: no note */
    }
  }, []);

  return (
    <>
      {found.length > 0 && (
        <div className="notice warn ed-paper" role="status">
          <b>Before you send: this may need more than an electronic signature.</b>
          <ul>{found.map((w) => <li key={w.kind}>{w.found} {w.why}</li>)}</ul>
          <p>{PAPER_TAIL} <a href={PAPER_HELP} target="_blank" rel="noreferrer">What we know, country by country<span className="ab-vh"> (opens in a new tab)</span></a>.</p>
        </div>
      )}
      {stamp && sending && (
        <div className="notice ed-paper" role="note">
          <b>Stamp duty.</b> Your device&apos;s clock is set to a time zone in {stamp}, so: {stampNote(stamp).replace(/^S/, 's')} <a href={PAPER_HELP} target="_blank" rel="noreferrer">More on the help page<span className="ab-vh"> (opens in a new tab)</span></a>.
        </div>
      )}
    </>
  );
}

/** One line under the Send button, for every envelope: what kind of signature this is, and where to check. */
export const EnoughLink = () => (
  <p className="muted small ed-paper-foot">Sign&Grow makes simple electronic signatures. <a href="/help#enough" target="_blank" rel="noreferrer">Is that enough for this document?<span className="ab-vh"> (opens in a new tab)</span></a></p>
);
