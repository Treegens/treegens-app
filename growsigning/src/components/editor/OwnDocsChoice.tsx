'use client';
// Step 3, More options: "Each person sees only their files" (research/ux-notes.json "ds-visibility"). Listed only
// with two or more files. On, each person is shown the files with their fields; a tick adds a file for someone.
// The rule is the server's own (src/lib/owndocs.ts), so what this card says is what each link gets.
import { shownDocIds, subjectFor, SEES_ALL_ROLES, OWN_DOCS_LABEL, OWN_DOCS_NOTE } from '@/lib/owndocs';
import { personLabel } from '@/lib/editorux';
import { type Ed } from './shared';

const people = (ed: Ed) => ed.rcps.filter((r) => !ed.isIdle(r));

/** The files one person is shown now, by name, or null for every file. For the line under them in Who gets it. */
export function ownDocsFor(ed: Ed, r: any): string[] | null {
  const s = shownDocIds(!!ed.env.own_docs, ed.docs, people(ed), ed.fields.value, r.id);
  return s ? ed.docs.filter((d) => s.has(d.id)).map((d) => d.name || 'A file') : null;
}

/** "Sees: Contract" under a person in Who gets it, only while the option is on and they see some of the files. */
export function OwnDocsLine({ ed, r }: { ed: Ed; r: any }) {
  if (!ed.env.own_docs || ed.docs.length < 2) return null;
  const names = ownDocsFor(ed, r);
  // Their email subject never names a file they are not shown: when yours does, they get their own (subjectFor).
  const shown = names ? shownDocIds(true, ed.docs, people(ed), ed.fields.value, r.id) : null;
  const theirs = shown ? subjectFor(ed.env.subject, ed.docs, shown) : '';
  return (
    <div className="muted small ed-break" data-feature="ds-visibility">
      {names ? `Sees only: ${names.join(', ')}` : 'Sees every file'}
      {shown && theirs !== String(ed.env.subject ?? '') ? <span style={{ display: 'block' }}>Their email subject: {theirs}</span> : null}
    </div>
  );
}

export function OwnDocsChoice({ ed }: { ed: Ed }) {
  const { env, docs } = ed;
  if (docs.length < 2) return null;
  const on = !!env.own_docs;
  const list = people(ed).filter((r) => !SEES_ALL_ROLES.includes(r.role));
  // Once someone has finished, what they were shown is part of what they signed: the switch and their ticks stay.
  const fixed = ed.anyLocked;
  const flip = (v: boolean) => ed.patchEnv({ own_docs: v });
  const ownOf = (r: any) => shownDocIds(true, docs, people(ed).map((x) => (x.id === r.id ? { ...x, also_sees: [] } : x)), ed.fields.value, r.id);
  const nowOf = (r: any) => shownDocIds(true, docs, people(ed), ed.fields.value, r.id);
  const tick = (r: any, docId: string, v: boolean) => {
    const own = ownOf(r);
    const now = nowOf(r);
    // A file to read that nobody has ticked goes to everyone (src/lib/owndocs.ts). Taking it from one person makes it
    // ticked for each of the others who are shown only some files or have fields, so they keep it.
    const d = docs.find((x) => x.id === docId);
    if (d?.supplemental && !v && !people(ed).some((x) => (x.also_sees || []).includes(docId)))
      for (const p of list) {
        if (p.id === r.id) continue;
        const pNow = nowOf(p);
        if (!pNow && !ownOf(p)) continue; // no fields and nothing ticked: they see every file anyway
        ed.patchRcp(p.id, { also_sees: pNow ? [...pNow] : docs.map((x) => x.id) });
      }
    // Someone with no field sees every file until something is ticked: the ticks start from every file then.
    const base = new Set<string>(now ? [...now] : docs.map((x) => x.id));
    if (v) base.add(docId);
    else base.delete(docId);
    // A file to read that nobody has ticked comes by itself: ticking it here would take it from everyone else.
    const isSupp = (x: string) => !!docs.find((y) => y.id === x)?.supplemental;
    const untargeted = (x: string) => isSupp(x) && !people(ed).some((p) => (p.also_sees || []).includes(x));
    const extra = [...base].filter((x) => (isSupp(x) || !own?.has(x)) && !untargeted(x));
    ed.patchRcp(r.id, { also_sees: extra.length ? extra : null });
  };
  return (
    <div className="card" data-feature="ds-visibility">
      <label className="setting-row" style={{ minHeight: 44, borderTop: 0, paddingTop: 0 }}>
        <input type="checkbox" role="switch" checked={on} disabled={fixed} aria-describedby="ed-own-hint" onChange={(e) => flip(e.target.checked)} />
        <span>
          <b>{OWN_DOCS_LABEL}</b>
          <span className="muted small" id="ed-own-hint" style={{ display: 'block' }}>{fixed ? `That is fixed, because ${ed.lockedNames} already finished.` : OWN_DOCS_NOTE}</span>
        </span>
      </label>
      {on && (
        <div className="stack" style={{ gap: 10, marginTop: 6 }}>
          {list.map((r) => {
            const now = nowOf(r);
            const own = ownOf(r);
            // Everyone gets at least one file to sign or look at: for someone with no fields, the last one stays ticked.
            const ticked = docs.filter((d) => !d.supplemental && (!now || now.has(d.id)));
            const last = !own && ticked.length === 1 ? ticked[0].id : null;
            const locked = ed.lockedIds.has(r.id);
            const name = personLabel(r, ed.rcps.indexOf(r));
            return (
              <fieldset key={r.id} className="ed-own" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small"><b className="ed-break">{name}</b></legend>
                {docs.map((d) => {
                  const theirs = !!own?.has(d.id) && !d.supplemental;
                  return (
                    <label key={d.id} className="check ed-tap">
                      <input type="checkbox" checked={!now || now.has(d.id)} disabled={theirs || locked || last === d.id} onChange={(e) => tick(r, d.id, e.target.checked)} />
                      <span className="ed-break">{d.name || 'A file'}{theirs ? <span className="muted small"> (has their fields)</span> : null}</span>
                    </label>
                  );
                })}
                {!own && !now && <div className="muted small">Gets every file. Untick one to leave it out.</div>}
                {last && <div className="muted small">Everyone gets at least one file.</div>}
              </fieldset>
            );
          })}
        </div>
      )}
    </div>
  );
}
