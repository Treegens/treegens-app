'use client';
// One page of the document in Easy reading (TextView.tsx): its words put back together by sign/reflow.ts, read in
// order, with this person's fields between the parts of the text they sit in. Each part has "See this on the page",
// which opens the page view at that spot, and a long part can be folded away. Nothing is folded when the page opens,
// and folding hides only words: the fields of a folded part stay on the screen, so nothing that must be filled is
// ever out of sight.
import { useState, type ReactNode } from 'react';
import { placeFields, sectionsOf, FOLD_FROM, type RBlock, type RField, type RPage } from './reflow';
import { useT } from './lang';
import { partId } from './readview';

function Block({ b, k }: { b: RBlock; k: string }) {
  const T = useT();
  if (b.kind === 'list') {
    // A numbered list keeps its own numbers as printed, so they are part of the words and not added again.
    return <ul className="sg-flow-list">{(b.items || []).map((t, i) => <li key={`${k}-${i}`} dir="auto">{t}</li>)}</ul>;
  }
  if (b.kind === 'table') {
    const rows = b.rows || [];
    // Said as stacked rows: on a phone a table of three or four columns does not fit, and a row read across is
    // what a screen reader does anyway. Its cells keep their place in the row.
    return (
      <div className="sg-flow-table" role="group" aria-label={T('sign.read.table', { rows: rows.length })}>
        {rows.map((r, i) => (
          <p key={`${k}-${i}`} className="sg-flow-row" dir="auto">{r.map((c, j) => <span key={j} className="sg-flow-cell">{j > 0 && <span className="sg-vh">, </span>}{c}</span>)}</p>
        ))}
      </div>
    );
  }
  return <p className="sg-flow-p" dir="auto">{b.text}</p>;
}

const short = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}...` : t);
const words = (n: number) => Math.max(1, Math.round(n / 6));

// The parts a person folded, for each page, kept while the tab is open: after "See this on the page" and back, the
// same parts are still folded. Empty when the page opens, so nothing is ever folded at the start.
const keptFolds = new Map<string, Set<number>>();


export function EasyPage({ docId, page, flow, mine, fields, onSee }: {
  docId: string;
  page: number;
  flow: RPage;
  /** This person's fields on this page, with where they sit. */
  mine: RField[];
  /** The form for some of those fields (by id), as TextFields.PageFields draws it. */
  fields: (ids: string[]) => ReactNode;
  /** Open the page view at this spot (0 to 1 from the top of the page), from part `part` of this page. */
  onSee?: (y: number, part: number) => void;
}) {
  const T = useT();
  const foldKey = `${docId}:${page}`;
  const [folded, setFolded] = useState<Set<number>>(() => new Set(keptFolds.get(foldKey) || []));
  const { start, after } = placeFields(flow, mine);
  const sections = sectionsOf(flow);
  const chunk = (ids: RField[], key: string) => (ids.length ? <div key={key} className="sg-flow-fields">{fields(ids.map((f) => f.id))}</div> : null);
  return (
    <>
      {chunk(start, 'start')}
      {sections.map((s, si) => {
        const id = partId(docId, page, si);
        const isFolded = folded.has(si);
        // Which blocks belong to this part, by their place in the page: the heading (if any) and those after it.
        const from = s.first;
        const to = si + 1 < sections.length ? sections[si + 1].first : flow.blocks.length;
        const inside = after.slice(from, to).flat();
        const toggle = () => setFolded((x) => {
          const n = new Set(x);
          if (n.has(si)) n.delete(si);
          else n.add(si);
          keptFolds.set(foldKey, n);
          return n;
        });
        return (
          <section key={si} id={`${id}-sec`} className="sg-flow-sec" aria-labelledby={s.heading ? id : undefined}>
            {s.heading && <h4 id={id} dir="auto">{s.heading.text}</h4>}
            {s.heading && chunk(after[from], `h-${from}`)}
            <div className="sg-flow-tools">
              {/* A part that is only a heading (a title, say) has nothing of its own to check on the page. The name
                  says which part, so a screen reader's list of links is not a run of copies. */}
              {onSee && s.blocks.length > 0 && (
                <button type="button" className="sg-link sg-flow-see" onClick={() => onSee(s.top, si)}
                  aria-label={s.heading ? T('sign.read.see_part', { part: short(s.heading.text || ''), page: page + 1 }) : T('sign.read.see_where', { page: page + 1 })}>
                  {T('sign.read.see')}
                </button>
              )}
              {s.chars >= FOLD_FROM && (
                <button type="button" className="sg-link sg-flow-fold" aria-expanded={!isFolded} aria-controls={`${id}-body`} onClick={toggle}>
                  {isFolded ? T('sign.read.unfold') : T('sign.read.fold')}
                </button>
              )}
            </div>
            <div id={`${id}-body`}>
              {isFolded && <p className="muted small sg-flow-folded">{T(inside.length ? 'sign.read.folded' : 'sign.read.folded_none', { words: words(s.chars) })}</p>}
              {flow.blocks.slice(from, to).map((b, j) => {
                const i = from + j;
                if (b.kind === 'heading') return null;
                return (
                  <div key={i} className="sg-flow-part">
                    {!isFolded && <Block b={b} k={`${i}`} />}
                    {chunk(after[i], `a-${i}`)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
