'use client';
import { useId } from 'react';
import { PHONE_HOW, normalPhone, maskPhone } from '@/lib/checks';
import { WA_AGREE, WA_HOW } from '@/lib/channels';
import { BY_SENDER_TICK, BY_SENDER_HOW } from '@/lib/bysender';
import { canSendMyself } from '@/lib/editorux';
import { PhoneBox } from './CheckPick';

// The link by WhatsApp, in a person's More under "How they get it" (PersonMore.tsx). Only where this server's
// operator set WhatsApp up (/api/me says so in `whatsapp`), only for one person on an envelope (never a template, a
// group, a copy, someone who signs in person, or someone whose link the sender passes on), and never together with
// the link by text message. Where it is set up, "How they get it" is one list (DeliverPick): Email, Email and a text
// message, Email and WhatsApp, I will send the link myself. One choice at a time, so the rule needs no sentence.
// The rules are the server's (src/server/whatsapp.ts): this only says them.

/** Whether WhatsApp can be offered for this person at all. */
export const canWhatsApp = (r: any, isTpl: boolean, on: boolean) =>
  on && !isTpl && !r.group_id && !r.link_by_sender && !r.text_link && ['signer', 'approver', 'viewer', 'witness'].includes(r.role);

/** The tick holds for the number it was given for: a freshly typed number needs it again. */
export const waTicked = (r: any) => (r.wa_tick_for === undefined ? !!r.whatsapp_agreed : !!r.whatsapp_agreed && r.wa_tick_for === String(r.phone || ''));

/** The number, the tick that they agreed, and what WhatsApp does, for a person who gets the link by WhatsApp. */
function WaDetails({ r, waOn, hint, onChange }: { r: any; waOn: boolean; hint: string; onChange: (p: any) => void }) {
  const typed = String(r.phone || '');
  const bad = !!typed.trim() && !normalPhone(typed);
  const phone = normalPhone(typed);
  return (
    <>
      {r.verify !== 'sms_code' && (
        <label className="f" style={{ margin: '10px 0 0' }}>
          <span>Mobile number <span className="hint">(with country code, like +44 7700 900123)</span></span>
          <input type="tel" inputMode="tel" autoComplete="off" value={typed} maxLength={40} aria-invalid={bad} onChange={(e) => onChange({ phone: e.target.value })} />
        </label>
      )}
      {bad && <p className="notice warn small ed-check-says" role="status">{PHONE_HOW}</p>}
      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={waTicked(r)} disabled={!phone} onChange={(e) => onChange({ whatsapp_agreed: e.target.checked, wa_tick_for: typed })} />
        <span>{WA_AGREE}{phone ? <span className="muted"> ({maskPhone(phone)})</span> : null}</span>
      </label>
      <p id={hint} className="muted small ed-check-says">{WA_HOW}</p>
      {!waOn && <p className="notice warn small ed-check-says" role="status">This server cannot send WhatsApp messages, because its operator has not set it up. Choose Email.</p>}
      {r.text_link && <p className="notice warn small ed-check-says" role="status">The link by text message is on too. Choose one of the two.</p>}
    </>
  );
}

/** A WhatsApp choice saved earlier on a server that no longer offers it, or on a template: shown so it can be taken off. */
export function WaLink({ r, isTpl, waOn, onChange }: { r: any; isTpl: boolean; waOn: boolean; onChange: (p: any) => void }) {
  const hint = useId();
  const on = !!r.whatsapp;
  if (!on && !canWhatsApp(r, isTpl, waOn)) return null;
  return (
    <div className="ed-walink">
      <label className="check"><input type="checkbox" checked={on} aria-describedby={on ? hint : undefined} onChange={(e) => onChange({ whatsapp: e.target.checked })} /> <span>Also send the link by WhatsApp</span></label>
      {on && <WaDetails r={r} waOn={waOn} hint={hint} onChange={onChange} />}
    </div>
  );
}

type Way = 'email' | 'text' | 'whatsapp' | 'myself';
const wayOf = (r: any): Way => (r.link_by_sender ? 'myself' : r.text_link ? 'text' : r.whatsapp ? 'whatsapp' : 'email');

/** Whether "How they get it" is the one list: an envelope (not a template) on a server with WhatsApp set up. */
export const usesDeliverPick = (isTpl: boolean, waOn: boolean) => waOn && !isTpl;

/**
 * "How they get it" as one list, where WhatsApp is set up: the four answers the line itself says (src/lib/editorux.ts
 * moreLines). Each choice switches the others off. A choice this person cannot have is not listed, unless it is
 * what they have now. Going back from "I will send the link myself" gives back the address typed before.
 */
export function DeliverPick({ r, textsOn, onChange }: { r: any; textsOn: boolean; onChange: (p: any) => void }) {
  const hint = useId();
  const group = `ed-deliver-${r.id}`;
  const way = wayOf(r);
  const plain = { ...r, text_link: false, whatsapp: false, link_by_sender: false };
  const offer: Way[] = ['email'];
  if ((textsOn && r.role !== 'inperson' && !r.group_id) || way === 'text') offer.push('text');
  if (canWhatsApp(plain, false, true) || way === 'whatsapp') offer.push('whatsapp');
  if (canSendMyself(plain, false) || way === 'myself') offer.push('myself');
  const choose = (to: Way) => {
    if (to === way) return;
    const back = way === 'myself' ? { email: r.email_before_tick || '' } : {};
    if (to === 'email') onChange({ ...back, link_by_sender: false, text_link: false, whatsapp: false });
    else if (to === 'text') onChange({ ...back, link_by_sender: false, text_link: true, whatsapp: false });
    else if (to === 'whatsapp') onChange({ ...back, link_by_sender: false, text_link: false, whatsapp: true });
    else onChange({ link_by_sender: true, text_link: false, whatsapp: false, email: '', email_before_tick: r.email || '' });
  };
  const words: Record<Way, string> = { email: 'Email', text: 'Email and a text message', whatsapp: 'Email and WhatsApp', myself: BY_SENDER_TICK };
  return (
    <fieldset className="ed-myself ed-deliver" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="ed-sr">How they get it</legend>
      {offer.map((w) => (
        <label key={w} className="check">
          <input type="radio" name={group} checked={way === w} aria-describedby={way === w && w !== 'email' ? hint : undefined} onChange={() => choose(w)} />
          <span>{words[w]}{w === 'myself' ? <span className="muted"> (no email address needed)</span> : null}</span>
        </label>
      ))}
      {way === 'text' && (r.verify === 'sms_code' ? <p id={hint} className="muted small ed-check-says">The link goes by text to the number under Check who signs.</p> : <div id={hint}><PhoneBox r={r} onChange={onChange} /></div>)}
      {way === 'text' && !textsOn && <p className="notice warn small ed-check-says" role="status">This server cannot send text messages, because its operator has not switched them on. Choose Email.</p>}
      {way === 'whatsapp' && <WaDetails r={r} waOn hint={hint} onChange={onChange} />}
      {way === 'myself' && <p id={hint} className="muted small">{BY_SENDER_HOW}</p>}
    </fieldset>
  );
}
