'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { pageTexts, textNear, type PageText } from './pdfText';
import { OCR_WARNING } from '@/lib/a11y';
import { EasyPage } from './EasyReading';
import type { RField } from './reflow';
import { useT } from './lang';

// What a machine read from the pages of a document that are pictures (GET /sign/:token/ocr, src/server/ocr.ts).
type Ocr = { state: string; pages: Record<number, string> };

// The document as plain text, page by page, with this signer's fields for each page as an ordinary form.
// It is the same document and the same answers as the visual view, just readable by a screen reader or at any size.

function DocText({ doc, url, showName, fields, others, senderName, onAsk, onShown, ocr, mine, onSee }: {
  ocr?: Ocr;
  mine?: (page: number) => RField[];
  onSee?: (page: number, y: number, part: number) => void;
  doc: any; url: string; showName: boolean; fields: (page: number, near: (f: any) => string, ids?: string[]) => ReactNode; others: (page: number, near: (f: any) => string) => ReactNode; senderName: string; onAsk?: () => void; onShown?: (doc: any) => void;
}) {
  const T = useT();
  const [pages, setPages] = useState<PageText[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    // A new address is a new file (the sender replaced it): the words of the old one must not stay on the screen
    // while the new ones are read. The parent is told once the words of this file are there.
    setPages(null);
    pageTexts(url).then((p) => live && (setPages(p), onShown?.(doc))).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [url, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fields still work even when the words cannot be read, so the page count falls back to what the server told us.
  const count = pages?.length || doc.pages || 1;
  return (
    <section className="card sg-text" aria-label={`${doc.name}, as text`}>
      {showName && <h2 className="sg-text-doc">{doc.name}</h2>}
      {failed && (
        <div className="notice warn sg-problem" role="alert">
          We could not read the words of this document. <button type="button" className="sg-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button>, or use Download to open the PDF itself.
        </div>
      )}
      {!pages && !failed && <p className="muted" role="status">Reading the document</p>}
      {Array.from({ length: count }, (_, i) => {
        const blocks = pages?.[i]?.blocks;
        const form = fields(i, (f) => textNear(pages?.[i], f));
        // `near` names the printed line a mark sits on, so a line the sender struck out can be said in words.
        const filledByOthers = others(i, (f) => textNear(pages?.[i], f));
        return (
          <section key={i} className="sg-text-page" aria-labelledby={`sg-p-${doc.id}-${i}`}>
            <h3 id={`sg-p-${doc.id}-${i}`}>Page {i + 1} of {count}</h3>
            {/* Words in the file that the page does not show (white or covered text) are left out here (sign/visible.ts). */}
            {!!pages?.[i]?.hidden && <p className="notice warn">{T('sign.read.hidden', { sender: senderName })}</p>}
            {/* A page with no text of its own whose text a machine read: that text, always after the warning, never
                instead of the page, which stays what is signed. */}
            {blocks && blocks.length === 0 && ocr?.pages[i + 1] && (
              <div className="sg-ocr">
                <p className="notice warn">{OCR_WARNING}</p>
                {ocr.pages[i + 1].split(/\n{2,}/).map((t, j) => <p key={j} dir="auto">{t}</p>)}
              </div>
            )}
            {blocks && blocks.length === 0 && !ocr?.pages[i + 1] && (
              <p className="notice warn">
                This page has no text we can read out. It may be a scan or a picture. You can download the PDF, or
                {onAsk ? <> <button type="button" className="sg-link" onClick={onAsk}>ask {senderName} for a readable copy</button>.</> : <> ask {senderName} for a readable copy.</>}
                {(ocr?.state === 'queued' || ocr?.state === 'running') && ' Its text is being read by a machine now: reload this page in a few minutes to see it here.'}
              </p>
            )}
            {/* Easy reading: the text put back together, with this person's fields where they sit (EasyReading.tsx). */}
            {mine && pages?.[i]?.flow?.blocks.length ? (
              <EasyPage docId={doc.id} page={i} flow={pages[i].flow} mine={mine(i)} onSee={onSee && ((y, part) => onSee(i, y, part))} fields={(ids) => fields(i, (f) => textNear(pages?.[i], f), ids)} />
            ) : blocks?.map((b, j) => (b.kind === 'heading' ? <h4 key={j}>{b.text}</h4> : <p key={j}>{b.text}</p>))}
            {filledByOthers}
            {!(mine && pages?.[i]?.flow?.blocks.length) && form}
          </section>
        );
      })}
    </section>
  );
}

export function TextView({ documents, urlFor, fields, others, senderName, onAsk, onShown, ocrUrl, mine, onSee }: {
  /** This person's fields on one page, with where they sit: with it, each page is laid out for Easy reading. */
  mine?: (docId: string, page: number) => RField[];
  /** "See this on the page": opens the page view at this spot of this page. */
  onSee?: (docId: string, page: number, y: number, part: number) => void;
  /** Where the text a machine read from pictures of pages is asked for (it answers an empty list when there is none). */
  ocrUrl?: string;
  /** Called with a document once the words of its file, as it is now, have been read and are on the screen. */
  onShown?: (doc: any) => void;
  documents: any[];
  urlFor: (docId: string) => string;
  fields: (docId: string, page: number, near: (f: any) => string, ids?: string[]) => ReactNode;
  others: (docId: string, page: number, near: (f: any) => string) => ReactNode;
  senderName: string;
  onAsk?: () => void;
}) {
  const [ocr, setOcr] = useState<Record<string, Ocr>>({});
  useEffect(() => {
    if (!ocrUrl) return;
    let live = true;
    fetch(ocrUrl, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setOcr(Object.fromEntries((d.documents || []).map((x: any) => [x.id, { state: x.state, pages: Object.fromEntries((x.pages || []).map((p: any) => [p.page, String(p.text || '')])) }]))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ocrUrl]);
  const T = useT();
  return (
    <div className="stack">
      {/* Said once, above the document: what is signed is the pages, never this view of them. */}
      {mine && <p className="notice sg-flow-banner" id="sg-flow-banner" tabIndex={-1}>{T('sign.read.banner')}</p>}
      {documents.map((d) => (
        <DocText key={d.id} doc={d} url={urlFor(d.id)} showName={documents.length > 1} fields={(p, near, ids) => fields(d.id, p, near, ids)} others={(p, near) => others(d.id, p, near)} senderName={senderName} onAsk={onAsk} onShown={onShown} ocr={ocr[d.id]}
          mine={mine && ((p) => mine(d.id, p))} onSee={onSee && ((p, y, part) => onSee(d.id, p, y, part))} />
      ))}
    </div>
  );
}
