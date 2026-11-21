'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { pageTexts, textNear, type PageText } from './pdfText';

// The document as plain text, page by page, with this signer's fields for each page as an ordinary form.
// It is the same document and the same answers as the visual view, just readable by a screen reader or at any size.

function DocText({ doc, url, showName, fields, others, senderName, onAsk, onShown }: {
  doc: any; url: string; showName: boolean; fields: (page: number, near: (f: any) => string) => ReactNode; others: (page: number, near: (f: any) => string) => ReactNode; senderName: string; onAsk?: () => void; onShown?: (doc: any) => void;
}) {
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
            {blocks && blocks.length === 0 && (
              <p className="notice warn">
                This page has no text we can read out. It may be a scan or a picture. You can download the PDF, or
                {onAsk ? <> <button type="button" className="sg-link" onClick={onAsk}>ask {senderName} for a readable copy</button>.</> : <> ask {senderName} for a readable copy.</>}
              </p>
            )}
            {blocks?.map((b, j) => (b.kind === 'heading' ? <h4 key={j}>{b.text}</h4> : <p key={j}>{b.text}</p>))}
            {filledByOthers}
            {form}
          </section>
        );
      })}
    </section>
  );
}

export function TextView({ documents, urlFor, fields, others, senderName, onAsk, onShown }: {
  /** Called with a document once the words of its file, as it is now, have been read and are on the screen. */
  onShown?: (doc: any) => void;
  documents: any[];
  urlFor: (docId: string) => string;
  fields: (docId: string, page: number, near: (f: any) => string) => ReactNode;
  others: (docId: string, page: number, near: (f: any) => string) => ReactNode;
  senderName: string;
  onAsk?: () => void;
}) {
  return (
    <div className="stack">
      {documents.map((d) => (
        <DocText key={d.id} doc={d} url={urlFor(d.id)} showName={documents.length > 1} fields={(p, near) => fields(d.id, p, near)} others={(p, near) => others(d.id, p, near)} senderName={senderName} onAsk={onAsk} onShown={onShown} />
      ))}
    </div>
  );
}
