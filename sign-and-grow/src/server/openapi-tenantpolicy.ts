// The account's own switches (routes-tenantpolicy.ts), as part of /api/openapi.json. Kept apart so the main
// description stays readable; openapi.ts spreads it into its paths.
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const onOff = (description: string) => ({ type: 'string', enum: ['on', 'off'], description });
const bool = (description: string) => ({ type: 'boolean', description });

/** The shape GET /me ("policy") and GET /sign/{token} ("policy", for the account whose document it is) carry. */
export const clientPolicySchema = {
  type: 'object',
  description: 'What the account switched on or off for itself. Nothing in it is a secret, and a signer learns nothing else about the account from it.',
  properties: {
    impact_display: onOff('"Trees on screens and emails". Off: the signing page, the finished screen, the emails about the account\'s documents, and the sender\'s envelope page and review step say nothing about trees or paper. What was planted is counted all the same.'),
    ai_helper: onOff('"AI answers in the help chat", for the account\'s people and for the people who sign its documents. Off: their questions are answered from the built-in help and never sent to a model.'),
    white_label: bool('Kept for a later feature. Always false.'),
  },
};

const view = {
  type: 'object',
  properties: {
    ...clientPolicySchema.properties,
    impact_record: onOff('"Trees on the signing record" as it applies on this server (PUT /account/impact-record changes it). Always "off" when the server is set up for a public body.'),
    record_fixed: bool('True when the server is set up for a public body (DEPLOYMENT_PROFILE=government): the signing record never carries trees, so there is no switch for it.'),
    ai_available: bool('True when a model answers the help chat on this server. False: there is nothing to switch on, and "ai_helper" changes nothing. On a server set up for a public body only a model the operator runs answers, never a hosted service.'),
    ai_provider: { type: 'string', nullable: true, description: 'Who writes the answers, as the operator named them, when "ai_available" is true.' },
    ai_assist: bool('True when "ai_helper" also turns on AI help when sending and signing (Draft a message, and with "Let the AI read document text" suggested fields and a summary for signers). False when AI_ASSIST_DAILY_LIMIT is 0. Absent when no model answers.'),
  },
};

export const tenantPolicyPaths = () => ({
  '/account/policy': {
    get: {
      tags: ['Account'], summary: 'The account\'s switches for trees on screens and AI answers (admins)',
      description: 'Every account starts with both on, also on a server set up for a public body. GET /me carries "impact_display", "ai_helper" and "white_label" as "policy" for everyone in the account, and GET /sign/{token} carries them as "policy" for the account whose document it is. There "ai_helper" is what happens: "on" only when the account has it on and a model answers the chat on this server. An API key with the admin scope may read this.',
      responses: ok(view),
    },
    put: {
      tags: ['Account'], summary: 'Switch trees on screens or AI answers on or off (owners and admins, signed in to the app)',
      description: 'Send one or both of "impact_display" and "ai_helper", each "on" or "off". Refused with 400 when a value is anything else, with "white_label" or "impact_record" in the body, or with neither; nothing is changed then, also not the half that was right. 403 for an API key, of either scope, and for a member who is not an admin. 409 for "ai_helper": "on" when no model answers the help chat on this server. Each change is written to the security record as "settings.changed" with what it was and what it is; sending what is already set writes nothing.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { impact_display: onOff('Trees on screens and emails.'), ai_helper: onOff('AI answers in the help chat.') } } } } },
      responses: ok(view),
    },
  },
});
