// What the person's role allows (perm.ts): 'groups' here, where this file once asked for an admin.
import { can } from './perm.ts';
import { route } from './router.ts';
import { get } from './db.ts';
import { bad, rateLimit, rateWait } from './util.ts';
import { mine } from './routes-envelopes.ts';
import { find, look } from './routes-sign.ts';
import { listGroups, saveGroup, deleteGroup, handBack, askTakeOver, releaseGroup } from './groups.ts';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS } from '../lib/policy.ts';

// Signing groups: the routes. What a group is and how it behaves on an envelope is in groups.ts.

// ---- The groups an account keeps ---------------------------------------------------------------------------
// Every member of the team can read and use them. Making, changing and deleting one is for admins, because a group
// decides who can sign for "HR team" on everything the whole team sends.

// may_change: what the caller can really do. An API key with the "send" scope gets 403 on every change, whoever made it.
route('GET', '/groups', (c) => ({ groups: listGroups(c.account.id), min_members: GROUP_MIN_MEMBERS, max_members: GROUP_MAX_MEMBERS,
  may_change: !!can(c, 'groups') && !(c.auth?.via === 'api_key' && c.auth?.scope !== 'admin') }));
route('POST', '/groups', async (c) => ({ group: saveGroup(c.account.id, await c.body()) }), 'admin');
route('PUT', '/groups/:id', async (c) => ({ group: saveGroup(c.account.id, await c.body(), c.params.id) }), 'admin');
route('DELETE', '/groups/:id', (c) => void deleteGroup(c.account.id, c.params.id), 'admin');

// ---- The sender: give a group's document back to the whole group -----------------------------------------------

// Answers how many members were emailed, and a sentence that says so, for the screen to show as it is.
route('POST', '/envelopes/:id/recipients/:rid/release', async (c) => releaseGroup(mine(c, c.params.id, 'envelope'), c.params.rid, c.actor));

// ---- A member, through their own link ------------------------------------------------------------------------

const senderOf = (e: any) => get('SELECT name, email FROM users WHERE id=?', e.sender_id) || { name: 'the sender', email: '' };

// Every hand-back emails the whole group, so one link cannot do it over and over to fill colleagues' inboxes. It is
// counted for the member who hands it back, so one member's hand-backs never leave a colleague who took it on by
// mistake stuck with it, and for the document as a whole, with a higher ceiling, so several members together
// cannot flood the group either.
const HAND_BACKS_PER_DAY = 3, HAND_BACKS_PER_DOCUMENT = 6;
route('POST', '/sign/:token/hand-back', async (c) => {
  find(c);
  const b = await c.req.json().catch(() => ({}));
  // Looked up again after the body is in, with nothing waited for before the change: see checkedBody in routes-sign.ts.
  const { e, r, actor } = look(c);
  const mine = `handback:${r.claimed_by || r.id}`, all = `handback-row:${r.id}`;
  const s = senderOf(e);
  const ask = `If someone else should have it, ask ${s.name} to give it back to the group${s.email ? `: ${s.email}` : ''}. Nothing you filled in is lost.`;
  if (rateWait(mine, HAND_BACKS_PER_DAY)) throw bad(`You have handed this document back ${HAND_BACKS_PER_DAY} times today, and each time the whole group is emailed. It stays with you for now. ${ask}`, 429);
  if (rateWait(all, HAND_BACKS_PER_DOCUMENT)) throw bad(`This document has been handed back ${HAND_BACKS_PER_DOCUMENT} times today by members of the group, and each time the whole group is emailed. It stays with you for now. ${ask}`, 429);
  await handBack(e, r, b?.reason, actor);
  rateLimit(mine, Infinity, 86400_000);
  rateLimit(all, Infinity, 86400_000);
}, 'public');

// "Ask the sender to give it back to the group": for a member whose colleague has taken the document on. Only the
// sender can do that, so this tells the sender and changes nothing else.
const ASKS_PER_DAY = 2;
route('POST', '/sign/:token/take-over', async (c) => {
  const { e, r, actor } = find(c);
  const key = `takeover:${r.member?.id || r.id}`;
  if (rateWait(key, ASKS_PER_DAY)) {
    const s = senderOf(e);
    throw bad(`You have asked ${ASKS_PER_DAY} times today, and ${s.name} has been told each time. You can also write to them yourself${s.email ? `: ${s.email}` : ''}.`, 429);
  }
  await askTakeOver(e, r, actor);
  rateLimit(key, Infinity, 86400_000);
}, 'public');
