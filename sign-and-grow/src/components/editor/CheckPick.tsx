'use client';
import { useId, useState } from 'react';
import { CHECK_PROVES, PHONE_HOW, normalPhone } from '@/lib/checks';
import { checkChoices, checkHasCode, checkPatch, checkValue, ACCESS_CODE_SAYS, NO_CHECK_SAYS } from '@/lib/editorux';
import type { KeptForPerson } from '@/lib/tplroles';

// Two pickers of a person's More in step 1 (PersonMore.tsx). "Check who signs" is one list, so nobody has to put an
// access code and a one-time code together by hand (src/lib/editorux.ts checkChoices). "Also text the signing link"
// stands under "How they get it", where the line that names it is. Text messages are only offered where this
// server sends them; something set earlier is still shown, so it can be taken off, and it says why it has to be.

const says = (key: string) => CHECK_PROVES.find((p) => p.key === key)!.text;
const NO_TEXTS = 'This server cannot send text messages, because its operator has not switched them on.';

function PhoneBox({ r, onChange }: { r: any; onChange: (p: any) => void }) {
  const typed = String(r.phone || '');
  const bad = !!typed.trim() && !normalPhone(typed);
  return (
    <>
      <label className="f" style={{ margin: '10px 0 0' }}>
        <span>Mobile number <span className="hint">(with country code, like +44 7700 900123)</span></span>
        <input type="tel" inputMode="tel" autoComplete="off" value={typed} maxLength={40} aria-invalid={bad} onChange={(e) => onChange({ phone: e.target.value })} />
      </label>
      {bad && <p className="notice warn small ed-check-says" role="status">{PHONE_HOW}</p>}
    </>
  );
}

const TPL_PHONE = 'The mobile number comes with the person each time this template is used: a "phone" column in a bulk send, or "phone" next to the name and email in the API. A public form cannot use text messages, because its visitors type their own details.';

/** "Check who signs": none, an access code, a one-time code, or both. `open`: a template role filled in each time. */
export function CheckPick({ r, name, kept, textsOn, open, onChange }: { r: any; name: string; kept?: KeptForPerson; textsOn: boolean; open: boolean; onChange: (p: any) => void }) {
  const saysId = useId();
  // Picking a choice with an access code shows its box before anything is typed in it.
  const [wants, setWants] = useState(false);
  const value = checkValue(r, wants || !!kept?.code);
  const code = checkHasCode(value);
  const verify = r.verify === 'email_code' || r.verify === 'sms_code' ? r.verify : 'none';
  return (
    <div className="ed-checkpick">
      <label className="f" style={{ margin: 0 }}><span>Check before {name} can open it</span>
        <select value={value} aria-label="Check who signs" aria-describedby={saysId} onChange={(e) => (setWants(checkHasCode(e.target.value)), onChange(checkPatch(e.target.value)))}>
          {checkChoices({ textsOn, current: value, keepVerify: !!kept?.verify, keepCode: !!kept?.code }).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      {/* What a locked template gave this person stays (wording.people, tplroles.ts): shown as such. */}
      {code && <label className="f" style={{ margin: '10px 0 0' }}><span>Access code <span className="hint">{kept?.code ? '(from the template: you can change it, not take it off)' : '(at least 4 characters, a code you tell them yourself)'}</span></span><input value={r.access_code || ''} maxLength={50} required onChange={(e) => onChange({ access_code: e.target.value })} /></label>}
      {verify === 'sms_code' && !open && <PhoneBox r={r} onChange={onChange} />}
      <p id={saysId} className="muted small ed-check-says" aria-live="polite">
        {/* One short note: what a one-time code shows and does not show, or what an access code rests on. */}
        {value === 'none' ? NO_CHECK_SAYS : verify !== 'none' ? `${says(verify)} Nothing is sent until they open the link and ask for the code.` : ACCESS_CODE_SAYS}
      </p>
      {verify === 'sms_code' && open && <p className="muted small ed-check-says">{TPL_PHONE}</p>}
      {verify === 'sms_code' && !textsOn && <p className="notice warn small ed-check-says" role="status">{NO_TEXTS} Choose a code by email or no check.</p>}
    </div>
  );
}

/** "Also text the signing link", with the number it goes to. Nothing at all where texts are off and none was set. */
export function TextLink({ r, textsOn, open, onChange }: { r: any; textsOn: boolean; open: boolean; onChange: (p: any) => void }) {
  const on = !!r.text_link;
  if (!on && (!textsOn || r.role === 'inperson' || r.link_by_sender)) return null;
  return (
    <div className="ed-textlink">
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => onChange({ text_link: e.target.checked })} /> <span>Also text the signing link</span></label>
      {on && !open && <PhoneBox r={r} onChange={onChange} />}
      {on && open && <p className="muted small ed-check-says">{TPL_PHONE}</p>}
      {on && !textsOn && <p className="notice warn small ed-check-says" role="status">{NO_TEXTS} Take the tick off.</p>}
    </div>
  );
}
