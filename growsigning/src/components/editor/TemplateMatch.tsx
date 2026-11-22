'use client';
// "This looks like your template Volunteer agreement. Use it?": one line under a file just added
// to a draft, when its words are that alike one of the templates this person may use (src/server/tplmatch.ts). It is
// the file row's one note line, shared with the other notes (FileRow.tsx). Nothing happens until "Use it" is
// pressed; "Hide this" puts it away for that file for good, on this browser.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, toast } from '../ui';
import { fail } from '../sender/feedback';
import { differenceLines, matchLine, useLabel, useMeans, type TemplateMatch } from '@/lib/tplcombine';
import type { Ed } from './shared';

const asked = new Map<string, Promise<TemplateMatch | null>>();
const KEY = (fileId: string) => `gs.tplmatch.hidden.${fileId}`;
const hidden = (fileId: string) => {
  try {
    return localStorage.getItem(KEY(fileId)) === '1';
  } catch {
    return false;
  }
};

/** The match for a file of the draft, when one should be offered: a draft envelope, a file to sign with no fields yet, not put away. */
export function useTemplateMatch(ed: Ed, d: any) {
  const [m, setM] = useState<TemplateMatch | null>(null);
  const [gone, setGone] = useState(false);
  const fit = ed.env?.kind === 'envelope' && ed.env?.status === 'draft' && !ed.wording && !ed.embedded && !d.supplemental && !!d.file_id
    && !(d.is_scan && (d.scan_pages?.length ?? d.pages) >= d.pages) && !ed.fields.value.some((f: any) => f.document_id === d.id);
  useEffect(() => {
    if (!fit || hidden(d.file_id)) return;
    let on = true;
    if (!asked.has(d.file_id)) asked.set(d.file_id, api(`/files/${d.file_id}/template-match`).then((r) => r.match || null).catch(() => null));
    asked.get(d.file_id)!.then((x) => on && setM(x));
    return () => {
      on = false;
    };
  }, [fit, d.file_id]);
  const hide = () => {
    try {
      localStorage.setItem(KEY(d.file_id), '1');
    } catch {
      // Without storage it is put away until the page is opened again.
    }
    setGone(true);
  };
  return fit && m && !gone ? { m, hide, done: () => setGone(true) } : null;
}

export function TemplateMatchLine({ ed, d, m, onHide, onDone }: { ed: Ed; d: any; m: TemplateMatch; onHide: () => void; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const diff = differenceLines(m);
  async function use() {
    setBusy(true);
    try {
      if (m.locked) {
        // Its fields belong to its own documents: a new document from the template itself. This draft stays.
        await ed.flush?.().catch(() => {});
        const { envelope } = await api('/envelopes', { body: { template_id: m.template_id } });
        toast(`Started a new document from ${m.template}. The draft with your file is still in Drafts.`);
        return router.push(`/app/envelopes/${envelope.id}/edit`);
      }
      const r = await api(`/files/${d.file_id}/template-match/use`, { body: { template_id: m.template_id, document_id: d.id } });
      ed.addFromTemplate?.(r.people, r.fields);
      onDone();
      toast(`Added the people and fields of ${r.template}. Check them before you send.${r.left_out ? ` ${r.left_out} field${r.left_out === 1 ? ' was' : 's were'} on pages your file does not have, so ${r.left_out === 1 ? 'it was' : 'they were'} left out.` : ''}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notice small ed-file-note" data-feature="ds-tpl-combine" role="status">
      <span>{matchLine(m)}</span>
      <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
        <button type="button" className="btn sm" style={{ minHeight: 44 }} disabled={busy} onClick={use} aria-label={m.locked ? undefined : `Use it: template ${m.template}`}>{busy ? 'Working…' : useLabel(m)}</button>
        <button type="button" className="btn sm ghost" style={{ minHeight: 44 }} onClick={onHide} aria-label={`Hide this: suggestion for ${d.name || 'this file'}`}>Hide this</button>
      </div>
      <details data-fold className="ed-fold">
        <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>What is different</summary>
        {diff.map((l) => <p key={l} className="small" style={{ margin: '4px 0' }}>{l}</p>)}
        <p className="muted small" style={{ margin: '4px 0 0' }}>{useMeans(m)}</p>
      </details>
    </div>
  );
}
