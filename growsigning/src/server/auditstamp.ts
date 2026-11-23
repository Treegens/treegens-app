// The time stamp of the audit trail at completion: when a time-stamp service is set (TSA_URL, tsa.ts), finishPdf
// (finalpipe.ts) asks it, before the certificate is drawn, for an RFC 3161 time stamp over the SHA-256 of the chain
// head, the value the certificate prints as "Chain head" (the hash of the last line, as 64 hex characters, without
// a line break). The token is kept in audit_stamps once the file is stored, the certificate prints one line about it
// (chainStampLine), and the evidence pack carries it with the command that checks it (evidenceFiles).
//
// What it adds, said in CHAIN_TRUTH (src/lib/evidence.ts): before completion the chain is only ours to vouch for.
// After it, whoever rewrites the lines up to completion and recomputes the chain ends with another head, and the
// time stamp, signed by the service and not by us, is over the old one. Lines written after completion are not
// covered. Whoever can write the database can still delete the token; the emailed certificates still say it existed.
// Nor can the check on the envelope page stand alone against them: without TSA_TRUST, a token from a service they
// made themselves over a rewritten head would hold here. With TSA_TRUST it must come from a listed service, whose time
// is the time it was asked. What stands in every case is the head printed on the certificates people were emailed,
// checked with openssl against the service's own root certificate (the evidence pack says how).
// It is evidence of time from that service, nothing more: nothing here calls it qualified.
import crypto from 'node:crypto';
import { timeStamp, tsaUrls, checkToken, trustCerts, TsaError } from './tsa.ts';
import { tokenChain } from './ltv.ts';
import { get, run } from './db.ts';
import { now } from './util.ts';
import { stampText } from '../lib/dates.ts';

export type ChainStamp = { head: string; token: Buffer; time: string; tsaName: string; host: string; trusted: boolean } | { head: string; why: string };

/** The time stamp over the record's last value now. Null when no service is set or the record is empty. Never throws. */
export async function stampChainHead(envelopeId: string, until?: number): Promise<ChainStamp | null> {
  const urls = tsaUrls();
  if (!urls.length) return null;
  const head: string | undefined = get('SELECT hash FROM audit WHERE envelope_id=? ORDER BY seq DESC LIMIT 1', envelopeId)?.hash;
  if (!head) return null;
  try {
    // timeStamp hashes what it is given: the request is over the SHA-256 of the head as text.
    const s = await timeStamp(Buffer.from(head, 'utf8'), urls, until);
    return { head, token: s.token, time: s.time.toISOString(), tsaName: s.tsaName, host: s.host, trusted: s.trusted };
  } catch (e: any) {
    return { head, why: e instanceof TsaError ? e.message : String(e?.message || e).slice(0, 300) };
  }
}

// "21 Nov 2026 10:15:02 UTC", the way the certificate writes every time (stampText in src/lib/dates.ts).
const utc = (iso: string) => stampText(iso);

/** The certificate's line, only when this file's time stamp is over the very head the certificate prints. */
export function chainStampLine(e: any, printedHead: string | undefined): string | null {
  const s: ChainStamp | undefined = e?.chain_stamp;
  if (!s || !('token' in s) || !printedHead || s.head !== printedHead) return null;
  return `The last value of this record was time-stamped by ${s.tsaName} at ${utc(s.time)}.`;
}

/** Keeps the token of the stored file's record. The first one kept stays: a second build does not replace it. */
export function saveChainStamp(envelopeId: string, s: ChainStamp) {
  if ('token' in s) run('INSERT OR IGNORE INTO audit_stamps (envelope_id, head, token, tsa_name, tsa_host, trusted, stamped_at, created_at) VALUES (?,?,?,?,?,?,?,?)', envelopeId, s.head, s.token.toString('base64'), s.tsaName, s.host, s.trusted ? 1 : 0, s.time, now());
  else run('INSERT OR IGNORE INTO audit_stamps (envelope_id, head, why, created_at) VALUES (?,?,?,?)', envelopeId, s.head, s.why.slice(0, 600), now());
}

/**
 * The record's time stamp for the envelope page: when, by whom, and whether it still holds. `holds` is true only when
 * the token is over the stored head, the stored chain, checked now, still has a line with that very value, and, when
 * TSA_TRUST is set, the token's service leads to one of those certificates. "at" and "by" are read from the token
 * itself, never from the row beside it. `trusted`: TSA_TRUST is set and the token leads there. Without it, anyone who
 * can write the database could put in a token from a service they made themselves, so the page says the service was
 * not checked; only the head on the emailed certificate and a check outside this server stand against that.
 */
export function chainStampFacts(envelopeId: string, chainOk: boolean): { at: string; by: string; holds: boolean; trusted: boolean } | { missing: string } | null {
  const r = get('SELECT * FROM audit_stamps WHERE envelope_id=?', envelopeId);
  if (!r) return null;
  if (!r.token) return { missing: r.why || 'the time-stamp service did not answer' };
  const token = Buffer.from(r.token, 'base64');
  const over = (h: string) => crypto.createHash(h).update(r.head, 'utf8').digest();
  let t: { time: Date; tsaName: string } | null = null;
  try {
    t = checkToken(token, over, null);
  } catch {
    t = null;
  }
  if (!t) return { at: r.stamped_at, by: r.tsa_name, holds: false, trusted: false };
  // A TSA_TRUST that cannot be read is a setting to fix, not a sign of a changed record: then it is as if unset.
  let trust: ReturnType<typeof trustCerts> = null;
  try {
    trust = trustCerts();
  } catch {
    trust = null;
  }
  let trusted = false;
  if (trust) {
    try {
      trusted = checkToken(token, over, trust).trusted;
    } catch {
      trusted = false;
    }
  }
  const holds = chainOk && (!trust || trusted) && !!get('SELECT 1 x FROM audit WHERE envelope_id=? AND hash=?', envelopeId, r.head);
  return { at: t.time.toISOString(), by: t.tsaName, holds, trusted };
}

const pem = (der: Buffer) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

/** The files for the evidence pack, and the README lines about them. Empty when the record has no time stamp. */
export function evidenceFiles(envelopeId: string): { files: { name: string; data: string | Buffer }[]; readme: string[] } {
  const r = get('SELECT * FROM audit_stamps WHERE envelope_id=? AND token IS NOT NULL', envelopeId);
  if (!r) return { files: [], readme: [] };
  const token = Buffer.from(r.token, 'base64');
  const certs = tokenChain(token);
  return {
    files: [
      { name: 'audit-trail-head.txt', data: r.head },
      { name: 'audit-trail-timestamp.tsr', data: token },
      ...(certs.length ? [{ name: 'audit-trail-timestamp-certificates.pem', data: certs.map((c) => pem(c.der)).join('') }] : []),
    ],
    readme: [
      `audit-trail-timestamp.tsr  a time stamp (RFC 3161) from ${r.tsa_name}, at ${utc(r.stamped_at)}, over the SHA-256 of audit-trail-head.txt: the chain head when the last person finished, as printed on the certificate. It is evidence of time from that service. To check it with OpenSSL:`,
      `    openssl ts -verify -in audit-trail-timestamp.tsr -token_in -data audit-trail-head.txt -CAfile <the root certificate of ${r.tsa_name}>`,
      `  "Verification: OK" means the service signed that very value at that time. Take the root certificate from the service itself: ${certs.length ? 'audit-trail-timestamp-certificates.pem holds the certificates the token carries, which shows the token is whole but not whose service it is. ' : ''}Then check that the line with that hash is still in audit-trail.json and the chain still leads to it.`,
    ],
  };
}
