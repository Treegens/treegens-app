'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, COLORS, ROLE_LABEL, newId, oops, toast, Leaf } from './ui';
import { useMe } from './AppShell';
import { PdfDoc } from './PdfDoc';
import { fmtNum, sheetsSaved, impactOf, fmtTrees } from '@/lib/impact';

// [type, label, width, height] with sizes as a fraction of the page. Height 0 means "make it square".
const TYPES: [string, string, number, number][] = [
  ['signature', 'Signature', 0.22, 0.055], ['initials', 'Initials', 0.08, 0.045], ['date_signed', 'Date signed', 0.14, 0.026], ['full_name', 'Name', 0.2, 0.026],
  ['email', 'Email', 0.24, 0.026], ['company', 'Company', 0.2, 0.026], ['title', 'Title', 0.2, 0.026], ['text', 'Text', 0.22, 0.026],
  ['number', 'Number', 0.12, 0.026], ['date', 'Date', 0.14, 0.026], ['checkbox', 'Checkbox', 0.024, 0], ['radio', 'Radio', 0.024, 0],
  ['dropdown', 'Dropdown', 0.2, 0.026], ['attachment', 'Attachment', 0.2, 0.03], ['note', 'Note', 0.25, 0.026],
];
const TLABEL = Object.fromEntries(TYPES.map((t) => [t[0], t[1]]));
const PREFILL = ['text', 'number', 'date', 'company', 'title', 'note'];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const SIGNS = (r: any) => r.role === 'signer' || r.role === 'inperson';

export function Editor({ id }: { id: string }) {
  const me = useMe();
  const router = useRouter();
  const [env, setEnv] = useState<any>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [rcps, setRcps] = useState<any[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [step, setStep] = useState(1);
  const [tool, setTool] = useState<string | null>(null);
  const [active, setActive] = useState<string>('');
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [state, setState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [more, setMore] = useState<string | null>(null);
  const latest = useRef<any>(null);
  const isTpl = env?.kind === 'template';

  useEffect(() => {
    api(`/envelopes/${id}`).then(({ envelope: e }) => {
      if (e.status !== 'draft') return router.replace(`/app/envelopes/${id}`);
      setEnv(e);
      setDocs(e.documents);
      setRcps(e.recipients);
      setFields(e.fields);
      setActive(e.recipients.find(SIGNS)?.id || '');
    }).catch((e) => (oops(e), router.replace('/app/envelopes')));
    api('/contacts').then((d) => setContacts(d.contacts)).catch(() => {});
  }, [id, router]);

  latest.current = env && { subject: env.subject, message: env.message, ordered: env.ordered, reminder_days: env.reminder_days, expire_days: env.expire_days, documents: docs, recipients: rcps, fields };
  const dirty = () => setState('dirty');
  const save = useCallback(async () => {
    if (!latest.current) return;
    setState('saving');
    try {
      await api(`/envelopes/${id}`, { method: 'PUT', body: latest.current });
      setState((s) => (s === 'saving' ? 'saved' : s));
    } catch (e) {
      setState('dirty');
      throw e;
    }
  }, [id]);
  useEffect(() => {
    if (state !== 'dirty') return;
    const t = setTimeout(() => save().catch(oops), 1200);
    return () => clearTimeout(t);
  }, [state, env, docs, rcps, fields, save]);

  const patchEnv = (p: any) => (setEnv((e: any) => ({ ...e, ...p })), dirty());
  const patchRcp = (rid: string, p: any) => (setRcps((l) => l.map((r) => (r.id === rid ? { ...r, ...p } : r))), dirty());
  const patchField = (fid: string, p: any) => (setFields((l) => l.map((f) => (f.id === fid ? { ...f, ...p } : f))), dirty());
  const color = (rid: string | null) => (rid ? COLORS[Math.max(0, rcps.findIndex((r) => r.id === rid)) % COLORS.length] : '#6b7280');

  async function addFiles(list: FileList | File[] | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const fd = new FormData();
        fd.append('file', file);
        const f = await api('/files', { form: fd });
        setDocs((d) => [...d, { id: newId('doc'), file_id: f.id, name: f.name, pages: f.pages, page_sizes: f.page_sizes }]);
        if (!latest.current?.subject) setEnv((e: any) => (e.subject ? e : { ...e, subject: isTpl ? f.name : `Please sign: ${f.name}` }));
      }
      dirty();
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  }
  const removeDoc = (did: string) => (setDocs((d) => d.filter((x) => x.id !== did)), setFields((f) => f.filter((x) => x.document_id !== did)), dirty());
  const moveDoc = (i: number, by: number) => (setDocs((d) => {
    const n = [...d];
    const [x] = n.splice(i, 1);
    n.splice(clamp(i + by, 0, n.length), 0, x);
    return n;
  }), dirty());

  function addRcp(p: any = {}) {
    const r = { id: newId('rcp'), role: 'signer', role_name: isTpl ? `Signer ${rcps.length + 1}` : '', name: '', email: '', routing_order: rcps.length ? Math.max(...rcps.map((x) => x.routing_order)) + 1 : 1, access_code: '', note: '', ...p };
    setRcps((l) => [...l, r]);
    if (!active && SIGNS(r)) setActive(r.id);
    dirty();
  }
  const removeRcp = (rid: string) => (setRcps((l) => l.filter((r) => r.id !== rid)), setFields((f) => f.filter((x) => x.recipient_id !== rid)), active === rid && setActive(''), dirty());

  function place(doc: any, page: number, x: number, y: number) {
    if (!tool) return setSel(null);
    const t = TYPES.find((v) => v[0] === tool)!;
    const size = doc.page_sizes?.[page] || { w: 612, h: 792 };
    const w = t[2];
    const h = t[3] || (w * size.w) / size.h;
    const rid = tool === 'note' ? null : active || rcps.find(SIGNS)?.id;
    if (tool !== 'note' && !rid) return toast('Add a signer first, then place fields for them.', true);
    const f = {
      id: newId('fld'), document_id: doc.id, recipient_id: rid, type: tool, page, x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - h / 2, 0, 1 - h), w, h,
      required: !['checkbox', 'company', 'title', 'attachment'].includes(tool), label: '', value: tool === 'note' ? 'Note' : '', options: tool === 'dropdown' ? ['Option 1', 'Option 2'] : [],
      group_name: tool === 'radio' ? 'Group 1' : '', validation: '', readonly: tool === 'note',
    };
    setFields((l) => [...l, f]);
    setSel(f.id);
    setTool(null);
    dirty();
  }

  function drag(e: React.PointerEvent, f: any, mode: 'move' | 'resize') {
    e.stopPropagation();
    e.preventDefault();
    setSel(f.id);
    const rect = (e.currentTarget as HTMLElement).closest('.pdfpage')!.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / rect.width, dy = (ev.clientY - sy) / rect.height;
      patchField(f.id, mode === 'move' ? { x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) } : { w: clamp(f.w + dx, 0.012, 1 - f.x), h: clamp(f.h + dy, 0.008, 1 - f.y) });
    };
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const selected = fields.find((f) => f.id === sel);
  const dup = useCallback((f: any, p: any = {}) => {
    const n = { ...f, id: newId('fld'), x: clamp(f.x + 0.015, 0, 1 - f.w), y: clamp(f.y + 0.015, 0, 1 - f.h), ...p };
    setFields((l) => [...l, n]);
    setState('dirty');
    return n;
  }, []);

  useEffect(() => {
    if (step !== 2) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'Escape') (setTool(null), setSel(null));
      const f = fields.find((x) => x.id === sel);
      if (!f) return;
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), setFields((l) => l.filter((x) => x.id !== f.id)), setSel(null), setState('dirty'));
      else if (nudge[e.key]) {
        e.preventDefault();
        const s = e.shiftKey ? 0.01 : 0.002;
        patchField(f.id, { x: clamp(f.x + nudge[e.key][0] * s, 0, 1 - f.w), y: clamp(f.y + nudge[e.key][1] * s, 0, 1 - f.h) });
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') (e.preventDefault(), setSel(dup(f).id));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [step, sel, fields, dup]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = docs.reduce((n, d) => n + d.pages, 0);
  const problems = useMemo(() => {
    const p: string[] = [];
    if (!docs.length) p.push('Add at least one document.');
    if (!rcps.length) p.push('Add at least one recipient.');
    for (const r of rcps) {
      const who = r.name || r.role_name || 'A recipient';
      if (!isTpl && (!r.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim()))) p.push(`${who} needs a name and a valid email.`);
      if (isTpl && !r.role_name?.trim() && !r.email) p.push('Give every open recipient a role name, such as "Client".');
      if (SIGNS(r) && !fields.some((f) => f.recipient_id === r.id)) p.push(`${who} has no fields to sign yet.`);
    }
    return p;
  }, [docs, rcps, fields, isTpl]);

  async function go(n: number) {
    if (n > 1 && !docs.length) return toast('Upload a document first.', true);
    try {
      await save();
      setStep(n);
    } catch (e) {
      oops(e);
    }
  }

  async function send() {
    setBusy(true);
    try {
      await save();
      if (isTpl) {
        toast('Template saved');
        return router.push('/app/templates');
      }
      await api(`/envelopes/${id}/send`, { method: 'POST' });
      toast('Sent. No paper involved.');
      router.push(`/app/envelopes/${id}?sent=1`);
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <div className="muted center" style={{ padding: 80 }}>Loading…</div>;
  const impact = impactOf(sheetsSaved(pages, rcps.length));

  return (
    <div>
      <div className="topbar">
        <button className="btn sm ghost" onClick={() => save().catch(() => {}).then(() => router.push(isTpl ? '/app/templates' : '/app/envelopes'))}>← Save and close</button>
        <div className="steps grow">
          {['Add', 'Place fields', isTpl ? 'Review' : 'Review and send'].map((s, i) => (
            <button key={s} className={step === i + 1 ? 'on' : ''} onClick={() => go(i + 1)}><span className="n">{i + 1}</span><span className={step === i + 1 ? '' : 'hide-sm'}>{s}</span></button>
          ))}
        </div>
        <span className="muted small hide-sm" aria-live="polite">{state === 'saved' ? 'All changes saved' : state === 'saving' ? 'Saving…' : 'Unsaved changes'}</span>
        {step < 3 ? <button className="btn primary" onClick={() => go(step + 1)}>Next</button>
          : <button className="btn primary" disabled={busy || problems.length > 0} onClick={send}>{isTpl ? 'Save template' : 'Send'}</button>}
      </div>

      {step === 1 && (
        <div className="main stack" style={{ margin: '0 auto', maxWidth: 860 }}>
          <div className="card">
            <h2 style={{ marginBottom: 12 }}>Documents</h2>
            <label className={`drop${over ? ' over' : ''}`} style={{ display: 'block' }}
              onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)}
              onDrop={(e) => (e.preventDefault(), setOver(false), addFiles(e.dataTransfer.files))}>
              <input type="file" hidden multiple accept="application/pdf,image/png,image/jpeg" onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
              <b>{busy ? 'Uploading…' : 'Drop files here or click to upload'}</b>
              <div className="muted small">PDF, PNG or JPEG, up to 25 MB each</div>
            </label>
            {docs.map((d, i) => (
              <div key={d.id} className="row" style={{ marginTop: 10 }}>
                <input value={d.name} aria-label="Document name" onChange={(e) => (setDocs((l) => l.map((x) => (x.id === d.id ? { ...x, name: e.target.value } : x))), dirty())} />
                <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{d.pages} page{d.pages === 1 ? '' : 's'}</span>
                <button className="btn sm ghost" disabled={i === 0} onClick={() => moveDoc(i, -1)} aria-label="Move up">↑</button>
                <button className="btn sm ghost" disabled={i === docs.length - 1} onClick={() => moveDoc(i, 1)} aria-label="Move down">↓</button>
                <button className="btn sm ghost danger" onClick={() => removeDoc(d.id)}>Remove</button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="row between wrap" style={{ marginBottom: 12 }}>
              <h2>{isTpl ? 'Roles' : 'Recipients'}</h2>
              <label className="check"><input type="checkbox" checked={!!env.ordered} onChange={(e) => patchEnv({ ordered: e.target.checked ? 1 : 0 })} /> Set signing order</label>
            </div>
            {isTpl && <p className="muted small">Leave name and email empty for roles you fill in each time you use the template.</p>}
            <datalist id="contact-emails">{contacts.map((c) => <option key={c.id} value={c.email}>{c.name}</option>)}</datalist>
            <div className="stack" style={{ display: 'grid', gap: 10 }}>
              {rcps.map((r) => (
                <div key={r.id} className="rcpt" style={{ ['--fc' as any]: color(r.id) }}>
                  <div className="row wrap">
                    {!!env.ordered && <input type="number" min={1} max={99} value={r.routing_order} aria-label="Signing order" style={{ width: 64 }} onChange={(e) => patchRcp(r.id, { routing_order: Number(e.target.value) || 1 })} />}
                    {isTpl && <input placeholder="Role, e.g. Client" value={r.role_name || ''} aria-label="Role name" style={{ flex: '1 1 130px' }} onChange={(e) => patchRcp(r.id, { role_name: e.target.value })} />}
                    <input placeholder="Full name" value={r.name} aria-label="Recipient name" style={{ flex: '1 1 150px' }} onChange={(e) => patchRcp(r.id, { name: e.target.value })} />
                    <input placeholder="Email" type="email" list="contact-emails" value={r.email} aria-label="Recipient email" style={{ flex: '1 1 190px' }}
                      onChange={(e) => {
                        const c = contacts.find((x) => x.email.toLowerCase() === e.target.value.toLowerCase());
                        patchRcp(r.id, { email: e.target.value, ...(c && !r.name ? { name: c.name } : {}) });
                      }} />
                    <select value={r.role} aria-label="Role" style={{ flex: '0 1 170px' }} onChange={(e) => patchRcp(r.id, { role: e.target.value })}>
                      {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <button className="btn sm ghost" onClick={() => setMore(more === r.id ? null : r.id)} aria-expanded={more === r.id}>More</button>
                    <button className="btn sm ghost danger" onClick={() => removeRcp(r.id)} aria-label="Remove recipient">✕</button>
                  </div>
                  {more === r.id && (
                    <div className="grid g2" style={{ marginTop: 10 }}>
                      <label className="f" style={{ margin: 0 }}><span>Access code <span className="hint">(share it with them yourself)</span></span><input value={r.access_code || ''} onChange={(e) => patchRcp(r.id, { access_code: e.target.value })} /></label>
                      <label className="f" style={{ margin: 0 }}><span>Private note <span className="hint">(only they see it)</span></span><input value={r.note || ''} onChange={(e) => patchRcp(r.id, { note: e.target.value })} /></label>
                    </div>
                  )}
                  {r.role === 'inperson' && <div className="muted small" style={{ marginTop: 6 }}>You host the signing on your own device. The link is emailed to you.</div>}
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => addRcp()}>Add {isTpl ? 'role' : 'recipient'}</button>
              {!isTpl && !rcps.some((r) => r.email.toLowerCase() === me.user.email.toLowerCase()) && <button className="btn ghost" onClick={() => addRcp({ name: me.user.name, email: me.user.email })}>Add myself</button>}
            </div>
          </div>

          <div className="card">
            <h2 style={{ marginBottom: 12 }}>{isTpl ? 'Template details' : 'Message'}</h2>
            <label className="f"><span>{isTpl ? 'Template name and email subject' : 'Email subject'}</span><input value={env.subject} maxLength={200} onChange={(e) => patchEnv({ subject: e.target.value })} /></label>
            <label className="f"><span>Message <span className="hint">(optional)</span></span><textarea value={env.message} onChange={(e) => patchEnv({ message: e.target.value })} /></label>
            <div className="grid g2">
              <label className="f"><span>Remind every <span className="hint">(days, 0 for never)</span></span><input type="number" min={0} max={60} value={env.reminder_days} onChange={(e) => patchEnv({ reminder_days: Number(e.target.value) })} /></label>
              <label className="f"><span>Expires after <span className="hint">(days)</span></span><input type="number" min={1} max={365} value={env.expire_days} onChange={(e) => patchEnv({ expire_days: Number(e.target.value) })} /></label>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="editor">
          <div className="pane">
            <h3 style={{ marginBottom: 8 }}>Fields for</h3>
            {rcps.filter(SIGNS).length === 0 && <div className="notice warn small">Add a signer in step 1 to place fields.</div>}
            <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
              {rcps.filter(SIGNS).map((r) => (
                <button key={r.id} className="btn sm" style={{ justifyContent: 'flex-start', borderColor: active === r.id ? color(r.id) : undefined, boxShadow: active === r.id ? `0 0 0 1px ${color(r.id)}` : undefined }} onClick={() => setActive(r.id)} aria-pressed={active === r.id}>
                  <span className="dot" style={{ background: color(r.id) }} /> <span className="truncate">{r.name || r.role_name || r.email || 'Unnamed'}</span>
                </button>
              ))}
            </div>
            <h3 style={{ marginBottom: 8 }}>Add a field</h3>
            <div className="palette">
              {TYPES.map(([t, label]) => <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(tool === t ? null : t)} aria-pressed={tool === t}>{label}</button>)}
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>{tool ? `Click on the page to place the ${TLABEL[tool].toLowerCase()} field.` : 'Pick a field, then click where it goes. Drag to move, pull the corner to resize.'}</p>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn sm" onClick={() => setZoom((z) => clamp(+(z - 0.15).toFixed(2), 0.55, 1.6))} aria-label="Zoom out">−</button>
              <span className="small num">{Math.round(zoom * 100)}%</span>
              <button className="btn sm" onClick={() => setZoom((z) => clamp(+(z + 0.15).toFixed(2), 0.55, 1.6))} aria-label="Zoom in">+</button>
            </div>
          </div>

          <div className="canvas" style={{ cursor: tool ? 'crosshair' : undefined }}>
            <div className="stack">
              {docs.map((d) => (
                <div key={d.id}>
                  <div className="muted small" style={{ fontWeight: 600, marginBottom: 6, textAlign: 'center' }}>{d.name}</div>
                  <PdfDoc url={`/api/files/${d.file_id}/content`} zoom={zoom} onPageClick={(p, x, y) => place(d, p, x, y)}
                    overlay={(page) => fields.filter((f) => f.document_id === d.id && f.page === page).map((f) => (
                      <div key={f.id} className={`field edit${sel === f.id ? ' sel' : ''}${f.type === 'checkbox' || f.type === 'radio' ? ' box' : ''}`}
                        style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, ['--fc' as any]: color(f.recipient_id), borderRadius: f.type === 'radio' ? '50%' : undefined }}
                        tabIndex={0} role="button" aria-label={`${TLABEL[f.type]} field`} onClick={(e) => e.stopPropagation()} onFocus={() => setSel(f.id)} onPointerDown={(e) => drag(e, f, 'move')}>
                        {f.type !== 'checkbox' && f.type !== 'radio' && <span className="tag">{f.type === 'note' ? f.value : f.label || TLABEL[f.type]}{!!f.required && f.type !== 'note' && <span className="req">*</span>}</span>}
                        {sel === f.id && <span className="grip" onPointerDown={(e) => drag(e, f, 'resize')} />}
                      </div>
                    ))} />
                </div>
              ))}
            </div>
          </div>

          <div className="pane right">
            {!selected ? (
              <div className="muted small">
                <h3 style={{ color: 'var(--ink)', marginBottom: 8 }}>Field settings</h3>
                Select a field to edit it.
                <ul style={{ paddingLeft: 18, lineHeight: 1.8 }}>
                  <li>Arrow keys nudge</li><li>Delete removes</li><li>Ctrl or ⌘ + D duplicates</li><li>Esc deselects</li>
                </ul>
                <div className="num">{fields.length} field{fields.length === 1 ? '' : 's'} placed</div>
              </div>
            ) : (
              <div>
                <h3 style={{ marginBottom: 12 }}>{TLABEL[selected.type]}</h3>
                {selected.type !== 'note' && (
                  <label className="f"><span>Assigned to</span>
                    <select value={selected.recipient_id || ''} onChange={(e) => patchField(selected.id, { recipient_id: e.target.value })}>
                      {rcps.filter(SIGNS).map((r) => <option key={r.id} value={r.id}>{r.name || r.role_name || r.email || 'Unnamed'}</option>)}
                    </select>
                  </label>
                )}
                {selected.type !== 'note' && !['date_signed', 'full_name', 'email'].includes(selected.type) && (
                  <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={!!selected.required} onChange={(e) => patchField(selected.id, { required: e.target.checked })} /> Required</label>
                )}
                {selected.type !== 'note' && <label className="f"><span>Label <span className="hint">(shown to the signer)</span></span><input value={selected.label || ''} onChange={(e) => patchField(selected.id, { label: e.target.value })} /></label>}
                {PREFILL.includes(selected.type) && (
                  <>
                    <label className="f"><span>{selected.type === 'note' ? 'Text' : 'Prefilled value'}</span><textarea style={{ minHeight: 60 }} value={selected.value || ''} onChange={(e) => patchField(selected.id, { value: e.target.value })} /></label>
                    {selected.type !== 'note' && <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" checked={!!selected.readonly} onChange={(e) => patchField(selected.id, { readonly: e.target.checked })} /> Read only</label>}
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
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <button className="btn sm" onClick={() => setSel(dup(selected).id)}>Duplicate</button>
                  {docs.find((d) => d.id === selected.document_id)?.pages > 1 && (
                    <button className="btn sm" onClick={() => {
                      const d = docs.find((x) => x.id === selected.document_id);
                      for (let p = 0; p < d.pages; p++) if (p !== selected.page) dup(selected, { page: p, x: selected.x, y: selected.y });
                      toast(`Copied to ${d.pages - 1} other page${d.pages === 2 ? '' : 's'}`);
                    }}>Copy to every page</button>
                  )}
                  <button className="btn sm danger" onClick={() => (setFields((l) => l.filter((f) => f.id !== selected.id)), setSel(null), dirty())}>Delete field</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="main stack" style={{ margin: '0 auto', maxWidth: 760 }}>
          {problems.length > 0 && <div className="notice warn"><b>Almost there.</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
          <div className="card">
            <h2>{env.subject || '(no subject)'}</h2>
            {env.message && <p className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{env.message}</p>}
            <div className="muted small" style={{ marginTop: 8 }}>{docs.length} document{docs.length === 1 ? '' : 's'}, {pages} page{pages === 1 ? '' : 's'} · {env.ordered ? 'signed in order' : 'everyone at once'} · {env.reminder_days ? `reminder every ${env.reminder_days} days` : 'no automatic reminders'} · expires after {env.expire_days} days</div>
          </div>
          <div className="card pad0">
            <table className="t">
              <thead><tr>{!!env.ordered && <th>Order</th>}<th>{isTpl ? 'Role' : 'Recipient'}</th><th>Action</th><th>Fields</th></tr></thead>
              <tbody>
                {[...rcps].sort((a, b) => (env.ordered ? a.routing_order - b.routing_order : 0)).map((r) => (
                  <tr key={r.id}>
                    {!!env.ordered && <td className="num">{r.routing_order}</td>}
                    <td><div className="row"><span className="dot" style={{ background: color(r.id) }} /><div><b>{r.name || r.role_name || 'Unnamed'}</b><div className="muted small">{r.email || 'Filled in when the template is used'}</div></div></div></td>
                    <td>{ROLE_LABEL[r.role]}{r.access_code ? ' · access code' : ''}</td>
                    <td className="num">{fields.filter((f) => f.recipient_id === r.id).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!isTpl && pages > 0 && (
            <div className="card row" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2', alignItems: 'flex-start' }}>
              <Leaf size={26} color="#1f6f43" />
              <div>
                <b>Sending this digitally saves about {fmtNum(impact.sheets)} sheets of paper</b>
                <div className="small" style={{ marginTop: 2 }}>That is {fmtNum(impact.litresWater)} litres of water and {fmtNum(impact.kgCo2, 2)} kg of CO2e not used, or {fmtTrees(impact.trees)} of a tree. Printing, couriers and filing cabinets not included.</div>
              </div>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => go(2)}>Back</button>
            <button className="btn primary lg" disabled={busy || problems.length > 0} onClick={send}>{isTpl ? 'Save template' : busy ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
