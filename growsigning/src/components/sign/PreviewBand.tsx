'use client';
// The band over the signing page while the sender looks at it as one of their people (src/server/preview.ts): it says
// that nothing is recorded or sent, whose view this is, what that person is asked for before the document opens, and
// it switches to another person. Absent on every real signing link.
import { useEffect, useState, type CSSProperties } from 'react';
import { t } from '@/lib/i18n';

export type PreviewFacts = {
  expires_at: string;
  kind: 'draft' | 'envelope' | 'template';
  envelope_id: string;
  person: { id: string; name: string; role: string };
  does: string;
  check: string | null;
  turn: string | null;
  language?: string | null;
  people: { id: string; name: string; role: string; token: string }[];
  nothing: string;
};

// The sender reads the band in their own browser's language; the page under it is in the person's.
const lang = () => (typeof navigator === 'undefined' ? 'en' : navigator.language);
export const previewT = (key: string, vars?: Record<string, string>) => t(lang(), key, vars);

const BAND: CSSProperties = { background: '#fff1bf', color: '#3d2c00', borderBottom: '2px solid #b98a00', padding: '10px 16px', fontSize: 14, lineHeight: 1.45 };

/**
 * How the sender leaves the preview. The tab "See what each person sees" opened was opened by script, so it can be
 * closed. Anywhere else (a pasted or forwarded link, another device) a browser ignores window.close(), so the way out
 * is a link to the documents instead of a button that does nothing.
 */
export function useCanClose() {
  const [can, setCan] = useState(false);
  useEffect(() => {
    try {
      setCan(!!window.opener);
    } catch {
      setCan(false);
    }
  }, []);
  return can;
}
export function closeOrLeave() {
  window.close();
  // Still here: this browser kept the tab open after all, so go somewhere useful rather than nowhere.
  setTimeout(() => {
    if (!window.closed) window.location.assign('/app');
  }, 400);
}
export function LeavePreview({ closeKey }: { closeKey: string }) {
  const can = useCanClose();
  return can
    ? <button type="button" className="btn" style={{ minHeight: 44 }} onClick={closeOrLeave}>{previewT(closeKey)}</button>
    : <a className="btn" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href="/app">{previewT('preview.band.leave')}</a>;
}

/** One word in the signing page's top bar, which stays on screen while the document scrolls and the band does not. */
export function PreviewChip() {
  return <span className="sg-preview-chip" style={{ background: '#fff1bf', color: '#3d2c00', borderRadius: 999, padding: '2px 10px', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{previewT('preview.chip')}</span>;
}

export function PreviewBand({ preview }: { preview: PreviewFacts }) {
  const ends = new Date(preview.expires_at).toLocaleTimeString(lang(), { hour: 'numeric', minute: '2-digit' });
  // The person switch moves only when Show is pressed, so arrow keys in the list never load another page (WCAG 3.2.2).
  const [pick, setPick] = useState(preview.person.id);
  const show = () => {
    const p = preview.people.find((x) => x.id === pick);
    if (p && p.id !== preview.person.id) window.location.assign(`/sign/${encodeURIComponent(p.token)}`);
  };
  return (
    <section className="sg-preview-band" style={BAND} aria-label={previewT('preview.band.title')}>
      <div style={{ maxWidth: 980, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: '6px 16px', alignItems: 'center' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <b>{previewT('preview.band.title')}</b>{' '}
          <span>{previewT('preview.band.seeing', { name: preview.person.name, does: preview.does })}</span>
          {preview.check && <> {preview.check}</>}
          {preview.turn && <> {preview.turn}</>}
          {preview.language && <> {preview.language}</>}
          {preview.kind === 'template' && <> {previewT('preview.band.template')}</>}
          {' '}<span>{previewT('preview.band.ends', { time: ends })}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: '0 1 auto', maxWidth: '100%' }}>
          {preview.people.length > 1 && (
            <form style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%', minWidth: 0 }} onSubmit={(ev) => (ev.preventDefault(), show())}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{previewT('preview.band.who')}</span>
                <select value={pick} style={{ minHeight: 44, maxWidth: '100%', minWidth: 0, fontSize: 15 }} onChange={(ev) => setPick(ev.target.value)}>
                  {preview.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <button type="submit" className="btn" style={{ minHeight: 44 }} disabled={pick === preview.person.id}>{previewT('preview.band.show')}</button>
            </form>
          )}
          <LeavePreview closeKey="preview.band.close" />
        </div>
      </div>
    </section>
  );
}
