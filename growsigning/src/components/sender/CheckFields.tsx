'use client';
import { useId } from 'react';
import { CHECK_NAMES, CHECK_PROVES, PHONE_HOW, isCodeCheck, normalPhone, premiumPhone } from '@/lib/checks';

// The check a sender can ask for before a document opens for one recipient: none, a one-time code by email, or a
// one-time code by text message to a mobile number the sender types here. Used in the editor (step 1, under "More")
// and in the quick Correct dialog. Text messages are only offered when the operator of this server has switched
// them on (`textsOn`, from /api/me). When they are off, nothing here mentions them, unless this recipient was set
// up for texts earlier: then it is shown so it can be switched off, and said why it has to be.

export type CheckValue = { verify?: string | null; phone?: string | null; text_link?: boolean | number | null };

const verifyOf = (v: CheckValue) => (isCodeCheck(v.verify) ? v.verify : 'none');
const says = (key: string) => CHECK_PROVES.find((p) => p.key === key)!.text;

/**
 * Why this recipient's check cannot be sent as it stands, or null. The same rules the server refuses with
 * (checkProblem in src/server/signercode.ts), said before the sender presses Send. `open` is a role in a template
 * that is filled in each time the template is used: its number comes with the person.
 */
export function checkTrouble(r: CheckValue & { role?: string }, textsOn: boolean, name: string, open = false): string | null {
  const verify = verifyOf(r);
  const typed = String(r.phone || '').trim();
  const texts = verify === 'sms_code' || !!r.text_link;
  if (texts && !textsOn) return `This server cannot send text messages, because its operator has not switched them on. For ${name}, choose a one-time code by email or no extra check, and switch "also text the signing link" off.`;
  if (typed && !normalPhone(typed)) return premiumPhone(typed) ? `The number for ${name} is a premium-rate, satellite or international network number, and those are never texted. Type their mobile number.` : `The mobile number for ${name} is not complete. ${PHONE_HOW}`;
  if (r.text_link && r.role === 'inperson') return `${name} signs in person on your device, so there is no link to text them. Switch "also text the signing link" off for them.`;
  if (texts && !typed && !open) return `${name} needs a mobile number${verify === 'sms_code' ? ', because they are checked with a code by text message' : ' for the text with the signing link'}. ${PHONE_HOW}`;
  return null;
}

// keepCode: a locked template asks this person for a one-time code (src/server/tplroles.ts), so "no extra check" is
// not offered: the server would refuse it, and the editor says so before anyone picks it.
export function CheckFields({ value, role, textsOn, open = false, keepCode = false, onChange }: { value: CheckValue; role?: string; textsOn: boolean; open?: boolean; keepCode?: boolean; onChange: (patch: CheckValue) => void }) {
  const saysId = useId();
  const verify = verifyOf(value);
  const typed = String(value.phone || '');
  const usesTexts = verify === 'sms_code' || !!value.text_link;
  // Text messages are shown when this server sends them, or when this recipient still has something of them set.
  const showTexts = textsOn || usesTexts || !!typed.trim();
  const badNumber = !!typed.trim() && !normalPhone(typed);
  return (
    <div className="ed-check">
      <div className="ed-check-row">
        <label className="f">
          <span>Check before the document opens</span>
          <select value={verify} aria-describedby={saysId} onChange={(e) => onChange({ verify: e.target.value })}>
            {(!keepCode || verify === 'none') && <option value="none">{CHECK_NAMES.none}</option>}
            <option value="email_code">{CHECK_NAMES.email_code}</option>
            {(textsOn || verify === 'sms_code') && <option value="sms_code">{CHECK_NAMES.sms_code}</option>}
          </select>
        </label>
        {showTexts && !open && (
          <label className="f">
            <span>Mobile number <span className="hint">(with country code, like +44 7700 900123)</span></span>
            <input type="tel" inputMode="tel" autoComplete="off" value={typed} maxLength={40} aria-invalid={badNumber} onChange={(e) => onChange({ phone: e.target.value })} />
          </label>
        )}
      </div>
      {showTexts && role !== 'inperson' && (
        <label className="check"><input type="checkbox" checked={!!value.text_link} onChange={(e) => onChange({ text_link: e.target.checked })} /> Also text the signing link</label>
      )}
      <p id={saysId} className="muted small ed-check-says" aria-live="polite">
        {verify === 'none' ? says('link') : says(verify)}
        {verify !== 'none' && ' Nothing is sent until they open the link and ask for the code.'}
      </p>
      {showTexts && open && usesTexts && <p className="muted small ed-check-says">The mobile number comes with the person each time this template is used: a &ldquo;phone&rdquo; column in Send to many, or &ldquo;phone&rdquo; next to the name and email in the API. A public form cannot use text messages, because its visitors type their own details.</p>}
      {badNumber && <p className="notice warn small ed-check-says" role="status">{PHONE_HOW}</p>}
      {usesTexts && !textsOn && <p className="notice warn small ed-check-says" role="status">This server cannot send text messages, because its operator has not switched them on. Choose a one-time code by email or no extra check, and switch &ldquo;also text the signing link&rdquo; off.</p>}
    </div>
  );
}
