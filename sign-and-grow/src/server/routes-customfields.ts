// Custom fields (customfields.ts): the account's own fields, which admins define, and the values of one envelope or
// template set on their own. Values also go with POST and PUT /envelopes ("custom_fields", "documents[].fields").
import { route } from './router.ts';
import { bad } from './util.ts';
import { mine, assertMayChange } from './routes-envelopes.ts';
import { createDef, updateDef, deleteDef, filterNames, readCustom, writeCustom, valuesOf } from './customfields.ts';
import { MAX_CUSTOM_FIELDS, CUSTOM_NAME_MAX, CUSTOM_VALUE_MAX, CUSTOM_CHOICES_MAX, DOC_FIELDS_MAX } from '../lib/customfields.ts';

// Everyone on the team reads them (the editor asks for them on its last step), and so does a "send" API key.
route('GET', '/custom-fields', (c) => ({
  ...filterNames(c.account.id),
  limits: { fields: MAX_CUSTOM_FIELDS, name: CUSTOM_NAME_MAX, value: CUSTOM_VALUE_MAX, choices: CUSTOM_CHOICES_MAX, document_fields: DOC_FIELDS_MAX },
}));
route('POST', '/custom-fields', async (c) => createDef(c, await c.body()), 'admin');
route('PATCH', '/custom-fields/:id', async (c) => {
  const b = await c.body();
  return updateDef(c, c.params.id, b);
}, 'admin');
route('DELETE', '/custom-fields/:id', (c) => deleteDef(c, c.params.id), 'admin');

// The values of one envelope or template, on their own: the whole list, like "custom_fields" in PUT /envelopes/:id.
// On an envelope that is out this is the way to put right a reference typed wrongly, with a line in its audit trail;
// once it is completed they are fixed. The body is read first and the envelope looked up after it.
route('PUT', '/envelopes/:id/custom-fields', async (c) => {
  const b = await c.body();
  if (b.custom_fields === undefined || b.custom_fields === null) throw bad('Send "custom_fields": a list of {"name", "value"} objects, the whole list as it should be. Nothing was changed.');
  const e = mine(c, c.params.id);
  assertMayChange(c, e);
  const plan = readCustom(c.account.id, e, { custom_fields: b.custom_fields });
  writeCustom(e.id, plan, c.actor);
  return { custom_fields: valuesOf(e.id) };
});
