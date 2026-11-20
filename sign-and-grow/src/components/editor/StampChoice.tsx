'use client';
import { useEffect, useState } from 'react';
import { api } from '../ui';
import { who } from './shared';
import { stampBox, fieldMm, STAMP_DEFAULT_MM, STAMP_IS_TEAM } from '@/lib/stamps';
import { INK_WORD } from '@/lib/stampink';

// A stamp field in the editor (src/server/stamps.ts): who puts it on, which of the team's stamps when it is the
// sender's own, and its size on the page. A recipient puts their own stamp on when they sign. The sender's stamp is
// one of the account's stamps (Settings, Stamps), printed as part of the document from the start.

let cache: Promise<any[]> | null = null;
/** The team's stamps, fetched once while the editor is open. */
export function useStamps(): any[] {
  const [list, setList] = useState<any[]>([]);
  useEffect(() => {
    let live = true;
    cache ??= api('/stamps').then((r) => r.stamps || []).catch(() => ((cache = null), []));
    cache.then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** Where the picture of a stamp field is, in the editor: the one it holds, or that of the stamp chosen for it. */
export function editorStampSrc(f: any, envelopeId: string | undefined, stamps: any[]): string | null {
  if (f.type !== 'stamp') return null;
  if (f.value && envelopeId) return `/api/envelopes/${envelopeId}/stamp-image/${f.value}`;
  if (!f.recipient_id && f.stamp_id) return stamps.find((s) => s.id === f.stamp_id)?.image_url || null;
  return null;
}

export function StampChoice({ field, open, envelopeId, page, patch }: {
  field: any;
  /** The people who can put a stamp on: those who sign. */
  open: any[];
  envelopeId?: string;
  page: { w: number; h: number };
  patch: (p: any) => void;
}) {
  const stamps = useStamps();
  const mine = !field.recipient_id;
  const chosen = stamps.find((s) => s.id === field.stamp_id);
  const mm = fieldMm(field, page.w, page.h);
  const real = (mine && chosen?.size_mm) || STAMP_DEFAULT_MM;
  const realBox = stampBox(real, page.w, page.h);
  const atReal = Math.abs(field.w - realBox.w) < 0.002 && Math.abs(field.h - realBox.h) < 0.002;
  // The picture this field holds is older than the stamp under Settings: it was changed after it was put here.
  const older = mine && !!chosen && !!field.value && field.value !== chosen.image_sha256;
  return (
    <div className="ed-stamp">
      <label className="f"><span>Who puts the stamp on</span>
        <select value={field.recipient_id || ''} onChange={(e) => patch(e.target.value
          ? { recipient_id: e.target.value, stamp_id: null, value: '', required: true }
          : { recipient_id: null, stamp_id: field.stamp_id || stamps[0]?.id || null, value: '', required: false })}>
          {open.map((r) => <option key={r.id} value={r.id}>{who(r)}, their own stamp</option>)}
          <option value="">Me: one of my team&apos;s stamps</option>
        </select>
      </label>
      {!mine && <p className="muted small">They put their own stamp on when they sign: a picture of it, a photo taken then, or one saved in their own account.</p>}
      {mine && (stamps.length ? (
        <fieldset className="st-saved">
          <legend>Which stamp</legend>
          <div className="st-saved-list">
            {stamps.map((s) => (
              <label key={s.id} className={`st-card${field.stamp_id === s.id ? ' on' : ''}`}>
                <input type="radio" name={`ed-stamp-${field.id}`} checked={field.stamp_id === s.id} onChange={() => patch({ stamp_id: s.id, value: '' })} />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.image_url} alt="" />
                <span><b>{s.name}</b><span className="muted small">{INK_WORD[s.ink as keyof typeof INK_WORD] || ''} ink, {s.size_mm} mm</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="notice small">Your team has no stamps yet. An admin adds them under Settings, Stamps. Until one is chosen here, this cannot be sent.</p>
      ))}
      {older && (
        <p className="notice small">
          This field keeps the picture of &ldquo;{chosen.name}&rdquo; it was put here with. Someone changed that stamp under Settings since.{' '}
          <button type="button" className="btn sm" onClick={() => patch({ value: '', stamp_refresh: true })}>Use it as it is now</button>
        </p>
      )}
      <p className="muted small">On the page it is about {mm.w} by {mm.h} mm.{atReal ? ' That is its real size.' : ''}</p>
      {!atReal && (
        <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => patch({ w: realBox.w, h: realBox.h, x: Math.min(field.x, 1 - realBox.w), y: Math.min(field.y, 1 - realBox.h) })}>
          Make it {real} mm, {mine && chosen ? 'the stamp\'s real size' : 'the size of a round company seal'}
        </button>
      )}
      <p className="muted small">{STAMP_IS_TEAM}</p>
    </div>
  );
}
