'use client';
import { useEffect, useId, useState } from 'react';
import { api } from '@/components/ui';
import { isStepRole } from '@/lib/recipienttypes';

// The signing page for someone who changes the envelope on their turn instead of signing it (src/server/agents.ts):
//   - "Chooses who comes next" (agent): a name and an email box for each person after them, then Save and finish.
//   - "Can change the document" (editor): the same, with Take off for a person and Replace for a file.
// One main button. Whatever cannot be changed says why in one line. Someone who already signed is only asked to
// sign again after a plain question, and the answer is theirs to give.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether this screen takes the place of the document: their own turn, after the consent screen. */
export const stepFirst = (data: any, stage: string): boolean => stage === 'sign' && isStepRole(data?.recipient?.role);

type Person = { id: string; role: string; role_name: string | null; name: string; email: string; place: string | null; open: boolean; why_not: string | null };

export function NameNext({ data, base, downloadUrl, onDone }: { data: any; base: string; downloadUrl: string; onDone: () => void }) {
  const me = data.recipient;
  const sender = data.envelope?.sender || {};
  const editor = me.role === 'editor';
  const [view, setView] = useState<any>(null);
  const [rows, setRows] = useState<(Person & { off?: boolean })[]>([]);
  const [files, setFiles] = useState<Record<string, { id: string; name: string } | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [again, setAgain] = useState<{ names: string[]; why: string[] } | null>(null);
  const ids = useId();

  const load = () => api(`${base}/step`).then((v) => { setView(v); setRows(v.people.map((p: Person) => ({ ...p }))); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return <div className="card" role="status">{error || 'Loading...'}</div>;

  // On their own screen a place without a role name is "Person 1 after you", never "Chosen by" their own name.
  const openNo = (p: Person) => view.people.filter((x: Person) => x.open && !x.role_name).findIndex((x: Person) => x.id === p.id) + 1;
  const label = (p: Person) => p.role_name || (p.open ? `Person ${openNo(p)} after you` : p.name);
  // Someone has to come after them (the server says the same): the last person left has no Take off.
  const leftAfter = rows.filter((p) => p.role !== 'witness' && !p.off).length;
  const patch = (id: string, q: any) => setRows((l) => l.map((x) => (x.id === id ? { ...x, ...q } : x)));
  const changed = rows.filter((p) => { const o = view.people.find((x: Person) => x.id === p.id); return !p.why_not && (p.off || p.name.trim() !== o.name || p.email.trim().toLowerCase() !== o.email.toLowerCase()); });
  const missing = rows.filter((p) => !p.why_not && !p.off && (!p.name.trim() || !EMAIL.test(p.email.trim())) && (p.open || p.name || p.email));

  const upload = async (docId: string, file: File | undefined) => {
    if (!file) return;
    setError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api(`${base}/step/files`, { form });
      setFiles((f) => ({ ...f, [docId]: r.file }));
    } catch (e: any) { setError(e.message); }
  };

  const finish = async (resign = false) => {
    setError('');
    if (missing.length) {
      // The name is there and the address is not right: say that it is the address.
      const m = missing[0];
      if (missing.length === 1 && m.name.trim() && m.email.trim()) return setError(`Check the email address for ${label(m)}. It should look like paul@example.com.`);
      return setError(`Type a full name and an email address for ${missing.map(label).join(', ')}.`);
    }
    setBusy(true);
    try {
      if (editor && (changed.length || Object.keys(files).length)) {
        const body: any = { edit_version: view.edit_version, resign };
        if (changed.length) body.people = rows.filter((p) => !p.off && p.role !== 'witness').map((p) => (p.why_not ? { id: p.id } : { id: p.id, name: p.name.trim(), email: p.email.trim() }));
        if (Object.keys(files).length) body.documents = view.documents.map((d: any) => ({ id: d.id, file_id: files[d.id]?.id || d.file_id }));
        await api(`${base}/step/change`, { body });
        setFiles({});
        // Someone before them signs again first: their own turn comes round again after that, so the page shows that now.
        if (resign) return onDone();
      } else if (!editor && changed.length) {
        await api(`${base}/step/people`, { body: { people: changed.map((p) => ({ id: p.id, name: p.name.trim(), email: p.email.trim() })) } });
      }
      await api(`${base}/step/finish`, { method: 'POST', body: {} });
      onDone();
    } catch (e: any) {
      if (e.code === 'sign_again') setAgain({ names: e.data?.sign_again || [], why: (e.data?.changes || []).slice(0, 3).map((s: string) => String(s).replace(/\s*Before:[\s\S]*$/, '')) });
      else setError(e.message);
      if (e.code !== 'sign_again') load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-feature="ds-recipient-types" aria-labelledby={`${ids}-h`}>
      <h1 className="serif" id={`${ids}-h`} tabIndex={-1}>{editor ? 'Check the document and change it if needed' : 'Choose who signs next'}</h1>
      <p>{sender.name} asked you to {editor ? 'look at this document and, if something is wrong, change the files or the people after you' : 'name the people after you'}. You do not sign it. Everything you change is written in the document's history with your name.</p>
      <p><a className="sg-link" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer">Open the document<span className="sg-vh"> (opens in a new tab)</span></a></p>

      {editor && view.documents?.length > 0 && (
        <fieldset className="sg-gap" style={{ border: 0, padding: 0 }}>
          <legend className="serif"><b>Files</b></legend>
          {view.documents.map((d: any) => (
            <div key={d.id} className="row wrap" style={{ gap: 8, alignItems: 'center', minHeight: 44 }}>
              <span style={{ flex: '1 1 160px' }}>{d.name}{files[d.id] ? <> <b>replaced by {files[d.id]!.name}</b></> : null}</span>
              <label className="btn sm ghost" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
                Replace
                <input type="file" accept="application/pdf,image/png,image/jpeg" className="sg-vh" aria-label={`Replace ${d.name}`} onChange={(e) => upload(d.id, e.target.files?.[0])} />
              </label>
            </div>
          ))}
        </fieldset>
      )}

      <fieldset className="sg-gap" style={{ border: 0, padding: 0 }}>
        <legend className="serif"><b>The people after you</b></legend>
        {rows.filter((p) => p.role !== 'witness' || p.why_not).map((p) => (
          <div key={p.id} className="sg-gap" style={{ opacity: p.off ? 0.6 : 1 }}>
            <div className="small"><b>{label(p)}</b>{p.open ? ' (not named yet)' : ''}</div>
            {p.why_not ? <p className="muted small" style={{ margin: '4px 0 0' }}>{p.name}. {p.why_not}</p> : (
              <div className="row wrap" style={{ gap: 8 }}>
                <label className="small" style={{ flex: '1 1 150px', display: 'grid', gap: 2 }}>Full name
                  <input value={p.name} dir="auto" aria-label={`Full name for ${label(p)}`} autoComplete="off" disabled={p.off} style={{ minHeight: 44 }} onChange={(e) => patch(p.id, { name: e.target.value })} />
                </label>
                <label className="small" style={{ flex: '2 1 220px', display: 'grid', gap: 2 }}>Email
                  <input value={p.email} type="email" dir="auto" aria-label={`Email for ${label(p)}`} autoComplete="off" disabled={p.off} style={{ minHeight: 44 }} onChange={(e) => patch(p.id, { email: e.target.value })} />
                </label>
                {editor && !p.open && (p.off || leftAfter > 1) && <button type="button" className="btn sm ghost" style={{ minHeight: 44 }} aria-pressed={!!p.off} onClick={() => patch(p.id, { off: !p.off })}>{p.off ? 'Keep' : 'Take off'}</button>}
              </div>
            )}
          </div>
        ))}
        {!rows.length && <p className="muted">Nobody comes after you.</p>}
      </fieldset>

      {again && (
        <div className="notice warn sg-gap" role="alertdialog" aria-labelledby={`${ids}-a`}>
          <p id={`${ids}-a`}><b>{again.names.join(', ')} {again.names.length === 1 ? 'has' : 'have'} already signed, and this change touches what they signed.</b> If you save it, {again.names.length === 1 ? 'they are' : 'they are each'} told what changed and asked to sign again. The first signature stays on record. Your turn comes back after that, and you finish then.</p>
          {again.why.length > 0 && <p className="small">What changes for them: {again.why.join(' ')}</p>}
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => { setAgain(null); finish(true); }}>Save and ask again</button>
            <button type="button" className="btn ghost" style={{ minHeight: 44 }} onClick={() => setAgain(null)}>Go back</button>
          </div>
        </div>
      )}
      {error && <div className="notice warn sg-gap" role="alert">{error}</div>}
      <div className="row wrap sg-actions sg-gap">
        <button type="button" className="btn primary lg" disabled={busy || !!again} onClick={() => finish(false)}>{busy ? 'Saving...' : changed.length || Object.keys(files).length ? 'Save and finish' : 'Finish'}</button>
      </div>
      <p className="muted small">After you finish, the next person is asked, and you cannot change anything here after that. {editor ? 'Something you cannot fix here?' : 'Not sure who to name?'} Ask {sender.name} in Questions and comments, under Other actions.</p>
    </div>
  );
}
