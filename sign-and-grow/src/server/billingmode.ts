// BILLING_MODE=deployment on the server side (the setting and its words: src/lib/billingmode.ts).
//
// How "nothing is counted and no payment provider is called" is kept without a branch in every place that holds or
// uses a signature: every one of them already asks creditsEnabled() (src/server/credits.ts) or billingEnabled()
// (src/server/envelopes.ts) first, and both are true only while STRIPE_SECRET_KEY is set. In deployment mode the
// payment settings are taken away before anything reads them, the same way OUTSIDE_CALLS=none switches off a service
// (src/lib/outside.ts applyOutsideCalls), so each of those places finds payments not set up: no signature is
// counted, held, used or expires, no low-balance email, no tree line per signature, and no call to Stripe.
// The routes of the plan answer 404 in deployment mode (closedRoute, asked by src/server/router.ts).
import { isDeploymentBilling, PAYMENT_SETTINGS } from '../lib/billingmode.ts';

type Env = Record<string, string | undefined>;
const g = globalThis as any;

/** In deployment mode, take the payment settings away. Returns the names it removed (for the log). */
export function applyBillingMode(env: Env = process.env): string[] {
  if (!isDeploymentBilling(env)) return [];
  const had = PAYMENT_SETTINGS.filter((k) => String(env[k] ?? '').trim());
  for (const k of had) delete env[k];
  if (had.length && env === process.env) g.__sgBillingOff = [...(g.__sgBillingOff || []), ...had];
  return had;
}

/** What applyBillingMode took away since this server started. */
export const paymentSettingsIgnored = (): string[] => g.__sgBillingOff || [];

// The plan: its state, paying, top-ups, codes, refunds, stopping from an email, the payment provider's webhook and
// the operator's money tools (src/server/routes-billing.ts).
const PLAN_ROUTES = /^\/(?:billing|public\/billing|operator\/billing)(?:\/|$)|^\/stripe(?:\/|$)/;

export const CLOSED_TEXT = 'There is no plan on this server: it is provided under an agreement, and nothing is counted or charged here. Settings, Plan says which agreement.';

/** True when this API path belongs to the plan and the server is in deployment mode. */
export function closedRoute(path: string, env: Env = process.env): boolean {
  if (!isDeploymentBilling(env)) return false;
  // A setting put back while the server runs (a test, a hot reload) is taken away again before it is read.
  applyBillingMode(env);
  return PLAN_ROUTES.test(path);
}

applyBillingMode();
