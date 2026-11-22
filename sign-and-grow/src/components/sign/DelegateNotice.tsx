'use client';
// The signing page when someone signs for a person who is away (src/server/delegation.ts). The server sends
// "recipient.delegate" with what this link is: the delegate's own ("as": "delegate") or the person's ("person"),
// and its state: open (either can still act), mine (the delegate has it), taken (the person started on it, or it
// is closed), removed (no longer needed) or by_delegate (on the person's link: the delegate has it). Everything
// here only says what the server decided. Absent everywhere else, so no other page changes.
import { StateCard, Sender } from './parts';
import { useT } from './lang';

const facts = (data: any) => data?.recipient?.delegate || null;

/** Whether this link shows only who has it, and no document. */
export const delegateAway = (data: any): boolean => {
  const d = facts(data);
  return !!d && ['removed', 'taken', 'by_delegate'].includes(d.state);
};

/** A delegate who has not taken it on yet: the person's own questions to the sender are not theirs to read. */
export const delegateWaiting = (data: any): boolean => facts(data)?.as === 'delegate' && facts(data)?.state === 'open';

/** The "For" line of the consent screen, for a delegate: "Signing for Ana Silva, who named you while they are away." */
export function useDelegateFor(data: any): string | null {
  const T = useT();
  const d = facts(data);
  return d?.as === 'delegate' && (d.state === 'open' || d.state === 'mine') ? T('sign.delegate.for', { name: d.for_name }) : null;
}

/** The whole screen for a link that has nothing left to do. */
export function DelegateAway({ data }: { data: any }) {
  const T = useT();
  const d = facts(data);
  const env = data.envelope;
  const sender = env.sender?.name || '';
  if (d.state === 'by_delegate') {
    const key = d.done ? 'by_done' : d.declined ? 'by_declined' : 'by';
    return (
      <StateCard tone={d.done ? 'ok' : d.declined ? 'stop' : 'wait'} title={T(`sign.delegate.${key}_title`, { name: d.by_name })}>
        <p>{T(`sign.delegate.${key}`, { name: d.by_name, sender })}</p>
        <Sender env={env} brand={data.brand} lead="Questions? Contact" />
      </StateCard>
    );
  }
  const removed = d.state === 'removed';
  return (
    <StateCard tone={removed ? 'stop' : 'wait'} title={removed ? T('sign.delegate.removed_title') : T('sign.delegate.taken_title', { name: d.for_name })}>
      <p>{removed ? T('sign.delegate.removed', { name: d.for_name }) : T('sign.delegate.taken', { name: d.for_name })}</p>
      <Sender env={env} brand={data.brand} lead="Questions? Contact" />
    </StateCard>
  );
}

const NOTE_ID = 'sg-delegate-note';
/** The id of the note above Continue while it is shown, so Continue is described by it. */
export const delegateNoteId = (data: any): string | undefined => (facts(data)?.state === 'open' ? NOTE_ID : undefined);

/** Right above Continue: what agreeing does, for the delegate and for the person. */
export function DelegateConsentNote({ data }: { data: any }) {
  const T = useT();
  const d = facts(data);
  if (d?.state !== 'open') return null;
  return (
    <p className="notice sg-gap" role="note" id={NOTE_ID}><b>{d.as === 'delegate' ? T('sign.delegate.take_on', { name: d.for_name }) : T('sign.delegate.person_note', { name: d.by_name })}</b></p>
  );
}
