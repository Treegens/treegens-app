'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { newId, toast } from '../ui';
import { PdfDoc } from '../PdfDoc';
import { findFields, overlap, scanPdf, type Found } from '@/lib/autoplace';
import { snapBox, type Guide } from './snap';
import { Lock, UndoRedo, Wand } from './parts';
import { MAX_FIELDS, MIN_H, MIN_W, PREFILL, SIGNS, TLABEL, TYPES, clamp, makeField, plural, who, type Ed } from './shared';
import { SENDER_MARK } from './shared';
import { strikeClass, STRIKE_HELP } from '@/lib/strike';
import { WordingField } from '../templates/WhoCanUse';
import { FieldLogic, withoutField } from './FieldLogic';
import { WitnessBlockButton } from './WitnessChoice';
// A stamp field: who puts it on, which of the team's stamps, its real size (StampChoice.tsx, src/server/stamps.ts).
import { StampChoice, useStamps, editorStampSrc, editorStampTurn } from './StampChoice';
import { stampBox, STAMP_DEFAULT_MM, turnStyle } from '@/lib/stamps';
const senderStamp = (f: any) => f?.type === 'stamp' && !f.recipient_id;

const SNAP_PX = 5; // how close, in screen pixels, before a field jumps into line
const DRAG_START_PX = 3; // a press only becomes a drag after this much movement, so a click never moves anything
let dragCount = 0;

// Step 2: place fields on the pages.
export function StepFields({ ed }: { ed: Ed }) {
  const { env, docs, rcps, fields, setFields, lockedIds, anyLocked, isLockedField, color } = ed;
  const [tool, setTool] = useState<string | null>(null);
  const [activeId, setActiveId] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [guides, setGuides] = useState<{ doc: string; page: number; lines: Guide[] } | null>(null);
  const [pdfs, setPdfs] = useState<Record<string, any>>({});
  const [finding, setFinding] = useState('');
  const [note, setNote] = useState<{ text: string; count: number } | null>(null); // what the last search found
  const [sheet, setSheet] = useState(false);
  // The team's stamps, for the sender's own stamp fields and their pictures on the page.
  const stamps = useStamps();
  const canvas = useRef<HTMLDivElement>(null);
  const reveal = useRef<{ id: string; focus: boolean } | null>(null);
  const pressed = useRef(false); // a press that started on a field must not count as a click on the page

  // Signers in the order they sign, which is also what {{signature2}} counts by.
  // A witness takes no place in the order, so {{signature2}} never means a witness (editor/WitnessChoice.tsx).
  const signers = useMemo(() => {
    const l = rcps.filter((r) => SIGNS(r) && r.role !== 'witness');
    return env.ordered ? [...l].sort((a, b) => a.routing_order - b.routing_order) : l;
  }, [rcps, env.ordered]);
  // Fields can be placed for anyone who signs. For someone who has finished that means they sign again, which is
  // asked before the change is saved, so the people who have not signed yet come first when nothing is picked.
  const open = useMemo(() => [...signers, ...rcps.filter((r) => r.role === 'witness')], [signers, rcps]);
  const active = open.some((r) => r.id === activeId) ? activeId : (open.find((r) => !lockedIds.has(r.id)) || open[0])?.id || '';
  const list = fields.value;
  const selected = list.find((f) => f.id === sel);
  const selLocked = !!selected && isLockedField(selected);
  const patchField = (fid: string, p: any, key = Object.keys(p).join()) => setFields((l) => l.map((f) => (f.id === fid ? { ...f, ...p } : f)), { tag: `prop:${fid}:${key}` });
  // Fields that depended on the deleted one are put right in the same step, and the sender is told (withoutField).
  const remove = (fid: string) => {
    const r = withoutField(fields.current(), fid);
    setFields(() => r.list);
    if (r.said.length) toast(r.said.join(' '));
    setSel(null);
    setSheet(false);
  };
  const full = () => (fields.current().length >= MAX_FIELDS ? (toast('An envelope can hold up to 2,000 fields. Remove one to add another.', true), true) : false);

  // After a field is added from the keyboard or found automatically, bring it into view.
  useEffect(() => {
    const r = reveal.current;
    if (!r) return;
    reveal.current = null;
    const el = canvas.current?.querySelector<HTMLElement>(`[data-fid="${r.id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (r.focus) el.focus({ preventScroll: true });
  });

  // Arriving from the review step's list of fields without a label: that field is selected, its settings are
  // open, and once its page is drawn it is brought into view with the cursor in the Label box.
  useEffect(() => {
    const id = ed.jump;
    if (!id) return;
    ed.clearJump();
    setSel(id);
    setSheet(true);
    let tries = 0;
    const t = setInterval(() => {
      const el = canvas.current?.querySelector<HTMLElement>(`[data-fid="${id}"]`);
      if (!el && ++tries < 60) return;
      clearInterval(t);
      el?.scrollIntoView({ block: 'center', inline: 'nearest' });
      // On a phone the settings cover the lower half of the screen, so the field goes above them, as when tapped.
      const panel = document.querySelector('.ed-settings.has');
      if (el && panel && window.matchMedia('(max-width: 900px)').matches) {
        const top = panel.getBoundingClientRect().top, r = el.getBoundingClientRect();
        if (r.bottom > top - 12) window.scrollBy({ top: r.bottom - top + 24 });
      }
      document.getElementById('ed-label')?.focus({ preventScroll: true });
    }, 100);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On a phone the settings slide up from the bottom. Keep the selected field in view above them.
  useEffect(() => {
    if (!sel || !window.matchMedia('(max-width: 900px)').matches) return;
    const panel = document.querySelector('.ed-settings.has');
    const el = canvas.current?.querySelector(`[data-fid="${sel}"]`);
    if (!panel || !el) return;
    const top = panel.getBoundingClientRect().top, r = el.getBoundingClientRect();
    if (r.bottom > top - 12) window.scrollBy({ top: r.bottom - top + 24 });
  }, [sel, sheet]);

  function add(type: string, doc: any, page: number, x: number, y: number, fromKeyboard = false) {
    const t = TYPES.find((v) => v[0] === type)!;
    const size = doc.page_sizes?.[page] || { w: 612, h: 792 };
    // A stamp starts at the real size of a round company seal, 40 mm across, whatever the size of the page.
    const seal = type === 'stamp' ? stampBox(STAMP_DEFAULT_MM, size.w, size.h) : null;
    const w = seal ? seal.w : t[2];
    const h = seal ? seal.h : t[3] || (w * size.w) / size.h;
    if (!SENDER_MARK(type) && !active) return toast('Add a signer in step 1 first, then place fields for them.', true);
    if (full()) return;
    const box = { x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - h / 2, 0, 1 - h), w, h };
    // Dropped from the keyboard, a field lands in the middle of the page. Step down until it has a spot of its own.
    if (fromKeyboard) for (let i = 0; i < 12 && fields.current().some((f) => f.document_id === doc.id && f.page === page && overlap(box, f) > 0.4); i++) box.y = clamp(box.y + h + 0.012, 0, 1 - h);
    const f = makeField(type, doc.id, page, active || null, box);
    setFields((l) => [...l, f]);
    setSel(f.id);
    setTool(null);
    if (fromKeyboard) reveal.current = { id: f.id, focus: true };
  }

  function place(doc: any, page: number, x: number, y: number) {
    if (pressed.current) return;
    if (tool) add(tool, doc, page, x, y);
    else (setSel(null), setSheet(false));
  }

  // Keyboard and screen reader users cannot click a spot on the page, so choosing a field type from the keyboard
  // drops it in the middle of the page that is most in view. Arrow keys move it from there.
  function addInView(type: string) {
    const root = canvas.current;
    if (!root) return;
    const view = root.getBoundingClientRect();
    const top = Math.max(view.top, 0), bottom = Math.min(view.bottom, window.innerHeight);
    let best: { el: HTMLElement; r: DOMRect; seen: number } | null = null;
    root.querySelectorAll<HTMLElement>('[data-doc] .pdfpage').forEach((el) => {
      const r = el.getBoundingClientRect();
      const seen = Math.min(r.bottom, bottom) - Math.max(r.top, top);
      if (seen > (best?.seen ?? 0)) best = { el, r, seen };
    });
    const b = best as { el: HTMLElement; r: DOMRect; seen: number } | null;
    const doc = b && docs.find((d) => d.id === b.el.closest<HTMLElement>('[data-doc]')?.dataset.doc);
    if (!b || !doc) return toast('The document is still loading. Try again in a moment.', true);
    const y = ((Math.max(b.r.top, top) + Math.min(b.r.bottom, bottom)) / 2 - b.r.top) / b.r.height;
    add(type, doc, Number(b.el.dataset.page), 0.5, y, true);
  }

  function drag(e: React.PointerEvent, f: any, mode: 'move' | 'resize') {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    setSel(f.id);
    // Letting go somewhere else on the page (after trying to drag a locked field, say) should not deselect it.
    pressed.current = true;
    const lift = () => {
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
      setTimeout(() => (pressed.current = false), 0);
    };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    if (isLockedField(f)) return;
    e.preventDefault();
    const pageEl = (e.currentTarget as HTMLElement).closest('.pdfpage') as HTMLElement;
    const start = pageEl.getBoundingClientRect();
    const sx = (e.clientX - start.left) / start.width, sy = (e.clientY - start.top) / start.height;
    const px = e.clientX, py = e.clientY;
    const copy = mode === 'move' && e.altKey;
    const tag = `drag:${++dragCount}`;
    const step = { tag, within: Infinity };
    let id = f.id;
    let started = false;
    let others: any[] = [];
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - px, ev.clientY - py) < DRAG_START_PX) return;
        started = true;
        if (copy && !full()) {
          // Alt or Option + drag leaves the original where it is and moves a copy.
          const twin = { ...f, id: newId('fld') };
          id = twin.id;
          setFields((l) => [...l, twin], step);
          setSel(twin.id);
        }
        others = fields.current().filter((o) => o.document_id === f.document_id && o.page === f.page && o.id !== id);
      }
      // Measure against the page as it is now, so scrolling in the middle of a drag does not throw the field off.
      const r = pageEl.getBoundingClientRect();
      const dx = (ev.clientX - r.left) / r.width - sx, dy = (ev.clientY - r.top) / r.height - sy;
      let box = mode === 'move'
        ? { x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h), w: f.w, h: f.h }
        : { x: f.x, y: f.y, w: clamp(f.w + dx, MIN_W, 1 - f.x), h: clamp(f.h + dy, MIN_H, 1 - f.y) };
      let lines: Guide[] = [];
      if (!ev.altKey) {
        // Holding Alt turns snapping off for fine work.
        const s = snapBox(box, others, mode, { x: SNAP_PX / r.width, y: SNAP_PX / r.height });
        box = s.box;
        lines = s.guides;
      }
      setGuides(lines.length ? { doc: f.document_id, page: f.page, lines } : null);
      setFields((l) => l.map((x) => (x.id === id ? { ...x, ...box } : x)), step);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setGuides(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  const dup = (f: any) => {
    if (full()) return;
    const n = { ...f, id: newId('fld'), x: clamp(f.x + 0.015, 0, 1 - f.w), y: clamp(f.y + 0.015, 0, 1 - f.h) };
    setFields((l) => [...l, n]);
    setSel(n.id);
  };

  function copyToEveryPage(f: any) {
    const d = docs.find((x) => x.id === f.document_id);
    if (!d) return;
    const cur = fields.current();
    const copies: any[] = [];
    for (let p = 0; p < d.pages; p++) {
      if (p === f.page || cur.some((o) => o.document_id === f.document_id && o.page === p && o.type === f.type && overlap(f, o) > 0.6)) continue;
      copies.push({ ...f, id: newId('fld'), page: p });
    }
    if (cur.length + copies.length > MAX_FIELDS) return void toast('That would be more than 2,000 fields in one envelope. Remove some fields first.', true);
    if (!copies.length) return void toast('Every other page already has this field in the same spot.');
    setFields((l) => [...l, ...copies]); // one step, so one undo takes all the copies away again
    toast(`Copied to ${plural(copies.length, 'other page')}`);
  }

  async function findForMe() {
    if (finding) return;
    setNote(null);
    setFinding('Looking through your documents');
    const setFound = (text: string) => setNote({ text, count: fields.current().length });
    try {
      const all: (Found & { doc: string })[] = [];
      for (const d of docs) {
        const pdf = pdfs[d.id];
        if (!pdf) throw new Error('The document is still loading. Try again in a moment.');
        const pages = await scanPdf(pdf, (n, total) => setFinding(total > 3 ? `Looking at page ${n} of ${total}` : 'Looking through your documents'));
        all.push(...findFields(pages).map((f) => ({ ...f, doc: d.id })));
      }
      if (!all.length) return setFound('No blanks, form fields or tags found. Pick a field type and click where it goes.');

      const cur = fields.current();
      const fresh: any[] = [];
      const missing = new Set<number>();
      let taken = 0, lockedOut = 0;
      for (const f of all) {
        let rid = active;
        if (f.signer) {
          const r = signers[f.signer - 1];
          if (!r) {
            missing.add(f.signer);
            continue;
          }
          rid = r.id;
        }
        if (!rid || lockedIds.has(rid)) {
          lockedOut++;
          continue;
        }
        // Never stack a new field on one that is already there, or on one found a moment ago.
        if ([...cur, ...fresh].some((o) => o.document_id === f.doc && o.page === f.page && overlap(f, o) >= 0.3)) {
          taken++;
          continue;
        }
        if (cur.length + fresh.length >= MAX_FIELDS) break;
        fresh.push(makeField(f.type, f.doc, f.page, rid, { x: f.x, y: f.y, w: f.w, h: f.h }, {
          label: f.label || '',
          ...(f.source === 'form' && f.type !== 'signature' ? { required: !!f.required } : {}),
          ...(f.options?.length ? { options: f.options } : {}),
          ...(f.group ? { group_name: f.group } : {}),
        }));
      }
      if (fresh.length) {
        setFields((l) => [...l, ...fresh]); // one step: a single undo removes everything that was found
        reveal.current = { id: fresh[0].id, focus: false };
      }
      const people = new Set(fresh.map((f) => f.recipient_id));
      const forWhom = people.size === 1 ? ` for ${who(rcps.find((r) => r.id === [...people][0]))}` : '';
      const parts = [`Found ${plural(all.length, 'place')}.`];
      if (fresh.length) parts.push(`Added ${plural(fresh.length, 'field')}${forWhom}. Undo takes them away again.`);
      if (taken) parts.push(fresh.length ? `${taken} already had a field.` : taken === all.length ? 'Each one already has a field, so nothing was added.' : `${taken} already had a field.`);
      if (missing.size) parts.push(`${[...missing].sort((a, b) => a - b).map((n) => `Signer ${n}`).join(' and ')} ${missing.size === 1 ? 'is' : 'are'} not on this envelope yet. Add them in step 1, then look again.`);
      if (lockedOut) parts.push(active ? `${lockedOut} belong to someone who already finished, so they were left alone.` : 'Add a signer in step 1, then look again.');
      setFound(parts.join(' '));
      if (fresh.length) toast(`Added ${plural(fresh.length, 'field')}${forWhom}`);
    } catch (e: any) {
      setFound(e?.message?.startsWith('The document') ? e.message : 'We could not read this document. You can still place fields by hand.');
    } finally {
      setFinding('');
    }
  }

  // Keyboard: undo and redo, nudging, deleting, duplicating.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (ed.modalOpen) return;
      const t = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
      if (typing) return; // text boxes keep their own undo, arrows and delete
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) ed.redo();
        else ed.undo();
        return;
      }
      if (e.key === 'Escape') return void (setTool(null), setSel(null), setSheet(false));
      const f = fields.current().find((x) => x.id === sel);
      if (!f || isLockedField(f)) return;
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), remove(f.id));
      else if (nudge[e.key] && !mod && !e.altKey) {
        e.preventDefault();
        const s = e.shiftKey ? 0.01 : 0.002;
        patchField(f.id, { x: clamp(f.x + nudge[e.key][0] * s, 0, 1 - f.w), y: clamp(f.y + nudge[e.key][1] * s, 0, 1 - f.h) }, 'nudge');
      } else if (mod && k === 'd') (e.preventDefault(), dup(f));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = docs.length > 0 && docs.every((d) => pdfs[d.id]);
  const pct = (n: number) => +(n * 100).toFixed(1);
  const setSize = (f: any, key: 'w' | 'h', value: string) => {
    const n = Number(value) / 100;
    if (!Number.isFinite(n) || n <= 0) return;
    patchField(f.id, key === 'w' ? { w: clamp(n, MIN_W, 1 - f.x) } : { h: clamp(n, MIN_H, 1 - f.y) });
  };
  const undoRedo = <UndoRedo canUndo={fields.canUndo} canRedo={fields.canRedo} undo={ed.undo} redo={ed.redo} />;

  return (
    <div className="editor">
      <div className="pane ed-tools">
        <div className="ed-row-a">
          <div className="ed-group">
            <h3 id="ed-for">Fields for</h3>
            {signers.length === 0 && <div className="notice warn small">Add a signer in step 1 to place fields.</div>}
            <div className="ed-signers" role="group" aria-labelledby="ed-for">
              {open.map((r) => {
                const locked = lockedIds.has(r.id);
                return (
                  <button key={r.id} type="button" className={`btn sm${active === r.id ? ' on' : ''}`} style={{ ['--fc' as any]: color(r.id) }}
                    onClick={() => setActiveId(r.id)} aria-pressed={active === r.id} title={locked ? 'Already finished. The fields they signed stay where they are. A new field for them means they sign again.' : undefined}>
                    <span className="dot" style={{ background: color(r.id) }} /> <span className="truncate">{who(r)}</span>{locked && <><Lock /><span className="ed-sr">, already finished</span></>}
                  </button>
                );
              })}
            </div>
            {/* For a witness: their whole block at once, next to the signature they witness (editor/WitnessChoice.tsx). */}
            <WitnessBlockButton ed={ed} witness={rcps.find((r) => r.id === active && r.role === 'witness')} onPlaced={(id) => (setSel(id), (reveal.current = { id, focus: true }))} />
          </div>
          <div className="ed-only-sm">{undoRedo}</div>
        </div>

        <div className="ed-row-b">
          <div className="ed-group ed-findbox">
            <button type="button" className="btn sm ed-find" disabled={!ready || !!finding || !active || !!ed.wording} onClick={findForMe} aria-describedby="ed-find-help">
              <Wand /> {finding ? 'Looking' : 'Find fields for me'}
            </button>
            <p id="ed-find-help" className="muted small ed-hide-sm">Looks for form fields, labels such as &ldquo;Signature:&rdquo; with a blank after them, and tags such as {'{{signature}}'}.</p>
          </div>
          <div className="ed-group ed-palbox">
            <h3 id="ed-add">Add a field</h3>
            <div className="palette" role="group" aria-labelledby="ed-add">
              {TYPES.map(([t, label]) => {
                // Nothing is switched off once someone has finished. A new field or note then means they sign again,
                // which is asked before the change is saved.
                const again = anyLocked ? `${ed.lockedNames} already finished. Adding this means they have to sign again. You are asked before anything is saved.` : undefined;
                return (
                  <button key={t} type="button" className={tool === t ? 'on' : ''} title={again} disabled={!!ed.wording}
                    onClick={(e) => (e.detail === 0 ? addInView(t) : setTool(tool === t ? null : t))} aria-pressed={tool === t}>{label}</button>
                );
              })}
            </div>
          </div>
        </div>
        {/* The result stays until the fields change again, so it never describes something that is no longer true. */}
        <p className="small ed-status" role="status">{finding ? `${finding}…` : note && note.count === list.length ? note.text : ''}</p>
        <p className="muted small ed-hint">
          {ed.wording ? `The wording is locked, so the fields stay as the template has them. Select a field to see it, and to fill in one the template left empty for you. To change the fields, ask ${ed.wording.ask}.` : tool ? `Click on the page to place the ${TLABEL[tool].toLowerCase()} field.` : 'Pick a field, then click where it goes.'}
          {!ed.wording && <span className="ed-hide-sm">{tool ? '' : ' Drag to move, pull the corner to resize.'} Using the keyboard? Press Enter on a field type to drop it on the page in view, then move it with the arrow keys.</span>}
        </p>
      </div>

      <div className="ed-mid">
        <div className="ed-bar">
          <div className="ed-hide-sm">{undoRedo}</div>
          <div className="row" style={{ gap: 6 }} role="group" aria-label="Zoom">
            <button type="button" className="btn sm" onClick={() => setZoom((z) => clamp(+(z - 0.15).toFixed(2), 0.55, 1.6))} aria-label="Zoom out" disabled={zoom <= 0.55}>−</button>
            <span className="small num" aria-live="polite" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
            <button type="button" className="btn sm" onClick={() => setZoom((z) => clamp(+(z + 0.15).toFixed(2), 0.55, 1.6))} aria-label="Zoom in" disabled={zoom >= 1.6}>+</button>
          </div>
          <span className="muted small num" style={{ marginLeft: 'auto' }}>{plural(list.length, 'field')} placed</span>
        </div>
        <div className="canvas" ref={canvas} style={{ cursor: tool ? 'crosshair' : undefined }}>
          <div className="stack">
            {docs.map((d) => (
              <div key={d.id} data-doc={d.id}>
                <div className="muted small" style={{ fontWeight: 600, marginBottom: 6, textAlign: 'center' }}>{d.name}</div>
                <PdfDoc url={`/api/files/${d.file_id}/content`} zoom={zoom} onPageClick={(p, x, y) => place(d, p, x, y)} onDocument={(pdf) => setPdfs((m) => ({ ...m, [d.id]: pdf }))}
                  // Stamps on the page, printed like ink the way the signing page and the PDF print them.
                  // eslint-disable-next-line @next/next/no-img-element
                  ink={(page) => list.filter((f) => f.document_id === d.id && f.page === page && editorStampSrc(f, env.id, stamps)).map((f) => <span key={f.id} className="st-print" style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}><img src={editorStampSrc(f, env.id, stamps)!} alt="" style={turnStyle(editorStampTurn(f, stamps))} /></span>)}
                  overlay={(page) => (
                    <>
                      {list.filter((f) => f.document_id === d.id && f.page === page).map((f) => {
                        const locked = isLockedField(f);
                        const owner = f.recipient_id ? rcps.find((r) => r.id === f.recipient_id) : null;
                        return (
                          <div key={f.id} data-fid={f.id} className={`field edit${sel === f.id ? ' sel' : ''}${f.type === 'checkbox' || f.type === 'radio' ? ' box' : ''}${f.type === 'stamp' ? ' stamp' : ''}${strikeClass(f)}${locked ? ' locked' : ''}`}
                            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, ['--fc' as any]: color(f.recipient_id), borderRadius: f.type === 'radio' ? '50%' : undefined }}
                            tabIndex={0} role="button" aria-label={`${TLABEL[f.type]} field${owner ? ` for ${who(owner)}` : senderStamp(f) ? ', your own stamp' : ''}, page ${page + 1}${locked ? ', locked' : ''}`}
                            onClick={(e) => e.stopPropagation()} onFocus={() => setSel(f.id)} onPointerDown={(e) => drag(e, f, 'move')}>
                            {f.type !== 'checkbox' && f.type !== 'radio' && f.type !== 'strike' && <span className="tag">{locked && <Lock size={11} />}{f.type === 'note' ? f.value : senderStamp(f) ? `Your stamp${stamps.find((x) => x.id === f.stamp_id) ? `: ${stamps.find((x) => x.id === f.stamp_id).name}` : ''}` : f.label || TLABEL[f.type]}{!!f.required && f.type !== 'note' && <span className="req">*</span>}</span>}
                            {sel === f.id && !locked && <span className="grip" onPointerDown={(e) => drag(e, f, 'resize')} />}
                          </div>
                        );
                      })}
                      {guides && guides.doc === d.id && guides.page === page && guides.lines.map((g, i) => (
                        <span key={i} className={`ed-guide ${g.axis}`} aria-hidden="true"
                          style={g.axis === 'x' ? { left: `${g.at * 100}%`, top: `${g.from * 100}%`, height: `${(g.to - g.from) * 100}%` } : { top: `${g.at * 100}%`, left: `${g.from * 100}%`, width: `${(g.to - g.from) * 100}%` }} />
                      ))}
                    </>
                  )} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={`pane right ed-settings${selected ? ' has' : ''}${sheet ? ' open' : ''}`}>
        {!selected ? (
          <div className="muted small">
            <h3 style={{ color: 'var(--ink)', marginBottom: 8 }}>Field settings</h3>
            Select a field to edit it.
            <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Fields line up with each other as you drag. Hold Alt to place one freely.</li>
              <li>Alt or Option + drag makes a copy</li>
              <li>Arrow keys nudge, Shift for bigger steps</li>
              <li>Delete removes</li>
              <li>Ctrl or ⌘ + D duplicates</li>
              <li>Ctrl or ⌘ + Z undoes, add Shift to redo</li>
              <li>Esc deselects</li>
            </ul>
          </div>
        ) : (
          <div>
            <div className="ed-sheetbar">
              <span className="truncate"><span className="dot" style={{ background: color(selected.recipient_id) }} /> <b>{TLABEL[selected.type]}</b>{selLocked && <> <Lock /></>}</span>
              {!selLocked && <button type="button" className="btn sm" onClick={() => setSheet(!sheet)} aria-expanded={sheet}>{sheet ? 'Hide settings' : 'Settings'}</button>}
              {!selLocked && <button type="button" className="btn sm danger" onClick={() => remove(selected.id)}>Delete</button>}
              <button type="button" className="btn sm ghost" onClick={() => (setSel(null), setSheet(false))}>Done</button>
            </div>
            {selLocked ? (
              <div className="ed-sheetbody always">
                <h3 className="ed-hide-sm" style={{ marginBottom: 12 }}>{TLABEL[selected.type]}</h3>
                {ed.wording && !lockedIds.has(selected.recipient_id) ? <WordingField field={selected} lock={ed.wording} onValue={(v) => patchField(selected.id, { value: v })} />
                  : <div className="notice ed-lockline small"><Lock size={16} /><span>{who(rcps.find((r) => r.id === selected.recipient_id))} already finished, so this field stays where it is.</span></div>}
              </div>
            ) : (
              <div className="ed-sheetbody">
                <h3 className="ed-hide-sm" style={{ marginBottom: 12 }}>{TLABEL[selected.type]}</h3>
                {/* A strike-out has nothing to set: it is a line, it belongs to nobody, and its place is the whole of it. */}
                {selected.type === 'strike' && <p className="muted small" id="ed-strike-help">{STRIKE_HELP}</p>}
                {selected.type === 'stamp' ? (
                  <StampChoice field={selected} open={open} envelopeId={env.id} page={docs.find((d) => d.id === selected.document_id)?.page_sizes?.[selected.page] || { w: 612, h: 792 }} patch={(p) => patchField(selected.id, p)} />
                ) : !SENDER_MARK(selected.type) && (
                  <label className="f"><span>Assigned to</span>
                    <select value={selected.recipient_id || ''} onChange={(e) => patchField(selected.id, { recipient_id: e.target.value })}>
                      {open.map((r) => <option key={r.id} value={r.id}>{who(r)}</option>)}
                    </select>
                  </label>
                )}
                {/* A calculated field is never typed into: not required, no prefilled value (FieldLogic.tsx). */}
                {!SENDER_MARK(selected.type) && !senderStamp(selected) && !['date_signed', 'full_name', 'email'].includes(selected.type) && selected.formula == null && (
                  <label className="check ed-tap" style={{ marginBottom: 12 }}><input type="checkbox" checked={!!selected.required} onChange={(e) => patchField(selected.id, { required: e.target.checked })} /> Required</label>
                )}
                {!SENDER_MARK(selected.type) && !senderStamp(selected) && <label className="f"><span>Label <span className="hint">(shown to the signer, and read out by a screen reader)</span></span><input id="ed-label" value={selected.label || ''} maxLength={120} onChange={(e) => patchField(selected.id, { label: e.target.value })} /></label>}
                {PREFILL.includes(selected.type) && selected.formula == null && (
                  <>
                    {/* A date is picked, never typed: the server takes a real day as year-month-day (isDateValue). */}
                    <label className="f"><span>{selected.type === 'note' ? 'Text' : 'Prefilled value'}</span>{selected.type === 'date'
                      ? <input type="date" style={{ minHeight: 44 }} value={selected.value || ''} onChange={(e) => patchField(selected.id, { value: e.target.value })} />
                      : <textarea style={{ minHeight: 60 }} value={selected.value || ''} onChange={(e) => patchField(selected.id, { value: e.target.value })} />}</label>
                    {selected.type !== 'note' && <label className="check ed-tap" style={{ marginBottom: 12 }}><input type="checkbox" checked={!!selected.readonly} onChange={(e) => patchField(selected.id, { readonly: e.target.checked })} /> Read only</label>}
                  </>
                )}
                {selected.type === 'text' && (
                  <label className="f"><span>Validation</span>
                    <select value={selected.validation || ''} onChange={(e) => patchField(selected.id, { validation: e.target.value })}>
                      <option value="">None</option><option value="email">Email</option><option value="number">Number</option><option value="phone">Phone</option>
                    </select>
                  </label>
                )}
                {selected.type === 'dropdown' && <label className="f"><span>Options <span className="hint">(one per line)</span></span><textarea value={(selected.options || []).join('\n')} onChange={(e) => patchField(selected.id, { options: e.target.value.split('\n') })} onBlur={(e) => patchField(selected.id, { options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} /></label>}
                {selected.type === 'radio' && <label className="f"><span>Group <span className="hint">(one choice per group)</span></span><input value={selected.group_name || ''} onChange={(e) => patchField(selected.id, { group_name: e.target.value })} /></label>}
                {/* "Only show when..." and "Calculate from...", each said back as a sentence (FieldLogic.tsx). */}
                <FieldLogic key={selected.id} field={selected} fields={list} patch={(p) => patchField(selected.id, p)} />
                <div className="grid ed-size">
                  <label className="f"><span>Width <span className="hint">(%)</span></span><input type="number" inputMode="decimal" min={1} max={100} step={0.5} value={pct(selected.w)} onChange={(e) => setSize(selected, 'w', e.target.value)} /></label>
                  <label className="f"><span>Height <span className="hint">(%)</span></span><input type="number" inputMode="decimal" min={0.5} max={100} step={0.5} value={pct(selected.h)} onChange={(e) => setSize(selected, 'h', e.target.value)} /></label>
                </div>
                <p className="muted small" style={{ marginTop: -6 }}>Size as a share of the page.</p>
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <button type="button" className="btn sm" onClick={() => dup(selected)}>Duplicate</button>
                  {docs.find((d) => d.id === selected.document_id)?.pages > 1 && <button type="button" className="btn sm" onClick={() => copyToEveryPage(selected)}>Copy to every page</button>}
                  <button type="button" className="btn sm danger ed-hide-sm" onClick={() => remove(selected.id)}>Delete field</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
