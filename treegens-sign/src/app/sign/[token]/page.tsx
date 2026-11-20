'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, Modal, Leaf, oops, toast, fmtDate } from '@/components/ui';
import { PdfDoc } from '@/components/PdfDoc';
import { AdoptSignature } from '@/components/SignaturePad';
import { fmtNum, fmtTrees } from '@/lib/impact';

const AUTO = ['date_signed', 'full_name', 'email'];
const LABEL: Record<string, string> = { signature: 'Sign', initials: 'Initial', text: 'Text', number: 'Number', date: 'Date', company: 'Company', title: 'Title', dropdown: 'Choose', attachment: 'Attach file' };

function Shell({ data, children, bar }: { data?: any; children: React.ReactNode; bar?: React.ReactNode }) {
  const brand = data?.brand;
  return (
    <div style={{ minHeight: '100vh' }}>
      <div className="signbar" style={brand?.brand_color ? ({ ['--brand' as any]: brand.brand_color }) : undefined}>
        {brand?.brand_logo ? <img src={brand.brand_logo} alt={brand.name} style={{ maxHeight: 30, maxWidth: 140, background: '#fff', borderRadius: 6, padding: 3 }} /> : <Leaf size={22} color="#9ed88f" />}
        <div className="grow truncate" style={{ fontWeight: 600 }}>{data?.envelope?.subject || 'Treegens Sign'}</div>
        {bar}
      </div>
      <div className="signwrap">{children}</div>
    </div>
  );
}

function Impact({ impact, title }: { impact: any; title: string }) {
  if (!impact?.sheets) return null;
  return (
    <div className="card" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Leaf size={28} color="#1f6f43" />
        <div>
          <b>{title}</b>
          <p style={{ margin: '4px 0 0' }}>
            About <b>{fmtNum(impact.sheets)} sheets of paper</b>, {fmtNum(impact.litresWater)} litres of water and {fmtNum(impact.kgCo2, 2)} kg of CO2e were not used
            (that is {fmtTrees(impact.trees)} of a tree). And 100% of Treegens Sign subscription revenue goes to planting more. <a href="/impact">How we count</a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [ini, setIni] = useState<string | null>(null);
  const [adopt, setAdopt] = useState<{ kind: 'signature' | 'initials'; field: string } | null>(null);
  const [modal, setModal] = useState<'' | 'decline' | 'reassign' | 'menu'>('');
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  const [code, setCode] = useState('');
  const [finished, setFinished] = useState<any>(null);
  const [form, setForm] = useState({ reason: '', name: '', email: '' });
  const base = `/sign/${token}`;

  const load = useCallback(async () => {
    try {
      const d = await api(base);
      setData(d);
      if (d.fields) {
        setValues(Object.fromEntries(d.fields.map((f: any) => [f.id, f.value || ''])));
        setSig((s) => s || d.recipient.signature_png || null);
        setIni((s) => s || d.recipient.initials_png || null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [base]);
  useEffect(() => {
    load();
  }, [load]);

  // Signed-in users get their saved signature offered automatically.
  useEffect(() => {
    if (!data?.recipient) return;
    api('/me').then((m) => {
      if (m.user?.email?.toLowerCase() === data.recipient.email.toLowerCase()) {
        setSig((s) => s || m.user.signature_png || null);
        setIni((s) => s || m.user.initials_png || null);
      }
    }).catch(() => {});
  }, [data?.recipient?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields: any[] = data?.fields || [];
  const isDone = useCallback((f: any) => {
    if (f.readonly || AUTO.includes(f.type)) return true;
    if (f.type === 'radio') {
      const group = fields.filter((x) => x.type === 'radio' && (x.group_name || x.id) === (f.group_name || f.id));
      return group.some((x) => values[x.id]) || !group.some((x) => x.required);
    }
    return !f.required || !!values[f.id];
  }, [fields, values]);
  const ordered = useMemo(() => {
    const docIndex = new Map((data?.documents || []).map((d: any, i: number) => [d.id, i]));
    return [...fields].sort((a, b) => (docIndex.get(a.document_id) as number) - (docIndex.get(b.document_id) as number) || a.page - b.page || a.y - b.y || a.x - b.x);
  }, [fields, data?.documents]);
  const todo = ordered.filter((f) => !isDone(f));
  const actionable = ordered.filter((f) => !f.readonly && !AUTO.includes(f.type));
  const nextId = todo[0]?.id;

  const set = (id: string, v: string) => setValues((s) => ({ ...s, [id]: v }));

  function goNext() {
    const el = nextId && document.getElementById(`f-${nextId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (el.querySelector('input,select,textarea,button') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  function clickSig(f: any) {
    const kind = f.type as 'signature' | 'initials';
    const have = kind === 'signature' ? sig : ini;
    if (values[f.id]) return;
    if (have) set(f.id, '1');
    else setAdopt({ kind, field: f.id });
  }

  async function run(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  }

  const finish = () => run(async () => {
    const r = await api(`${base}/complete`, { body: { values, signature_png: sig, initials_png: ini } });
    setFinished(r);
    window.scrollTo({ top: 0 });
  });

  async function attach(f: any, file?: File) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    await run(async () => {
      const r = await api(`${base}/upload`, { form: fd });
      set(f.id, r.id);
      toast('File attached');
    });
  }

  if (error) return <Shell><div className="card center"><h2>This link cannot be opened</h2><p className="muted" style={{ marginTop: 8 }}>{error}</p></div></Shell>;
  if (!data) return <Shell><div className="muted center" style={{ padding: 60 }}>Loading…</div></Shell>;

  const { envelope: env, recipient: me } = data;

  if (data.locked)
    return (
      <Shell data={data}>
        <form className="card" style={{ maxWidth: 420, margin: '40px auto' }} onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`${base}/unlock`, { body: { code } }); await load(); }); }}>
          <h2>Enter your access code</h2>
          <p className="muted" style={{ margin: '8px 0 16px' }}>{env.sender.name} protected this document with a code. They will have shared it with you separately.</p>
          <label className="f"><span>Access code</span><input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" /></label>
          <button className="btn primary" disabled={busy || !code}>Open document</button>
        </form>
      </Shell>
    );

  const closed = env.status === 'voided' || env.status === 'declined' || env.status === 'expired';
  const allDone = finished?.envelope_status === 'completed' || env.status === 'completed';
  const iAmDone = finished || me.status === 'completed';

  if (closed || me.status === 'declined')
    return (
      <Shell data={data}>
        <div className="card center">
          <h2>{env.status === 'voided' ? 'The sender voided this document' : env.status === 'expired' ? 'This signing request has expired' : 'This document was declined'}</h2>
          <p className="muted" style={{ marginTop: 8 }}>{env.status === 'voided' && env.void_reason ? `Reason: ${env.void_reason}` : `There is nothing more to do here. Contact ${env.sender.name} (${env.sender.email}) if you have questions.`}</p>
        </div>
      </Shell>
    );

  if (iAmDone)
    return (
      <Shell data={data}>
        <div className="stack">
          <div className="card center" style={{ padding: 36 }}>
            <div style={{ fontSize: 40 }}>🌱</div>
            <h1 className="serif" style={{ marginTop: 6 }}>{allDone ? 'All done. Everyone has signed.' : me.role === 'cc' ? 'Here is your copy' : 'You are done. Thank you!'}</h1>
            <p className="muted" style={{ margin: '10px auto 20px', maxWidth: 480 }}>
              {allDone ? 'The completed document includes a certificate with the full audit trail. A copy is on its way to your inbox too.' : 'We will email you the completed document once everyone has finished.'}
            </p>
            <div className="row wrap" style={{ justifyContent: 'center' }}>
              <a className="btn primary" href={`/api${base}/download?inline=1`} target="_blank" rel="noreferrer">{allDone ? 'View completed document' : 'View document so far'}</a>
              <a className="btn" href={`/api${base}/download`}>Download PDF</a>
            </div>
          </div>
          <Impact impact={finished?.impact || env.impact} title="Signed without paper" />
          <div className="card center">
            <b>Need signatures yourself?</b>
            <p className="muted" style={{ margin: '4px 0 12px' }}>Treegens Sign is free to start, and every subscription plants trees.</p>
            <a className="btn" href="/signup">Create a free account</a>
          </div>
        </div>
      </Shell>
    );

  if (me.status === 'pending')
    return <Shell data={data}><div className="card center"><h2>It is not your turn yet</h2><p className="muted" style={{ marginTop: 8 }}>Others need to finish first. We will email you when the document is ready for you.</p></div></Shell>;

  if (!me.consented)
    return (
      <Shell data={data}>
        <div className="card" style={{ maxWidth: 620, margin: '24px auto' }}>
          <p className="muted small" style={{ marginBottom: 4 }}>{env.sender.name} ({env.sender.email}) sent you</p>
          <h1 className="serif">{env.subject}</h1>
          {data.message && <p style={{ whiteSpace: 'pre-wrap', margin: '14px 0 0' }}>{data.message}</p>}
          {data.note && <div className="notice" style={{ marginTop: 14 }}><b>Private note for you:</b> {data.note}</div>}
          {me.role === 'inperson' && <div className="notice warn" style={{ marginTop: 14 }}>In-person signing. Hand this device to <b>{me.name}</b> now.</div>}
          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
          <h3>Electronic records and signatures</h3>
          <p className="muted small" style={{ marginTop: 6 }}>
            You are about to review{me.role === 'signer' || me.role === 'inperson' ? ' and sign' : ''} this document electronically. An electronic signature has the same legal effect as a handwritten one.
            You can download or print a copy at any time, decline to sign, or ask {env.sender.name} for a paper copy instead. We record the time, your IP address and each step you take in a tamper-evident audit trail.
          </p>
          <label className="check" style={{ margin: '14px 0 18px' }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to use electronic records and signatures.
          </label>
          <button className="btn primary lg" disabled={!agree || busy} onClick={() => run(async () => { await api(`${base}/consent`, { method: 'POST' }); await load(); })}>Continue</button>
        </div>
      </Shell>
    );

  const acts = me.role === 'signer' || me.role === 'inperson';
  const bar = (
    <>
      {acts && actionable.length > 0 && (
        <div className="hide-sm" style={{ fontSize: 13 }}>
          <div className="progress"><i style={{ width: `${((actionable.length - todo.length) / actionable.length) * 100}%` }} /></div>
          <div style={{ marginTop: 3 }}>{todo.length ? `${todo.length} required left` : 'Ready to finish'}</div>
        </div>
      )}
      <button className="btn sm" onClick={() => setModal('menu')}>Other actions</button>
      {acts && todo.length > 0 ? <button className="btn go" onClick={goNext}>Next</button>
        : <button className="btn go" disabled={busy} onClick={finish}>{me.role === 'approver' ? 'Approve' : me.role === 'viewer' ? 'Mark as viewed' : 'Finish'}</button>}
    </>
  );

  const overlay = (docId: string) => (page: number) => (
    <>
      {data.others.filter((f: any) => f.document_id === docId && f.page === page).map((f: any) => (
        <div key={f.id} className={`field other${f.type === 'checkbox' || f.type === 'radio' ? ' box' : ''}`} style={pos(f)}>
          {f.image ? <img src={f.image} alt="Signature" /> : f.type === 'checkbox' || f.type === 'radio' ? (f.value === '1' ? '✓' : '') : f.value}
        </div>
      ))}
      {fields.filter((f) => f.document_id === docId && f.page === page).map((f) => {
        const done = isDone(f) && (AUTO.includes(f.type) || f.readonly || !!values[f.id]);
        const cls = `field fill${done ? ' done' : ''}${f.id === nextId ? ' next' : ''}${f.type === 'checkbox' || f.type === 'radio' ? ' box' : ''}`;
        const common = { id: `f-${f.id}`, className: cls, style: pos(f), title: f.label || undefined };
        const name = f.label || LABEL[f.type] || f.type;
        if (f.type === 'signature' || f.type === 'initials')
          return (
            <div {...common} onClick={() => clickSig(f)}>
              {values[f.id] ? <img src={(f.type === 'signature' ? sig : ini || sig) || ''} alt={`Your ${f.type}`} />
                : <button className="cta" style={{ all: 'unset', cursor: 'pointer', width: '100%', textAlign: 'center', fontWeight: 700, color: '#7a5b00' }}>{LABEL[f.type]} ✍</button>}
            </div>
          );
        if (AUTO.includes(f.type)) return <div {...common}><span style={{ padding: '0 .3em' }}>{f.type === 'full_name' ? me.name : f.type === 'email' ? me.email : new Date().toISOString().slice(0, 10)}</span></div>;
        if (f.readonly) return <div {...common}><span style={{ padding: '0 .3em' }}>{f.type === 'checkbox' || f.type === 'radio' ? (f.value === '1' ? '✓' : '') : f.value}</span></div>;
        if (f.type === 'checkbox')
          return <div {...common} role="checkbox" aria-checked={!!values[f.id]} aria-label={name} tabIndex={0} onClick={() => set(f.id, values[f.id] ? '' : '1')} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), set(f.id, values[f.id] ? '' : '1'))}>{values[f.id] ? '✓' : ''}</div>;
        if (f.type === 'radio')
          return (
            <div {...common} role="radio" aria-checked={!!values[f.id]} aria-label={name} tabIndex={0} style={{ ...pos(f), borderRadius: '50%' }}
              onClick={() => setValues((s) => {
                const n = { ...s };
                fields.filter((x) => x.type === 'radio' && (x.group_name || x.id) === (f.group_name || f.id)).forEach((x) => (n[x.id] = ''));
                n[f.id] = '1';
                return n;
              })}>{values[f.id] ? '●' : ''}</div>
          );
        if (f.type === 'dropdown')
          return <div {...common}><select aria-label={name} value={values[f.id] || ''} onChange={(e) => set(f.id, e.target.value)}><option value="">{name}…</option>{(f.options || []).map((o: string) => <option key={o}>{o}</option>)}</select></div>;
        if (f.type === 'attachment')
          return <label {...common}><input type="file" hidden accept="application/pdf,image/png,image/jpeg" onChange={(e) => attach(f, e.target.files?.[0])} /><span className="cta">{values[f.id] ? 'Attached ✓' : `${name} 📎`}</span></label>;
        return (
          <div {...common}>
            <input aria-label={name} placeholder={name + (f.required ? ' *' : '')} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
              value={values[f.id] || ''} onChange={(e) => set(f.id, e.target.value)} />
          </div>
        );
      })}
    </>
  );

  return (
    <Shell data={data} bar={bar}>
      {me.role === 'inperson' && <div className="notice warn" style={{ marginBottom: 12 }}>In-person signing for <b>{me.name}</b>.</div>}
      {!acts && <div className="notice" style={{ marginBottom: 12 }}>{me.role === 'approver' ? 'Review the document, then choose Approve or decline from Other actions.' : 'Review the document, then choose Mark as viewed.'}</div>}
      <div className="stack">
        {data.documents.map((d: any) => (
          <div key={d.id}>
            {data.documents.length > 1 && <div className="muted small" style={{ margin: '4px 0 8px', fontWeight: 600 }}>{d.name}</div>}
            <PdfDoc url={`/api${base}/doc/${d.id}`} overlay={overlay(d.id)} />
          </div>
        ))}
      </div>
      <p className="muted small center" style={{ marginTop: 28 }}>Envelope {env.id}{env.expires_at ? ` · expires ${fmtDate(env.expires_at)}` : ''} · Signing digitally saves about {fmtNum(env.impact.sheets)} sheets of paper.</p>

      {adopt && (
        <AdoptSignature kind={adopt.kind} name={me.name} onClose={() => setAdopt(null)}
          onDone={(png) => {
            if (adopt.kind === 'signature') setSig(png);
            else setIni(png);
            if (adopt.field) set(adopt.field, '1');
            setAdopt(null);
          }} />
      )}
      {modal === 'menu' && (
        <Modal title="Other actions" onClose={() => setModal('')}>
          <div className="stack" style={{ display: 'grid', gap: 8 }}>
            {acts && <button className="btn" onClick={() => run(async () => { await api(`${base}/save`, { body: { values } }); setModal(''); toast('Saved. Use the link in your email to come back and finish.'); })}>Finish later</button>}
            {acts && (sig || ini) && <button className="btn" onClick={() => { setSig(null); setIni(null); setValues((s) => { const n = { ...s }; fields.filter((f) => f.type === 'signature' || f.type === 'initials').forEach((f) => (n[f.id] = '')); return n; }); setModal(''); }}>Change my signature</button>}
            <a className="btn" href={`/api${base}/download?inline=1`} target="_blank" rel="noreferrer">View or print the document</a>
            {(me.role === 'signer' || me.role === 'approver') && <button className="btn" onClick={() => setModal('reassign')}>Assign to someone else</button>}
            {me.role !== 'viewer' && me.role !== 'cc' && <button className="btn danger" onClick={() => setModal('decline')}>Decline to sign</button>}
          </div>
          <div className="actions"><button className="btn ghost" onClick={() => setModal('')}>Close</button></div>
        </Modal>
      )}
      {modal === 'decline' && (
        <Modal title="Decline to sign" onClose={() => setModal('')}>
          <p className="muted">This closes the document for everyone. {env.sender.name} will be told why.</p>
          <label className="f"><span>Reason</span><textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} autoFocus /></label>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Keep signing</button>
            <button className="btn primary" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy || !form.reason.trim()} onClick={() => run(async () => { await api(`${base}/decline`, { body: { reason: form.reason } }); setModal(''); await load(); })}>Decline</button>
          </div>
        </Modal>
      )}
      {modal === 'reassign' && (
        <Modal title="Assign to someone else" onClose={() => setModal('')}>
          <p className="muted">If you are not the right person to sign, pass it on. Your link will stop working and {env.sender.name} will be notified.</p>
          <label className="f"><span>Their name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></label>
          <label className="f"><span>Their email</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="f"><span>Reason <span className="hint">(optional)</span></span><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></label>
          <div className="actions">
            <button className="btn" onClick={() => setModal('')}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api(`${base}/reassign`, { body: form }); setModal(''); setError(`You assigned this document to ${form.name}. Nothing more for you to do.`); })}>Assign</button>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

const pos = (f: any) => ({ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });
