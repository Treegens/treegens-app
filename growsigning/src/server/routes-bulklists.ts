// What the person's role allows (perm.ts): 'settings' here, where this file once asked for an admin.
import { can } from './perm.ts';
import { route } from './router.ts';
import { listLists, saveList, openList, deleteList, setListDays, listDays } from './bulklists.ts';
import { LIST_DAYS_MIN, LIST_DAYS_MAX, LIST_PERSONAL_DATA } from '../lib/reports.ts';

// Saved lists for Send to many: the routes. What a list is and who may do what is in bulklists.ts.

route('GET', '/bulk-lists', (c) => ({ lists: listLists(c), days: listDays(c.account), min_days: LIST_DAYS_MIN, max_days: LIST_DAYS_MAX, may_change_days: !!can(c, 'settings'), personal_data: LIST_PERSONAL_DATA }));
route('POST', '/bulk-lists', async (c) => ({ list: saveList(c, await c.body()) }));
route('PUT', '/bulk-lists/settings', async (c) => setListDays(c.account.id, await c.body()), 'admin');
route('GET', '/bulk-lists/:id', (c) => ({ list: openList(c, c.params.id) }));
route('DELETE', '/bulk-lists/:id', (c) => void deleteList(c, c.params.id));
