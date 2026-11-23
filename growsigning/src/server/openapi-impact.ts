// Trees, as part of /api/openapi.json (routes-impact.ts). Kept apart so the main description stays readable;
// openapi.ts spreads it into its paths.
import { TREES_PER_SIGNATURE, SOFT_LINE } from '../lib/impactwords.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const tok = { name: 'token', in: 'path', required: true, schema: { type: 'string' } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const RULE = `Every signature plants ${TREES_PER_SIGNATURE} trees: mangroves, planted by Treegens. It makes no difference where the signature came from: the free ones a new account starts with, the monthly plan, a top-up, a free code or a reward. The only people who sign and plant none are a sender signing their own document (that uses no signature) and anyone on a server that takes no payments. A finished signature is counted when it is finished, whether or not anyone opens a screen, and keeps its trees. Signatures finished before 23 November 2026 count what was promised then: 10 when paid for, none when free; for one of those that plants none, a server that takes payments prints one line on the signing record: "${SOFT_LINE}"`;

export const impactPaths = () => ({
  '/sign/{token}/impact': {
    get: {
      tags: ['Signing'], security: [], parameters: [tok],
      summary: 'What the signing page may say about trees to the person holding this link',
      description: `${RULE} Refused with 401 until an access code or one-time code has been passed. An approver, a viewer, a copy and a witness get { finish: 0, done: null }.`,
      responses: ok({ type: 'object', properties: {
        finish: { ...int, description: `Trees that will be planted when this person finishes: ${TREES_PER_SIGNATURE} for someone who signs while it is their turn, otherwise 0. The signing page says it on its first screen and next to Finish.` },
        done: { type: 'object', nullable: true, description: 'After this person has finished signing. null before, and for anyone who does not sign.', properties: {
          trees: { ...int, description: `${TREES_PER_SIGNATURE}, or 0 for a signature that does not count (see above). A signature from before 23 November 2026 says what was promised then.` },
          first: { ...bool, description: 'No earlier finished signature from this address on this server. Someone who signs in person is known only on this document: the address on their row is the host\'s.' },
          celebrate: { ...bool, description: 'The picture has not been shown yet: for the first signature of this person, and once more for their first signature that plants anything.' },
          total: { ...int, description: 'Trees planted by all signatures from this address, this one included. For someone who signs in person: this signature only.' },
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
        plus: { ...bool, description: 'For a draft: every person who signs has an address and none is the sender signing their own document, so each signature plants trees. Asked again after sending.' },
        sent: { type: 'object', nullable: true, description: 'null for a draft.', properties: {
          counted: { ...int, description: 'People who sign and whose signature plants trees: everyone but the sender signing their own document. (Before 23 November 2026 this field was "paid".)' },
          signers: { ...int, description: 'Everyone on it who signs, the sender included. "Every signature on it plants" is said only when counted equals this.' },
          planted: { ...int, description: 'Trees planted by the signatures finished on this account\'s documents.' },
          here: { ...int, description: 'Trees planted by the signatures finished on this envelope.' },
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
    get: { tags: ['Account'], summary: '"Trees on the signing record": whether the certificate of completion ends with the box on paper and trees', responses: ok({ type: 'object', properties: { on: bool, fixed: { ...bool, description: 'Only on a server set up for a public body: the record never carries trees there, so there is nothing to switch.' } } }) },
    put: {
      tags: ['Account'], summary: 'Switch "Trees on the signing record" on or off (admins)',
      description: 'On by default. Off leaves the box "Signed without paper" off the signing record of documents completed from then on. Screens, emails and the impact pages are not changed by it. The change is written to the security record. 403 for an API key: like the other switches under Settings, Account (PUT /account/policy), it needs an owner or admin signed in to the app. On a server set up for a public body (DEPLOYMENT_PROFILE=government) the record never carries trees: GET answers { on: false, fixed: true } and PUT answers 409.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['on'], properties: { on: bool } } } } },
      responses: ok({ type: 'object', properties: { on: bool } }),
    },
  },
});
