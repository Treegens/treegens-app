// Whether deleting an envelope only takes it out of the sender's lists, because somebody on it keeps a copy: every
// completed one, and a voided, declined or expired one on which anyone but a cc had finished, signed, approved,
// viewed or witnessed, also before the sender changed it and asked them again (keepsCopy in envelopes.ts). One rule
// for DELETE /envelopes/:id and for the delete dialog (GET /envelopes/:id answers kept_on_delete), so the dialog
// never says "removed for good" about an envelope the server keeps, nor the other way round.
import { keepsCopy } from './envelopes.ts';
// A dispute that a person at Sign&Grow has not closed yet keeps the envelope too, whatever its state (the owner's
// rule: evidence.ts). Deleting it would take the dispute with it.
import { disputeOpen } from './evidence.ts';

export const keptOnDelete = (e: any): boolean =>
  e.kind === 'envelope' && e.status !== 'draft' && (e.status === 'completed' || e.recipients.some((r: any) => keepsCopy(e, r)) || disputeOpen(e.id));

/** The line the envelope's record gets when deleting it only took it out of the sender's lists. */
export const keptLine = (e: any): string => (e.status !== 'completed' && !e.recipients.some((r: any) => keepsCopy(e, r))
  ? 'The sender deleted this envelope from their account. It is kept, because a person named on it disputes it and Sign&Grow has not closed that dispute yet. Once it is closed, it can be deleted for good.'
  : 'The sender deleted this envelope from their account. Everyone on it keeps their link and their copy.');
