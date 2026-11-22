// The API of signing at a service counter (counter.ts). Officials with the counter permission work the queue; admins
// say who has the permission and which templates are used at the counter; the person's own screen connects with a
// one-use code and needs no login.
import { route, type Ctx } from './router.ts';
import { all, get, run } from './db.ts';
import { bad, isEmail, now, str } from './util.ts';
import { copyEnvelope, sendEnvelope, yesNo } from './envelopes.ts';
import { mine } from './routes-envelopes.ts';
import { cloneOwner } from './tplroles.ts';
import { readCustom, writeCustom } from './customfields.ts';
import {
  assertStaff, settingsOf, scansPossible, counterTemplates, hasInPerson, queue, openVisit, recordIdentity, storeScan, addHelp, confirmHelp,
  withdrawHelp, makeCode, pairScreen, screenState, endScreen, handLink, visitView, receipt,
} from './counter.ts';
import { CANNOT_CHECK_ID, PAD_LINE } from '../lib/counter.ts';

// ---- For officials -----------------------------------------------------------------------------------------------

route('GET', '/counter', (c) => {
  assertStaff(c);
  return { ...queue(c.account.id, c.user.id), templates: counterTemplates(c.account.id).map(({ id, subject }) => ({ id, subject })), note: CANNOT_CHECK_ID, pad: PAD_LINE, can_set_up: !!c.admin };
});

// "Start" for someone who is not on the list yet: a new document from a counter template, sent, with this official.
route('POST', '/counter/start', async (c) => {
  assertStaff(c);
  const b = await c.body();
  const name = str(b.name, 120).trim();
  const email = str(b.email, 254).trim();
  if (!name) throw bad("Type the person's full name as it should appear on the document.");
  if (!isEmail(email)) throw bad('Type an email address for their copy of the signed document. It is where the copy is sent.');
  const tpl = mine(c, str(b.template_id, 80), 'template');
  if (!get('SELECT 1 x FROM counter_templates WHERE template_id=? AND account_id=?', tpl.id, c.account.id)) throw bad('That template is not used at the counter. Choose one from the list.', 404);
  const who = tpl.recipients.find((r: any) => r.role === 'inperson');
  if (!who) throw bad('That template has nobody who signs in person. An admin can fix the template, or choose another one.', 409);
  const custom = readCustom(c.account.id, tpl, {}, { merge: true });
  const eid = copyEnvelope(tpl, { accountId: c.account.id, senderId: cloneOwner(c, tpl, 'envelope'), kind: 'envelope', fill: { [who.id]: { name, email } } });
  writeCustom(eid, custom, c.actor);
  try {
    await sendEnvelope(eid, c.actor);
  } catch (e) {
    run('DELETE FROM envelopes WHERE id=?', eid);
    throw e;
  }
  return { envelope_id: eid, visit_id: openVisit(c, eid) };
});

route('POST', '/counter/visits', async (c) => {
  const b = await c.body();
  return { visit_id: openVisit(c, str(b.envelope_id, 80), b.recipient_id ? str(b.recipient_id, 80) : undefined) };
});
route('GET', '/counter/visits/:id', (c) => visitView(c, c.params.id));
route('POST', '/counter/visits/:id/identity', async (c) => recordIdentity(c, c.params.id, await c.body()));
route('POST', '/counter/visits/:id/picture', (c) => storeScan(c, c.params.id));
route('POST', '/counter/visits/:id/helps', async (c) => addHelp(c, c.params.id, await c.body()));
route('POST', '/counter/visits/:id/helps/:help/confirm', async (c) => confirmHelp(c, c.params.id, c.params.help, await c.body()));
route('DELETE', '/counter/visits/:id/helps/:help', (c) => withdrawHelp(c, c.params.id, c.params.help));
route('POST', '/counter/visits/:id/code', (c) => makeCode(c, c.params.id));
route('POST', '/counter/visits/:id/link', (c) => handLink(c, c.params.id));
route('GET', '/counter/visits/:id/receipt', (c) => receipt(c, c.params.id));

// ---- The person's own screen (no login) ----------------------------------------------------------------------------

route('POST', '/counter/screen', async (c) => pairScreen(c, (await c.body()).code), 'public');
route('GET', '/counter/screen', (c) => screenState(c), 'public');
route('POST', '/counter/screen/next', (c) => endScreen(c), 'public');

// ---- For admins: who works at the counter, which templates, and the agency's rules ----------------------------------

function settingsView(c: Ctx) {
  const members = all(`SELECT u.id, u.name, u.email, m.role, (SELECT 1 FROM counter_staff s WHERE s.account_id=m.account_id AND s.user_id=u.id) counter
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? ORDER BY u.name COLLATE NOCASE`, c.account.id);
  const marked = new Map(counterTemplates(c.account.id).map((t) => [t.id, t.show_values]));
  const templates = all("SELECT id, subject FROM envelopes WHERE account_id=? AND kind='template' ORDER BY subject COLLATE NOCASE", c.account.id)
    .filter((t: any) => hasInPerson(t.id))
    .map((t: any) => ({ id: t.id, subject: t.subject || 'Untitled template', counter: marked.has(t.id), show_values: !!marked.get(t.id) }));
  const s = settingsOf(c.account.id);
  return { members: members.map((m: any) => ({ id: m.id, name: m.name, email: m.email, role: m.role, counter: !!m.counter })), templates, settings: s, pictures_possible: scansPossible() };
}

route('GET', '/counter/settings', (c) => settingsView(c), 'admin');

route('PUT', '/counter/settings', async (c) => {
  const b = await c.body();
  const s = settingsOf(c.account.id);
  const contact = b.contact === undefined ? s.contact : str(b.contact, 300).trim();
  const may = b.official_may_witness === undefined ? s.official_may_witness : yesNo(b.official_may_witness, false, '"official_may_witness"');
  let pics = b.id_pictures === undefined ? s.id_scans : yesNo(b.id_pictures, false, '"id_pictures"');
  if (pics && !scansPossible()) throw bad('Pictures of ID documents can only be kept encrypted, and stored files are not encrypted on this server. Ask whoever runs it to set FILE_ENCRYPTION_KEY.', 409);
  pics = !!pics;
  run(`INSERT INTO counter_settings (account_id, contact, official_may_witness, id_scans, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET contact=excluded.contact, official_may_witness=excluded.official_may_witness, id_scans=excluded.id_scans, updated_at=excluded.updated_at`,
    c.account.id, contact || null, may ? 1 : 0, pics ? 1 : 0, now());
  return settingsView(c);
}, 'admin');

route('PUT', '/counter/staff/:user', async (c) => {
  const b = await c.body();
  const on = yesNo(b.counter, false, '"counter"');
  const m = get('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=? AND m.user_id=?', c.account.id, str(c.params.user, 80));
  if (!m) throw bad('That person is not on this team. Invite them first, under Team.', 404);
  if (on) run('INSERT OR IGNORE INTO counter_staff (account_id, user_id, added_by, at) VALUES (?,?,?,?)', c.account.id, m.id, c.user.id, now());
  else run('DELETE FROM counter_staff WHERE account_id=? AND user_id=?', c.account.id, m.id);
  return settingsView(c);
}, 'admin');

route('PUT', '/counter/templates/:id', async (c) => {
  const b = await c.body();
  const t = get("SELECT id, subject FROM envelopes WHERE id=? AND account_id=? AND kind='template'", str(c.params.id, 80), c.account.id);
  if (!t) throw bad('That template is not in this account. Reload the page to see the templates there are.', 404);
  const on = yesNo(b.counter, false, '"counter"');
  if (on && !hasInPerson(t.id)) throw bad('This template has nobody who signs in person, so it cannot be used at the counter. Add a person who signs in person to it first.', 409);
  if (on) run('INSERT INTO counter_templates (template_id, account_id, show_values, at) VALUES (?,?,?,?) ON CONFLICT(template_id) DO UPDATE SET show_values=excluded.show_values',
    t.id, c.account.id, yesNo(b.show_values, false, '"show_values"') ? 1 : 0, now());
  else run('DELETE FROM counter_templates WHERE template_id=?', t.id);
  return settingsView(c);
}, 'admin');
