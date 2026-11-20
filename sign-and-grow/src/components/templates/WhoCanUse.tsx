'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, toast } from '@/components/ui';
import { Dialog } from '@/components/sender/Dialog';
import { fail } from '@/components/sender/feedback';
import { Lock } from '@/components/editor/parts';
import { PREFILL } from '@/components/editor/shared';
import { accessSentence, accessMark, lockedBanner, listNames, USE_LABEL, CHANGE_LABEL, TPL_USES, TPL_CHANGES, LOCK_MEANS, type TplUse, type TplChange } from '@/lib/tplroles';

// Who can use a template, who can change it, and the lock on its wording, on the template page and in the editor.
// The server decides (src/server/tplroles.ts); these screens say the rule in a sentence, let the person it belongs
// to and admins change it, and show what is locked before anyone types, instead of refusing at the end.

/** The marks in the list of templates: "Admins only" or "Chosen members", and "Wording locked". */
export function AccessMarks({ access }: { access?: { use: TplUse; locked: boolean } }) {
  if (!access) return null;
  const mark = accessMark(access);
  if (!mark && !access.locked) return null;
  return (
    <span className="tr-marks">
      {mark && <span className="badge tr-mark">{mark}</span>}
      {access.locked && <span className="badge tr-mark tr-lock"><Lock size={12} />Wording locked</span>}
    </span>
  );
}

type Member = { id: string; name: string; email: string; role: string; always: boolean; chosen: boolean; can_change: boolean };
type Draft = { use: TplUse; change: TplChange; locked: boolean; picks: Record<string, { chosen: boolean; can_change: boolean }> };

/** The rule of one template: read by everyone who may use it, changed by the person it belongs to and admins. */
export function AccessDialog({ templateId, name, onClose, onSaved }: { templateId: string; name: string; onClose: () => void; onSaved?: (access: any) => void }) {
  const [a, setA] = useState<any>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const box = useRef<any>(null);
  useEffect(() => {
    let live = true;
    api(`/envelopes/${templateId}/access`).then(({ access }) => {
      if (!live) return;
      setA(access);
      setD({ use: access.use, change: access.change, locked: access.locked, picks: Object.fromEntries((access.members || []).map((m: Member) => [m.id, { chosen: m.chosen, can_change: m.can_change }])) });
    }).catch((e) => (fail(e), onClose()));
    return () => {
      live = false;
    };
  }, [templateId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The dialog opens on "Loading" with nothing to focus, so once the rule is there focus moves to the choice that is
  // ticked (or to Close), and a keyboard or screen reader user starts inside the dialog.
  const ready = !!a;
  useEffect(() => {
    if (ready) (box.current as HTMLElement | null)?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [ready]);

  if (!a || !d) return <Dialog title={`Who can use "${name}"`} onClose={onClose}><p className="muted" role="status">Loading…</p></Dialog>;
  const members: Member[] = a.members || [];
  const pickable = members.filter((m) => !m.always);
  const names = (pred: (p: { chosen: boolean; can_change: boolean }) => boolean) => pickable.filter((m) => d.picks[m.id] && pred(d.picks[m.id])).map((m) => m.name);
  const preview = accessSentence({ ...d, owner: a.owner, chosen_use: d.use === 'chosen' ? names((p) => p.chosen || p.can_change) : [], chosen_change: d.change === 'chosen' ? names((p) => p.can_change) : [] });
  const pick = (id: string, p: Partial<{ chosen: boolean; can_change: boolean }>) => setD({ ...d, picks: { ...d.picks, [id]: { ...{ chosen: false, can_change: false }, ...d.picks[id], ...p } } });
  // Everyone may change it only if everyone may use it. Choosing otherwise moves "change" back, and says so.
  const setUse = (use: TplUse) => {
    if (use !== 'team' && d.change === 'team') (setD({ ...d, use, change: 'owner' }), setNote(`Changed to "${CHANGE_LABEL.owner}", because only people who can use a template can change it.`));
    else (setD({ ...d, use }), setNote(''));
  };

  async function save() {
    if (!d) return;
    setBusy(true);
    try {
      const members = Object.entries(d.picks).filter(([, p]) => p.chosen || p.can_change).map(([id, p]) => ({ id, can_change: p.can_change }));
      const r = await api(`/envelopes/${templateId}/access`, { method: 'PUT', body: { use: d.use, change: d.change, locked: d.locked, members } });
      toast('Saved. The rule is written in the template\'s history.');
      onSaved?.(r.access);
      onClose();
    } catch (e) {
      fail(e, 'Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  if (!a.may_set)
    return (
      <Dialog title={`Who can use "${name}"`} onClose={onClose}>
        <div ref={box}>
          <p>{accessSentence(a)}</p>
          <p className="muted small">If it should be different, ask {a.owner} or an admin of your team.</p>
          <div className="actions"><button type="button" className="btn tr-tap" data-autofocus="" onClick={onClose}>Close</button></div>
        </div>
      </Dialog>
    );
  return (
    <Dialog title={`Who can use "${name}"`} onClose={onClose} wide>
      <form ref={box} onSubmit={(e) => (e.preventDefault(), save())} className="tr-form">
        <fieldset className="tr-set">
          <legend>Who can use it</legend>
          {TPL_USES.map((u) => (
            <label key={u} className="sn-choice"><input type="radio" name="tr-use" checked={d.use === u} onChange={() => setUse(u)} data-autofocus={d.use === u ? '' : undefined} /> {USE_LABEL[u]}</label>
          ))}
        </fieldset>
        <fieldset className="tr-set">
          <legend>Who can change it</legend>
          {TPL_CHANGES.map((ch) => {
            const off = ch === 'team' && d.use !== 'team';
            return (
              <label key={ch} className={`sn-choice${off ? ' tr-off' : ''}`}>
                <input type="radio" name="tr-change" checked={d.change === ch} disabled={off} aria-describedby={off ? 'tr-team-why' : undefined} onChange={() => (setD({ ...d, change: ch }), setNote(''))} /> {ch === 'owner' ? `${a.owner} and admins` : CHANGE_LABEL[ch]}
              </label>
            );
          })}
          {d.use !== 'team' && <p className="muted small" id="tr-team-why">Everyone on the team can only change a template that everyone can use.</p>}
          <p className="small" role="status" aria-live="polite">{note}</p>
        </fieldset>
        {(d.use === 'chosen' || d.change === 'chosen') && (
          <fieldset className="tr-set">
            <legend>Chosen members</legend>
            {pickable.length === 0 && <p className="muted small">Everyone on your team is an admin or owns this template, so they can already use and change it.</p>}
            <ul className="tr-people">
              {pickable.map((m) => {
                const p = d.picks[m.id] || { chosen: false, can_change: false };
                return (
                  <li key={m.id}>
                    <span className="tr-who"><b>{m.name}</b> <span className="muted small">{m.email}</span></span>
                    {d.use === 'chosen' && <label className="check tr-tap"><input type="checkbox" checked={p.chosen || p.can_change} disabled={p.can_change} onChange={(e) => pick(m.id, { chosen: e.target.checked })} /> Can use</label>}
                    {d.change === 'chosen' && <label className="check tr-tap"><input type="checkbox" checked={p.can_change} onChange={(e) => pick(m.id, { can_change: e.target.checked, ...(e.target.checked ? { chosen: true } : {}) })} /> Can change</label>}
                  </li>
                );
              })}
            </ul>
            <p className="muted small">{listNames(members.filter((m) => m.always).map((m) => m.name))} can always use and change it: {members.filter((m) => m.always).length === 1 ? 'they own it or run the account' : 'they own it, or they are admins or the owner of the account'}.</p>
          </fieldset>
        )}
        <fieldset className="tr-set">
          <legend>Wording</legend>
          <label className="check tr-tap"><input type="checkbox" checked={d.locked} onChange={(e) => setD({ ...d, locked: e.target.checked })} aria-describedby="tr-lock-means" /> Lock the wording</label>
          <p className="muted small" id="tr-lock-means">{LOCK_MEANS} This holds for envelopes started from now on. Unlocking it frees the ones already started as well.</p>
        </fieldset>
        <div className="notice tr-preview" aria-live="polite"><b>It will say:</b> {preview}</div>
        <div className="actions">
          <button type="button" className="btn tr-tap" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary tr-tap" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Who can use this" in the template editor: the rule in a sentence, and a way to change it for those who may. */
export function WhoCanUse({ templateId, name, access }: { templateId: string; name: string; access?: any }) {
  const [a, setA] = useState<any>(access || null);
  const [open, setOpen] = useState(false);
  useEffect(() => setA(access || null), [access]);
  if (!a) return null;
  return (
    <div className="card" aria-labelledby="tr-who-h">
      <h2 id="tr-who-h" style={{ marginBottom: 8 }}>Who can use this</h2>
      <p style={{ marginTop: 0 }}>{accessSentence(a)}</p>
      {a.may_set
        ? <button type="button" className="btn tr-tap" onClick={() => setOpen(true)}>Change who can use this</button>
        : <p className="muted small">Only {a.owner} and admins can change who can use it. Ask them if it should be different.</p>}
      {open && <AccessDialog templateId={templateId} name={name} onClose={() => setOpen(false)} onSaved={(x) => setA((old: any) => ({ ...old, ...x }))} />}
    </div>
  );
}

export type WordingLock = { template_id: string; template: string | null; ask: string; fixed: string[] };

/** Said at the top of the editor when the wording of this envelope is locked. */
export function WordingBanner({ lock }: { lock: WordingLock }) {
  return (
    <div className="ed-banner tr-banner" role="note">
      <Lock size={16} /> <span><b>The wording is locked.</b> {lockedBanner(lock.template, lock.ask)}</span>
    </div>
  );
}

/** One line where a locked part would otherwise be edited. */
export function LockedLine({ children }: { children: ReactNode }) {
  return <div className="notice ed-lockline small tr-line"><Lock size={16} /><span>{children}</span></div>;
}

/** The settings of a field on an envelope whose wording is locked: why it stays, and its value when it is left to fill in. */
export function WordingField({ field, lock, onValue }: { field: any; lock: WordingLock; onValue: (v: string) => void }) {
  const fixed = lock.fixed.includes(field.id);
  const fillable = !fixed && PREFILL.includes(field.type) && field.type !== 'note';
  return (
    <div>
      <LockedLine>{fixed ? 'This holds wording from the template. The wording is locked, so it stays as it is.' : 'The wording is locked, so this field stays where it is, as the template has it.'}{fillable ? ' You can fill in what it says.' : ''} To change the template, ask {lock.ask}.</LockedLine>
      {fillable && <label className="f" style={{ marginTop: 10 }}><span>{field.label || 'Value'} <span className="hint">(you fill this in)</span></span><textarea style={{ minHeight: 60 }} value={field.value || ''} onChange={(e) => onValue(e.target.value)} /></label>}
    </div>
  );
}
