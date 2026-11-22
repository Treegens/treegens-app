'use client';
import { useState } from 'react';
import { api, toast } from '../ui';
import { useST } from '../senderLang';
import type { Ed } from './shared';

// Under a document made from photos that were cleaned before uploading (photos.ts, scan.ts): what was done, and
// "Undo cleanup", which makes the document again from the photos as they were before cleanup (POST /files/:id/undo-cleanup).
export function CleanedLine({ ed, d }: { ed: Ed; d: any }) {
  const T = useST();
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await api(`/files/${d.file_id}/undo-cleanup`, { method: 'POST' });
      ed.swapFile(d.id, r.file);
      toast(T('editor.undo_done'));
    } catch (e: any) {
      toast(e?.message || T('editor.undo_failed'), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="muted small ed-file-note" data-feature="ds-phone-app">
      {T('editor.cleaned', { count: d.cleaned_pages.length })}
      <button type="button" className="btn sm ph-undo" disabled={busy} onClick={undo} aria-label={T('editor.undo_cleanup_label', { file: d.name || 'this file' })}>{busy ? T('editor.undoing') : T('editor.undo_cleanup')}</button>
    </p>
  );
}
