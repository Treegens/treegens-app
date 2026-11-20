// Numbers the public pages quote: the refund window, the unused-plan rule, the time to undo closing an account.
// Server components only: this reads the environment, so do not import it from a 'use client' file.
//
// These mirror the server on purpose instead of importing it. A page must never import a routes-*.ts file from
// src/server: Next.js gives pages and the API their own copies of every module, the import registers the API
// handlers a second time from the page's copy, and the router then no longer recognises their errors, so every
// "that card does not match" turns into a 500. If one of the rules below changes on the server, change it here too.
//
//   refundDays        refundDays() in src/server/routes-billing.ts         REFUND_DAYS, default 30
//   dormantStopDays   dormantStopDays() in routes-billing.ts               DORMANT_AUTO_STOP_DAYS, default 90, 0 = off
//   closeGraceDays    CLOSE_GRACE_DAYS in src/server/routes-trust.ts       not configurable

export type Facts = {
  refundDays: number; // unused signatures from the latest payment are refunded on request within this many days
  dormantStopDays: number; // an unused paid plan is not renewed after this many quiet days; 0 means the rule is off
  closeGraceDays: number; // a closed account can be brought back by signing in for this long
};

export function publicFacts(): Facts {
  return {
    refundDays: Number(process.env.REFUND_DAYS) || 30,
    dormantStopDays: process.env.DORMANT_AUTO_STOP_DAYS === undefined ? 90 : Number(process.env.DORMANT_AUTO_STOP_DAYS) || 0,
    closeGraceDays: 30,
  };
}
