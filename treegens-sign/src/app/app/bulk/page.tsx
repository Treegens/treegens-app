'use client';
import { useMemo, useState } from 'react';
import { api, useLoad, fmtDate, oops, toast } from '@/components/ui';

// Minimal CSV parser: handles quoted cells, commas and new lines inside quotes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') (row.push(cell.trim()), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export default function Bulk() {
  const [tpls] = useLoad(() => api('/envelopes?kind=template'));
  const [batches, reload] = useLoad(() => api('/bulk'));
  const [tid, setTid] = useState('');
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const tpl = tpls?.envelopes.find((t: any) => t.id === tid);
  // The API matches rows to open roles by role name.
  const roles: string[] = useMemo(() => (tpl?.recipients || []).filter((r: any) => !r.email && r.role_name).map((r: any) => r.role_name), [tpl]);
  const header = roles.flatMap((r) => [`${r} name`, `${r} email`]).join(',');
  const rows = useMemo(() => {
    const p = parseCsv(csv);
    const body = p.length && /name|email/i.test(p[0].join(' ')) ? p.slice(1) : p;
    return body.map((cells) => Object.fromEntries(roles.map((r, i) => [r, { name: cells[i * 2] || '', email: cells[i * 2 + 1] || '' }])));
  }, [csv, roles]);

  async function send() {
    setBusy(true);
    try {
      const r = await api('/bulk', { body: { template_id: tid, rows } });
      setResult(r);
      toast(`${r.sent} envelope${r.sent === 1 ? '' : 's'} sent`);
      setCsv('');
      reload();
    } catch (e) {
      oops(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Bulk send</h1><div className="muted">Send one template to a whole list. Everyone gets their own private copy to sign.</div></div></div>
      <div className="card">
        <label className="f"><span>Template</span>
          <select value={tid} onChange={(e) => (setTid(e.target.value), setResult(null))}>
            <option value="">Choose a template…</option>
            {(tpls?.envelopes || []).map((t: any) => <option key={t.id} value={t.id}>{t.subject || 'Untitled template'}</option>)}
          </select>
        </label>
        {tpl && roles.length === 0 && <div className="notice warn">This template has no open roles. Edit it and leave the name and email empty for the role you want to fill from your list.</div>}
        {tpl && roles.length > 0 && (
          <>
            <label className="f"><span>Recipients <span className="hint">(paste from a spreadsheet or upload a CSV, one row per envelope)</span></span>
              <textarea style={{ minHeight: 150, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} placeholder={`${header}\nAda Lovelace,ada@example.com`} value={csv} onChange={(e) => setCsv(e.target.value)} />
            </label>
            <div className="row between wrap">
              <label className="btn sm">Upload CSV<input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => e.target.files?.[0]?.text().then(setCsv)} /></label>
              <span className="muted small">Columns: <span className="mono">{header}</span></span>
            </div>
            {rows.length > 0 && (
              <div className="tablewrap" style={{ marginTop: 14, border: '1px solid var(--line)', borderRadius: 10, maxHeight: 260, overflow: 'auto' }}>
                <table className="t"><thead><tr><th>#</th>{roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
                  <tbody>{rows.slice(0, 100).map((row: any, i: number) => <tr key={i}><td className="num muted">{i + 1}</td>{roles.map((r) => <td key={r}>{row[r].name} <span className="muted small">{row[r].email}</span></td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={busy || rows.length === 0} onClick={send}>{busy ? 'Sending…' : `Send ${rows.length || ''} envelope${rows.length === 1 ? '' : 's'}`}</button>
            </div>
          </>
        )}
        {result?.failed?.length > 0 && <div className="notice err" style={{ marginTop: 12 }}>{result.failed.length} could not be sent: {result.failed[0].error}</div>}
      </div>

      <div className="card pad0">
        <div style={{ padding: '14px 16px' }}><h2>Past batches</h2></div>
        {batches && batches.batches.length === 0 ? <div className="empty">No batches yet.</div> : (
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Batch</th><th>Sent</th><th>Completed</th><th>Date</th></tr></thead>
            <tbody>{(batches?.batches || []).map((b: any) => <tr key={b.id}><td><b>{b.name}</b></td><td className="num">{b.created} of {b.total}</td><td className="num">{b.completed}</td><td className="muted small">{fmtDate(b.created_at, true)}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
