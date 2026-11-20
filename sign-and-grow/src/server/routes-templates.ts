// Who can use a template, who can change it, and whether its wording is locked: reading the rule and setting it.
// The rules themselves, and where they are enforced, are in tplroles.ts.
import { route, type Ctx } from './router.ts';
import { all, get, run, tx } from './db.ts';
import { bad, str } from './util.ts';
import { audit } from './envelopes.ts';
import { mine } from './routes-envelopes.ts';
import { accessOf, maySetRules, ruleOf, askWho, ownerName } from './tplroles.ts';
import { TPL_USES, TPL_CHANGES, accessSentence } from '../lib/tplroles.ts';

// The rule in a sentence, what this person may do, and for the people who may set it, the members of the team with
// who was chosen. Anyone who may use the template may read it.
route('GET', '/envelopes/:id/access', (c) => ({ access: accessOf(c, mine(c, c.params.id, 'template')) }));

// Set by the person the template belongs to and by admins, never by the members they chose: otherwise a chosen
// member could hand the template to anyone, or lift the lock that was meant for them. Whatever the body leaves out
// stays as it is. "members" is the whole list of chosen people: [{ "id": "<user id>", "can_change": true }].
// Every change is written to the template's history with the rule before and after.
route('PUT', '/envelopes/:id/access', async (c) => {
  const b = await c.body();
  const t = mine(c, c.params.id, 'template');
  if (!maySetRules(c, t))
    throw bad(`Only ${ownerName(t)} or an admin of your team can change who can use and change this template, or lock its wording. Nothing was changed. Ask ${askWho(t)}.`, 403, { code: 'template_not_yours' });
  const was = ruleOf(t);
  const pick = <T extends string>(v: any, list: readonly T[], key: string, d: T): T => {
    if (v == null || v === '') return d;
    // A list or an object is said as it was sent: written as text it would read "team" or "[object Object]".
    if (typeof v !== 'string') throw bad(`"${key}" is ${str(JSON.stringify(v), 60)}, and it has to be one of ${list.join(', ')}, written as text in quotes. Nothing was changed.`);
    if (!list.includes(v as T)) throw bad(`"${key}" is "${str(v, 40)}", which does not exist. Use one of: ${list.join(', ')}. Nothing was changed.`);
    return v as T;
  };
  const use = pick(b.use, TPL_USES, 'use', was.use);
  const change = pick(b.change, TPL_CHANGES, 'change', was.change);
  if (b.locked != null && typeof b.locked !== 'boolean') throw bad(`"locked" is ${str(JSON.stringify(b.locked), 40)}, and it has to be true or false, written without quotes. Nothing was changed.`);
  const locked = b.locked == null ? was.locked : b.locked;
  // Everyone may change it, but not everyone may use it, would make no sense: whoever may change a template may use it.
  if (change === 'team' && use !== 'team') throw bad('A template that everyone on the team may change is one that everyone may use. Choose who can use it first, or let only its owner, admins or chosen members change it. Nothing was changed.');
  let lines: { id: string; can_change: boolean }[] | null = null;
  if (b.members !== undefined) {
    if (!Array.isArray(b.members)) throw bad('"members" must be a list of { "id": "<user id>", "can_change": true or false }. Nothing was changed.');
    if (b.members.length > 500) throw bad('Choose up to 500 members. Nothing was changed.');
    const team = new Set(all('SELECT user_id FROM memberships WHERE account_id=?', c.account.id).map((m) => m.user_id as string));
    lines = b.members.map((m: any, i: number) => {
      const uid = str(typeof m === 'string' ? m : m?.id, 80);
      if (!team.has(uid)) throw bad(`Member ${i + 1} ("${uid}") is not on your team. Use the ids from GET /envelopes/:id/access or GET /account/members. Nothing was changed.`);
      if (m?.can_change != null && typeof m.can_change !== 'boolean') throw bad(`"can_change" of member ${i + 1} has to be true or false, written without quotes. Nothing was changed.`);
      return { id: uid, can_change: m?.can_change === true };
    });
  }
  const before = accessSentence(accessOf(c, t));
  tx(() => {
    run('UPDATE envelopes SET tpl_use=?, tpl_change=?, tpl_locked=? WHERE id=?', use, change, locked ? 1 : 0, t.id);
    if (lines) {
      run('DELETE FROM template_members WHERE template_id=?', t.id);
      for (const l of lines) run('INSERT OR REPLACE INTO template_members (template_id, account_id, user_id, can_change) VALUES (?,?,?,?)', t.id, c.account.id, l.id, l.can_change ? 1 : 0);
    }
  });
  const now = loadRule(t.id, c);
  const after = accessSentence(now);
  // Written down only when something changed, so saving the same rule twice leaves one line.
  if (after !== before) audit(t.id, c.actor, 'Who can use and change it', `${after} Before: ${before}`);
  return { access: now };
});

const loadRule = (templateId: string, c: Ctx) => accessOf(c, get('SELECT * FROM envelopes WHERE id=?', templateId));
