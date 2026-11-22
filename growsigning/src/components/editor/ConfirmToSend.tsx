'use client';
import { useMe } from '../AppShell';
import { ConfirmCode, ResendLink, useConfirmedElsewhere } from '../ConfirmEmail';
import { toast } from '../ui';
import { CONFIRM_BEFORE_SEND } from '@/lib/confirm';

/** Whether a refusal from the server is the one about an address that is not confirmed yet. */
export const isConfirmRefusal = (error: string) => !!error && error.startsWith(CONFIRM_BEFORE_SEND);

/**
 * The review step for a person who has not confirmed their email address yet: the code box right here, where Send
 * is, so nobody has to leave the editor to find it. The editor is drawn full screen, without the banner the rest of
 * the app has. Nothing is drawn for a confirmed address. `refused` is set once the button was pressed and refused for this.
 */
export function ConfirmToSend({ refused, button = 'Send' }: { refused: boolean; /** What the step's main button reads: Send, or Sign now. */ button?: string }) {
  const me = useMe();
  const unconfirmed = !me.user.email_verified;
  useConfirmedElsewhere(unconfirmed, me.reload);
  if (!unconfirmed) return null;
  const email = <bdi className="cc-email">{me.user.email}</bdi>;
  // Too many wrong codes were typed (src/server/confirmcode.ts): only the button in the email works now.
  if (me.user.confirm_by_code === false) return (
    <section className={`notice ${refused ? 'err' : 'warn'} cc-banner cc-send`} role={refused ? 'alert' : undefined} aria-labelledby="cc-send-h">
      <p className="cc-text"><b id="cc-send-h">{refused ? 'Not sent yet.' : 'One thing before you send.'}</b> Press the button in the email we sent to {email}, in this browser, then press {button}{refused ? ' again' : ''}. Codes no longer work for this login. Your document is saved as a draft.</p>
      <ResendLink email={me.user.email} label="Send the email again" />
    </section>
  );
  return (
    <section className={`notice ${refused ? 'err' : 'warn'} cc-banner cc-send`} role={refused ? 'alert' : undefined} aria-labelledby="cc-send-h">
      <p className="cc-text"><b id="cc-send-h">{refused ? 'Not sent yet.' : 'One thing before you send.'}</b> Type the 6-digit code we emailed to {email}, then press {button}{refused ? ' again' : ''}. Your document is saved as a draft.</p>
      <ConfirmCode email={me.user.email} onConfirmed={() => (toast(`Email confirmed. Now press ${button}.`), me.reload())} onClosed={me.reload} />
    </section>
  );
}
