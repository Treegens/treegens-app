'use client';
// Step 2, after "Place fields for me": fields the AI suggests for pages where the tags, blanks and form fields found
// nothing (POST /api/ai/fields, src/server/aiassist.ts). Only where the account lets the AI read document text. The
// page text goes with where each piece sits, never a picture. Every suggestion is a line here with Add, and a dashed
// outline marked "Suggested" on the page (outlines(), drawn by StepFields.tsx) so the sender can check it first;
// nothing is placed until the sender adds it, and one undo takes an added field away again.
import { useRef, useState } from 'react';
import { api } from '../ui';
import { overlap, type Found, type PageScan } from '@/lib/autoplace';
import { SUGGEST_WORDS, SUGGEST_PAGES_MAX, type SuggestType } from '@/lib/aiassist';
import { MAX_FIELDS, makeField, plural, type Ed } from './shared';
import { useAssist } from './DraftMessage';

type Sug = { key: string; doc: string; page: number; type: SuggestType; x: number; y: number; w: number; h: number; signer: number; label: string };

export function useSuggest(ed: Ed, o: { signers: any[]; active: string; label: (r: any) => string; reveal: (id: string) => void }) {
  const a = useAssist();
  const [list, setList] = useState<Sug[]>([]);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [lead, setLead] = useState('');
  const [lit, setLit] = useState('');
  const asking = useRef(0);

  /** Called by "Place fields for me" with what it read. Asks only for pages where nothing was found. True when it asked. */
  const ask = (scans: { doc: string; pages: PageScan[] }[], found: (Found & { doc: string })[]): boolean => {
    setList([]);
    setSaid('');
    setLead('');
    if (!a?.fields || ed.wording) return false;
    const cur = ed.fields.current();
    const pages = scans.flatMap((s) => s.pages.map((p, i) => ({ doc: s.doc, page: i, w: p.size.w, h: p.size.h, items: p.items.map(({ str, x, y, w, h }) => ({ str, x, y, w, h })),
      taken: cur.filter((f) => f.document_id === s.doc && f.page === i).map(({ x, y, w, h }) => ({ x, y, w, h })) })))
      .filter((p) => p.items.length && !found.some((f) => f.doc === p.doc && f.page === p.page) && !cur.some((f) => f.document_id === p.doc && f.page === p.page));
    if (!pages.length) return false;
    const mine = ++asking.current;
    // One notice, not two: when Place fields for me found nothing at all, this panel says so itself.
    const before = found.length ? '' : 'No blanks or form fields found. ';
    setLead(before);
    setBusy(true);
    const sent = pages.slice(0, SUGGEST_PAGES_MAX);
    // One document at a time keeps the page numbers the model reads simple.
    const docs = [...new Set(sent.map((p) => p.doc))];
    (async () => {
      const got: Sug[] = [];
      try {
        for (const doc of docs) {
          const r = await api('/ai/fields', { method: 'POST', body: { signers: o.signers.length || 1, pages: sent.filter((p) => p.doc === doc) } });
          for (const s of r.suggestions || []) got.push({ ...s, doc, key: `${doc}:${s.page}:${s.x}:${s.y}:${s.type}` });
        }
        if (mine !== asking.current) return;
        setList(got);
        setSaid(got.length ? `${before}The AI suggests ${plural(got.length, 'place')}, marked Suggested on the page. Check each one, then add it.`
          : `${before}The AI found no ${before ? '' : 'other '}places for fields${before ? ' either' : ''}. Pick a field and click where it goes.`);
      } catch (e: any) {
        if (mine === asking.current) setSaid(`${before}${e?.message || 'The AI is not answering just now. You can place fields by hand.'}`);
      } finally {
        if (mine === asking.current) setBusy(false);
      }
    })();
    return true;
  };

  const owner = (s: Sug) => o.signers[s.signer - 1]?.id || o.active;
  const add = (items: Sug[]) => {
    const cur = ed.fields.current();
    const fresh: any[] = [];
    for (const s of items) {
      const rid = owner(s);
      if (!rid || ed.lockedIds.has(rid)) continue;
      if ([...cur, ...fresh].some((f) => f.document_id === s.doc && f.page === s.page && overlap(s, f) >= 0.3)) continue;
      if (cur.length + fresh.length >= MAX_FIELDS) break;
      fresh.push(makeField(s.type, s.doc, s.page, rid, { x: s.x, y: s.y, w: s.w, h: s.h }, { label: s.label || '' }));
    }
    const done = new Set(items.map((s) => s.key));
    setList((l) => l.filter((s) => !done.has(s.key)));
    if (fresh.length) {
      ed.setFields((l) => [...l, ...fresh]);
      o.reveal(fresh[0].id);
      setSaid(`Added ${plural(fresh.length, 'field')}. Undo takes ${fresh.length === 1 ? 'it' : 'them'} away again.`);
    } else setSaid('Nothing was added: there is already a field in that place.');
  };

  const show = (s: Sug) => {
    setLit(s.key);
    if (typeof document !== 'undefined') document.querySelector(`[data-sugg="${CSS.escape(s.key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const docName = (id: string) => (ed.docs.length > 1 ? `${ed.docs.find((d) => d.id === id)?.name || 'Document'}, ` : '');
  const panel = busy || said || list.length ? (
    <div className="ed-suggest" data-feature="ds-ai-assist" role="region" aria-label="Fields the AI suggests">
      <p className="small" role="status" style={{ margin: '6px 0' }}>{busy ? `${lead}Asking the AI about pages with nothing found…` : said}</p>
      {list.length > 0 && (
        <>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: '0 0 8px', gap: 4 }}>
            {list.map((s) => (
              <li key={s.key} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                <span className="small">{SUGGEST_WORDS[s.type]}{s.label ? ` "${s.label}"` : ''} for {o.label(o.signers[s.signer - 1] || o.signers.find((r) => r.id === o.active))}, {docName(s.doc)}page {s.page + 1}</span>
                <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => add([s])} aria-label={`Add ${SUGGEST_WORDS[s.type]} on page ${s.page + 1}`}
                  // Focus or point at a line: its outline lights up and comes into view, so it can be checked first.
                  onFocus={() => show(s)} onMouseEnter={() => show(s)} onBlur={() => setLit('')} onMouseLeave={() => setLit('')}>Add</button>
              </li>
            ))}
          </ul>
          <div className="row wrap" style={{ gap: 8 }}>
            {list.length > 1 && <button type="button" className="btn sm" style={{ minHeight: 44 }} onClick={() => add(list)}>Add all {list.length}</button>}
            <button type="button" className="btn sm ghost" style={{ minHeight: 44 }} onClick={() => (setList([]), setSaid(''))}>Leave them</button>
          </div>
        </>
      )}
    </div>
  ) : null;
  /** The pending suggestions of one page, drawn by StepFields.tsx on that page. A click adds one; the list is the way
   *  in by keyboard and screen reader, so the outline itself is only for the eye. */
  const outlines = (doc: string, page: number) => list.filter((s) => s.doc === doc && s.page === page).map((s) => (
    <div key={s.key} className={`ed-sugg${lit === s.key ? ' lit' : ''}`} data-sugg={s.key} data-feature="ds-ai-assist" aria-hidden="true"
      style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` }}
      onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <span className="ed-sugg-under">
        <span className="ed-sugg-tag">Suggested: {SUGGEST_WORDS[s.type]}</span>
        <button type="button" tabIndex={-1} className="btn sm ed-sugg-add" onClick={(e) => (e.stopPropagation(), add([s]))}>Add</button>
      </span>
    </div>
  ));
  return { ask, panel, outlines, on: !!a?.fields };
}
