import { all, get, run } from './db.ts';
import { sendMail } from './mail.ts';
import { baseUrl } from './util.ts';
import { applyFloor } from './orgs.ts';
import { removedText, type Removed } from '../lib/signin.ts';

// A login whose address was never confirmed may have been made by a stranger in its owner's name, set up to keep
// working for that stranger once the owner arrives: a webhook that hears about every document the owner sends, a
// name like "Customer Support Team" that the owner's emails would go out under, a signature image, a logo, a public
// form or click-to-agree page that opens the day the address is confirmed. So the moment the owner of the address
// proves it is theirs (Google or Microsoft vouches, or they open the password link we mailed there), all of that goes,
// together with the ways in that cutEarlierAccess (auth.ts) ends. What does nothing by itself (drafts, templates,
// contacts, groups) stays, and the owner is told it is there and to look at it before using it, because it was made
// before anyone had shown the address was theirs.
//
// Only workspaces this login is alone in are touched: a team with other people in it is theirs too. A login that was
// never confirmed cannot invite anyone (POST /account/invites), so in practice that is every workspace it owns.
//
// `name` is the name the login has from now on: the one the provider knows the person by, or else the part of the
// address before the @, which the person is told to change. Returns what was removed, for the screen and the email.
// Call inside tx(), before cutEarlierAccess, which deletes the API keys counted here.
export function forgetEarlierSetup(userId: string, name: string): Removed {
  const u = get('SELECT * FROM users WHERE id=?', userId);
  if (!u) return {};
  const out: Removed = { name };
  const profile = [
    ['name', u.name !== name], ['job title', !!u.title], ['company', !!u.company], ['signature', !!u.signature_png], ['initials', !!u.initials_png],
    // Which emails the login gets: someone could have switched off the very notices that would tell the owner.
    ['email settings', u.notify != null],
  ].filter(([, changed]) => changed).map(([what]) => what as string);
  if (profile.length) out.profile = profile;
  run('UPDATE users SET name=?, title=NULL, company=NULL, signature_png=NULL, initials_png=NULL, notify=NULL WHERE id=?', name, userId);
  const keys = run('DELETE FROM api_keys WHERE user_id=?', userId).changes;
  if (keys) out.keys = keys;
  const alone = all(`SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id AND m.user_id=?
    WHERE NOT EXISTS (SELECT 1 FROM memberships o WHERE o.account_id=a.id AND o.user_id!=?)`, userId, userId);
  const webhooks: string[] = [], workspace = new Set<string>();
  const kept = { drafts: 0, templates: 0, contacts: 0, groups: 0 };
  let invites = 0, forms = 0, agreements = 0, stamps = 0;
  for (const a of alone) {
    // A webhook is the one thing here that sends the owner's business somewhere else on its own. It goes with its log.
    for (const w of all('SELECT id, url FROM webhooks WHERE account_id=?', a.id)) {
      webhooks.push(hostOf(w.url));
      run('DELETE FROM webhook_deliveries WHERE webhook_id=?', w.id);
      run('DELETE FROM webhooks WHERE id=?', w.id);
    }
    invites += run('DELETE FROM invites WHERE account_id=? AND accepted_at IS NULL', a.id).changes;
    // A public form is closed while its owner's address is unconfirmed (formClosed in routes-envelopes.ts), so the
    // confirmation that happens now would open it. It is switched off instead, and the owner switches it on again if
    // it is theirs. The same for terms that visitors accept with a click.
    forms += run('UPDATE powerforms SET active=0 WHERE account_id=? AND active=1', a.id).changes;
    agreements += run('UPDATE clickwraps SET active=0 WHERE account_id=? AND active=1', a.id).changes;
    stamps += run('DELETE FROM stamps WHERE account_id=?', a.id).changes;
    const fresh = `${name}'s workspace`;
    if (a.name !== fresh) workspace.add('name');
    if (a.brand_color) workspace.add('brand colour');
    if (a.brand_logo) workspace.add('logo');
    // Asking everyone for two-step login is a rule for a team, set by nobody we know.
    if (a.two_step_required_at) workspace.add('two-step rule');
    run('UPDATE accounts SET name=?, brand_color=NULL, brand_logo=NULL, two_step_required_at=NULL WHERE id=?', fresh, a.id);
    // A rule an organisation above the account asks (src/server/orgs.ts) is not the stranger's: it is put back at once.
    if (a.org_id) applyFloor(a.id);
    kept.drafts += get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind!='template'", a.id).n;
    kept.templates += get("SELECT COUNT(*) n FROM envelopes WHERE account_id=? AND kind='template'", a.id).n;
    kept.contacts += get('SELECT COUNT(*) n FROM contacts WHERE account_id=?', a.id).n;
    kept.groups += get('SELECT COUNT(*) n FROM signing_groups WHERE account_id=?', a.id).n;
  }
  // The hosts once each, a few of them: this travels to the first screen in a cookie, which has room for little.
  if (webhooks.length) Object.assign(out, { webhooks: webhooks.length, hooks_to: [...new Set(webhooks)].slice(0, 5) });
  if (invites) out.invites = invites;
  if (forms) out.forms = forms;
  if (agreements) out.agreements = agreements;
  if (stamps) out.stamps = stamps;
  if (workspace.size) out.workspace = [...workspace];
  if (Object.values(kept).some(Boolean)) out.kept = kept;
  return out;
}

// Only the host goes on a screen and into the cookie that carries the first screen's words: the full address can be
// long, and the host is what says where the owner's business was going.
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
};

// The owner hears by email what was removed, also when it was said on the screen: a screen is gone once it is closed.
export async function tellRemoved(user: { email: string }, r: Removed, how: string) {
  const said = removedText(r);
  if (!said) return;
  await sendMail({
    to: user.email, subject: 'What we removed from your GrowSigning login', heading: 'What we removed from your login',
    lines: [`${how} Until then nobody had shown that the address ${user.email} was theirs, so anything set up in the login before could have been set up by someone else. To be safe, we removed it.`, said,
      'If you set these things up yourself, you can set them up again under Settings. If you did not, there is nothing more to do: the person who did can no longer sign in to this login.'],
    cta: { label: 'Open Settings', url: `${baseUrl()}/app/settings?tab=security` },
  });
}

// Sign-ins at Google or Microsoft that were started and never came back (signin_states, routes-signin.ts). Each holds
// what was carried along (an invitation, a typed code, the page to open, the login being connected), so none is kept
// past its ten minutes: the timer clears them (cron.ts), and deleting a login clears its own at once (purgeUser).
export const sweepSignIns = (): number => run('DELETE FROM signin_states WHERE expires_at <= ?', new Date().toISOString()).changes;
