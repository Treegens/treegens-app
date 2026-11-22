import { get } from './db.ts';
import { sentByName, sentByLine } from '../lib/shares.ts';

// Who pressed Send for the person an envelope belongs to (envelopes.sent_by_id, src/server/shares.ts), said where the
// people it went to read the sender's name: the From line and the foot of every email from that sender
// (mail.ts), the signing page (routes-sign.ts) and the certificate (pdf.ts). Only db.ts below this, so mail.ts and
// pdf.ts can use it without going round in a circle.

/** { owner, by } when someone else sent this envelope for the person it belongs to, else null. */
export function sentFor(envelopeId: string | null | undefined): { owner: string; by: string; byEmail: string } | null {
  if (!envelopeId) return null;
  const r = get(`SELECT o.name owner, b.name by_name, b.email by_email FROM envelopes e JOIN users o ON o.id=e.sender_id JOIN users b ON b.id=e.sent_by_id
    WHERE e.id=? AND e.sent_by_id IS NOT NULL AND e.sent_by_id != e.sender_id`, envelopeId);
  return r ? { owner: r.owner, by: r.by_name, byEmail: r.by_email } : null;
}

/**
 * An email in the sender's name (it has a fromName) about an envelope someone else sent for them: the From line reads
 * "Ben Okoro (sent by Ana Silva) via GrowSigning", and a last line says who sent it for whom.
 */
export function withSentBy<M extends { envelopeId?: string; fromName?: string; lines: string[] }>(m: M): M {
  if (!m.fromName || !m.envelopeId) return m;
  const s = sentFor(m.envelopeId);
  if (!s || m.fromName !== s.owner) return m;
  return { ...m, fromName: sentByName(s.owner, s.by), lines: [...m.lines, sentByLine(s.owner, s.by)] };
}

/**
 * The sender as the signing page is given it: the owner's own name (used in sentences: "ask Ben Okoro or a lawyer"),
 * and `sent_by` when a colleague pressed Send, so its From line reads "Ben Okoro (sent by Ana Silva)" (ConsentTop.tsx).
 */
export function shownSender<S extends { name?: string } | null | undefined>(envelopeId: string, sender: S): S {
  const s = sender && sentFor(envelopeId);
  return s && sender ? { ...sender, sent_by: s.by } : sender;
}

/** The certificate's "Sent by" line: who pressed Send for the person it belongs to, or null. */
export function certSentBy(e: any): string | null {
  const s = sentFor(e?.id);
  return s ? `${s.by} <${s.byEmail}>, for ${s.owner}` : null;
}

/** The person the certificate names as the sender: whoever it belonged to before it was first moved, else its sender. */
export function firstSender(e: any): any {
  const id = e?.original_sender_id;
  return id ? get('SELECT id, name, email FROM users WHERE id=?', id) : null;
}
