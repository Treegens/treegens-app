'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { BatchCost, batchLine, useBatchCheck } from './BatchCost';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, useLoad, toast } from '@/components/ui';
import { useAllowance, voidCostLine } from '@/components/sender/allowance';
import { BatchView } from '@/components/sender/BatchView';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { headerFor, readRecipients, MAX_ROWS, type BulkRow, type Role } from '@/components/sender/csv';
import { readFieldColumns, fillableColumns } from '@/components/sender/fieldColumns';
// Columns named like one of the account's custom fields fill it for that row (customColumns.ts).
import { readCustomColumns } from '@/components/sender/customColumns';
import { dayTime, explain, plural } from '@/components/sender/lib';
import { sendAnywayAsk, type BouncedAddress } from '@/lib/mailnews';
import { reminderText } from '@/lib/policy';

export default function BulkPage() {
  return <Suspense fallback={<div className="muted" role="status">Loading…</div>}><Bulk /></Suspense>;
}

// /app/bulk is the send form and the list of past batches. /app/bulk?batch=<id> is one batch.
function Bulk() {
  const params = useSearchParams();
  const batch = params.get('batch');
  return batch ? <BatchView id={batch} /> : <BulkSend preset={params.get('template') || ''} />;
}

type Sent = { id: string; sent: number; failed: { row: BulkRow; error: string }[] };

function BulkSend({ preset }: { preset: string }) {
  const router = useRouter();
  const [tpls] = useLoad<any>(() => api('/envelopes?kind=template'));
  const [batches, reloadBatches] = useLoad<any>(() => api('/bulk'));
  const [allowance, reloadAllowance] = useAllowance();
  // The templates page links here with ?template=<id> so the template is already chosen.
  const [tid, setTid] = useState(preset);
  // The full template is needed for its open roles; the list only has a summary.
  const [tpl, , tplError] = useLoad<any>(() => (tid ? api(`/envelopes/${tid}`) : Promise.resolve(null)), [tid]);
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [fileNote, setFileNote] = useState('');
  const [confirming, setConfirming] = useState<BulkRow[] | null>(null);
  const [result, setResult] = useState<Sent | null>(null);

  const loaded = tid && tpl?.envelope?.id === tid ? tpl.envelope : null;
  const open: any[] = useMemo(() => (loaded?.recipients || []).filter((r: any) => !r.email), [loaded]);
  const roles: Role[] = useMemo(() => {
    const seen = new Set<string>();
    // phone: the template checks this role with a code by text message, or texts them the link, so every row needs a number.
    return open.map((r, i) => ({ key: r.role_name || r.id, label: r.role_name || `Recipient ${i + 1}`, phone: r.verify === 'sms_code' || !!r.text_link })).filter((r) => !seen.has(r.key) && !!seen.add(r.key));
  }, [open]);
  const sameName = open.length > roles.length;
  const header = headerFor(roles);
  const reading = useMemo(() => readRecipients(csv, roles), [csv, roles]);
  // Columns named like a field of the template fill that field in each row's envelope (fieldColumns.ts).
  const fieldCols = useMemo(() => readFieldColumns(csv, loaded?.fields, reading.header), [csv, loaded, reading.header]);
  const [customs] = useLoad<any>(() => api('/custom-fields'));
  const customCols = useMemo(() => readCustomColumns(csv, (customs?.fields || []).map((f: any) => f.name), reading.header), [csv, customs, reading.header]);
  // A row as it is sent: its people, the fields of the template its columns fill, and the custom fields they fill.
  const rowBody = (x: BulkRow) => ({ ...x.cells, ...(fieldCols.byRow.has(x.row) ? { fields: fieldCols.byRow.get(x.row) } : {}), ...(customCols.byRow.has(x.row) ? { custom_fields: customCols.byRow.get(x.row) } : {}) });
  const ready = reading.missing.length ? [] : reading.rows.filter((r) => !r.problems.length);
  const stuck = reading.rows.filter((r) => r.problems.length);
  const tooMany = reading.rows.length > MAX_ROWS;
  const listOk = ready.length > 0 && !tooMany && !reading.missing.length;
  // What this list would hold, against what is free to send with, and what the missing ones cost. The server counts
  // (POST /bulk/check), with the function the send is held to, so the answer comes before the Send button and the
  // two cannot disagree. `asked` moves when the balance may have changed.
  const [asked, setAsked] = useState(0);
  const { check, failed: checkFailed } = useBatchCheck(tid, listOk ? ready.map((x) => ({ ...x, cells: rowBody(x) as any })) : [], asked);
  // The server would refuse the whole batch, and the notice above the button says why and what to do about it.
  const wouldRefuse = !!check && ((check.counted && check.short > 0) || !!check.refusal);
  // Addresses in the list that bounced before: from the check, or from a refusal that came after it. The dialog
  // names them and its button becomes "Send anyway". A new list starts again.
  const [deadNow, setDeadNow] = useState<BouncedAddress[]>([]);
  useEffect(() => setDeadNow([]), [csv, tid]);
  const dead = check?.bounced?.length ? check.bounced : deadNow;
  const canSend = listOk && !wouldRefuse;

  // The list is kept in this browser tab while it is being worked on, so paying for missing signatures (which
  // leaves this page for the payment provider) does not lose it. It goes once the batch has been sent.
  const KEPT = 'sg:bulk-list';
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const kept = JSON.parse(sessionStorage.getItem(KEPT) || 'null');
      if (!kept?.csv || csv) return;
      if (!preset || preset === kept.tid) {
        setTid(kept.tid || preset);
        setCsv(String(kept.csv));
        setName(String(kept.name || ''));
        setFileNote('This is the list you were working on in this tab.');
      }
    } catch {
      /* no storage: the list simply is not kept */
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restored.current) return;
    try {
      if (csv.trim() && csv.length < 2_000_000) sessionStorage.setItem(KEPT, JSON.stringify({ tid, csv, name }));
      else sessionStorage.removeItem(KEPT);
    } catch {
      /* no storage, or no room in it */
    }
  }, [tid, csv, name]);

  function starter() {
    const example = roles.flatMap((r, i) => [`Example ${r.label}`, `person${i + 1}@example.org`, ...(r.phone ? ['+44 7700 900123'] : [])]).join(',');
    const url = URL.createObjectURL(new Blob([`${header}\n${example}\n`], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'bulk-send-list.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function pickFile(file?: File) {
    if (!file) return;
    if (file.size > 2_000_000) return setFileNote(`${file.name} is larger than 2 MB. Save just the recipient columns as a CSV file and try again.`);
    const text = await file.text();
    if (text.includes('\u0000')) return setFileNote(`${file.name} is not a text file. In your spreadsheet, choose Save as CSV, then upload that file.`);
    setCsv(text);
    setResult(null);
    setFileNote(`Loaded ${file.name}.`);
  }

  // One key per batch as it stands. If the connection drops and Send is pressed again for the same batch, the server
  // sees the same key and finishes that batch instead of sending everybody a second time.
  const sendKey = useRef<{ sig: string; key: string } | null>(null);
  async function send(rows: BulkRow[], anyway = false) {
    // "send_anyway": the sender has seen which addresses bounced before and chose to send (src/lib/mailnews.ts).
    const body = { template_id: tid, name: name.trim() || undefined, rows: rows.map(rowBody), ...(anyway ? { send_anyway: true } : {}) };
    const sig = JSON.stringify(body);
    if (sendKey.current?.sig !== sig) sendKey.current = { sig, key: `bulk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` };
    const r = await api('/bulk', { body, headers: { 'Idempotency-Key': sendKey.current.key } });
    const all = (r.results as any[]).map((x, i) => ({ row: rows[i], error: x.error as string, ok: x.ok, pending: !!x.pending }));
    const failed = all.filter((x) => !x.ok && !x.pending);
    const waiting = all.filter((x) => x.pending).length;
    if (!waiting) sendKey.current = null;
    setResult({ id: r.id, sent: r.sent, failed });
    setConfirming(null);
    toast(waiting ? `${plural(r.sent, 'envelope')} sent so far, ${waiting} still going out. Nobody is sent to twice.` : r.sent ? `${plural(r.sent, 'envelope')} sent.` : 'Nothing was sent. See why below.', !r.sent && !waiting);
    if (!failed.length) (setCsv(''), setName(''), setFileNote(''));
    reloadBatches();
    reloadAllowance();
    setAsked((n) => n + 1);
  }

  const first = roles[0];
  return (
    <div className="sn stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">Bulk send</h1><div className="muted">Send one template to a whole list. Everyone gets their own private copy to sign, and you follow them all as one batch.</div></div></div>

      <section className="card" aria-labelledby="sn-bulk-new-h">
        <h2 id="sn-bulk-new-h" className="sn-vh">New bulk send</h2>
        <label className="f"><span>1. Choose a template</span>
          <select value={tid} onChange={(e) => (setTid(e.target.value), setResult(null))}>
            <option value="">Choose a template…</option>
            {(tpls?.envelopes || []).map((t: any) => <option key={t.id} value={t.id}>{t.subject || 'Untitled template'}</option>)}
          </select>
        </label>
        {tpls && tpls.envelopes.length === 0 && <div className="notice">You have no templates yet. <Link href="/app/envelopes/new?kind=template">Create a template</Link> with an empty role, such as &ldquo;Volunteer&rdquo;, and come back here.</div>}
        {tid && !loaded && !tplError && <div className="muted" role="status">Loading the template…</div>}
        {tid && !loaded && tplError && <div className="notice err" role="alert">We could not open that template. It may have been deleted. Choose another one, or reload the page.</div>}
        {loaded && roles.length === 0 && <div className="notice warn">Every recipient in this template already has a name and email, so there is nothing to fill in from a list. <Link href={`/app/templates/${tid}/edit`}>Edit the template</Link> and leave the name and email empty for the role you want to fill.</div>}
        {loaded && sameName && <div className="notice warn" style={{ marginBottom: 12 }}>Two roles in this template share the same name, so they would both get the same person. <Link href={`/app/templates/${tid}/edit`}>Edit the template</Link> and give each role its own name.</div>}

        {loaded && roles.length > 0 && (
          <>
            <label className="f" style={{ marginBottom: 6 }}><span>2. Add your list <span className="hint">(paste from a spreadsheet or upload a CSV file, one row per envelope)</span></span>
              <textarea className="sn-csv" spellCheck={false} placeholder={`${header}\nAda Lovelace,ada@example.org`} value={csv} onChange={(e) => (setCsv(e.target.value), setResult(null), setFileNote(''))} aria-describedby="sn-csv-help" />
            </label>
            <div className="sn-csvtools">
              <label className="btn sm sn-file">Upload CSV<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sn-vh" onChange={(e) => (pickFile(e.target.files?.[0]), (e.target.value = ''))} /></label>
              <button type="button" className="btn sm ghost" onClick={starter}>Download a starter file</button>
              {fileNote && <span className="small muted" role="status">{fileNote}</span>}
            </div>
            <p className="muted small" id="sn-csv-help">
              Start with a header row and name the columns {roles.map((r, i) => <span key={r.key}>{i > 0 ? ', ' : ''}<b>{r.label} name</b>, <b>{r.label} email</b>{r.phone ? <>, <b>{r.label} phone</b></> : null}</span>)}.{roles.some((r) => r.phone) ? ' This template sends text messages, so every row needs a mobile number with its country code, like +44 7700 900123.' : ''} They can be in any order, in capitals or not, and extra columns are fine.{fillableColumns(loaded?.fields).size ? ` A column named like a field of the template (${[...fillableColumns(loaded?.fields).values()].slice(0, 4).join(', ')}) fills that field in each envelope, as if you had typed it in, and anything that depends on it shows or hides from the start.` : ''}{customs?.fields?.length ? ` A column named like one of your account's details (${customs.fields.slice(0, 4).map((f: any) => f.name).join(', ')}) fills it for that envelope, in place of the template's value.${customs.fields.some((f: any) => f.required) ? ' Every envelope needs a value for the required ones, from a column or from the template.' : ''}` : ''}
              {' '}No header row? Then use exactly that order.
            </p>

            {reading.rows.length > 0 && (
              <div className="sn-verify" role="region" aria-label="Check your list">
                <h3>3. Check before sending</h3>
                {reading.missing.length > 0 ? (
                  <p className="small" aria-live="polite">We found {plural(reading.rows.length, 'row')} under a header row, but could not tell which columns hold the names and emails.</p>
                ) : (
                  <p className="small" aria-live="polite">
                    <b>{plural(ready.length, 'row')} ready.</b>{stuck.length > 0 ? <> <b className="sn-bad">{plural(stuck.length, 'row')} {stuck.length === 1 ? 'needs' : 'need'} a fix.</b></> : null}
                    {' '}<span className="muted">
                      {reading.header ? 'We matched your columns by their names.' : `No header row found, so we read the columns in this order: ${header.replace(/,/g, ', ')}.`}
                      {reading.swapped ? ' The names and emails looked swapped, so we put them the right way round.' : ''}
                      {fieldCols.names.length ? ` These columns fill fields of the template, as if you had typed the value in: ${fieldCols.names.join(', ')}.` : ''}
                      {customCols.names.length ? ` These columns fill details of your account: ${customCols.names.join(', ')}.` : ''}
                      {reading.ignored.filter((c) => !fieldCols.names.includes(c) && !customCols.names.includes(c)).length ? ` Not used: ${reading.ignored.filter((c) => !fieldCols.names.includes(c) && !customCols.names.includes(c)).join(', ')}.` : ''}
                    </span>
                  </p>
                )}
                {reading.missing.length > 0 && (
                  <div className="notice err" role="alert">
                    We could not find {reading.missing.length === 1 ? 'a column' : 'columns'} called <b>{reading.missing.join(' and ')}</b>. Your first row has: {reading.ignored.join(', ') || 'no column names we recognise'}. Rename {reading.missing.length === 1 ? 'that column' : 'those columns'} in the first row, or remove the first row and put the columns in this order: {header.replace(/,/g, ', ')}.
                  </div>
                )}
                {tooMany && <div className="notice err" role="alert">That is {reading.rows.length} rows. One batch can hold up to {MAX_ROWS}. Split the list and send it in two goes.</div>}
                {!reading.missing.length && stuck.length > 0 && (
                  <div className="notice warn">
                    <b>Fix these in the box above, or send without them.</b> Nothing has been sent yet.
                    <ul className="sn-problems">
                      {stuck.slice(0, 50).map((r) => <li key={r.row}><b>Row {r.row}</b>{first && r.cells[first.key].name ? ` (${r.cells[first.key].name})` : ''}: {r.problems.join('; ')}.</li>)}
                      {stuck.length > 50 && <li>And {stuck.length - 50} more.</li>}
                    </ul>
                  </div>
                )}
                {!reading.missing.length && (
                  <div className="sn-preview-table" tabIndex={0} role="group" aria-label="Your list as we read it">
                    <table className="t">
                      <thead><tr><th>Row</th>{roles.map((r) => <th key={r.key}>{r.label}</th>)}<th>Check</th></tr></thead>
                      <tbody>
                        {reading.rows.slice(0, 100).map((row) => (
                          <tr key={row.row} className={row.problems.length ? 'bad' : ''}>
                            <td className="num muted">{row.row}</td>
                            {roles.map((r) => <td key={r.key}>{row.cells[r.key].name || <span className="sn-bad">no name</span>}<div className="muted small sn-break">{row.cells[r.key].email || <span className="sn-bad">no email</span>}</div></td>)}
                            <td className="small">{row.problems.length ? <span className="sn-bad">{row.problems.join('; ')}</span> : row.notes.length ? <span className="sn-cold">Ready. Note: {row.notes.join('; ')}</span> : <span className="sn-good">Ready</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {reading.rows.length > 100 && <p className="muted small">Showing the first 100 of {reading.rows.length} rows. Rows that need a fix are all listed above.</p>}

                {/* What the batch holds, what is there, what is missing and what that costs: before the button, for every list. */}
                {listOk && <BatchCost check={check} failed={checkFailed} />}
                {/* Said before every send, also here: each envelope of the batch reminds as the template says (reminderText). */}
                {listOk && <p className="muted small" id="sn-batch-reminders">{reminderText(loaded.reminder_days)} That comes from the template, for every envelope in this batch. To change it, <Link href={`/app/templates/${tid}/edit`}>edit the template</Link> first.</p>}

                <div className="sn-sendrow">
                  <label className="f"><span>Name this batch <span className="hint">(optional, only you see it)</span></span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={loaded.subject || 'Bulk send'} /></label>
                  <button className="btn primary" disabled={!canSend} aria-describedby={listOk ? 'sn-batch-cost sn-batch-reminders' : undefined} onClick={() => setConfirming(ready)}>
                    {stuck.length > 0 && ready.length > 0 ? `Send the ${plural(ready.length, 'ready row')}` : `Send ${plural(ready.length, 'envelope')}`}
                  </button>
                </div>
                {stuck.length > 0 && ready.length > 0 && !reading.missing.length && <p className="muted small" style={{ textAlign: 'right' }}>The {plural(stuck.length, 'row')} that {stuck.length === 1 ? 'needs' : 'need'} a fix will be left out.</p>}
              </div>
            )}
          </>
        )}

        {result && (
          <div className={`notice${result.failed.length ? ' warn' : ''}`} role="status" style={{ marginTop: 14 }}>
            <b>{result.sent ? `${plural(result.sent, 'envelope')} sent.` : 'Nothing was sent.'}</b>
            {result.failed.length > 0 && (
              <>
                {' '}{plural(result.failed.length, 'row')} could not be sent and {result.failed.length === 1 ? 'was' : 'were'} saved as {result.failed.length === 1 ? 'a draft' : 'drafts'} in the batch, so nothing is lost:
                <ul className="sn-problems">
                  {result.failed.slice(0, 20).map((f, i) => <li key={i}><b>Row {f.row.row}</b>{first ? ` (${f.row.cells[first.key].name})` : ''}: {f.error}</li>)}
                  {result.failed.length > 20 && <li>And {result.failed.length - 20} more, for the same kind of reason.</li>}
                </ul>
              </>
            )}
            <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => router.push(`/app/bulk?batch=${result.id}`)}>Open this batch</button></div>
          </div>
        )}
      </section>

      <section className="card pad0" aria-labelledby="sn-batches-h">
        <div className="sn-cardhead"><h2 id="sn-batches-h">Past batches</h2><p className="muted small">Open a batch to see everyone in it, remind them, void what is still open or download what is done.</p></div>
        {!batches ? <div className="empty" role="status">Loading…</div> : batches.batches.length === 0 ? <div className="empty"><h3>No batches yet</h3>Your first bulk send will show up here.</div> : (
          <div className="tablewrap"><table className="t sn-list">
            <thead><tr><th>Batch</th><th className="hide-sm">Completed</th><th className="hide-sm">Sent on</th><th><span className="sn-vh">Open</span></th></tr></thead>
            <tbody>
              {batches.batches.map((b: any) => (
                <tr key={b.id} className="click" onClick={() => router.push(`/app/bulk?batch=${b.id}`)}>
                  <td className="sn-main">
                    <Link href={`/app/bulk?batch=${b.id}`} className="sn-subject" onClick={(e) => e.stopPropagation()}>{b.name}</Link>
                    <div className="muted small sn-only-sm">{b.completed} of {b.created} completed · {dayTime(b.created_at)}</div>
                  </td>
                  <td className="hide-sm num">{b.completed} of {b.created}</td>
                  <td className="hide-sm muted small">{dayTime(b.created_at)}</td>
                  <td className="sn-fit" onClick={(e) => e.stopPropagation()}><Link className="btn sm" href={`/app/bulk?batch=${b.id}`} aria-label={`Open batch ${b.name}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      {confirming && (
        <ConfirmDialog title={`Send ${plural(confirming.length, 'envelope')}`} confirmLabel={dead.length ? 'Send anyway' : `Send ${plural(confirming.length, 'envelope')}`} keepLabel="Not yet" danger={false} unchanged="" onClose={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await send(confirming, dead.length > 0);
            } catch (e: any) {
              if (e?.code === 'bounced_address') {
                setDeadNow(e.data?.bounced || []);
                throw new Error('Nothing was sent yet. Read which addresses bounced before, above, then choose Send anyway or go back and correct the list.');
              }
              // A dropped connection does not tell us whether the batch went out, so never invite a blind second try.
              if (!e?.status) throw new Error('We lost the connection while sending. Look under Past batches to see whether it went out before you try again, so nobody gets it twice.');
              throw new Error(explain(e, 'Nothing was sent.'));
            }
          }}>
          <p>{confirming.length === 1 ? 'One person gets' : `${confirming.length} people each get`} their own copy of &ldquo;{loaded?.subject || 'this template'}&rdquo; by email, straight away.</p>
          {batchLine(check) && <p>{batchLine(check)}</p>}
          {dead.length > 0 && <div className="notice warn"><b>{sendAnywayAsk(dead).title}.</b> {sendAnywayAsk(dead).body}</div>}
          <p className="muted">Sent to the wrong list? You can void the whole batch in one go afterwards. {voidCostLine(allowance)}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
