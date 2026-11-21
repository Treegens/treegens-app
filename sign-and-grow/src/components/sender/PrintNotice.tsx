'use client';
import { CANNOT_PRINT_HEAD, CANNOT_PRINT_THEN, cannotPrintAdvice, shownChars } from '@/lib/scripts';

export type PrintProblem = { where: string; chars: string };

// Said to the sender wherever a name or wording holds a character the signed PDF has no font for: on the envelope
// page and in the editor before sending. The server makes the check, because it holds the fonts. The words are in
// src/lib/scripts.ts, the same ones the signer reads before finishing.
export function PrintNotice({ problems }: { problems: PrintProblem[] }) {
  if (!problems.length) return null;
  return (
    <div className="notice warn sn-print" role="status">
      <b>{CANNOT_PRINT_HEAD}</b>
      <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
        {problems.slice(0, 8).map((p, i) => <li key={i} style={{ overflowWrap: 'anywhere' }}>{p.where}: <bdi>{shownChars(p.chars)}</bdi></li>)}
        {problems.length > 8 && <li>And {problems.length - 8} more places.</li>}
      </ul>
      {CANNOT_PRINT_THEN} {cannotPrintAdvice}
    </div>
  );
}
