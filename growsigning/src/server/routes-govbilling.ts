// Government billing (research/government.json, G14): which billing mode this server is in, for Settings, Plan; the
// tree commitments of government contracts for the operator; and the signed ones for /impact.
import { route, type Ctx } from './router.ts';
import { HttpError, rateLimit } from './util.ts';
import { isOperator } from './routes-trust.ts';
import { billingMode, agreementOf, agreementLine } from '../lib/billingmode.ts';
import { createCommitment, setSigned, addStatement, removeStatement, allCommitments, publicCommitments } from './commitments.ts';
import './billingmode.ts';

// Anyone signed in to the account may read it: it is the line every person on a government server can see.
route('GET', '/billing-mode', () => {
  if (billingMode() !== 'deployment') return { mode: 'signatures' };
  const a = agreementOf();
  return { mode: 'deployment', holder: a.holder, ref: a.ref, until: a.until, ended: a.ended, line: agreementLine(a) };
});

// For public pages (the footer, /impact): only which mode, never the agreement's holder or reference.
route('GET', '/public/billing-mode', (c) => {
  rateLimit(`billingmode:${c.ip}`, 240, 60_000);
  return { mode: billingMode() };
}, 'public');

const operator = (c: Ctx) => {
  if (!isOperator(c.user)) throw new HttpError(404, 'Not found');
  return `${c.user.name} <${c.user.email}>`;
};

route('GET', '/operator/tree-commitments', (c) => (operator(c), { commitments: allCommitments() }));
route('POST', '/operator/tree-commitments', async (c) => {
  const by = operator(c);
  return { commitment: createCommitment(await c.body(), by) };
});
route('POST', '/operator/tree-commitments/:id/signed', async (c) => {
  operator(c);
  const b = await c.body();
  // Only a real true or false: a string such as "false" must never publish a draft by mistake.
  if (typeof b?.signed !== 'boolean') throw new HttpError(400, 'Say "signed": true (with "signed_on", the day it was signed, YYYY-MM-DD) to show the contract on the impact page, or "signed": false to make it a draft again. Nothing was changed.');
  return { commitment: setSigned(c.params.id, b.signed, b.signed_on) };
});
route('POST', '/operator/tree-commitments/:id/statements', async (c) => {
  const by = operator(c);
  return { statements: addStatement(c.params.id, await c.body(), by) };
});
route('DELETE', '/operator/tree-commitments/:id/statements/:sid', (c) => (operator(c), { statements: removeStatement(c.params.id, c.params.sid) }));

route('GET', '/public/tree-commitments', (c) => {
  rateLimit(`treecommit:${c.ip}`, 120, 60_000);
  return { commitments: publicCommitments() };
}, 'public');
