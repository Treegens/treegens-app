'use client';
import { convertNotes, type Converted } from '@/lib/convert';
import { plural } from './shared';

// What is said over the pages of a document that was made from a Word file or the like (src/lib/convert.ts): one
// line, the most urgent, and the rest folded into "1 more note" (research/ux-notes.json, ds-convert). The server
// keeps the notes with the file, so they are said again whenever the draft or template is opened. Step 1 says the
// same under the file's row (FileRow.tsx), where its notes share one line with the other notes of that file.
export function ConvertNotes({ d }: { d: { name?: string; converted?: Converted | null } }) {
  const lines = convertNotes(d.converted);
  if (!lines.length) return null;
  return (
    <div data-feature="ds-convert" role="note" aria-label={`About ${d.name || 'this document'}: it was made from ${d.converted?.from || 'another file'}`} style={{ margin: '0 0 8px' }}>
      <p className="notice warn small" style={{ margin: 0 }}>{lines[0]}</p>
      {lines.length > 1 && (
        <details data-fold className="ed-fold">
          <summary>{plural(lines.length - 1, 'more note')}</summary>
          {lines.slice(1).map((l) => <p key={l} className="notice warn small ed-file-note">{l}</p>)}
        </details>
      )}
    </div>
  );
}
