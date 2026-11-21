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
import {
  AI_DRAFT_NOTE, CHANGE_PLACEHOLDER, DRAFT_PLACEHOLDER, PAPER_LABEL, WHAT_IS_SIGNED, WRITE_STARTERS, WRITE_TEXT_MAX, WRITE_TITLE_MAX, WRITE_PROMPT_MAX, WRITE_CHANGE_MAX,
  blanksIn, blanksLine, cleanModelText, paperFor, signersNeeded, tagChip, wordDiff, writeBlocks, type DiffPart, type Paper, type Piece, type WriteBlock,
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
const CSS = `
.wd { display: grid; gap: 14px; }
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
.wd-blank { font: inherit; border: 0; border-bottom: 2px solid var(--amber); background: var(--amber-soft); color: inherit; padding: 0 3px; min-height: 28px; cursor: pointer; border-radius: 3px; }
.wd-diff ins { background: var(--green-soft); color: var(--green-deep); text-decoration: none; border-bottom: 2px solid var(--green); }
.wd-diff del { background: var(--red-soft); color: var(--red); }
.wd-diff { white-space: pre-wrap; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: #fff; max-height: 40vh; overflow: auto; font-size: 14px; }
.wd-starters { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.wd-starters .btn { white-space: normal; text-align: left; justify-content: flex-start; min-height: 44px; }
.wd .btn, .wd select { min-height: 44px; }
.wd input { min-height: 46px; }
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
  const sel = useRef<{ start: number; end: number } | null>(null);
  const stop = useRef<AbortController | null>(null);
  const cur = (): Snap => ({ title, text });

  useEffect(() => {
    api('/write').then(setInfo).catch(() => setInfo({ ai: false }));
    if (writing.fileId)
      api(`/write/source/${writing.fileId}`).then((s) => (setTitle(s.title), setText(s.text), setPaper(s.paper), setAiUsed(!!s.ai))).catch((e) => setError(e.message)).finally(() => setLoading(false));
    return () => stop.current?.abort();
  }, [writing.fileId]);

  // Undo and redo cover typing and asked changes alike. Typing is remembered in steps of a moment.
  const remember = (before: Snap, force = false) => {
    if (!force && Date.now() - lastPush.current < 900) return;
    lastPush.current = Date.now();
    undo.current.push(before);
    if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    tick((n) => n + 1);
  };
  const restore = (s: Snap) => (setTitle(s.title), setText(s.text));
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
  const type = (next: string) => (remember(cur()), setText(next.slice(0, WRITE_TEXT_MAX)), setError(''));

  const pick = (s: (typeof WRITE_STARTERS)[number] | null) => {
    remember(cur(), true);
    setTitle(s ? s.title : title);
    setText(s ? s.text : '');
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
    const n = signersNeeded(text) + 1;
    const tag = n === 1 ? '{{signature}} {{date}}\n{{name}}' : `{{signature${n}}} {{date${n}}}\n{{name${n}}}`;
    const a = area.current;
    const at = a ? a.selectionEnd : text.length;
    const before = text.slice(0, at), after = text.slice(at);
    const piece = `${before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''}${tag}\n`;
    remember(cur(), true);
    setText(`${before}${piece}${after}`.slice(0, WRITE_TEXT_MAX));
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
        // Stopped: what came is kept, made safe like a whole draft would be.
        if (got.trim()) (setText(cleanModelText(got.replace(/^#\s+[^\n]*\n?/, ''))), setAiUsed(true), setNotes(['You stopped the AI part way. What it wrote so far is kept: read it through and finish it by typing.']));
        else (restore(before), undo.current.pop());
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
    const s = sel.current && sel.current.end > sel.current.start ? sel.current : null;
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
      const people = [...new Set(r.fields.map((f: any) => f.signer))].sort().map((n) => `Signer ${n}`);
      toast(r.warning || (writing.replace ? 'The document was made again from your text. Check its fields in step 2.' : people.length ? `Added. Its places to fill in are for ${people.join(' and ')}: type who they are under People.` : 'Added. Place the fields in step 2.'), !!r.warning);
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
        return <button key={`${key}-${i}`} type="button" className="wd-blank" onClick={() => toBlank(n)} aria-label={`Fill in: ${p.text.slice(1, -1)}`}>{p.text}</button>;
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
          <textarea id="wd-prompt" rows={grow('prompt', prompt)} value={prompt} maxLength={WRITE_PROMPT_MAX} placeholder={DRAFT_PLACEHOLDER}
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
          <input id="wd-title" value={title} maxLength={WRITE_TITLE_MAX} placeholder="For example: Logo design agreement" onChange={(e) => (remember(cur()), setTitle(e.target.value))} />
        </div>

        <div className="wd-tools wd-only-phone" role="group" aria-label="Show">
          <button type="button" className="btn sm" aria-pressed={show === 'preview'} onClick={() => setShow(show === 'text' ? 'preview' : 'text')}>{show === 'text' ? 'Preview' : 'Back to the text'}</button>
        </div>

        <div className="wd-cols" data-show={show}>
          <div className="wd-edit wd-box">
            <label htmlFor="wd-text">Text</label>
            <textarea id="wd-text" ref={area} className="wd-text" value={text} aria-describedby="wd-marks" maxLength={WRITE_TEXT_MAX} readOnly={busy === 'draft'}
              onChange={(e) => type(e.target.value)} onSelect={(e) => (sel.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') (e.preventDefault(), e.shiftKey ? doRedo() : doUndo());
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') (e.preventDefault(), doRedo());
              }} />
            <p id="wd-marks" className="muted small" style={{ margin: 0 }}>
              Start a line with # for a heading or - for a list. **Two stars** make words bold. Words in [square brackets] are blanks to fill in. {'{{signature}}'} is where Signer 1 signs, {'{{signature2}}'} Signer 2.
            </p>
            <div className="wd-tools">
              <button type="button" className="btn sm" onClick={doUndo} disabled={!undo.current.length || !!busy}>Undo</button>
              <button type="button" className="btn sm" onClick={doRedo} disabled={!redo.current.length || !!busy}>Redo</button>
              <button type="button" className="btn sm" onClick={addPlace} disabled={!!busy}>Add a place to sign</button>
            </div>
            {info.ai && (
              <div className="wd-box" data-feature="ds-ai-assist">
                <label htmlFor="wd-change">Ask for a change</label>
                <textarea id="wd-change" rows={grow('request', request)} value={request} maxLength={WRITE_CHANGE_MAX} placeholder={CHANGE_PLACEHOLDER} aria-describedby="wd-change-hint"
                  onFocus={() => setFocus('request')} onBlur={() => setFocus('')} onChange={(e) => setRequest(e.target.value)} />
                <p id="wd-change-hint" className="muted small" style={{ margin: 0 }}>Select words in the text first to change only those.</p>
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
              {pending.parts.map((p, i) => (p.kind === 'add' ? <ins key={i} aria-label={`Added: ${p.text}`}>{p.text}</ins> : p.kind === 'del' ? <del key={i} aria-label={`Removed: ${p.text}`}>{p.text}</del> : <span key={i}>{p.text}</span>))}
            </div>
            <div className="wd-tools">
              <button type="button" className="btn" onClick={() => setPending(null)}>Keep the change</button>
              <button type="button" className="btn" onClick={() => (restore(pending.before), undo.current.pop(), setPending(null), tick((n) => n + 1))}>Undo</button>
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
          <button type="button" className="btn" onClick={use} disabled={!!busy}>{busy === 'use' ? 'Making the PDF…' : 'Use this document'}</button>
        </div>
      </>}
    </section>
  );
}
