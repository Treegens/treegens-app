'use client';
import { convertNotes, type Converted } from '@/lib/convert';

// What is said next to a document that was made from a Word file or the like (src/lib/convert.ts): that the PDF is
// what people sign and every page wants a look, and what in the file the PDF may show differently. The server keeps
// it with the file, so it is said again whenever the draft or template is opened.
export function ConvertNotes({ d, compact }: { d: { name?: string; converted?: Converted | null }; compact?: boolean }) {
  const lines = convertNotes(d.converted);
  if (!lines.length) return null;
  return (
    <div className="notice warn small" role="note" aria-label={`About ${d.name || 'this document'}: it was turned into a PDF`} style={{ margin: compact ? '0 0 8px' : '6px 0 0' }}>
      <p style={{ margin: 0 }}><b>{lines[0]}</b></p>
      {lines.length > 1 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{lines.slice(1).map((l) => <li key={l}>{l}</li>)}</ul>}
    </div>
  );
}
