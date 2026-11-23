// The steps that turn the rendered signed PDF of a completed envelope into the file that is stored, emailed and
// checked on /verify. buildFinal (envelopes.ts) calls finishPdf, stores what it returns and then calls sealStored, so
// the stored SHA-256 is always of the finished file. The steps are the archive format, PDF/A (pdfa.ts, only when an
// account asked for it), and then the digital seal (seal.ts); later steps (an organisation's own seal, a qualified
// service, visible marks) join here, in this order, before the seal.
//
// The certificate of completion describes the seal of its own file, so the plan is decided here, before rendering,
// and the certificate is drawn from it (sealLineFor). When the plan cannot be kept, the file is rendered again with
// one that can, so the certificate never says more than the file does, and the PDF is never held back:
//   - no time-stamp service gave a time-stamp that checks out: sealed at B-B, and the certificate says the time is
//     the server's clock;
//   - the seal itself failed (a bug, a key that stopped working): made without a seal, as before any seal settings,
//     and the people who run the server are told.
// What happened is written into the envelope's audit trail once the file is stored (sealStored).
import { sealPlan, sealPdf, rememberSealCert, TimeStampMissing, type SealDone } from './seal.ts';
import { sealConfigured, tellOperators } from './sealkey.ts';
import { run, get } from './db.ts';
import { sha256 } from './util.ts';
import { audit } from './envelopes.ts';
import { t, SOURCE_LOCALE } from '../lib/i18n.ts';
import { TSA_TOTAL_MS } from './tsa.ts';
import { withLongTerm } from './ltv.ts';
import { stampText } from '../lib/dates.ts';
import { stampChainHead, saveChainStamp, type ChainStamp } from './auditstamp.ts';
import { cscReady } from './sealcsc.ts';
import { tsaUrls, TsaError } from './tsa.ts';
import { addDocTimeStamp } from './ltv.ts';
import { inArchiveFormat, archiveStored } from './pdfa.ts';

type Render = (e: any) => Promise<Uint8Array>;
/** `stamped`: a file without a seal that got a document time stamp over the whole file; `stampFailed`: why it did not. */
type Stamped = { host: string; time: string; tsaName: string; trusted: boolean };
type Outcome = { done?: SealDone; unsealed?: 'refused' | 'failed'; stamped?: Stamped; stampFailed?: string };
const outcomes = new WeakMap<Uint8Array, Outcome>();
const chains = new WeakMap<Uint8Array, ChainStamp>();

/**
 * Renders the signed PDF of `e` and runs every finishing step over it. With no seal and no time-stamp settings:
 * `render(e)` as it is. With a time-stamp service, the record's chain head is time-stamped first, because the
 * certificate prints that (auditstamp.ts); it shares the seconds for time-stamps with the seal's own.
 */
export async function finishPdf(e: any, render: Render): Promise<Uint8Array> {
  const until = Date.now() + TSA_TOTAL_MS;
  const chain = await stampChainHead(e.id, until);
  // The archive format (pdfa.ts) wraps the seal: PDF/A first, then the seal, then veraPDF checks the finished file.
  const pdf = await inArchiveFormat(chain ? { ...e, chain_stamp: chain } : e, render, (x, r) => finishSealed(x, r, until));
  if (chain) chains.set(pdf, chain);
  return pdf;
}

async function finishSealed(e: any, render: Render, until: number): Promise<Uint8Array> {
  // A cloud seal (sealcsc.ts): its certificate chain is fetched first when it is not there or more than a day old.
  await cscReady();
  const plan = sealPlan();
  if (plan) plan.until = until;
  // A seal key that is set but refused (expired, for example): the file as before, and the record says so. Without
  // any seal settings, the file as before. With a time-stamp service, either one still gets a time stamp over it.
  if (!plan) return sealConfigured() ? stampOnly(await render(e), { unsealed: 'refused' }) : stampOnly(await render(e), null);
  try {
    const r = await sealPdf(await render({ ...e, seal_plan: plan }), plan);
    return longTerm(r, plan);
  } catch (err) {
    if (err instanceof TimeStampMissing) {
      const bb = sealPlan(err.message);
      if (bb) {
        bb.until = until;
        try {
          const r = await sealPdf(await render({ ...e, seal_plan: bb }), bb);
          return keep(r.bytes, { done: r.done });
        } catch (again) {
          return unsealed(e, render, again);
        }
      }
    }
    return unsealed(e, render, err);
  }
}

async function unsealed(e: any, render: Render, err: any): Promise<Uint8Array> {
  const why = String(err?.message || err).slice(0, 300);
  tellOperators(`A completed PDF could not be sealed, so it was made without a seal (envelope ${e.id}): ${why}`);
  return stampOnly(await render(e), { unsealed: 'failed' });
}

/**
 * A file without a seal, with a time-stamp service set (TSA_URL): one PAdES document time stamp over the whole file
 * (ltv.ts, addDocTimeStamp), so a PDF reader shows when the file existed in this form from the service's clock, not
 * ours. With no service, the file exactly as it was. The file is never held back: when the service does not answer
 * within its seconds, the file goes out without it and the record says why.
 */
async function stampOnly(pdf: Uint8Array, o: Outcome | null): Promise<Uint8Array> {
  if (!tsaUrls().length) return o ? keep(pdf, o) : pdf;
  try {
    const d = await addDocTimeStamp(Buffer.from(pdf), tsaUrls());
    return keep(d.bytes, { ...o, stamped: { host: d.host, time: d.time, tsaName: d.tsaName, trusted: d.trusted } });
  } catch (err: any) {
    return keep(pdf, { ...o, stampFailed: err instanceof TsaError ? err.message : String(err?.message || err).slice(0, 300) });
  }
}

// After a seal with a time stamp: the data to check it for years (ltv.ts). The file is never held back for it.
async function longTerm(r: { bytes: Buffer; done: SealDone }, plan: NonNullable<ReturnType<typeof sealPlan>>): Promise<Uint8Array> {
  if (r.done.level !== 'B-T') return keep(r.bytes, { done: r.done });
  const l = await withLongTerm(r.bytes, [plan.key.cert, ...plan.key.chain], r.done.tsaToken || null);
  return keep(l.bytes, { done: { ...r.done, ltv: l.ltv } });
}

function keep(pdf: Uint8Array, o: Outcome) {
  outcomes.set(pdf, o);
  return pdf;
}

/**
 * After buildFinal stored `pdf` for `e`: the seal is written down on the envelope and in its audit trail. Nothing
 * when the stored file is another one (a second build stored first) or when no seal was asked for.
 */
export function sealStored(e: any, pdf: Uint8Array) {
  try {
    archiveStored(e, pdf, sha256(pdf));
  } catch (x: any) {
    console.error('[pdfa] could not write down the archive format of envelope', e.id, x?.message);
  }
  const c = chains.get(pdf);
  if (c) {
    try {
      if (get('SELECT 1 x FROM envelopes WHERE id=? AND final_sha256=?', e.id, sha256(pdf))) saveChainStamp(e.id, c);
    } catch (x: any) {
      console.error('[seal] could not keep the time stamp of the record of envelope', e.id, x?.message);
    }
  }
  const o = outcomes.get(pdf);
  if (!o) return;
  try {
    noteSeal(e, pdf, o);
  } catch (x: any) {
    // The file is stored either way; only the note about its seal is missing.
    console.error('[seal] could not write down the seal of envelope', e.id, x?.message);
  }
}

function noteSeal(e: any, pdf: Uint8Array, o: Outcome) {
  const sha = sha256(pdf);
  if (!get('SELECT 1 x FROM envelopes WHERE id=? AND final_sha256=?', e.id, sha)) return;
  if (o.done) {
    const d = o.done;
    rememberSealCert(d);
    run('UPDATE envelopes SET seal_level=?, seal_cert=?, seal_tsa=?, seal_ltv=?, seal_ltv_note=? WHERE id=?', d.level, d.certHash, d.level === 'B-T' ? (d.tsaTrusted ? 'trusted' : 'unchecked') : null,
      d.ltv ? ('missing' in d.ltv ? 'missing' : d.ltv.level) : null, d.ltv ? ('missing' in d.ltv ? d.ltv.missing : d.ltv.docTsFailed || null) : null, e.id);
    // The words of the history line are the charter's: "Sealed by <operator name>", and no technical names.
    audit(e.id, { name: 'System' }, t(SOURCE_LOCALE, 'seal.sealed_by', { name: d.name }), (d.level === 'B-T'
      ? `The signed PDF carries a digital seal made with the certificate of ${d.name}, issued by ${d.issuer}. A PDF reader shows if the file changed after this. ${d.tsaTrusted ? `The seal carries a trusted time stamp from ${d.tsaHost} at ${d.tsaTime}: the certificate of that service leads to one this server was set up to trust.` : `The seal carries a time stamp from ${d.tsaHost} at ${d.tsaTime}. This server checked that the time stamp is over this seal and that its time is within 5 minutes of its own clock. It was not set up to check whose service that is, so nothing here calls the time stamp trusted.`}`
      : `The signed PDF carries a digital seal made with the certificate of ${d.name}, issued by ${d.issuer}. A PDF reader shows if the file changed after this. The time in the seal is this server's clock.${d.tsaFailed ? ` The time-stamp service could not give a time stamp: ${d.tsaFailed}.` : ''}`) + ltvSentence(d));
  } else if (o.unsealed) {
    audit(e.id, { name: 'System' }, 'Not sealed', `The signed PDF was made without a digital seal, because ${o.unsealed === 'refused' ? "this server's seal certificate cannot be used right now" : 'the seal could not be applied'}. Its certificate of completion says nothing about a seal. The people who run this server have been told.`);
  }
  if (o.stamped) {
    const s = o.stamped;
    audit(e.id, { name: 'System' }, 'Time-stamped', `A time stamp over the whole signed PDF was added by ${s.tsaName} (${s.host}) at ${stampText(s.time)}. A PDF reader shows it as a document time stamp, and shows if the file changed after it. ${s.trusted ? 'The certificate of that service leads to one this server was set up to trust.' : 'This server was not set up to check whose service that is, so nothing here calls the time stamp trusted.'} It is not a seal: it shows when the file existed in this form, not who made it.`);
  } else if (o.stampFailed) {
    audit(e.id, { name: 'System' }, 'Not time-stamped', `No time stamp could be added over the signed PDF, so the file carries none: ${o.stampFailed}.`);
  }
}

// What the long-term step did, said after the seal's own line in the history (ltv.ts).
function ltvSentence(d: SealDone): string {
  const l = d.ltv;
  if (!l) return '';
  if ('missing' in l) return ` What is needed to check the seal after its certificate has expired could not be added, so the file can be checked only while that certificate is valid: ${l.missing}.`;
  return ` The file also carries what is needed to check the seal after its certificate has expired.${l.level === 'B-LTA' ? ` After that, a time stamp over the whole file was added by ${l.docTsHost} at ${stampText(l.docTsTime)}.` : l.docTsFailed ? ` No time stamp over the whole file was added: ${l.docTsFailed}.` : ''}`;
}
