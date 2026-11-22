'use client';
// Step 3: "Draft a message" next to the message box, and "Plain summary for signers" in More options
// (src/server/routes-aiassist.ts). Neither is there unless a model answers for this account: useAssist() asks only
// when /api/me says the account's AI is on, so with zero setup nothing is fetched and nothing is shown.
import { useEffect, useState } from 'react';
import { api, toast } from '../ui';
import { useMe } from '../AppShell';
import type { Ed } from './shared';
import { DRAFT_BUTTON, SUMMARY_CHOICE, SUMMARY_CHOICE_HINT } from '@/lib/aiassist';

type Assist = { available: boolean; read: boolean; draft: boolean; summary: boolean; fields: boolean } | null;

// One answer per account for the whole visit to the editor: step 2 asks, so step 3 draws "Draft a message" at once
// instead of pushing the step down a moment after it appeared. Kept a minute, so a switch flipped in Settings shows.
let cache: { account: string; at: number; d: Assist } | null = null;
const KEEP_MS = 60_000;
/** Settings calls this after the read switch changed, so the editor asks again. */
export const forgetAssist = () => {
  cache = null;
};

/** What AI help this account has, or null while unknown and wherever the account's AI is off. */
export function useAssist(): Assist {
  const me = useMe();
  const on = me?.policy?.ai_helper === 'on';
  const account = String(me?.account?.id || '');
  const fresh = cache && cache.account === account && Date.now() - cache.at < KEEP_MS ? cache.d : undefined;
  const [d, setD] = useState<Assist>(fresh ?? null);
  useEffect(() => {
    if (!on) return setD(null);
    if (fresh !== undefined) return setD(fresh);
    let live = true;
    api('/ai/assist').then((r) => {
      cache = { account, at: Date.now(), d: r };
      if (live) setD(r);
    }).catch(() => live && setD(null));
    return () => {
      live = false;
    };
  }, [on, account, fresh]);
  return on ? d : null;
}

/** The button beside the message box. It fills the subject and the message; the sender edits them before sending. */
export function DraftMessage({ ed }: { ed: Ed }) {
  const a = useAssist();
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<{ subject: string; message: string } | null>(null);
  const [said, setSaid] = useState('');
  if (!a?.draft || ed.isTpl || ed.correcting || ed.wording || ed.signNow) return null;
  const draft = async () => {
    setBusy(true);
    setSaid('');
    try {
      const people = ed.rcps.filter((r) => !ed.isIdle(r)).map((r) => ({ name: r.name || '', role: r.role }));
      const r = await api('/ai/draft', { method: 'POST', body: { envelope_id: ed.env.id, documents: ed.docs.map((d) => d.name || 'Document'), people } });
      setBefore({ subject: ed.env.subject || '', message: ed.env.message || '' });
      ed.patchEnv({ subject: r.subject || ed.env.subject, message: r.message || '' });
      setSaid('Written by AI. Read it and change anything before you send.');
    } catch (e: any) {
      toast(e?.message || 'The AI is not answering just now. Write the message yourself.', true);
    }
    setBusy(false);
  };
  const undo = () => {
    if (!before) return;
    ed.patchEnv(before);
    setBefore(null);
    setSaid('Your own words are back.');
  };
  return (
    <div className="row wrap" data-feature="ds-ai-assist" style={{ gap: '4px 12px', marginTop: 8 }}>
      <button type="button" className="btn sm" style={{ minHeight: 44 }} disabled={busy} onClick={draft}>{busy ? 'Writing' : DRAFT_BUTTON}</button>
      {before && <button type="button" className="btn sm ghost" style={{ minHeight: 44 }} onClick={undo}>Put back what was there</button>}
      <span className="muted small" role="status">{said}</span>
    </div>
  );
}

/** In step 3's More options, only where the account lets the AI read document text. Saves by itself. */
export function SummaryChoice({ ed }: { ed: Ed }) {
  const a = useAssist();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const may = !!a?.summary && !ed.isTpl && !!ed.env.id;
  useEffect(() => {
    if (!may) return;
    let live = true;
    api(`/envelopes/${ed.env.id}/ai-summary`).then((r) => live && setOn(!!r.on)).catch(() => {});
    return () => {
      live = false;
    };
  }, [may, ed.env.id]);
  if (!may || on === null) return null;
  const flip = async (v: boolean) => {
    setBusy(true);
    setSaved(false);
    try {
      const r = await api(`/envelopes/${ed.env.id}/ai-summary`, { method: 'PUT', body: { on: v } });
      setOn(!!r.on);
      setSaved(true);
    } catch (e: any) {
      toast(e?.message || 'That was not saved. Try again in a moment.', true);
    }
    setBusy(false);
  };
  return (
    <label className="card setting-row" data-feature="ds-ai-assist" style={{ minHeight: 44, padding: 20 }}>
      <input type="checkbox" role="switch" checked={on} disabled={busy} aria-labelledby="ed-sum-title" aria-describedby="ed-sum-hint" onChange={(e) => flip(e.target.checked)} />
      <span>
        <b id="ed-sum-title">{SUMMARY_CHOICE}</b> <span role="status" className="small" style={{ marginLeft: 6, color: 'var(--green)' }}>{saved ? 'Saved' : ''}</span>
        <span className="muted small" id="ed-sum-hint" style={{ display: 'block' }}>{SUMMARY_CHOICE_HINT}</span>
      </span>
    </label>
  );
}
