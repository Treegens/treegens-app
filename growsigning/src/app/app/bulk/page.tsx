'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { BatchCost, batchLine, useBatchCheck } from './BatchCost';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, useLoad, toast } from '@/components/ui';
import { useAllowance, voidCostLine } from '@/components/sender/allowance';
import { BatchView } from '@/components/sender/BatchView';
import { ConfirmDialog } from '@/components/sender/dialogs';
import { headerFor, readRecipients, bulkLanguageHint, MAX_ROWS, type BulkRow, type Role } from '@/components/sender/csv';
import { readFieldColumns, fillableColumns } from '@/components/sender/fieldColumns';
// Columns named like one of the account's custom fields fill it for that row (customColumns.ts).
import { readCustomColumns } from '@/components/sender/customColumns';
// Saved lists and groups from Contacts to send to, and saving the list in the box (src/components/reports/SavedLists.tsx).
import { UseSavedList, SaveList } from '@/components/reports/SavedLists';
import '../../styles/reports.css';
import { dayTime, explain } from '@/components/sender/lib';
import { sendAnywayAsk, type BouncedAddress } from '@/lib/mailnews';
import { reminderText } from '@/lib/policy';
import { useST, senderRich } from '@/components/senderLang';

export default function BulkPage() {
  const T = useST();
  return <Suspense fallback={<div className="muted" role="status">{T('bulk.loading')}</div>}><Bulk /></Suspense>;
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
  const T = useST();
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
    return open.map((r, i) => ({ key: r.role_name || r.id, label: r.role_name || T('bulk.recipient_n', { n: String(i + 1) }), phone: r.verify === 'sms_code' || !!r.text_link })).filter((r) => !seen.has(r.key) && !!seen.add(r.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        setFileNote(T('bulk.kept_list'));
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
    const example = roles.flatMap((r, i) => [T('bulk.example_name', { role: r.label }), `person${i + 1}@example.org`, ...(r.phone ? ['+44 7700 900123'] : [])]).join(',');
    const url = URL.createObjectURL(new Blob([`${header}\n${example}\n`], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'bulk-send-list.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function pickFile(file?: File) {
    if (!file) return;
    if (file.size > 2_000_000) return setFileNote(T('bulk.too_big', { file: file.name }));
    const text = await file.text();
    if (text.includes('\u0000')) return setFileNote(T('bulk.not_text', { file: file.name }));
    setCsv(text);
    setResult(null);
    setFileNote(T('bulk.loaded', { file: file.name }));
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
    toast(waiting ? T('bulk.sent_so_far', { count: r.sent, waiting }) : r.sent ? T('bulk.sent', { count: r.sent }) : T('bulk.nothing_sent_below'), !r.sent && !waiting);
    if (!failed.length) (setCsv(''), setName(''), setFileNote(''));
    reloadBatches();
    reloadAllowance();
    setAsked((n) => n + 1);
  }

  const first = roles[0];
  return (
    <div className="sn stack">
      <div className="pagehead" style={{ marginBottom: 0 }}><div><h1 className="serif">{T('bulk.title')}</h1><div className="muted">{T('bulk.lede')}</div></div></div>

      <section className="card" aria-labelledby="sn-bulk-new-h">
        <h2 id="sn-bulk-new-h" className="sn-vh">{T('bulk.new')}</h2>
        <label className="f"><span>{T('bulk.step1')}</span>
          <select value={tid} onChange={(e) => (setTid(e.target.value), setResult(null))}>
            <option value="">{T('bulk.choose')}</option>
            {(tpls?.envelopes || []).map((t: any) => <option key={t.id} value={t.id}>{t.subject || T('bulk.untitled')}</option>)}
          </select>
        </label>
        {tpls && tpls.envelopes.length === 0 && <div className="notice">{senderRich(T.lang, 'bulk.no_templates', { link: <Link href="/app/envelopes/new?kind=template">{T('bulk.create_template')}</Link> })}</div>}
        {tid && !loaded && !tplError && <div className="muted" role="status">{T('bulk.loading_template')}</div>}
        {tid && !loaded && tplError && <div className="notice err" role="alert">{T('bulk.template_gone')}</div>}
        {loaded && roles.length === 0 && <div className="notice warn">{senderRich(T.lang, 'bulk.all_filled', { link: <Link href={`/app/templates/${tid}/edit`}>{T('bulk.edit_template')}</Link> })}</div>}
        {loaded && sameName && <div className="notice warn" style={{ marginBottom: 12 }}>{senderRich(T.lang, 'bulk.same_name', { link: <Link href={`/app/templates/${tid}/edit`}>{T('bulk.edit_template')}</Link> })}</div>}

        {loaded && roles.length > 0 && (
          <>
            <UseSavedList roles={roles} header={header} onLoad={(text, note) => (setCsv(text), setResult(null), setFileNote(note))} />
            <label className="f" style={{ marginBottom: 6 }}><span>{T('bulk.step2')} <span className="hint">{T('bulk.step2_hint')}</span></span>
              <textarea className="sn-csv" spellCheck={false} placeholder={`${header}\nAda Lovelace,ada@example.org`} value={csv} onChange={(e) => (setCsv(e.target.value), setResult(null), setFileNote(''))} aria-describedby="sn-csv-help" />
            </label>
            <div className="sn-csvtools">
              <label className="btn sm sn-file">{T('bulk.upload')}<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sn-vh" onChange={(e) => (pickFile(e.target.files?.[0]), (e.target.value = ''))} /></label>
              <button type="button" className="btn sm ghost" onClick={starter}>{T('bulk.starter')}</button>
              {fileNote && <span className="small muted" role="status">{fileNote}</span>}
            </div>
            {reading.rows.length > 0 && !reading.missing.length && !tooMany && <SaveList csv={csv} rows={reading.rows.length} />}
            <p className="muted small" id="sn-csv-help">
              {T('bulk.help_start')} {roles.map((r, i) => <span key={r.key}>{i > 0 ? ', ' : ''}<b>{T('bulk.col_name', { role: r.label })}</b>, <b>{T('bulk.col_email', { role: r.label })}</b>{r.phone ? <>, <b>{T('bulk.col_phone', { role: r.label })}</b></> : null}</span>)}.{roles.some((r) => r.phone) ? ` ${T('bulk.help_phone')}` : ''} {T('bulk.help_order')}{bulkLanguageHint()}{fillableColumns(loaded?.fields).size ? ` ${T('bulk.help_fields', { names: [...fillableColumns(loaded?.fields).values()].slice(0, 4).join(', ') })}` : ''}{customs?.fields?.length ? ` ${T('bulk.help_custom', { names: customs.fields.slice(0, 4).map((f: any) => f.name).join(', ') })}${customs.fields.some((f: any) => f.required) ? ` ${T('bulk.help_custom_required')}` : ''}` : ''}
              {' '}{T('bulk.help_no_header')}
            </p>

            {reading.rows.length > 0 && (
              <div className="sn-verify" role="region" aria-label={T('bulk.check_label')}>
                <h3>{T('bulk.step3')}</h3>
                {reading.missing.length > 0 ? (
                  <p className="small" aria-live="polite">{T('bulk.no_columns', { count: reading.rows.length })}</p>
                ) : (
                  <p className="small" aria-live="polite">
                    <b>{T('bulk.rows_ready', { count: ready.length })}</b>{stuck.length > 0 ? <> <b className="sn-bad">{T('bulk.rows_fix', { count: stuck.length })}</b></> : null}
                    {' '}<span className="muted">
                      {reading.header ? T('bulk.matched') : T('bulk.no_header', { order: header.replace(/,/g, ', ') })}
                      {reading.swapped ? ` ${T('bulk.swapped')}` : ''}
                      {fieldCols.names.length ? ` ${T('bulk.fills_fields', { names: fieldCols.names.join(', ') })}` : ''}
                      {customCols.names.length ? ` ${T('bulk.fills_custom', { names: customCols.names.join(', ') })}` : ''}
                      {reading.ignored.filter((c) => !fieldCols.names.includes(c) && !customCols.names.includes(c)).length ? ` ${T('bulk.not_used', { names: reading.ignored.filter((c) => !fieldCols.names.includes(c) && !customCols.names.includes(c)).join(', ') })}` : ''}
                    </span>
                  </p>
                )}
                {reading.missing.length > 0 && (
                  <div className="notice err" role="alert">
                    {senderRich(T.lang, 'bulk.missing_cols', { names: <b>{reading.missing.join(T('bulk.and'))}</b> }, { count: reading.missing.length })} {T('bulk.first_row_has', { names: reading.ignored.join(', ') || T('bulk.none_recognised') })} {T('bulk.rename', { count: reading.missing.length, order: header.replace(/,/g, ', ') })}
                  </div>
                )}
                {tooMany && <div className="notice err" role="alert">{T('bulk.too_many', { count: reading.rows.length, max: MAX_ROWS })}</div>}
                {!reading.missing.length && stuck.length > 0 && (
                  <div className="notice warn">
                    <b>{T('bulk.fix_these')}</b> {T('bulk.nothing_yet')}
                    <ul className="sn-problems">
                      {stuck.slice(0, 50).map((r) => <li key={r.row}><b>{T('bulk.row_n', { n: String(r.row) })}</b>{first && r.cells[first.key].name ? ` (${r.cells[first.key].name})` : ''}: {r.problems.join('; ')}.</li>)}
                      {stuck.length > 50 && <li>{T('bulk.and_more', { count: stuck.length - 50 })}</li>}
                    </ul>
                  </div>
                )}
                {!reading.missing.length && (
                  <div className="sn-preview-table" tabIndex={0} role="group" aria-label={T('bulk.as_read')}>
                    <table className="t">
                      <thead><tr><th>{T('bulk.col_row')}</th>{roles.map((r) => <th key={r.key}>{r.label}</th>)}<th>{T('bulk.col_check')}</th></tr></thead>
                      <tbody>
                        {reading.rows.slice(0, 100).map((row) => (
                          <tr key={row.row} className={row.problems.length ? 'bad' : ''}>
                            <td className="num muted">{row.row}</td>
                            {roles.map((r) => <td key={r.key}>{row.cells[r.key].name || <span className="sn-bad">{T('bulk.no_name')}</span>}<div className="muted small sn-break">{row.cells[r.key].email || <span className="sn-bad">{T('bulk.no_email')}</span>}</div></td>)}
                            <td className="small">{row.problems.length ? <span className="sn-bad">{row.problems.join('; ')}</span> : row.notes.length ? <span className="sn-cold">{T('bulk.ready_note', { notes: row.notes.join('; ') })}</span> : <span className="sn-good">{T('bulk.ready')}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {reading.rows.length > 100 && <p className="muted small">{T('bulk.first_100', { count: reading.rows.length })}</p>}

                {/* What the batch holds, what is there, what is missing and what that costs: before the button, for every list. */}
                {listOk && <BatchCost check={check} failed={checkFailed} />}
                {/* Said before every send, also here: each envelope of the batch reminds as the template says (reminderText). */}
                {listOk && <p className="muted small" id="sn-batch-reminders">{reminderText(loaded.reminder_days)} {senderRich(T.lang, 'bulk.reminders_from', { link: <Link href={`/app/templates/${tid}/edit`}>{T('bulk.edit_template_lower')}</Link> })}</p>}

                <div className="sn-sendrow">
                  <label className="f"><span>{T('bulk.batch_name')} <span className="hint">{T('bulk.batch_name_hint')}</span></span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={loaded.subject || T('bulk.title')} /></label>
                  <button className="btn primary" disabled={!canSend} aria-describedby={listOk ? 'sn-batch-cost sn-batch-reminders' : undefined} onClick={() => setConfirming(ready)}>
                    {stuck.length > 0 && ready.length > 0 ? T('bulk.send_ready', { count: ready.length }) : T('bulk.send_docs', { count: ready.length })}
                  </button>
                </div>
                {stuck.length > 0 && ready.length > 0 && !reading.missing.length && <p className="muted small" style={{ textAlign: 'right' }}>{T('bulk.left_out', { count: stuck.length })}</p>}
              </div>
            )}
          </>
        )}

        {result && (
          <div className={`notice${result.failed.length ? ' warn' : ''}`} role="status" style={{ marginTop: 14 }}>
            <b>{result.sent ? T('bulk.sent', { count: result.sent }) : T('bulk.nothing_sent')}</b>
            {result.failed.length > 0 && (
              <>
                {' '}{T('bulk.failed_rows', { count: result.failed.length })}
                <ul className="sn-problems">
                  {result.failed.slice(0, 20).map((f, i) => <li key={i}><b>{T('bulk.row_n', { n: String(f.row.row) })}</b>{first ? ` (${f.row.cells[first.key].name})` : ''}: {f.error}</li>)}
                  {result.failed.length > 20 && <li>{T('bulk.and_more_same', { count: result.failed.length - 20 })}</li>}
                </ul>
              </>
            )}
            <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => router.push(`/app/bulk?batch=${result.id}`)}>{T('bulk.open_batch')}</button></div>
          </div>
        )}
      </section>

      <section className="card pad0" aria-labelledby="sn-batches-h">
        <div className="sn-cardhead"><h2 id="sn-batches-h">{T('bulk.past')}</h2><p className="muted small">{T('bulk.past_note')}</p></div>
        {!batches ? <div className="empty" role="status">{T('bulk.loading')}</div> : batches.batches.length === 0 ? <div className="empty"><h3>{T('bulk.no_batches')}</h3>{T('bulk.no_batches_body')}</div> : (
          <div className="tablewrap"><table className="t sn-list">
            <thead><tr><th>{T('bulk.col_batch')}</th><th className="hide-sm">{T('bulk.col_completed')}</th><th className="hide-sm">{T('bulk.col_sent_on')}</th><th><span className="sn-vh">{T('bulk.col_open')}</span></th></tr></thead>
            <tbody>
              {batches.batches.map((b: any) => (
                <tr key={b.id} className="click" onClick={() => router.push(`/app/bulk?batch=${b.id}`)}>
                  <td className="sn-main">
                    <Link href={`/app/bulk?batch=${b.id}`} className="sn-subject" onClick={(e) => e.stopPropagation()}>{b.name}</Link>
                    <div className="muted small sn-only-sm">{T('bulk.of_completed', { done: b.completed, all: b.created, when: dayTime(b.created_at) })}</div>
                  </td>
                  <td className="hide-sm num">{T('bulk.of', { done: b.completed, all: b.created })}</td>
                  <td className="hide-sm muted small">{dayTime(b.created_at)}</td>
                  <td className="sn-fit" onClick={(e) => e.stopPropagation()}><Link className="btn sm" href={`/app/bulk?batch=${b.id}`} aria-label={T('bulk.open_label', { name: b.name })}>{T('bulk.open')}</Link></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      {confirming && (
        <ConfirmDialog title={T('bulk.send_docs', { count: confirming.length })} confirmLabel={dead.length ? T('bulk.send_anyway') : T('bulk.send_docs', { count: confirming.length })} keepLabel={T('bulk.not_yet')} danger={false} unchanged="" onClose={() => setConfirming(null)}
          onConfirm={async () => {
            try {
              await send(confirming, dead.length > 0);
            } catch (e: any) {
              if (e?.code === 'bounced_address') {
                setDeadNow(e.data?.bounced || []);
                throw new Error(T('bulk.bounced_first'));
              }
              // A dropped connection does not tell us whether the batch went out, so never invite a blind second try.
              if (!e?.status) throw new Error(T('bulk.lost_connection'));
              throw new Error(explain(e, T('bulk.nothing_sent')));
            }
          }}>
          <p>{T('bulk.each_get', { count: confirming.length, name: loaded?.subject || T('bulk.this_template') })}</p>
          {batchLine(check, T.lang) && <p>{batchLine(check, T.lang)}</p>}
          {dead.length > 0 && <div className="notice warn"><b>{sendAnywayAsk(dead).title}.</b> {sendAnywayAsk(dead).body}</div>}
          <p className="muted">{T('bulk.wrong_list')} {voidCostLine(allowance)}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
