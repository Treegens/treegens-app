// The text message with a signing link, in the person's language (lang-mail). Short on purpose: who it is for, which
// document, that it comes from GrowSigning for that sender, and the link. The words are "text.link.*" in en.json, one
// text for each role and kind, so a language never has to glue half sentences together.
import { mt } from './maillang.ts';

type Role = 'signer' | 'approver' | 'viewer' | 'cc';
const ROLES: Role[] = ['signer', 'approver', 'viewer', 'cc'];

/** The text for `role` ('signer' when it is none of these) and `kind` ('reminder', 'again', else a new request). */
export function linkTextIn(locale: string, role: string, kind: string, v: { sender: string; doc: string; url: string }): string {
  const r: Role = (ROLES as string[]).includes(role) ? (role as Role) : 'signer';
  const k = kind === 'reminder' ? 'reminder' : kind === 'again' ? 'again' : 'new';
  const words: Record<string, Record<Role, string>> = {
    new: { signer: mt(locale, 'text.link.new.signer', v), approver: mt(locale, 'text.link.new.approver', v), viewer: mt(locale, 'text.link.new.viewer', v), cc: mt(locale, 'text.link.new.cc', v) },
    reminder: { signer: mt(locale, 'text.link.reminder.signer', v), approver: mt(locale, 'text.link.reminder.approver', v), viewer: mt(locale, 'text.link.reminder.viewer', v), cc: mt(locale, 'text.link.reminder.cc', v) },
    again: { signer: mt(locale, 'text.link.again.signer', v), approver: mt(locale, 'text.link.again.approver', v), viewer: mt(locale, 'text.link.again.viewer', v), cc: mt(locale, 'text.link.again.cc', v) },
  };
  return words[k][r];
}
