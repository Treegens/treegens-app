'use client';
// Documents brought in from another server's export or from DocuSign (src/server/importer.ts), for owners and admins:
// a list, and one record with its banner, what came with it and its files. They are archived records: nothing here
// can be sent or signed again, and every record says where it was signed.
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, useLoad, oops } from '@/components/ui';
import { CHAIN_MEANS, IMPORTED_IS_NOT } from '@/lib/exportfull';
import { dayText } from '@/lib/dates';

/** The host of an address an export named, or nothing when it is not one: the file could hold any words there. */
const hostOf = (url: string | null): string | null => {
  try {
    return url ? new URL(url).host || null : null;
  } catch {
    return null;
  }
};
const where = (x: any) => (x.source === 'docusign' ? 'DocuSign' : hostOf(x.source_deployment) ? `An export that names ${hostOf(x.source_deployment)}` : 'A GrowSigning export');
/** A date as it came: written out when it reads as one, as it came otherwise. */
const asDay = (v: string) => (v && !Number.isNaN(Date.parse(v)) ? dayText(new Date(Date.parse(v)).toISOString()) : v);
const capital = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

export default function ImportedPage() {
  return <Suspense fallback={<div className="muted" role="status">Loading…</div>}><Imported /></Suspense>;
}

function Imported() {
  const id = useSearchParams().get('id');
  return id ? <OneRecord id={id} /> : <List />;
}

function List() {
  const [r, , err] = useLoad<any>(() => api('/imported'), []);
  if (err) return <div className="notice warn" role="alert">{err.message || 'We could not load the documents brought in.'}</div>;
  if (!r) return <div className="muted" role="status">Loading…</div>;
  return (
    <div className="stack">
      <h1>Documents brought in</h1>
      <p className="muted" style={{ maxWidth: 640, margin: 0 }}>{IMPORTED_IS_NOT}</p>
      {r.records.length === 0 ? (
        <div className="empty"><h3>Nothing brought in yet</h3>Bring documents in under <Link href="/app/settings?tab=data#bring-in">Settings, Records and data</Link>.</div>
      ) : (
        <div className="tablewrap"><table className="t">
          <thead><tr><th scope="col">Document</th><th scope="col">From</th><th scope="col">Brought in</th></tr></thead>
          <tbody>
            {r.records.map((x: any) => (
              <tr key={x.id}>
                <td><Link href={`/app/imported?id=${encodeURIComponent(x.id)}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{x.subject}</Link></td>
                <td>{where(x)}{x.chain_ok === false ? ', history did not check out' : ''}</td>
                <td>{dayText(x.imported_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function OneRecord({ id }: { id: string }) {
  const router = useRouter();
  const [r, , err] = useLoad<any>(() => api(`/imported/${encodeURIComponent(id)}`), [id]);
  const [asking, setAsking] = useState(false);
  if (err) return <div className="notice warn" role="alert">{err.message} <Link href="/app/imported">All documents brought in</Link></div>;
  if (!r) return <div className="muted" role="status">Loading…</div>;
  const x = r.record;
  const d = x.data || {};
  const people: any[] = d.recipients || [];
  async function remove() {
    try {
      await api(`/imported/${encodeURIComponent(id)}`, { method: 'DELETE' });
      router.replace('/app/imported');
    } catch (e) {
      oops(e);
    }
  }
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <p style={{ margin: 0 }}><Link href="/app/imported">All documents brought in</Link></p>
      <h1>{x.subject}</h1>
      {/* The banner stays on the record as it was written when it came in. */}
      <div className={`notice${x.chain_ok === false ? ' warn' : ''}`} role="note"><b>{x.banner}</b> {IMPORTED_IS_NOT}</div>
      {x.source === 'growsigning' && <p className="small muted" style={{ margin: 0 }}>{x.chain_ok ? CHAIN_MEANS : `Why it did not check out: ${d.chain_check?.why || 'its history could not be checked.'}`}</p>}
      {/* The rest of what came with it is the file's own words, shown as such. */}
      <dl className="grid g2 small" style={{ margin: 0 }}>
        {x.status && <><dt>Status, as the file says</dt><dd>{capital(x.status)}</dd></>}
        {(x.sent_at || d.sent) && <><dt>Sent</dt><dd>{asDay(x.sent_at || d.sent)}</dd></>}
        {(x.completed_at || d.completed) && <><dt>Completed</dt><dd>{asDay(x.completed_at || d.completed)}</dd></>}
        {d.sender?.email && <><dt>Sender</dt><dd>{d.sender.name} &lt;{d.sender.email}&gt;</dd></>}
        {d.docusign_envelope_id && <><dt>DocuSign envelope ID</dt><dd className="mono">{d.docusign_envelope_id}</dd></>}
        <dt>Brought in by</dt><dd>{x.imported_by}, {dayText(x.imported_at)}</dd>
      </dl>
      {people.length > 0 && <><h2>People on it</h2><ul className="rules small">{people.map((p: any, i: number) => <li key={i}>{p.name} &lt;{p.email}&gt;{p.status ? `, ${p.status}` : ''}</li>)}</ul></>}
      <h2>Files</h2>
      <ul className="rules">
        {x.files.map((f: any) => <li key={f.sha256}><a href={`/api/imported/${encodeURIComponent(x.id)}/files/${f.sha256}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Download {f.name}</a></li>)}
      </ul>
      <details data-fold="" className="set-kept">
        <summary className="set-fold">Checks on the files</summary>
        <p className="small muted" style={{ margin: '8px 0 0' }}>The fingerprint (SHA-256) of each file as it was brought in. A copy with the same fingerprint is the same file, byte for byte.</p>
        <ul className="rules small">{x.files.map((f: any) => <li key={f.sha256}>{f.name}: <span className="mono" style={{ overflowWrap: 'anywhere' }}>{f.sha256}</span></li>)}</ul>
      </details>
      {d.audit?.events?.length > 0 && (
        <details data-fold="" className="set-kept">
          <summary className="set-fold">History, as it came ({d.audit.events.length} lines)</summary>
          <ol className="small">{d.audit.events.map((a: any) => <li key={a.seq}>{a.at}: {a.actor}. {a.action}{a.detail ? `: ${a.detail}` : ''}</li>)}</ol>
        </details>
      )}
      <div>
        {!asking ? <button className="btn" onClick={() => setAsking(true)}>Delete this record</button> : (
          <div className="notice warn">This deletes the record and its files from this account for good. It does not touch the document where it was signed. <div className="row wrap" style={{ gap: 8, marginTop: 8 }}><button className="btn" onClick={() => setAsking(false)}>Keep it</button><button className="btn danger" onClick={remove}>Delete for good</button></div></div>
        )}
      </div>
    </div>
  );
}
