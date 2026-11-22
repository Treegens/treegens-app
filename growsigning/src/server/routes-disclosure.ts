// The account's own consent text (disclosure.ts): what admins save under Settings, Sending, "Your consent text", and
// the one thing a signer can do with it, which is to ask for paper instead.
import { route } from './router.ts';
import { find, look } from './routes-sign.ts';
import { readOwnText, saveOwnText, ownTextVersions, askForPaper } from './disclosure.ts';

route('GET', '/account/disclosure', (c) => readOwnText(c.account), 'admin');
route('PUT', '/account/disclosure', async (c) => saveOwnText(c, await c.body()), 'admin');
route('GET', '/account/disclosure/versions', (c) => ownTextVersions(c.account, c.q.get('language')), 'admin');

// "Sign on paper instead", "Ask <sender> to send it by post". Under /decline because that is what it does to the
// document, and a member of a group may do it wherever they may decline (MAY in groups.ts goes by this part of the
// address). The link is looked up before the body is read and again after it, like every call that changes
// something (checkedBody in routes-sign.ts).
route('POST', '/sign/:token/decline/paper', async (c) => {
  find(c);
  await c.req.json().catch(() => ({}));
  const { e, r, actor } = look(c);
  return askForPaper(e, r, actor);
}, 'public');
