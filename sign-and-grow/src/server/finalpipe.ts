// The steps that turn the rendered signed PDF of a completed envelope into the file that is stored, emailed and
// checked on /verify. buildFinal (envelopes.ts) calls finishPdf, stores what it returns and then calls sealStored, so
// the stored SHA-256 is always of the finished file. Today the only step is the digital seal (seal.ts); later steps
// (PDF/A, an organisation's own seal, a qualified service, visible marks) join here, in this order, before the seal.
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

type Render = (e: any) => Promise<Uint8Array>;
type Outcome = { done?: SealDone; unsealed?: 'refused' | 'failed' };
const outcomes = new WeakMap<Uint8Array, Outcome>();

/** Renders the signed PDF of `e` and runs every finishing step over it. With no seal settings: `render(e)` as it is. */
export async function finishPdf(e: any, render: Render): Promise<Uint8Array> {
  const plan = sealPlan();
  // A seal key that is set but refused (expired, for example): the file as before, and the record says so.
  if (!plan) return sealConfigured() ? keep(await render(e), { unsealed: 'refused' }) : render(e);
  try {
    const r = await sealPdf(await render({ ...e, seal_plan: plan }), plan);
    return keep(r.bytes, { done: r.done });
  } catch (err) {
    if (err instanceof TimeStampMissing) {
      const bb = sealPlan(err.message);
      if (bb) {
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
  return keep(await render(e), { unsealed: 'failed' });
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
    run('UPDATE envelopes SET seal_level=?, seal_cert=? WHERE id=?', d.level, d.certHash, e.id);
    audit(e.id, { name: 'System' }, 'Digital seal applied', d.level === 'B-T'
      ? `The signed PDF was sealed with the certificate of ${d.name}, issued by ${d.issuer}, at level PAdES B-T, with a time-stamp from ${d.tsaHost} at ${d.tsaTime}.`
      : `The signed PDF was sealed with the certificate of ${d.name}, issued by ${d.issuer}, at level PAdES B-B: the time in the seal is this server's clock.${d.tsaFailed ? ` The time-stamp service could not give a time-stamp: ${d.tsaFailed}.` : ''}`);
  } else if (o.unsealed) {
    audit(e.id, { name: 'System' }, 'Not sealed', `The signed PDF was made without a digital seal, because ${o.unsealed === 'refused' ? "this server's seal certificate cannot be used right now" : 'the seal could not be applied'}. Its certificate of completion says nothing about a seal. The people who run this server have been told.`);
  }
}
