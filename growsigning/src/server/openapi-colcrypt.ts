// The encryption check for the people who run the server, as part of /api/openapi.json (routes-colcrypt.ts). Kept apart
// so the main description stays readable; openapi.ts spreads it into its paths.
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });

export const colCryptPaths = () => ({
  '/operator/encryption': {
    get: {
      tags: ['Operator'], summary: 'Whether this server encrypts what it stores, and what needs a look',
      description: 'Only for the addresses in OPERATOR_EMAILS (anyone else gets 404). "on" is true when FILE_ENCRYPTION_KEY is set and is a key. "warning" says in words what is wrong: no key at all, or values in the database under a key the server was not given, or damaged; null when nothing is. "waiting" counts the values still in the clear or under an old key, which the server encrypts by itself a batch at a time (null without a key). A value the server cannot open is refused wherever it is asked for, with status 503 and code "data_locked", and never shown in another form.',
      responses: ok({ type: 'object', properties: { on: { type: 'boolean' }, warning: { type: 'string', nullable: true }, waiting: { type: 'integer', nullable: true } } }),
    },
  },
});
