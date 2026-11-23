'use client';
import { useEffect, useState } from 'react';
import { api } from '../ui';
import { useMe } from '../AppShell';
import { PrintNotice, type PrintProblem } from '../sender/PrintNotice';

// The check before sending for text the signed PDF cannot print: names, the subject, document names and the
// sender's own wording in fields, as they stand on screen. The server answers which of them hold a character none
// of its fonts has. It is a warning: nothing stops the envelope from going out.
export function PrintCheck({ subject, docs, rcps, fields }: { subject: string; docs: { name: string }[]; rcps: { id: string; name: string }[]; fields: any[] }) {
  const me = useMe();
  const [problems, setProblems] = useState<PrintProblem[]>([]);
  const names = new Map(rcps.map((r) => [r.id, r.name]));
  const texts = [
    { where: 'The subject', text: subject },
    { where: 'Your own name', text: me.user.name },
    ...docs.map((d) => ({ where: `The name of the document "${d.name}"`, text: d.name })),
    ...rcps.map((r) => ({ where: `The name ${r.name}`, text: r.name })),
    ...fields.filter((f) => f.value && ['text', 'number', 'date', 'company', 'title', 'note', 'dropdown'].includes(f.type))
      .map((f) => ({ where: `${f.label ? `"${f.label}"` : f.type === 'note' ? 'Your text' : f.type === 'text' ? 'A fill in field' : `A ${f.type} field`} on page ${f.page + 1}${f.recipient_id && names.get(f.recipient_id) ? `, in the part for ${names.get(f.recipient_id)}` : ''}`, text: String(f.value) })),
    // Only what is not plain ASCII can be a problem, so most envelopes never ask the server at all.
  ].filter((t) => /[^ -~\n]/.test(t.text || ''));
  const key = JSON.stringify(texts);
  useEffect(() => {
    if (!texts.length) return setProblems([]);
    let on = true;
    api('/print-check', { body: { texts } }).then((r) => on && setProblems(r.problems || [])).catch(() => {});
    return () => {
      on = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <PrintNotice problems={problems} />;
}
