'use client';
// One set of click-to-agree terms: the draft and publishing it as a new version, the versions, how to put the terms on
// a website (our page, a frame, the API and the signed link), and the acceptances with their filters, CSV and
// certificates. The rules are in src/server/clickwrap.ts; this page only shows what the server says.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';
import { ClickwrapTerms } from '@/components/ClickwrapTerms';
import { DEFAULT_BUTTON, DEFAULT_CHECKBOX, IDENTITY_LABEL, STATE_LABEL, VIA_LABEL, TERMS_MAX_CHARS } from '@/lib/clickwrap';

const copy = (s: string, what: string) => navigator.clipboard.writeText(s).then(() => toast(`${what} copied`)).catch(() => toast('Copying did not work here. Select the text and copy it yourself.', true));

export default function Agreement() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, reload, error] = useLoad(() => api(`/clickwraps/${id}`), [id]);
  const [d, setD] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState('');
  const [askAgain, setAskAgain] = useState(true);
  const [answer, setAnswer] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !dirty) setD({ name: data.agreement.name, ...data.draft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const edit = (patch: any) => (setD({ ...d, ...patch }), setDirty(true));

  if (error) return <div className="card cw-team"><h1 className="serif">Click-to-agree</h1><p style={{ marginTop: 8 }}>{error.status === 403 ? 'Only the owner and the admins of your team manage click-to-agree terms. Ask one of them.' : error.message}</p><Link href="/app/agreements">Back to all terms</Link></div>;
  if (!data || !d) return <div className="muted" role="status">Loading…</div>;
  const a = data.agreement;
  const total = data.versions.reduce((n: number, v: any) => n + v.accepted, 0);

  const save = () => api(`/clickwraps/${id}`, { method: 'PATCH', body: { name: d.name, format: d.format, text: d.text, file_id: d.file?.id ?? null, checkbox: d.checkbox, button: d.button, scroll: d.scroll } });
  const setting = (body: any, done: string) => api(`/clickwraps/${id}`, { method: 'PATCH', body }).then(() => (toast(done), reload())).catch(oops);

  async function upload(file: File) {
    const form = new FormData();
    form.append('file', file);
    try {
      const f = await api('/files', { form });
      edit({ format: 'pdf', file: f });
    } catch (e) {
      oops(e);
    }
  }
  async function publish() {
    setBusy(true);
    setAnswer('');
    try {
      if (dirty) await save();
      setDirty(false);
      const r = await api(`/clickwraps/${id}/publish`, { body: { note, ask_again: askAgain } });
      setAnswer(`Version ${r.version} is live. ${r.again}`);
      setNote('');
      reload();
    } catch (e: any) {
      setAnswer(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack cw-team">
      <div><Link href="/app/agreements" className="small">All click-to-agree terms</Link></div>
      <div className="pagehead" style={{ marginBottom: 0 }}>
        <div className="cw-cell">
          <h1 className="serif">{a.name}</h1>
          <div className="row wrap small" style={{ marginTop: 6 }}>
            <span className={`cw-state ${a.state}`}>{STATE_LABEL[a.state]}</span>
            {a.current_version && <span className="muted">Version {a.current_version} is live{a.counts_from_version && a.counts_from_version < a.current_version ? `; acceptances of version ${a.counts_from_version} and later count` : ''}.</span>}
          </div>
        </div>
        <div className="row wrap">
          {a.current_version && <a className="btn" href={a.url} target="_blank" rel="noreferrer">Open the page</a>}
          {a.current_version && <button className="btn" onClick={() => setting({ active: !a.active }, a.active ? 'Closed: the page takes no acceptances now' : 'Open again')}>{a.active ? 'Close' : 'Open again'}</button>}
          {total === 0 && <button className="btn ghost danger" onClick={() => window.confirm('Delete these terms? Nobody has accepted them, so nothing else is lost.') && api(`/clickwraps/${id}`, { method: 'DELETE' }).then(() => router.push('/app/agreements')).catch(oops)}>Delete</button>}
        </div>
      </div>
      {a.why && <div className="notice err" role="status">These terms are not taking acceptances. {a.why}</div>}
      <div className="notice">{data.usage.line} {data.not_a_signature}</div>

      <section className="card cw-editor" aria-labelledby="cw-draft">
        <h2 id="cw-draft" style={{ marginBottom: 12 }}>The terms{dirty && <span className="muted small" style={{ fontWeight: 400 }}> · changes not saved</span>}</h2>
        <p className="muted small">What you change here is shown to nobody until you publish it. The page keeps showing the version that is live.</p>
        <label className="f"><span>Name visitors see</span><input value={d.name} onChange={(e) => edit({ name: e.target.value })} maxLength={120} /></label>
        <fieldset className="row wrap" style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
          <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>How the terms are written</legend>
          <label className="check"><input type="radio" name="fmt" checked={d.format === 'text'} onChange={() => edit({ format: 'text' })} /> Written here</label>
          <label className="check"><input type="radio" name="fmt" checked={d.format === 'pdf'} onChange={() => edit({ format: 'pdf' })} /> A PDF</label>
        </fieldset>
        {d.format === 'text' ? (
          <div className="cw-grid">
            <label className="f" style={{ margin: 0 }}><span>Terms <span className="hint">(a line starting with # is a heading, - starts a list, 1. a numbered list, **two stars** make words bold, an empty line starts a paragraph)</span></span>
              <textarea value={d.text} onChange={(e) => edit({ text: e.target.value })} maxLength={TERMS_MAX_CHARS} dir="auto" /></label>
            <div><div className="small" style={{ fontWeight: 600, marginBottom: 5 }}>How visitors see it</div><div className="cw-preview cw-terms" style={{ margin: 0 }}>{d.text.trim() ? <ClickwrapTerms text={d.text} /> : <span className="muted">Nothing written yet.</span>}</div></div>
          </div>
        ) : (
          <div>
            {d.file ? <p>Chosen: <b>{d.file.name}</b>, {d.file.pages} page{d.file.pages === 1 ? '' : 's'}. {d.file.is_scan || d.file.scan_pages ? 'Some pages are pictures with no text: a screen reader cannot read them, and until your account has earned trust such a PDF cannot be published.' : ''}</p> : <p className="muted">No PDF chosen yet.</p>}
            <label className="f"><span>{d.file ? 'Choose another PDF' : 'Choose the PDF with your terms'}</span><input type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
          </div>
        )}
        <div className="cw-grid" style={{ marginTop: 12 }}>
          <label className="f"><span>Words next to the tick box</span><input value={d.checkbox} placeholder={DEFAULT_CHECKBOX} onChange={(e) => edit({ checkbox: e.target.value })} maxLength={200} /></label>
          <label className="f"><span>Words on the button</span><input value={d.button} placeholder={DEFAULT_BUTTON} onChange={(e) => edit({ button: e.target.value })} maxLength={200} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={d.scroll} onChange={(e) => edit({ scroll: e.target.checked })} /> <span>The button works only after the terms were scrolled to the end <span className="muted">(checked by the visitor&apos;s browser, and the record says it was asked for)</span></span></label>
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button className="btn" disabled={!dirty} onClick={() => save().then(() => (setDirty(false), toast('Saved. Publish to show it.'), reload())).catch(oops)}>Save the draft</button>
        </div>
      </section>

      <section className="card" aria-labelledby="cw-publish">
        <h2 id="cw-publish" style={{ marginBottom: 8 }}>Publish</h2>
        <p className="muted small">Publishing makes {a.current_version ? `version ${a.current_version + 1}` : 'version 1'} of what is written above. Any change to the terms, their name, the words of the box or the button, or the rule about scrolling is a new version. Versions are never changed afterwards.</p>
        {a.current_version && <>
          <label className="f"><span>What changed, in a sentence <span className="hint">(people asked to accept again are shown it)</span></span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
          <label className="check"><input type="checkbox" checked={askAgain} onChange={(e) => setAskAgain(e.target.checked)} /> <span>Everyone who accepted an earlier version has to accept again. Untick only for a correction that changes no meaning, such as a typo.</span></label>
        </>}
        <div className="row wrap" style={{ marginTop: 12 }}><button className="btn primary" disabled={busy} onClick={publish}>{busy ? 'Publishing…' : a.current_version ? 'Publish a new version' : 'Publish version 1'}</button></div>
        {answer && <p className="small" role="status" style={{ marginTop: 10 }}>{answer}</p>}
        {data.to_accept_again > 0 && <p className="small" style={{ marginTop: 10 }}>{data.to_accept_again} {data.to_accept_again === 1 ? 'person has' : 'people have'} accepted only a version that no longer counts, and {data.to_accept_again === 1 ? 'is' : 'are'} asked to accept again.</p>}
        {data.versions.length > 0 && <div className="tablewrap" style={{ marginTop: 12 }}><table className="t">
          <thead><tr><th>Version</th><th>Published</th><th>What changed</th><th>Accepted</th></tr></thead>
          <tbody>{data.versions.map((v: any) => (
            <tr key={v.number}><td>{v.number}{!v.ask_again && v.number > 1 && <div className="muted small">earlier ones still count</div>}</td><td className="small">{fmtDate(v.published_at, true)}<div className="muted">{v.published_by}</div></td><td className="cw-cell small">{v.note || (v.number === 1 ? 'First version' : '')}<div className="muted" style={{ fontSize: 11 }}>SHA-256 {v.terms_sha256.slice(0, 16)}…</div></td><td className="num">{v.accepted}</td></tr>
          ))}</tbody>
        </table></div>}
      </section>

      <section className="card" aria-labelledby="cw-who">
        <h2 id="cw-who" style={{ marginBottom: 8 }}>Who can accept</h2>
        <label className="check"><input type="checkbox" checked={a.signed_only} onChange={(e) => setting({ signed_only: e.target.checked }, e.target.checked ? 'Only people your website names can accept now' : 'Visitors can type their own name and address now')} /> <span>Only people your website names in a signed link. Without it, a visitor who comes without such a link types their name and email address, which nobody checks.</span></label>
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>This takes effect at once and is not a new version.</p>
      </section>

      <Use data={data} showKey={showKey} setShowKey={setShowKey} reload={reload} />
      <Acceptances id={id} versions={data.versions} />
    </div>
  );
}

function Use({ data, showKey, setShowKey, reload }: { data: any; showKey: boolean; setShowKey: (b: boolean) => void; reload: () => void }) {
  const u = data.use;
  const id = data.agreement.id;
  return (
    <section className="card" aria-labelledby="cw-use">
      <h2 id="cw-use" style={{ marginBottom: 8 }}>Put it on your website</h2>
      <h3 style={{ marginTop: 10 }}>1. Our page</h3>
      <p className="small">Link to it from your website or an email: <a href={u.page} target="_blank" rel="noreferrer">{u.page}</a> <button className="btn sm" onClick={() => copy(u.page, 'Link')}>Copy</button></p>
      <h3 style={{ marginTop: 10 }}>2. Inside your own page</h3>
      <p className="small">Paste the script where the terms should appear. It makes a frame, sizes it, and fires the event &quot;signgrow:accepted&quot; when the visitor has accepted. Or paste the frame alone.</p>
      <div className="cw-snippet">{u.script}</div><button className="btn sm" onClick={() => copy(u.script, 'Script')}>Copy the script</button>
      <div className="cw-snippet">{u.iframe}</div><button className="btn sm" onClick={() => copy(u.iframe, 'Frame')}>Copy the frame</button>
      <p className="small" style={{ marginTop: 10 }}><b>What the frame can guarantee.</b> {u.embed_can}</p>
      <p className="small"><b>What it cannot.</b> {u.embed_cannot}</p>
      <h3 style={{ marginTop: 10 }}>3. Saying who the visitor is</h3>
      <p className="small">Your website&apos;s server makes two values for each visitor, &quot;who&quot; and &quot;sig&quot;, and adds them to the address of the page (or puts them in data-who and data-sig of the script). Then the visitor cannot accept as somebody else, and does not type anything. &quot;who&quot; is JSON with:</p>
      <ul className="small">{u.who_fields.map((f: any) => <li key={f.key}><code>{f.key}</code>: {f.what}</li>)}</ul>
      <div className="cw-snippet">{u.sign}</div>
      <div className="row wrap small">
        <span>The key of these terms:</span>
        {showKey ? <code className="cw-cell">{data.secret}</code> : <button className="btn sm" onClick={() => setShowKey(true)}>Show the key</button>}
        {showKey && <button className="btn sm" onClick={() => copy(data.secret, 'Key')}>Copy</button>}
        <button className="btn sm ghost danger" onClick={() => window.confirm('Make a new key? Every link your website signed with the old key stops working at once.') && api(`/clickwraps/${id}/secret`, { body: {} }).then((r) => (toast(r.note), reload())).catch(oops)}>Make a new key</button>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>Keep the key on your server, like a password. Never put it in a page or an app.</p>
      <h3 style={{ marginTop: 10 }}>4. From your server, through the API</h3>
      <p className="small">With an API key (Settings, API and webhooks). An acceptance you send is marked everywhere as recorded by your website, because we did not see the click.</p>
      <div className="cw-snippet">{`POST /api/clickwraps/${id}/acceptances\n{"person": {"id": "c_123", "name": "Ada Lovelace", "email": "ada@example.com"}, "version": ${data.agreement.current_version || 1}, "page_url": "https://your.site/signup"}\n\nGET /api/clickwraps/${id}/status?person_id=c_123\n→ {"accepted": true, "counts_from_version": ..., "latest": {...}}`}</div>
      <p className="muted small" style={{ marginBottom: 0 }}>{data.law}</p>
    </section>
  );
}

function Acceptances({ id, versions }: { id: string; versions: any[] }) {
  const [f, setF] = useState({ q: '', version: '', via: '', identity: '', from: '', to: '' });
  const [shown, setShown] = useState(f);
  const [rows, setRows] = useState<any[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const query = (x = shown, before?: number | null) => new URLSearchParams(Object.entries({ agreement: id, ...x, ...(before ? { before: String(before) } : {}) }).filter(([, v]) => v)).toString();
  const load = (x = shown, more = false) => api(`/clickwrap-acceptances?${query(x, more ? next : null)}`).then((r) => (setErr(''), setTotal(r.total), setNext(r.next_before), setRows(more ? [...rows, ...r.acceptances] : r.acceptances))).catch((e) => setErr(e.message));
  useEffect(() => {
    load(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <section className="card" aria-labelledby="cw-acc">
      <h2 id="cw-acc" style={{ marginBottom: 8 }}>Acceptances{total != null && <span className="muted" style={{ fontWeight: 400 }}> ({total})</span>}</h2>
      <form className="cw-filters" onSubmit={(e) => (e.preventDefault(), setShown(f), load(f))}>
        <label className="f"><span>Name, email or id</span><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
        <label className="f"><span>Version</span><select value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })}><option value="">Any</option>{versions.map((v) => <option key={v.number} value={v.number}>{v.number}</option>)}</select></label>
        <label className="f"><span>How</span><select value={f.via} onChange={(e) => setF({ ...f, via: e.target.value })}><option value="">Any</option>{Object.entries(VIA_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f"><span>Who it came from</span><select value={f.identity} onChange={(e) => setF({ ...f, identity: e.target.value })}><option value="">Any</option>{Object.entries(IDENTITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f"><span>From (UTC)</span><input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="f"><span>To (UTC)</span><input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <button className="btn">Show</button>
        <a className="btn" href={`/api/clickwrap-acceptances/export?${query()}`}>Download CSV</a>
      </form>
      {err && <div className="notice err" role="alert" style={{ marginTop: 10 }}>{err}</div>}
      {rows.length === 0 ? <div className="empty">{total === 0 ? 'Nobody matches yet.' : 'Loading…'}</div> : (
        <div className="tablewrap" style={{ marginTop: 12 }}><table className="t">
          <thead><tr><th>When</th><th>Who, as given</th><th>Version</th><th>How</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td className="small">{fmtDate(r.accepted_at, true)}</td>
              <td className="cw-cell">{r.person.name || r.person.email || r.person.id}<div className="muted small">{[r.person.email, r.person.id && `id ${r.person.id}`].filter(Boolean).join(' · ')}</div><div className="muted small">{IDENTITY_LABEL[r.identity as keyof typeof IDENTITY_LABEL]}</div></td>
              <td className="num">{r.version}</td>
              <td className="small">{VIA_LABEL[r.via as keyof typeof VIA_LABEL]}{!r.intact && <div className="notice err small">This record no longer fits its seal.</div>}</td>
              <td><a className="btn sm" href={`/api/clickwrap-acceptances/${r.id}/certificate`} aria-label={`Certificate of the acceptance by ${r.person.name || r.person.email || r.person.id}, PDF`}>Certificate</a></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {next && <button className="btn" style={{ marginTop: 10 }} onClick={() => load(shown, true)}>Show more</button>}
    </section>
  );
}
