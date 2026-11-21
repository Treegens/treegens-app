'use client';
// Terms written as text with the simple formatting of src/lib/clickwrap.ts, drawn as React elements. Nothing in the
// terms is ever read as HTML, so they cannot carry a link, a button or a script.
import { termBlocks, type Span } from '@/lib/clickwrap';

const Spans = ({ s }: { s: Span[] }) => <>{s.map((x, i) => (x.bold ? <b key={i}>{x.text}</b> : <span key={i}>{x.text}</span>))}</>;

export function ClickwrapTerms({ text }: { text: string }) {
  return (
    <>
      {termBlocks(text).map((b, i) =>
        b.kind === 'h1' ? <h2 key={i}><Spans s={b.items[0]} /></h2>
          : b.kind === 'h2' ? <h3 key={i}><Spans s={b.items[0]} /></h3>
            : b.kind === 'ul' ? <ul key={i}>{b.items.map((it, j) => <li key={j}><Spans s={it} /></li>)}</ul>
              : b.kind === 'ol' ? <ol key={i}>{b.items.map((it, j) => <li key={j}><Spans s={it} /></li>)}</ol>
                : <p key={i}><Spans s={b.items[0]} /></p>)}
    </>
  );
}
