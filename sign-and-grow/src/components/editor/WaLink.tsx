'use client';
import { useId } from 'react';
import { PHONE_HOW, normalPhone, maskPhone } from '@/lib/checks';
import { WA_AGREE, WA_HOW } from '@/lib/channels';

// "Also send the link by WhatsApp", in a person's More under "How they get it" (PersonMore.tsx). Only where this
// server's operator set WhatsApp up (/api/me says so in `whatsapp`), only for one person on an envelope (never a
// template, a group, a copy, someone who signs in person, or someone whose link the sender passes on), and never
// together with the link by text message. Something set earlier is still shown, so it can be taken off. The rules
// are the server's (src/server/whatsapp.ts): this only says them.

/** Whether WhatsApp can be offered for this person at all. */
export const canWhatsApp = (r: any, isTpl: boolean, on: boolean) =>
  on && !isTpl && !r.group_id && !r.link_by_sender && !r.text_link && ['signer', 'approver', 'viewer', 'witness'].includes(r.role);

/** The tick holds for the number it was given for: a freshly typed number needs it again. */
export const waTicked = (r: any) => (r.wa_tick_for === undefined ? !!r.whatsapp_agreed : !!r.whatsapp_agreed && r.wa_tick_for === String(r.phone || ''));

export function WaLink({ r, isTpl, waOn, onChange }: { r: any; isTpl: boolean; waOn: boolean; onChange: (p: any) => void }) {
  const hint = useId();
  const on = !!r.whatsapp;
  if (!on && !canWhatsApp(r, isTpl, waOn)) return null;
  const typed = String(r.phone || '');
  const bad = !!typed.trim() && !normalPhone(typed);
  const phone = normalPhone(typed);
  return (
    <div className="ed-walink">
      <label className="check"><input type="checkbox" checked={on} aria-describedby={on ? hint : undefined} onChange={(e) => onChange({ whatsapp: e.target.checked })} /> <span>Also send the link by WhatsApp</span></label>
      {on && (
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
          {!waOn && <p className="notice warn small ed-check-says" role="status">This server cannot send WhatsApp messages, because its operator has not set it up. Take the tick off.</p>}
          {r.text_link && <p className="notice warn small ed-check-says" role="status">The link by text message is on too. Choose one of the two.</p>}
        </>
      )}
    </div>
  );
}
