'use client';
import { useState, type ReactNode } from 'react';
import { useMe } from '../AppShell';
import { scanWarning } from '@/lib/scans';
import { phoneWeight } from '@/lib/phone';
import { acceptList, convertNotes } from '@/lib/convert';
import { plural, type Ed } from './shared';
import { PageTools } from './PageTools';
import { openWriting } from './WriteDoc';
import { writtenLine } from '@/lib/writedoc';
// To read, not sign: a privacy notice or terms that go with the document (ToRead.tsx).
import { ToRead } from './ToRead';
import { ruleSummary } from '@/lib/supplements';
import { useTemplateMatch, TemplateMatchLine } from './TemplateMatch';

// One file in step 1 (research/ux-charter.md, 2.3): its name, how many pages, and one More with what is done to a
// file now and then (replace it, move it, remove it). Under the row at most one note; when more than one applies,
// the most urgent is shown and the others fold into "1 more note".
export function FileRow({ ed, d, i }: { ed: Ed; d: any; i: number }) {
  const me = useMe();
  const [more, setMore] = useState(false);
  const [pages, setPages] = useState(false);
  const name = d.name || 'this file';
  const panel = `ed-file-more-${d.id}`;
  const last = i === ed.docs.length - 1;
  const match = useTemplateMatch(ed, d);

  // Most urgent first: what is lost, then what a signer cannot read, then what is slow, then what may look different.
  const notes: ReactNode[] = [];
  // Signatures already in the uploaded PDF do not survive in the signed copy (POST /files, src/lib/seal.ts).
  if (d.existing_signatures_note) notes.push(<p key="sig" className="notice warn small ed-file-note">{d.existing_signatures_note}</p>);
  // The server keeps which pages are pictures with the file, so this is also said when a draft is opened again.
  if (scanWarning(d)) notes.push(<p key="scan" className="notice warn small ed-file-note">{scanWarning(d)}</p>);
  if (phoneWeight(d)) notes.push(<p key="phone" className="notice warn small ed-file-note">{phoneWeight(d)}</p>);
  // Made from a Word file or the like: the PDF is what is signed, and what may look different. Each sentence is a
  // note of its own, so the rule of this row holds for them too: one shows, the rest fold (src/lib/convert.ts).
  for (const line of convertNotes(d.converted)) notes.push(<p key={line} className="notice warn small ed-file-note" data-feature="ds-convert">{line}</p>);
  // To read, not sign: what each person is asked to do with it, so the choice shows with the More closed.
  if (d.supplemental) notes.push(<p key="toread" className="muted small ed-file-note" data-feature="ds-supplements">{ruleSummary(d.supplemental.rule, d.supplemental.in_copy)}</p>);
  // "This looks like your template ... Use it?" (TemplateMatch.tsx): an offer, not a warning, so after the warnings.
  if (match) notes.push(<TemplateMatchLine key="tplmatch" ed={ed} d={d} m={match.m} onHide={match.hide} onDone={match.done} />);
  // Written in the app (WriteDoc.tsx): said to the sender only, last, since it is no warning.
  if (d.written) notes.push(<p key="written" className="muted small ed-file-note" data-feature="ds-write-doc">{writtenLine(!!d.written.ai)}</p>);

  return (
    <div data-item="file">
      <div className="row ed-doc">
        <input value={d.name} aria-label="File name" maxLength={200} readOnly={!!ed.wording} onChange={(e) => ed.renameDoc(d.id, e.target.value)} />
        <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{plural(d.pages, 'page')}{d.supplemental ? <span data-feature="ds-supplements">, to read</span> : null}</span>
        {/* Remove, turn and move pages (PageTools.tsx), opened from here and closed every time the step opens. */}
        {!ed.wording && <button type="button" className="btn sm ghost" data-feature="ds-page-tools" onClick={() => setPages(true)} aria-label={`Pages of ${name}`}>Pages</button>}
        {!ed.wording && <button type="button" className="btn sm ghost" data-more="item" aria-expanded={more} aria-controls={panel} aria-label={`More options for ${name}`} onClick={() => setMore(!more)}>More</button>}
      </div>
      {more && !ed.wording && (
        <div id={panel} className="row wrap ed-file-more" role="group" aria-label={`More options for ${name}`}>
          {/* A document written here opens its text again (WriteDoc.tsx); after sending, saving it is a correction. */}
          {d.written && <button type="button" className="btn sm" data-feature="ds-write-doc" onClick={() => (setMore(false), openWriting(d.id, d.file_id))}>Edit the text</button>}
          <label className="btn sm" title="Swap in a corrected version. Your fields stay where they are.">
            Replace file
            <input type="file" className="ed-sr" accept={acceptList(!!me.converts)} aria-label={`Replace the file for ${name}`} onChange={(e) => (ed.replaceDoc(d.id, e.target.files?.[0]), (e.target.value = ''))} />
          </label>
          {ed.docs.length > 1 && <button type="button" className="btn sm" disabled={i === 0} onClick={() => ed.moveDoc(i, -1)} aria-label={`Move ${name} up`}>Move up</button>}
          {ed.docs.length > 1 && <button type="button" className="btn sm" disabled={last} onClick={() => ed.moveDoc(i, 1)} aria-label={`Move ${name} down`}>Move down</button>}
          {/* The file as it was uploaded, before it became a PDF (GET /files/:id/original). */}
          {d.converted?.from && <a className="btn sm" data-feature="ds-convert" href={`/api/files/${d.file_id}/original`} download>Download {d.converted.from}</a>}
          <button type="button" className="btn sm danger" onClick={() => ed.removeDoc(d.id)} aria-label={`Remove ${name}`}>Remove</button>
          <ToRead ed={ed} d={d} />
        </div>
      )}
      {pages && <PageTools ed={ed} d={d} onClose={() => setPages(false)} />}
      {notes[0]}
      {notes.length > 1 && (
        <details data-fold className="ed-fold">
          <summary>{plural(notes.length - 1, 'more note')}</summary>
          {notes.slice(1)}
        </details>
      )}
    </div>
  );
}
