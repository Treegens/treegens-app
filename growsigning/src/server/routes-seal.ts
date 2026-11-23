// The digital seal of completed PDFs, as an account's admins see it in Settings (Records and data): one read-only
// line once the people who run the server have set it up (src/server/seal.ts, sealkey.ts). Nothing can be changed
// from here: the key and the time-stamp service are settings of the server.
import { route } from './router.ts';
import { sealStatus } from './seal.ts';

// { set: false } on a server without seal settings (the screen then shows nothing);
// { set: true, on: false } when a seal is set but cannot be used right now: why is told to the people who run the
//   server, not here, because the reason can name files on the server;
// { set: true, on: true, by, issuer, time_stamp, until } otherwise: the name on the seal certificate, who issued it,
//   whether a time-stamp service is asked, and the day the certificate ends.
route('GET', '/seal', () => sealStatus(), 'admin');
