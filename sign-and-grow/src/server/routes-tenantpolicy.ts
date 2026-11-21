// Settings, Account: what an account switches on or off for itself (src/server/tenantpolicy.ts).
//   GET /account/policy   what is chosen, and which of the switches mean anything on this server.
//   PUT /account/policy   { impact_display?: 'on' | 'off', ai_helper?: 'on' | 'off' }, owners and admins, in a browser.
// Every change is written to the account's history (the security record, 'settings.changed'). An API key cannot
// change them: a leaked key should not be able to send an organisation's questions to an AI service, or put tree
// lines back on what its signers see.
import { route } from './router.ts';
import { bad } from './util.ts';
import { record } from './seclog.ts';
import { tenantPolicy, setTenantPolicy, clientPolicy, type OnOff } from './tenantpolicy.ts';
import { chatModelOn, chatProvider } from '../lib/chatprovider.ts';
import { isGovernment } from '../lib/deployment.ts';
import { setByField } from './orgs.ts';

function view(accountId: string) {
  const p = tenantPolicy(accountId);
  const ai = chatModelOn();
  return {
    ...clientPolicy(accountId),
    // What the account chose, which the switch shows (clientPolicy gives pages what happens instead).
    ai_helper: p.ai_helper,
    impact_record: p.impact_record,
    // Whether each switch does anything here. A page shows a switch only when it does.
    //   record_fixed: the signing record never carries trees on this server (DEPLOYMENT_PROFILE=government).
    //   ai_available: a model answers the help chat on this server. Without one there is nothing to switch.
    record_fixed: isGovernment(),
    ai_available: ai,
    ai_provider: ai ? chatProvider()!.name : null,
    // A switch an organisation above the account decided: "Set by Ministry of Health" (src/server/orgs.ts). Only
    // for an account in an organisation that set one.
    ...setByField(accountId),
  };
}

route('GET', '/account/policy', (c) => view(c.account.id), 'admin');

const onOff = (v: unknown, name: string): OnOff | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'on' && v !== 'off') throw bad(`Send "${name}" as "on" or "off". Nothing was changed.`);
  return v;
};

route('PUT', '/account/policy', async (c) => {
  if (c.auth?.via === 'api_key') throw bad('An API key cannot change these settings. That needs an owner or an admin signed in to the app, under Settings, Account. Nothing was changed.', 403);
  const b = await c.body();
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Send a JSON object with "impact_display" or "ai_helper", each "on" or "off". Nothing was changed.');
  if ('white_label' in b || 'impact_record' in b) throw bad('"white_label" and "impact_record" cannot be changed here. Nothing was changed.');
  const change = { impact_display: onOff(b.impact_display, 'impact_display'), ai_helper: onOff(b.ai_helper, 'ai_helper') };
  if (!change.impact_display && !change.ai_helper) throw bad('Send "impact_display" or "ai_helper", each "on" or "off". Nothing was changed.');
  // Switching AI answers on where no model answers would be a switch that does nothing. Off is always allowed.
  if (change.ai_helper === 'on' && !chatModelOn())
    throw bad(isGovernment()
      ? 'No AI model that this server may use is set up, so there is nothing to switch on. Whoever runs this server can point the help chat at a model of their own (SUPPORT_CHAT_BASE_URL with SUPPORT_CHAT_API_KEY). Nothing was changed.'
      : 'No AI model is set up for the help chat on this server, so there is nothing to switch on. Nothing was changed.', 409);
  const { before, after } = setTenantPolicy(c.account.id, change);
  const settings: Record<string, { from: OnOff; to: OnOff }> = {};
  if (before.impact_display !== after.impact_display) settings.trees_on_screens_and_emails = { from: before.impact_display, to: after.impact_display };
  if (before.ai_helper !== after.ai_helper) settings.ai_answers_in_help_chat = { from: before.ai_helper, to: after.ai_helper };
  if (Object.keys(settings).length) record('settings.changed', { c, about: ['account', c.account.id], details: { settings } });
  return view(c.account.id);
}, 'admin');
