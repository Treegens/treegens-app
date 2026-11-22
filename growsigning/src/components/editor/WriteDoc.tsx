'use client';
// The writing view of editor step 1 ("No document yet? Write one"): a title and the text, written with a few plain
// marks, a preview beside it on a wide screen (a Preview toggle on a phone), starters instead of a blank page, and,
// only where the AI is on for this account, "Describe what you need" and "Ask for a change". "Use this document"
// makes the PDF on the server (POST /write/render) and adds it like an upload, its tags becoming fields for the
// people of step 1 in order. The rules and the words are in src/lib/writedoc.ts; the server is src/server/writedoc.ts.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, toast } from '../ui';
import { useMe } from '../AppShell';
import type { Ed } from './shared';
import { TAG as TAG_RE } from '@/lib/autoplace';
import {
  AI_DRAFT_NOTE, CHANGE_PLACEHOLDER, DRAFT_PLACEHOLDER, PAPER_LABEL, WHAT_IS_SIGNED, WRITE_STARTERS, WRITE_TEXT_MAX, WRITE_TITLE_MAX, WRITE_PROMPT_MAX, WRITE_CHANGE_MAX,
  blanksIn, blanksLine, nextPlace, paperFor, tagChip, tagsIn, wordDiff, writeBlocks, type DiffPart, type Paper, type Piece, type WriteBlock,
} from '@/lib/writedoc';

// ---- Opening the view from a file's row ("Edit the text", FileRow.tsx) -----------------------------------------------
export type Writing = { replace?: string; fileId?: string } | null;
const OPEN = 'growsigning:write-open';
export const openWriting = (replace?: string, fileId?: string) => window.dispatchEvent(new CustomEvent(OPEN, { detail: { replace, fileId } }));
/** Whether step 1 shows the writing view, and for which document. ?write=1 in the address opens it once. */
export function useWriting(): [Writing, (w: Writing) => void] {
  const [w, setW] = useState<Writing>(null);
  useEffect(() => {
    const on = (e: Event) => setW((e as CustomEvent).detail || {});
    window.addEventListener(OPEN, on);
    const q = new URLSearchParams(window.location.search);
    if (q.get('write')) {
      setW({});
      q.delete('write');
      const rest = q.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    return () => window.removeEventListener(OPEN, on);
  }, []);
  return [w, setW];
}

type Info = { ai: boolean; sent?: string; left?: number };
type Snap = { title: string; text: string };
// What was written when Back was pressed, so opening the view again brings it back. In this tab only, for this person,
// until the text is made into the document.
type Kept = Snap & { paper: Paper; ai: boolean };
const kept = new Map<string, Kept>();
const CSS = `
.wd { display: grid; gap: 14px; }
.wd-hidden { display: none !important; }
.wd-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wd-head h2 { margin: 0; }
.wd-box { display: grid; gap: 6px; }
.wd-box label { font-weight: 600; }
.wd-box textarea { resize: vertical; }
.wd-cols { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
.wd-text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; line-height: 1.55; min-height: 340px; }
.wd-preview { border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; background: #fff; min-height: 340px; max-height: 70vh; overflow: auto; overflow-wrap: anywhere; }
.wd-preview h3 { font-size: 18px; margin: 0 0 10px; }
.wd-preview h4 { font-size: 15px; margin: 14px 0 6px; }
.wd-preview p { margin: 0 0 10px; }
.wd-preview ul, .wd-preview ol { margin: 0 0 10px; padding-inline-start: 22px; }
.wd-chip { display: inline-flex; align-items: center; min-height: 28px; padding: 2px 10px; margin: 2px 2px; border-radius: 6px; border: 1px dashed var(--green); background: var(--green-soft); color: var(--green-deep); font-size: 13px; font-weight: 600; vertical-align: middle; }
.wd-chip.s2 { border-color: var(--blue); background: var(--blue-soft); color: var(--blue); }
.wd-chip.s3 { border-color: var(--amber); background: var(--amber-soft); color: #7a4f0c; }
.wd-blank { display: inline; font: inherit; text-align: start; white-space: normal; -webkit-box-decoration-break: clone; box-decoration-break: clone; border: 0; border-bottom: 2px solid var(--amber); background: var(--amber-soft); color: inherit; padding: 0 3px; min-height: 28px; line-height: 1.6; cursor: pointer; border-radius: 3px; }
.wd-box textarea.wd-one { min-height: 46px; }
.wd-diff .wd-chip { margin: 0 2px; }
.wd-diff .wd-gap { color: var(--muted); }
.wd-diff ins { background: var(--green-soft); color: var(--green-deep); text-decoration: none; border-bottom: 2px solid var(--green); }
.wd-diff del { background: var(--red-soft); color: var(--red); }
.wd-diff { white-space: pre-wrap; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: #fff; max-height: 40vh; overflow: auto; font-size: 14px; }
.wd-starters { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.wd-starters .btn { white-space: normal; text-align: left; justify-content: flex-start; min-height: 44px; }
.wd .btn, .wd select { min-height: 44px; }
.wd input { min-height: 46px; box-sizing: border-box; }
.wd-tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.wd-only-phone { display: none; }
@media (max-width: 760px) {
  .wd-cols { grid-template-columns: minmax(0, 1fr); }
  .wd-only-phone { display: inline-flex; }
  .wd-cols[data-show='text'] .wd-preview { display: none; }
  .wd-cols[data-show='preview'] .wd-edit { display: none; }
}
`;

// Streams a writing call (Server-Sent Events, src/server/writedoc.ts askModel).
async function stream(path: string, body: any, signal: AbortSignal, on: (e: any) => void): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, credentials: 'same-origin' });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
    const d = await res.json().catch(() => ({}));
    throw Object.assign(new Error(d.error || 'The AI could not write it just now. Your text is as you left it. Try again in a minute.'), { code: d.code });
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const p of parts) if (p.startsWith('data: ')) try { on(JSON.parse(p.slice(6))); } catch {}
  }
}

export function WriteDoc({ ed, writing, onClose }: { ed: Ed; writing: NonNullable<Writing>; onClose: () => void }) {
  const me = useMe();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [paper, setPaper] = useState<Paper>(() => paperFor(me.account?.default_locale || (typeof navigator !== 'undefined' ? navigator.language : '')));
  const [info, setInfo] = useState<Info>({ ai: false });
  const [aiUsed, setAiUsed] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [request, setRequest] = useState('');
  const [focus, setFocus] = useState<'' | 'prompt' | 'request'>('');
  const [busy, setBusy] = useState<'' | 'draft' | 'change' | 'use'>('');
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ before: Snap; parts: DiffPart[] } | null>(null);
  const [show, setShow] = useState<'text' | 'preview'>('text');
  const [loading, setLoading] = useState(!!writing.fileId);
  const undo = useRef<Snap[]>([]), redo = useRef<Snap[]>([]), lastPush = useRef(0);
  const [, tick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  // Whether words are selected in the text right now: then "Ask for a change" changes only those, and says so.
  const [picked, setPicked] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const cur = (): Snap => ({ title, text });
  const keyOf = `${me.user?.id || ''}:${writing.fileId || ''}`;
  const latest = useRef<Kept>({ title, text, paper, ai: aiUsed });
  latest.current = { title, text, paper, ai: aiUsed };
  const used = useRef(false);

  useEffect(() => {
    api('/write').then(setInfo).catch(() => setInfo({ ai: false }));
    const k = kept.get(keyOf);
    if (k) (setTitle(k.title), setText(k.text), setPaper(k.paper), setAiUsed(k.ai), setLoading(false));
    else if (writing.fileId)
      api(`/write/source/${writing.fileId}`).then((s) => (setTitle(s.title), setText(s.text), setPaper(s.paper), setAiUsed(!!s.ai))).catch((e) => setError(e.message)).finally(() => setLoading(false));
    return () => {
      stop.current?.abort();
      const l = latest.current;
      if (!used.current && (l.text.trim() || l.title.trim())) kept.set(keyOf, l);
      else kept.delete(keyOf);
    };
  }, [writing.fileId, keyOf]);

  // Undo and redo cover typing and asked changes alike. Typing is remembered in steps of a moment.
  const remember = (before: Snap, force = false) => {
    if (!force && Date.now() - lastPush.current < 900) return;
    lastPush.current = Date.now();
    undo.current.push(before);
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    tick((n) => n + 1);
  };
  const restore = (s: Snap) => (setTitle(s.title), setText(s.text), setPicked(false));
  const doUndo = () => {
    const s = undo.current.pop();
    if (!s) return;
    redo.current.push(cur());
    restore(s);
    setPending(null);
    tick((n) => n + 1);
  };
  const doRedo = () => {
    const s = redo.current.pop();
    if (!s) return;
    undo.current.push(cur());
    restore(s);
    tick((n) => n + 1);
  };
  // Typing after an asked change keeps it: its "What changed" box goes, so its Undo can never throw the typing away.
  const type = (next: string) => (remember(cur()), setText(next.slice(0, WRITE_TEXT_MAX)), setError(''), setPending(null));

  const pick = (s: (typeof WRITE_STARTERS)[number] | null) => {
    remember(cur(), true);
    setTitle(s ? s.title : title);
    // The sender's own name is known: one blank fewer to stop on.
    const mine = String(me.user?.name || '').trim();
    setText(s ? (mine ? s.text.replace(/\[your name\]/g, mine) : s.text) : '');
    setPicked(false);
    setTimeout(() => area.current?.focus(), 0);
  };
  // A blank in the preview, clicked: its words are selected in the text, so typing replaces them.
  const toBlank = (n: number) => {
    const b = blanksIn(text)[n];
    if (!b) return;
    setShow('text');
    setTimeout(() => {
      const a = area.current;
      if (!a) return;
      a.focus();
      a.setSelectionRange(b.start, b.end);
    }, 0);
  };
  const addPlace = () => {
    const tag = nextPlace(text);
    const a = area.current;
    const at = a ? a.selectionEnd : text.length;
    const before = text.slice(0, at), after = text.slice(at);
    const piece = `${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${tag}\n`;
    remember(cur(), true);
    setText(`${before}${piece}${after}`.slice(0, WRITE_TEXT_MAX));
    setPending(null);
    setTimeout(() => (a?.focus(), a?.setSelectionRange(before.length + piece.length, before.length + piece.length)), 0);
  };

  async function draft() {
    if (!prompt.trim() || busy) return;
    setError('');
    setNotes([]);
    setPending(null);
    const before = cur();
    const ctl = new AbortController();
    stop.current = ctl;
    setBusy('draft');
    let got = '';
    let finished = false;
    try {
      remember(before, true);
      await stream('/write/draft', { prompt }, ctl.signal, (e) => {
        if (e.d) (got += e.d), setText(got.replace(/^#\s+[^\n]*\n?/, ''));
        if (e.done) {
          finished = true;
          setText(e.text);
          if (e.title && !before.title.trim()) setTitle(e.title);
          setNotes(e.notes || []);
          setAiUsed(true);
        }
        if (e.error) {
          finished = true;
          restore(before);
          undo.current.pop();
          setError(e.error);
        }
      });
    } catch (err: any) {
      if (ctl.signal.aborted) {
        // Stopped: what came is kept, made safe on the server exactly as a whole draft is (POST /write/tidy).
        const t = got.trim() ? await api('/write/tidy', { body: { text: got, typed: prompt, kind: 'draft' } }).catch(() => null) : null;
        if (t && t.text.trim()) {
          setText(t.text);
          if (t.title && !before.title.trim()) setTitle(t.title);
          setAiUsed(true);
          setNotes(['You stopped the AI part way. What it wrote so far is kept: read it through and finish it by typing.', ...(t.notes || [])]);
        } else {
          restore(before);
          undo.current.pop();
          if (got.trim()) setError('You stopped the AI, and what it had written could not be kept. Your text is as you left it. Ask again, or carry on typing.');
        }
      } else {
        restore(before);
        undo.current.pop();
        setError(err.message);
      }
      finished = true;
    } finally {
      if (!finished && !ctl.signal.aborted && !got.trim()) restore(before);
      setBusy('');
      stop.current = null;
      tick((n) => n + 1);
    }
  }

  async function change() {
    if (!request.trim() || busy || !text.trim()) return;
    setError('');
    setNotes([]);
    const before = cur();
    // The words selected in the text now, read from the text box itself: never a selection left from before a change.
    const a = area.current;
    const s = a && a.selectionEnd > a.selectionStart ? { start: a.selectionStart, end: a.selectionEnd } : null;
    const ctl = new AbortController();
    stop.current = ctl;
    setBusy('change');
    try {
      await stream('/write/change', { text, request, ...(s ? { selection: s } : {}) }, ctl.signal, (e) => {
        if (e.done) {
          remember(before, true);
          setText(e.text);
          setNotes(e.notes || []);
          setAiUsed(true);
          setPending({ before, parts: wordDiff(before.text, e.text) });
          setPicked(false);
          setRequest('');
        }
        if (e.error) setError(e.error);
      });
    } catch (err: any) {
      if (!ctl.signal.aborted) setError(err.message);
    } finally {
      setBusy('');
      stop.current = null;
    }
  }

  async function use() {
    const blanks = blanksIn(text);
    if (blanks.length) return setError(blanksLine(blanks.length));
    if (!text.trim()) return setError('Write the text of the document first. You can also start from one of the starters.');
    setBusy('use');
    setError('');
    try {
      const r = await api('/write/render', { body: { title, text, paper, ai: aiUsed } });
      ed.addWritten(r.file, r.fields, writing.replace);
      used.current = true;
      const people = new Set(r.fields.map((f: any) => f.signer)).size;
      toast(r.warning || (writing.replace ? 'The document was made again from your text. Check its fields in step 2.' : people > 1 ? `Added. Under People, type who signs: the first row is Person 1, the second row Person 2${people > 2 ? ', and so on' : ''}.` : people ? 'Added. Under People, type who signs in the first row: that is Person 1.' : 'Added. Place the fields in step 2.'), !!r.warning);
      onClose();
    } catch (e: any) {
      setError(e.message);
      if (e.code === 'blanks') toBlank(0);
    } finally {
      setBusy('');
    }
  }

  const blanks = blanksIn(text).length;
  const chipClass = (n: number) => `wd-chip${n > 1 ? ` s${Math.min(3, n)}` : ''}`;
  let blankNo = 0;
  const pieces = (items: Piece[], key: string): ReactNode[] =>
    items.map((p, i) => {
      if (p.tag) return <span key={`${key}-${i}`} className={chipClass(p.tag.signer)}>{tagChip(p.tag)}</span>;
      if (p.blank) {
        const n = blankNo++;
        // A span acting as a button: a real <button> is always a block in the line, so a long blank broke its sentence.
        return <span key={`${key}-${i}`} role="button" tabIndex={0} className="wd-blank" onClick={() => toBlank(n)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toBlank(n))} aria-label={`Fill in: ${p.text.slice(1, -1)}`}>{p.text}</span>;
      }
      return p.bold ? <b key={`${key}-${i}`}>{p.text}</b> : <span key={`${key}-${i}`}>{p.text}</span>;
    });
  const block = (b: WriteBlock, i: number) => {
    if (b.kind === 'h1') return <h4 key={i} dir="auto">{pieces(b.items[0], `${i}`)}</h4>;
    if (b.kind === 'h2') return <h4 key={i} dir="auto" style={{ fontSize: 14 }}>{pieces(b.items[0], `${i}`)}</h4>;
    if (b.kind === 'p') return <p key={i} dir="auto">{pieces(b.items[0], `${i}`)}</p>;
    const L = b.kind === 'ul' ? 'ul' : 'ol';
    return <L key={i} dir="auto">{b.items.map((it, j) => <li key={j}>{pieces(it, `${i}-${j}`)}</li>)}</L>;
  };
  const grow = (which: 'prompt' | 'request', value: string) => (focus === which || value ? 3 : 1);
  // "What changed" reads like the preview: no marks, places to sign as their chips, and long unchanged stretches cut
  // to their ends so the change itself stands out.
  // Each tag's chip as the whole text numbers it (the text after the change, then the one before for a tag taken out).
  const chipFor = (raw: string) => {
    for (const whole of [text, pending?.before.text || '']) {
      const t = tagsIn(whole).find((x) => whole.slice(x.start, x.end) === raw);
      if (t) return t;
    }
    return tagsIn(raw)[0];
  };
  const readable = (t: string) => t.replace(/\*\*/g, '').replace(/^#{1,3}\s+/gm, '').replace(new RegExp(TAG_RE.source, 'gi'), (m) => { const c = chipFor(m); return ` ${c ? tagChip(c) : m} `; });
  const gap = (t: string, first: boolean, lastOne: boolean) => {
    if (t.length <= 160) return t;
    const head = first ? '' : t.slice(0, 70).replace(/\S*$/, '');
    const tail = lastOne ? '' : t.slice(-70).replace(/^\S*/, '');
    return `${head}\u0000${tail}`;
  };
  const shown = (t: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = new RegExp(`${TAG_RE.source}|\u0000`, 'gi');
    let at = 0, n = 0;
    const plainOf = (x: string) => x.replace(/\*\*/g, '').replace(/^#{1,3}\s+/gm, '');
    for (const m of t.matchAll(re)) {
      if (m.index! > at) out.push(plainOf(t.slice(at, m.index)));
      if (m[0] === '\u0000') out.push(<span key={`${key}g${n++}`} className="wd-gap">{'\n…\n'}</span>);
      else {
        const tag = chipFor(m[0]);
        out.push(<span key={`${key}t${n++}`} className={chipClass(tag?.signer || 1)}>{tag ? tagChip(tag) : m[0]}</span>);
      }
      at = m.index! + m[0].length;
    }
    if (at < t.length) out.push(plainOf(t.slice(at)));
    return out;
  };

  return (
    <section className="wd" aria-labelledby="wd-h" data-feature="ds-write-doc">
      <style>{CSS}</style>
      <div className="wd-head">
        <h2 id="wd-h">Write a document</h2>
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy === 'use'}>Back</button>
      </div>

      {info.ai && (
        <div className="wd-box" data-feature="ds-ai-assist">
          <label htmlFor="wd-prompt">Describe what you need</label>
          <textarea id="wd-prompt" className={grow('prompt', prompt) === 1 ? 'wd-one' : undefined} rows={grow('prompt', prompt)} value={prompt} maxLength={WRITE_PROMPT_MAX} placeholder={DRAFT_PLACEHOLDER}
            onFocus={() => setFocus('prompt')} onBlur={() => setFocus('')} onChange={(e) => setPrompt(e.target.value)} aria-describedby="wd-sent" />
          <div className="wd-tools">
            {busy === 'draft'
              ? <button type="button" className="btn" onClick={() => stop.current?.abort()}>Stop</button>
              : <button type="button" className="btn" onClick={draft} disabled={!prompt.trim() || !!busy}>Write it</button>}
            {busy === 'draft' && <span className="muted small" role="status">Writing. You can stop it at any time.</span>}
          </div>
          <p id="wd-sent" className="muted small" style={{ margin: 0 }}>{info.sent}</p>
        </div>
      )}

      {aiUsed && <p className="notice small" role="note" style={{ margin: 0 }}>{AI_DRAFT_NOTE}</p>}
      {notes.map((n) => <p key={n} className="notice warn small" style={{ margin: 0 }}>{n}</p>)}
      {error && (
        <div className="notice warn small" role="alert" style={{ margin: 0 }}>
          {error}
          {blanks > 0 && error === blanksLine(blanks) && <> <button type="button" className="btn sm" onClick={() => toBlank(0)}>Go to the first blank</button></>}
        </div>
      )}

      {loading ? <p className="muted" role="status">Opening the text…</p> : <>
        {!text.trim() && !busy && (
          <div>
            <p className="muted small" style={{ margin: '0 0 8px' }}>Start from one of these, or type on the blank page below.</p>
            <div className="wd-starters" role="group" aria-label="Starters">
              {WRITE_STARTERS.map((s) => <button key={s.id} type="button" className="btn" onClick={() => pick(s)}>{s.name}</button>)}
            </div>
          </div>
        )}

        <div className="wd-box">
          <label htmlFor="wd-title">Title</label>
          <input id="wd-title" style={{ minHeight: 46 }} value={title} maxLength={WRITE_TITLE_MAX} placeholder="For example: Logo design agreement" onChange={(e) => (remember(cur()), setTitle(e.target.value))} />
        </div>

        <div className="wd-tools wd-only-phone" role="group" aria-label="Show">
          <button type="button" className="btn sm" aria-pressed={show === 'preview'} onClick={() => setShow(show === 'text' ? 'preview' : 'text')}>{show === 'text' ? 'Preview' : 'Back to the text'}</button>
        </div>

        <div className="wd-cols" data-show={show}>
          <div className="wd-edit wd-box">
            <label htmlFor="wd-text">Text</label>
            <textarea id="wd-text" ref={area} className="wd-text" value={text} aria-describedby="wd-marks" maxLength={WRITE_TEXT_MAX} readOnly={busy === 'draft'}
              onChange={(e) => type(e.target.value)} onSelect={(e) => setPicked(e.currentTarget.selectionEnd > e.currentTarget.selectionStart)} onKeyUp={(e) => setPicked(e.currentTarget.selectionEnd > e.currentTarget.selectionStart)} onMouseUp={(e) => setPicked(e.currentTarget.selectionEnd > e.currentTarget.selectionStart)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? doRedo() : doUndo());
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') (e.preventDefault(), doRedo());
              }} />
            <p id="wd-marks" className="muted small" style={{ margin: 0 }}>
              Start a line with # for a heading or - for a list. **Two stars** make words bold. Words in [square brackets] are blanks to fill in. Use Add a place to sign for each person who signs.
            </p>
            <div className="wd-tools">
              <button type="button" className="btn sm" onClick={doUndo} disabled={!undo.current.length || !!busy}>Undo</button>
              <button type="button" className="btn sm" onClick={doRedo} disabled={!redo.current.length || !!busy}>Redo</button>
              <button type="button" className="btn sm" onClick={addPlace} disabled={!!busy}>Add a place to sign</button>
            </div>
            {info.ai && (
              <div className="wd-box" data-feature="ds-ai-assist">
                <label htmlFor="wd-change">Ask for a change</label>
                <textarea id="wd-change" className={grow('request', request) === 1 ? 'wd-one' : undefined} rows={grow('request', request)} value={request} maxLength={WRITE_CHANGE_MAX} placeholder={CHANGE_PLACEHOLDER} aria-describedby="wd-change-hint"
                  onFocus={() => setFocus('request')} onBlur={() => setFocus('')} onChange={(e) => setRequest(e.target.value)} />
                <p id="wd-change-hint" className="muted small" style={{ margin: 0 }} aria-live="polite">{picked ? 'Only the words you selected change. Click in the text without selecting to change all of it.' : 'Select words in the text first to change only those.'}</p>
                <div className="wd-tools">
                  {busy === 'change'
                    ? <button type="button" className="btn" onClick={() => stop.current?.abort()}>Stop</button>
                    : <button type="button" className="btn" onClick={change} disabled={!request.trim() || !text.trim() || !!busy}>Ask for a change</button>}
                  {busy === 'change' && <span className="muted small" role="status">Changing it.</span>}
                </div>
              </div>
            )}
          </div>
          <div className="wd-preview" role="region" aria-label="Preview" tabIndex={0}>
            {title.trim() && <h3 dir="auto">{title}</h3>}
            {text.trim() ? writeBlocks(text).map(block) : <p className="muted">The preview shows here as you type.</p>}
          </div>
        </div>

        {pending && (
          <div className="wd-box" role="region" aria-label="What changed">
            <b>What changed</b>
            <div className="wd-diff" tabIndex={0}>
              {pending.parts.map((p, i) => {
                const words = shown(p.kind === 'same' ? gap(p.text, i === 0, i === pending.parts.length - 1) : p.text, `${i}`);
                return p.kind === 'add' ? <ins key={i} aria-label={`Added: ${readable(p.text)}`}>{words}</ins> : p.kind === 'del' ? <del key={i} aria-label={`Removed: ${readable(p.text)}`}>{words}</del> : <span key={i}>{words}</span>;
              })}
            </div>
            <div className="wd-tools">
              <button type="button" className="btn primary" onClick={() => setPending(null)}>Keep the change</button>
              {/* The change is the last step in Undo (typing after it closes this box), so this is the same Undo. */}
              <button type="button" className="btn" onClick={doUndo}>Undo the change</button>
            </div>
          </div>
        )}

        <p className="muted small" style={{ margin: 0 }}>{WHAT_IS_SIGNED}{blanks ? ` ${blanks === 1 ? 'One blank is' : `${blanks} blanks are`} still to fill in.` : ''}</p>
        <div className="wd-tools">
          <label className="small" htmlFor="wd-paper">Paper</label>
          <select id="wd-paper" value={paper} onChange={(e) => setPaper(e.target.value === 'letter' ? 'letter' : 'a4')} style={{ width: 'auto', minHeight: 44 }}>
            {(['a4', 'letter'] as Paper[]).map((p) => <option key={p} value={p}>{PAPER_LABEL[p]}</option>)}
          </select>
          <span className="grow" />
          <button type="button" className="btn primary" id="wd-use" onClick={use} disabled={!!busy}>{busy === 'use' ? 'Making the PDF…' : 'Use this document'}</button>
        </div>
      </>}
    </section>
  );
}
