'use client';
// Step 3's one link, "See what each person sees" (research/ux-notes.json "ds-preview"): it saves the draft, then opens
// the signing page as the first person in a new tab, with a band that switches person and says nothing is recorded
// or sent (src/server/preview.ts). Never a link per person, never required, never a dialog inside the editor.
import { useState } from 'react';
import { api, toast } from '../ui';
import { t } from '@/lib/i18n';
import type { Ed } from './shared';

const T = (key: string) => t(typeof navigator === 'undefined' ? 'en' : navigator.language, key);

export function SeeWhatTheySee({ ed, people, changed }: { ed: Ed; people: any[]; changed: boolean }) {
  const [busy, setBusy] = useState(false);
  // On an envelope that is out, only people already saved on it can be shown: the preview reads what the server holds.
  const saved = ed.correcting ? people.filter((r) => ed.base?.recipients?.some((x: any) => x.id === r.id)) : people;
  // Signing your own document ("Sign now") opens that very page next, so there is nothing to preview.
  if (ed.embedded || ed.signNow || !ed.env?.id || !saved.length) return null;
  async function open() {
    // Opened now, while the click still counts, so no pop-up blocker stops it; it is pointed at the preview below.
    const tab = window.open('', '_blank');
    setBusy(true);
    try {
      await ed.flush?.();
      const r = await api<{ url: string }>(`/${ed.isTpl ? 'templates' : 'envelopes'}/${ed.env.id}/recipient-preview`, { body: { recipient_id: saved[0].id } });
      if (tab) tab.location.href = r.url;
      else if (!window.open(r.url, '_blank')) toast('Your browser blocked the new tab. Allow pop-ups for this site and choose See what each person sees again.', true);
    } catch (e: any) {
      tab?.close();
      toast(`The preview did not open. ${e?.status ? e.message : 'We could not reach the server. Check your connection and try again.'}`, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <p className="small" style={{ margin: 0 }}>
      <button type="button" className="btn ghost sm" style={{ minHeight: 44, paddingLeft: 0, color: 'var(--green-deep, #1f6f43)', textDecoration: 'underline', textUnderlineOffset: 3 }} disabled={busy} onClick={open}>
        {T('preview.open.link')}<span className="sg-vh"> {T('preview.open.new_tab')}</span>
      </button>
      {ed.correcting && changed && <span className="muted"> {T('preview.open.unsaved')}</span>}
    </p>
  );
}
