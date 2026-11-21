'use client';
import { neverOpened, howLong } from './lib';

// The envelope page for someone whose link the sender sends themselves ("I will send the link myself", see
// src/lib/bysender.ts). We email that person nothing, ever, so this card is the only way their link reaches them:
// it says so, and offers the link and the ways to send it, while it is their turn and again once they have finished,
// because the same link is how they get the completed document. No nudge is offered: there is nobody to email.

/** Someone on this envelope with no address, whose link the sender passes on. */
export const ownLink = (r: any): boolean => !!r?.link_by_sender && !r?.email;

/** What the "Email" line of their card says, by where they stand. `waitingOn` names who has to finish first. */
export function ownLinkFact(r: any, out: boolean, waitingOn: string[]): string {
  if (r.status === 'pending') return out
    ? `None. We have no address for them and never write to them. ${waitingOn.length ? `Their link opens once ${waitingOn.join(' and ')} ${waitingOn.length === 1 ? 'has' : 'have'} finished, and we email you then, so you can send it.` : 'Their link opens when their turn comes, and we email you then.'}`
    : 'None. The document closed before their turn.';
  return 'None. You said you would send them the link yourself, so we have not written to them and never will. That includes reminders and the copy at the end.';
}

type Props = {
  r: any; envelopeStatus: string; busy: string; link: string;
  /** Kept for callers that pass it; the link is shown under the buttons once Copy link was pressed. */
  onShow?: () => void; onCopy: () => void; onQr: (el: HTMLButtonElement) => void; onShare: (how: 'whatsapp' | 'sms') => void;
};

/** The hint and the buttons. Shown while it is their turn, and after they finished while the document can be opened. */
export function OwnLinkActions({ r, envelopeStatus, busy, link, onCopy, onQr, onShare }: Props) {
  const turn = envelopeStatus === 'sent' && (r.status === 'sent' || r.status === 'viewed');
  const done = r.status === 'completed' && (envelopeStatus === 'sent' || envelopeStatus === 'completed');
  if (!ownLink(r) || (!turn && !done)) return null;
  const quiet = turn && r.status === 'sent' && neverOpened(r);
  return (
    <div className="sn-myself">
      <p className={`sn-hint${quiet ? ' warn' : ''}`}>
        {done
          ? envelopeStatus === 'completed'
            ? <><b>Send {r.name} their copy.</b> We have no address for them, so no copy went to them. Their link opens the completed document, and they can download it there.</>
            : <><b>{r.name} has finished.</b> Their link opens what they signed, and the completed document once everyone has signed. Send it to them again then: we cannot tell them.</>
          : quiet
            ? <><b>Not opened in {howLong(r.sent_at)}.</b> You said you would send {r.name} the link yourself. Check that it went to the right chat, or send it again:</>
            : <><b>Send {r.name} their link yourself.</b> We email them nothing, not even reminders or the final copy. Anyone with the link can open the document, so send it only to them:</>}
      </p>
      <div className="sn-person-actions">
        <button className="btn sm" disabled={!!busy} onClick={onCopy} aria-label={`Copy signing link for ${r.name}`}>Copy link</button>
        <button className="btn sm qr-tap" disabled={!!busy} onClick={(ev) => onQr(ev.currentTarget)} aria-haspopup="dialog" aria-label={`Show a QR code with the signing link for ${r.name}`}>QR code</button>
        <button className="btn sm" disabled={!!busy} onClick={() => onShare('whatsapp')} aria-label={`Share link with ${r.name} on WhatsApp`}>WhatsApp</button>
        <button className="btn sm" disabled={!!busy} onClick={() => onShare('sms')} aria-label={`Share link with ${r.name} by text message`}>Text</button>
      </div>
      {link && (
        <label className="sn-link">
          <span>Personal link for {r.name}. Only share it with them.</span>
          <input readOnly value={link} onFocus={(ev) => ev.currentTarget.select()} />
        </label>
      )}
    </div>
  );
}
