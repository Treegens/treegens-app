// Whether deleting an envelope only takes it out of the sender's lists, because somebody on it keeps a copy: every
// completed one, and a voided, declined or expired one on which anyone but a cc had finished, signed, approved,
// viewed or witnessed, also before the sender changed it and asked them again (keepsCopy in envelopes.ts). One rule
// for DELETE /envelopes/:id and for the delete dialog (GET /envelopes/:id answers kept_on_delete), so the dialog
// never says "removed for good" about an envelope the server keeps, nor the other way round.
import { keepsCopy } from './envelopes.ts';

export const keptOnDelete = (e: any): boolean =>
  e.kind === 'envelope' && e.status !== 'draft' && (e.status === 'completed' || e.recipients.some((r: any) => keepsCopy(e, r)));
