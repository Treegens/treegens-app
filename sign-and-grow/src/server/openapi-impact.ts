// Trees, as part of /api/openapi.json (routes-impact.ts). Kept apart so the main description stays readable;
// openapi.ts spreads it into its paths.
import { TREES_PER_SIGNATURE, SOFT_LINE } from '../lib/impactwords.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const tok = { name: 'token', in: 'path', required: true, schema: { type: 'string' } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const RULE = `A signature that was paid for funds ${TREES_PER_SIGNATURE} mangroves, planted by Treegens. A free one (the signatures a new account starts with, a free code, a sender signing their own document, a server that takes no payments) funds none, and nothing is said to be planted for it; the most that is said then is: "${SOFT_LINE}"`;

export const impactPaths = () => ({
  '/sign/{token}/impact': {
    get: {
      tags: ['Signing'], security: [], parameters: [tok],
      summary: 'What the signing page may say about trees to the person holding this link',
      description: `${RULE} Refused with 401 until an access code or one-time code has been passed. An approver, a viewer, a copy and a witness get { finish: 0, done: null }.`,
      responses: ok({ type: 'object', properties: {
        finish: { ...int, description: `Mangroves that will be planted when this person finishes: ${TREES_PER_SIGNATURE} for someone who signs with a paid signature while it is their turn, otherwise 0.` },
        done: { type: 'object', nullable: true, description: 'After this person has finished signing. null before, and for anyone who does not sign.', properties: {
          trees: { ...int, description: `${TREES_PER_SIGNATURE} or 0. Asked again each time: a payment that went back no longer counts.` },
          first: { ...bool, description: 'No earlier finished signature from this address on this server.' },
          celebrate: { ...bool, description: 'The first-time picture has not been shown yet.' },
          total: { ...int, description: 'Mangroves funded by all paid signatures from this address, this one included.' },
          sheets: { ...int, description: 'An estimate: the pages of the document times the people on it.' },
        } },
      } }),
    },
  },
  '/sign/{token}/impact/seen': {
    post: { tags: ['Signing'], security: [], parameters: [tok], summary: 'The first-time picture was shown: it is not offered again', description: 'Changes nothing before the person has finished.', responses: ok({ type: 'object', properties: { ok: bool } }) },
  },
  '/envelopes/{id}/impact': {
    get: {
      tags: ['Envelopes'], parameters: [idParam],
      summary: 'What an envelope of yours saves and plants',
      description: RULE,
      responses: ok({ type: 'object', properties: {
        plus: { ...bool, description: 'For a draft: every signature of it would come out of a payment, as things stand. A forecast, asked again after sending.' },
        sent: { type: 'object', nullable: true, description: 'null for a draft.', properties: {
          paid: { ...int, description: 'People who sign for whom a paid signature is held or was used. Someone later in a signing order has none held yet.' },
          signers: { ...int, description: 'People who sign and use a signature.' },
          planted: { ...int, description: 'Mangroves funded by the paid signatures finished on this account\'s documents.' },
          sheets: int,
          celebrate: { ...bool, description: 'This is the first envelope the account ever sent, asked by the person who sent it within the hour, and the picture has not been shown.' },
        } },
      } }),
    },
  },
  '/envelopes/{id}/impact/seen': {
    post: { tags: ['Envelopes'], parameters: [idParam], summary: 'The first-send picture was shown: it is not offered again', responses: ok({ type: 'object', properties: { ok: bool } }) },
  },
  '/account/impact-record': {
    get: { tags: ['Account'], summary: '"Trees on the signing record": whether the certificate of completion ends with the box on paper and mangroves', responses: ok({ type: 'object', properties: { on: bool } }) },
    put: {
      tags: ['Account'], summary: 'Switch "Trees on the signing record" on or off (admins)',
      description: 'On by default. Off leaves the box "Signed without paper" off the signing record of documents completed from then on. Screens, emails and the impact pages are not changed by it. The change is written to the security record.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['on'], properties: { on: bool } } } } },
      responses: ok({ type: 'object', properties: { on: bool } }),
    },
  },
});
