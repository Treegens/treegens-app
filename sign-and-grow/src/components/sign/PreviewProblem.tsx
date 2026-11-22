'use client';
// A preview link that did not open (src/server/preview.ts): it ended, it is not this browser's, or the document
// closed. Said in the server's words, with no offer to sign anything, because this was never a signing link.
import { Shell, StateCard } from './parts';
import { previewT, LeavePreview } from './PreviewBand';

export function PreviewProblem({ message }: { message: string }) {
  return (
    <Shell>
      <StateCard tone="stop" title={previewT('preview.problem.title')}>
        <p>{message}</p>
        {/* Close only where the browser lets a page close its tab; elsewhere a link to the documents (LeavePreview). */}
        <LeavePreview closeKey="preview.problem.close" />
      </StateCard>
    </Shell>
  );
}
