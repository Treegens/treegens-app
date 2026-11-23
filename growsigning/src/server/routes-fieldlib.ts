// Saved fields and the team's text style for new fields (fieldkinds.ts). Everyone on the team reads them, because
// the editor lists the saved fields under More fields; only admins save, replace or delete them.
import { route } from './router.ts';
import { savedFields, saveField, deleteSaved, setAccountLook, accountLook } from './fieldkinds.ts';
import { SAVED_MAX, brandHex } from '../lib/fieldkinds.ts';

// brand_color is the account's brand colour, or null: "Your brand colour" is offered only when there is one.
route('GET', '/saved-fields', (c) => ({ saved_fields: savedFields(c.account.id), field_look: accountLook(c.account.id), limit: SAVED_MAX, brand_color: brandHex(c.account.brand_color) }));
// The same name again replaces the field saved under it.
route('POST', '/saved-fields', async (c) => ({ saved_field: saveField(c.account.id, c.actor.name, await c.body()) }), 'admin');
route('DELETE', '/saved-fields/:id', (c) => (deleteSaved(c.account.id, c.params.id), { ok: true }), 'admin');
// The text style new fields start with: {"field_look": {"font", "size", "color", "bold"}} or null for as usual.
route('PUT', '/saved-fields/look', async (c) => ({ field_look: setAccountLook(c.account.id, (await c.body()).field_look) }), 'admin');
