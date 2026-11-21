// The public pages and Settings made simpler (brief "simplify-public", research/ux-charter.md 2.2 and 2.7, and the
// owner's notes of 21 November 2026): a home page that says one thing, the tree counting video, four entries in the
// top bar, Settings in sections a person can find, "Saved" next to what saved, and dates nobody can misread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple } from './helpers.ts';
import { homeVideo, HOME_VIDEO_CAPTION, HOME_VIDEO_TEXT } from '../src/lib/homevideo.ts';
import { sectionsFor, landingFor, SETTINGS_MAX, daysIn, refusedDays, nextTab, closingCount, sessionShort, MEMBER_READS, KEYS_AND_TWO_STEP } from '../src/lib/settingsnav.ts';
import { DEFAULT_DATE_FORMAT, DATE_FORMATS, DATE_FORMAT_CHOICES, dayText, formatDate, fmtDateTag } from '../src/lib/dates.ts';
import { TOTALS_FROM, totalWorthShowing } from '../src/lib/impact.ts';
import { finishLine, signerWords, reviewPlus } from '../src/lib/impactwords.ts';

const { db } = await boot();
const read = (f: string) => fs.readFileSync(f, 'utf8');
// What a person reads in a page's source: the text between tags and in strings, with code and comments left out.
const words = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/^import .*$/gm, ' ').split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w)).length;

// ---- 1. The home page ---------------------------------------------------------------------------------------------

test('the home page says one thing: one button, three points, and nothing of the long lists it had', () => {
  const home = read('src/app/page.tsx');
  assert.equal((home.match(/btn primary/g) || []).length, 1, 'one filled button');
  assert.match(home, /<Link href="\/signup" className="btn primary lg">Start free<\/Link>/);
  assert.equal((home.match(/<li>/g) || []).length, 3, 'three short points');
  for (const gone of ['FEATURES', 'COMPARE', 'PROMISES', 'The rules', 'How it compares', 'Nine things', 'Everything you need', 'See the impact'])
    assert.ok(!home.includes(gone), `"${gone}" is no longer on the home page`);
  assert.ok(words(home) < 450, `the source of the home page is short (${words(home)} words with its code)`);
  // The hero is about the mangroves a paid signature plants, with the leaf of the logo, and says what a free one does.
  assert.match(home, /Every signature you pay for plants <em>\{TREES_PER_SIGNATURE\} mangroves\.<\/em>/);
  assert.match(home, /<Mark size=\{28\} label="" \/> Planted with Treegens/);
  assert.match(home, /Free signatures plant no trees\./);
  // Green claims: what happens is said as what happens. No generic word and nothing about carbon.
  assert.doesNotMatch(home, /eco-friendly|\bgreen\b(?!-)|sustainab|planet|carbon|CO2|offset|climate|neutral/i);
  // Everything else is linked once from the body of the page.
  for (const href of ['/pricing', '/impact', '/features']) assert.equal(home.split(`href="${href}"`).length - 1, 1, `${href} is linked once`);
});

test('what left the home page is on /pricing and /features, with the anchors other pages point at', () => {
  const pricing = read('src/app/pricing/page.tsx'), features = read('src/app/features/page.tsx');
  for (const id of ['id="pricing"', 'id="rules"', 'id="expiry"', 'id="bulk-cost"', 'id="not-for-patients"', 'id="currency"']) assert.ok(pricing.includes(id), id);
  assert.match(pricing, /<h1 id="pricing-h" className="pub-h1">Simple pricing that plants trees<\/h1>/);
  assert.match(pricing, /const COMPARE: \[string, string, string\]\[\] = \[/);
  assert.match(pricing, /come back, unless their own date has passed by then\./);
  assert.match(pricing, /<li id="expiry"><b>When signatures expire\.<\/b> \{expiryShortText\(\)\} <Link href="\/help#expiry">How signatures expire<\/Link>\.<\/li>/);
  assert.equal((features.match(/^  \['/gm) || []).length, 12, 'all twelve features moved');
  assert.equal((features.match(/\{ said: '/g) || []).length, 9, 'and the nine promises');
  // Nothing in the product still points at an anchor of the old home page.
  const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(`${dir}/${e.name}`) : /\.(tsx?|json)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  for (const f of all('src')) assert.doesNotMatch(read(f), /['"`(]\/#(pricing|expiry|bulk-cost|currency|not-for-patients)|href: '#pricing'/, f);
});

test('the top bar has four entries and the footer the three groups of the charter', () => {
  const pub = read('src/components/Public.tsx');
  const links = /const LINKS: \[string, string\]\[\] = \[([\s\S]*?)\];/.exec(pub)![1];
  assert.deepEqual([...links.matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => `${m[2]} ${m[1]}`), ['Pricing /pricing']);
  // Pricing, Help (the helper), Sign in, Start free.
  assert.match(pub, /<HelpChatButton className="btn sm hc-open">Help<\/HelpChatButton>\s*<Link href="\/login" className="btn sm pub-signin">Sign in<\/Link>\s*<Link href="\/signup" className="btn primary sm">Start free<\/Link>/);
  assert.deepEqual([...pub.matchAll(/<nav aria-label="([^"]+)">\s*<h2>/g)].map((m) => m[1]), ['For signers', 'Product', 'Trust']);
  // What the top bar no longer carries is still one click away, in the footer.
  for (const href of ['/check', '/verify', '/help#find-documents', '/impact', '/developers', '/security', '/security/disclosure', '/help#cancel', '/help', '/help#contact', '/features'])
    assert.ok(pub.includes(`href="${href}"`), `${href} is in the footer`);
  // Every page the footer names exists.
  for (const p of ['pricing', 'features', 'impact', 'developers', 'security', 'security/processing', 'security/disclosure', 'check', 'verify', 'help']) assert.ok(fs.existsSync(`src/app/${p}/page.tsx`), p);
});

// ---- 2. The video ---------------------------------------------------------------------------------------------------

test('the video of the home page: the one that ships by default, none on request, and never an empty player', () => {
  const shipped = homeVideo({});
  assert.deepEqual(shipped, { src: '/videos/tree-count.mp4', type: 'video/mp4', poster: '/videos/tree-count.webp', preload: 'none' });
  assert.ok(fs.existsSync('public/videos/tree-count.mp4') && fs.existsSync('public/videos/tree-count.webp'), 'both files ship');
  assert.ok(fs.statSync('public/videos/tree-count.mp4').size < 6_000_000, 'small enough for a phone, and still not fetched before play');
  for (const none of ['none', 'NONE', ' none ']) assert.equal(homeVideo({ HOME_VIDEO_URL: none }), null);
  assert.deepEqual(homeVideo({ HOME_VIDEO_URL: 'https://cdn.example.org/v/count.webm' }), { src: 'https://cdn.example.org/v/count.webm', type: 'video/webm', poster: null, preload: 'metadata' });
  assert.deepEqual(homeVideo({ HOME_VIDEO_URL: '/videos/new-cut.mp4', HOME_VIDEO_POSTER: '/videos/new-cut.jpg' }), { src: '/videos/new-cut.mp4', type: 'video/mp4', poster: '/videos/new-cut.jpg', preload: 'none' });
  // Anything that is not an mp4 or webm file at an address a page may load gives no block at all.
  for (const bad of ['https://www.youtube.com/watch?v=abc', 'javascript:alert(1)//x.mp4', 'data:video/mp4;base64,AAAA', 'https://user:pw@example.org/a.mp4', '/videos/../../etc/passwd.mp4', '/other/a.mp4', 'a.mp4', 'https://example.org/a.mp4" onerror="x', 'https://example.org/a.mov', 'ftp://example.org/a.mp4', `https://example.org/${'a'.repeat(600)}.mp4`])
    assert.equal(homeVideo({ HOME_VIDEO_URL: bad }), null, bad);
  // A poster that is not a picture at such an address is left out; the video still shows.
  assert.equal(homeVideo({ HOME_VIDEO_URL: '/videos/a.mp4', HOME_VIDEO_POSTER: 'javascript:alert(1)' })!.poster, null);
});

test('the video block: controls, muted, never playing by itself, a caption and a text alternative; absent without a video', () => {
  const home = read('src/app/page.tsx');
  assert.match(home, /\{video && \(\s*<figure className="home-video">/, 'no video, no block');
  assert.match(home, /<video controls muted playsInline preload=\{video\.preload\} poster=\{video\.poster \|\| undefined\} width=\{960\} height=\{540\} aria-label=\{HOME_VIDEO_CAPTION\}/);
  assert.doesNotMatch(home, /autoPlay|autoplay|\bloop\b/);
  assert.match(home, /<figcaption>\{HOME_VIDEO_CAPTION\}<\/figcaption>/);
  assert.match(home, /<p id="home-video-text" className="pub-vh">\{HOME_VIDEO_TEXT\}<\/p>/);
  assert.equal(HOME_VIDEO_CAPTION, "Treegens' AI counting freshly planted mangroves in a planter's video.");
  assert.match(HOME_VIDEO_TEXT, /Every seedling gets a box drawn around it .* a counter climbs/);
  assert.match(HOME_VIDEO_TEXT, /no sound/);
  assert.ok(HOME_VIDEO_CAPTION.split(/\s+/).length <= 12, 'one line');
  // The setting is documented where settings are.
  assert.match(read('.env.example'), /^# ?HOME_VIDEO_URL=/m);
  assert.match(read('README.md'), /\| `HOME_VIDEO_URL` \|/);
});

// ---- 3. Totals and tiny figures -------------------------------------------------------------------------------------

test('no total is shown until it means something, and no figure under one tree anywhere', () => {
  assert.deepEqual(TOTALS_FROM, { sheets: 1000, treesPlanted: 10 });
  assert.equal(totalWorthShowing(999), false);
  assert.equal(totalWorthShowing(1000), true);
  assert.match(read('src/components/Public.tsx'), /if \(!i \|\| \(!paper && !planted\)\) return null;/, 'the band on the home page is absent, not zero');
  // The helper that wrote "0.0005" of a tree is used by no screen.
  const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  for (const f of all('src')) if (f !== 'src/lib/impact.ts') assert.doesNotMatch(read(f), /fmtTrees|of a tree`|\.trees\.toFixed/, f);
  // A signer is told about mangroves only when the signature was paid for, and never about a share of a tree.
  assert.equal(finishLine(0), '');
  assert.equal(finishLine(10), '10 mangroves will be planted when you finish.');
  assert.equal(reviewPlus(false), '');
  const free = signerWords({ trees: 0, first: true, total: 0, sheets: 15 });
  assert.doesNotMatch(`${free.title} ${free.line} ${free.count}`, /mangrove/i);
  assert.equal(signerWords({ trees: 10, first: true, total: 10, sheets: 15 }).line, 'You saved 15 pages of paper from a tree, and 10 mangroves are being planted.');
});

// ---- 4. Settings ----------------------------------------------------------------------------------------------------

test('Settings: an owner or admin sees at most 10 sections and a member at most 4, and old links still land', () => {
  const owner = sectionsFor('owner'), member = sectionsFor('member');
  assert.deepEqual(owner.map(([, l]) => l), ['Profile', 'Security', 'Account', 'Sending', 'Team', 'Stamps', 'Plan', 'Your data', 'API and webhooks']);
  assert.deepEqual(sectionsFor('admin'), owner);
  assert.deepEqual(member.map(([, l]) => l), ['Profile', 'Security', 'Team', 'API and webhooks']);
  assert.ok(owner.length <= SETTINGS_MAX.admin && member.length <= SETTINGS_MAX.member);
  assert.deepEqual(sectionsFor(undefined), member, 'nobody is shown the sections of the admins by accident');
  // What moved: the emails about your documents to Profile, everything about signing in to Security.
  assert.deepEqual(landingFor('owner', 'notifications'), { tab: 'profile', focus: 'notifications' });
  assert.deepEqual(landingFor('member', 'profile', '#two-step'), { tab: 'security', focus: 'two-step' });
  assert.deepEqual(landingFor('owner', 'profile', '', true), { tab: 'security', focus: undefined }, 'back from Google or Microsoft');
  assert.deepEqual(landingFor('owner', 'profile'), { tab: 'profile', focus: undefined });
  assert.deepEqual(landingFor('owner', 'billing'), { tab: 'billing', focus: undefined });
  assert.deepEqual(landingFor('owner', null), { tab: 'profile' });
  // A member who follows a link to a section of the admins is told so, in words, and is shown their own Settings.
  // (Plan and Stamps are the two a member may still read: see the repair test about MEMBER_READS below.)
  const sent = landingFor('member', 'data');
  assert.equal(sent.tab, 'profile');
  assert.equal(sent.note, 'Your data is set by the owner and the admins of this account, so it is not in your Settings. Ask one of them: Team lists who they are.');
  // A made-up section is not echoed anywhere.
  assert.deepEqual(landingFor('member', '<img src=x onerror=alert(1)>'), { tab: 'profile' });
  assert.deepEqual(landingFor('owner', 'SECURITY'), { tab: 'security', focus: undefined });
});

test('Settings: the page is built from those sections, with sign-in under Security and the sending defaults under Sending', () => {
  const page = read('src/app/app/settings/page.tsx');
  assert.match(page, /const TABS = sectionsFor\(me\.role\);/);
  assert.match(page, /const to = landingFor\(me\.role, q\.get\('tab'\), window\.location\.hash, !!\(q\.get\('signin'\) \|\| q\.get\('signin_error'\)\)\);/);
  // Security: one card "Your sign-in" for everyone, then the security record for admins.
  assert.match(page, /<h2 id="your-signin-h" className="set-group">Your sign-in<\/h2>\s*<SignInWays \/>\s*<TwoStepCard \/>\s*<SignedIn \/>/);
  assert.match(page, /\{me\.role !== 'member' && <Card><SecurityLog \/><\/Card>\}/);
  const profile = page.slice(page.indexOf('function Profile()'), page.indexOf('function Security()'));
  assert.doesNotMatch(profile, /<SignInWays|<TwoStepCard|<SignedIn/, 'Profile no longer mixes in the password and two-step login');
  assert.match(profile, /Your password, two-step login and the places you are signed in are under/, 'and says where they went');
  assert.match(profile, /<Card><Notifications \/><\/Card>/);
  // A member keeps what was theirs to do under Your data: export, and closing their own login.
  assert.match(profile, /\{member && <MoreOptions>[\s\S]*?<YourData \/>\s*<\/MoreOptions>\}/);
  // Sending: reminders, deadline and date format left Account.
  assert.match(page, /\{tab === 'sending' && <div className="stack"><Card><SendingDefaults \/><\/Card><CustomFieldSettings \/><\/div>\}/);
  const account = page.slice(page.indexOf('function Account()'), page.indexOf('function Team()'));
  assert.doesNotMatch(account, /default_reminder_days|default_expire_days|default_date_format/);
  const sending = read('src/components/settings/SendingDefaults.tsx');
  assert.match(sending, /id="set-reminders"><b>New documents start like this\.<\/b> \{reminderText\(/);
  assert.match(sending, /<h2 id="set-new-h" style=\{\{ marginBottom: 4 \}\}>New documents<\/h2>/);
  // The Plan section is the payment owner's component, placed as it is.
  assert.match(page, /\{tab === 'billing' && <Billing \/>\}/);
});

test('Settings: "Saved" stands next to what saved, the long lists are folded, and each section has one More options at most', () => {
  const page = read('src/app/app/settings/page.tsx');
  const mine = page.slice(0, page.indexOf('const TOP_UP_PICKS')) + page.slice(page.indexOf('function WhatIsKept()'));
  assert.doesNotMatch(mine, /toast\('Saved'\)/, 'no toast in the middle of the page');
  assert.equal((mine.match(/useSaved\(\)/g) || []).length, 3, 'Profile, the email switches and Account');
  assert.match(mine, /<span className="row">\{said\}<button className="btn" onClick=\{\(\) => save\(f\)\}>Save profile<\/button><\/span>/);
  assert.match(mine, /<b>\{title\}<\/b> \{last === k && said\}/, 'next to the switch that was changed');
  const frame = read('src/components/settings/Frame.tsx');
  assert.match(frame, /<span key="saved" role="status" className="set-saved">\{on \? words : ''\}<\/span>/, 'a live region, so a screen reader says it');
  assert.match(frame, /<details className="set-more" data-more="screen">\s*<summary>More options<\/summary>/);
  assert.match(frame, /<div data-item="card" className="set-card">/);
  // A text card saves with a button that is not the filled one (one main button a page: P5).
  assert.doesNotMatch(mine.slice(mine.indexOf('function Profile()'), mine.indexOf('function Team()')), /btn primary/);
  // Your data: the two lists are behind "What is kept", closed, and the page still says where to look.
  const kept = page.slice(page.indexOf('function WhatIsKept()'), page.indexOf('function YourData('));
  assert.match(kept, /<details data-fold="" className="set-kept">\s*<summary className="set-fold">What is kept<\/summary>/);
  assert.match(kept, /DELETED_WITH_ACCOUNT\.map/);
  assert.match(kept, /KEPT_AFTER_DELETION\.map/);
  const data = page.slice(page.indexOf('function YourData('), page.indexOf('const returned'));
  assert.equal((data.match(/<WhatIsKept \/>/g) || []).length, 2);
  assert.doesNotMatch(data, /DELETED_WITH_ACCOUNT\.map/);
  assert.match(data, /&quot;What is kept&quot; below says exactly what goes and what stays\./);
  // An admin closes the account from the one More options of Your data; nothing on any section is open on arrival.
  assert.match(page, /\{tab === 'data' && <MoreOptions><YourData only="close" \/><\/MoreOptions>\}/);
  assert.doesNotMatch(mine + frame + read('src/components/settings/SendingDefaults.tsx'), /<details[^>]* open/);
  // The plan rules are behind "How signatures work" (the payment owner's part, checked here so it stays).
  assert.match(page, /<details className="card" data-fold="">\s*<summary[^>]*>How signatures work<\/summary>/);
});

test('Sending defaults: a number saves only when it is one, so an empty box never switches reminders off', async () => {
  const rule = daysIn;
  assert.match(read('src/components/settings/SendingDefaults.tsx'), /const n = daysIn\(f\[key\], lo, hi\);\s*if \(n == null\) \{[\s\S]*?return setBad/, 'the box is checked before anything is sent');
  assert.equal(rule('', 0, 60), null);
  assert.equal(rule(' ', 0, 60), null);
  assert.equal(rule('0', 0, 60), 0, 'nought is a choice: no reminders');
  assert.equal(rule('3', 0, 60), 3);
  assert.equal(rule('61', 0, 60), null);
  assert.equal(rule('0', 1, 365), null, 'a deadline of no days is not one');
  for (const odd of ['-1', '1e1', '2.5', '0x10', '3 days']) assert.equal(rule(odd, 0, 60), null, odd);

  // The server keeps what it is not sent: one setting saved by itself leaves the others alone.
  const ada = await signUp('Ada Sending', 'ada.sending@example.com', '10.61.0.1');
  const before = (await ada.get('/me')).data.account;
  assert.equal((await ada.call('PATCH', '/account', { default_reminder_days: 7 })).status, 200);
  let now = (await ada.get('/me')).data.account;
  assert.equal(now.default_reminder_days, 7);
  assert.deepEqual([now.name, now.default_expire_days, now.default_date_format, now.brand_color], [before.name, before.default_expire_days, before.default_date_format, before.brand_color]);
  assert.equal((await ada.call('PATCH', '/account', { default_date_format: 'YYYY-MM-DD' })).status, 200);
  now = (await ada.get('/me')).data.account;
  assert.deepEqual([now.default_reminder_days, now.default_date_format, now.name], [7, 'YYYY-MM-DD', before.name]);
  // Someone who is not signed in changes nothing.
  assert.equal((await new Client().call('PATCH', '/account', { default_reminder_days: 0 })).status, 401);
  assert.equal((await ada.get('/me')).data.account.default_reminder_days, 7);
});

// ---- 5. Dates -------------------------------------------------------------------------------------------------------

test('a new document writes dates as 20 Nov 2026 unless the account chose another format; the choice of YYYY-MM-DD stays', async () => {
  assert.equal(DEFAULT_DATE_FORMAT, 'D MMM YYYY');
  assert.equal(formatDate('2026-11-20T10:00:00Z', DEFAULT_DATE_FORMAT, 'UTC'), '20 Nov 2026');
  assert.equal(DATE_FORMAT_CHOICES[0], DEFAULT_DATE_FORMAT, 'and it is the first in the list');
  assert.ok((DATE_FORMATS as readonly string[]).includes('YYYY-MM-DD') && DATE_FORMAT_CHOICES.includes('YYYY-MM-DD'));
  const ben = await signUp('Ben Dates', 'ben.dates@example.com', '10.61.0.2');
  assert.equal((await ben.get('/me')).data.account.default_date_format, null, 'nothing chosen yet');
  const env = await simple(ben, 'dee.dates@example.com');
  assert.equal(env.date_format, 'D MMM YYYY');
  assert.equal(db.get('SELECT date_format FROM envelopes WHERE id=?', env.id).date_format, 'D MMM YYYY');
  // An account that prefers year-month-day says so once, under Settings, Sending.
  assert.equal((await ben.call('PATCH', '/account', { default_date_format: 'YYYY-MM-DD' })).status, 200);
  assert.equal((await simple(ben, 'dee2.dates@example.com')).date_format, 'YYYY-MM-DD');
  // A format that does not exist is still refused, in words.
  const no = await ben.call('PATCH', '/account', { default_date_format: 'YY/MM/DD' });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /^The date format "YY\/MM\/DD" does not exist\. Use one of: /);
  // A document made before this, which never chose a format, keeps the one it was stamped with.
  db.run('UPDATE envelopes SET date_format=NULL WHERE id=?', env.id);
  assert.equal(formatDate('2026-11-20T10:00:00Z', db.get('SELECT date_format FROM envelopes WHERE id=?', env.id).date_format, 'UTC'), '2026-11-20');
  // Settings and the editor start from the same default.
  assert.match(read('src/components/settings/SendingDefaults.tsx'), /default_date_format: a\.default_date_format \|\| DEFAULT_DATE_FORMAT/);
  assert.match(read('src/components/editor/ReviewParts.tsx'), /dateFormat: me\.account\?\.default_date_format \|\| DEFAULT_DATE_FORMAT/);
});

test('a day written for a person reads 20 Nov 2026 on screens, in emails and on the signing record; files and the API keep 2026-11-20', () => {
  assert.equal(dayText('2026-11-20T23:59:59.000Z'), '20 Nov 2026');
  assert.equal(dayText('2026-11-20'), '20 Nov 2026');
  assert.equal(dayText('2027-01-01T00:00:00.000Z'), '1 Jan 2027');
  assert.equal(dayText(null), '');
  assert.equal(dayText('not a date'), '');
  // The signing record: the day with the month as a word, and the time in UTC next to it.
  assert.match(read('src/server/pdf.ts'), /const ts = \(s: string \| null \| undefined\) => \(s \? `\$\{dayText\(s\)\} \$\{s\.slice\(11, 19\)\} UTC` : '-'\);/);
  // Sentences a person reads no longer carry a day cut out of a timestamp.
  for (const f of ['src/components/sender/History.tsx', 'src/components/sender/Recipients.tsx', 'src/server/routes-evidence.ts', 'src/server/routes-envelopes.ts', 'src/server/routes-support.ts'])
    assert.doesNotMatch(read(f), /\$?\{[^{}]*\.slice\(0, 10\)\}/, f);
  assert.doesNotMatch(read('src/server/routes-trust.ts'), /deleted on \$\{when\.slice|before \$\{until\.slice|Until \$\{when\.slice/);
  assert.doesNotMatch(read('src/server/envelopes.ts'), /will be deleted on \$\{String\(account\.closing_at\)\.slice/);
  // File names in the export stay sortable.
  assert.match(read('src/server/routes-trust.ts'), /const base = `\$\{\(e\.completed_at \|\| e\.sent_at \|\| e\.created_at\)\.slice\(0, 10\)\} \$\{safeName\(e\.subject\)\}/);
});

// ---- 6. Repairs after the skeptic's and the simplicity reviewer's reports (21 November 2026) -------------------------

test('repair: a More that the measuring script opens stays on the page while it is open', () => {
  // "Change email address" was taken out of the page when pressed, and tests/ux/flows.cjs then waited 20 seconds for it
  // and stopped its inventory at Settings, Profile.
  const card = read('src/components/EmailProblem.tsx');
  const body = card.slice(card.indexOf('export function EmailAddressCard'));
  assert.match(body, /<button type="button" className="btn sm" style=\{TAP\} onClick=\{\(\) => setOpen\(\(o\) => !o\)\} aria-expanded=\{open\} aria-controls=\{`\$\{id\}-change`\} data-more="item">Change email address<\/button>/);
  assert.match(body, /<div id=\{`\$\{id\}-change`\} hidden=\{!open\}>\{open && <EmailChangeForm/);
  assert.doesNotMatch(body, /\{open \? <EmailChangeForm/, 'the button is not swapped for the form');
  // The same holds for every other mark of this kind on a Settings screen: a <details>, or a button that says where its panel is.
  const all = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(`${dir}/${e.name}`) : /\.tsx$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  for (const f of [...all('src/components/settings'), 'src/app/app/settings/page.tsx', 'src/app/app/settings/TwoStep.tsx', 'src/app/app/settings/SignedIn.tsx', 'src/components/EmailProblem.tsx'])
    for (const m of read(f).matchAll(/<(\w+)\b[^>]*data-more="(?:item|screen)"[^>]*>/g))
      assert.ok(m[1] === 'details' || /aria-controls=/.test(m[0]), `${f}: ${m[0].slice(0, 80)}`);
});

test('repair: each number box of Sending says its own refusal, with its name, its limits and what is still saved', () => {
  assert.equal(refusedDays('default_reminder_days', 0, 60, '3'), 'Reminders: type a whole number from 0 to 60. It is still 3.');
  assert.equal(refusedDays('default_expire_days', 1, 365, '120'), 'Deadline: type a whole number from 1 to 365. It is still 120.');
  assert.equal(refusedDays('default_expire_days', 1, 365, ''), 'Deadline: type a whole number from 1 to 365. Nothing was changed.');
  const s = read('src/components/settings/SendingDefaults.tsx');
  assert.doesNotMatch(s, /bad\.default_reminder_days \|\| bad\.default_expire_days/, 'no shared line that shows one of two refusals');
  assert.match(s, /\{bad\.default_reminder_days && <span id="set-rem-bad" className="set-bad" role="alert">\{bad\.default_reminder_days\}<\/span>\}\s*<\/label>/, 'under its own box');
  assert.match(s, /\{bad\.default_expire_days && <span id="set-due-bad" className="set-bad" role="alert">\{bad\.default_expire_days\}<\/span>\}\s*<\/label>/);
  assert.match(s, /aria-describedby=\{bad\.default_expire_days \? 'set-due-bad' : undefined\}/, 'and tied to it for a screen reader');
  assert.match(s, /setF\(\(x\) => \(\{ \.\.\.x, \[key\]: kept \}\)\);/, 'the box goes back to what is saved');
});

test('repair: the API leaves reminders and the deadline alone when it is sent null, nothing or words', async () => {
  const cy = await signUp('Cy Null', 'cy.null@example.com', '10.61.0.3');
  assert.equal((await cy.call('PATCH', '/account', { default_reminder_days: 5, default_expire_days: 90 })).status, 200);
  for (const v of [null, '', '  ', 'soon', true, false, [], {}]) {
    assert.equal((await cy.call('PATCH', '/account', { default_reminder_days: v, default_expire_days: v })).status, 200, JSON.stringify(v));
    const a = (await cy.get('/me')).data.account;
    assert.deepEqual([a.default_reminder_days, a.default_expire_days], [5, 90], `still as they were after ${JSON.stringify(v)}`);
  }
  // Nought is still a choice, as a number or as the text a form sends.
  assert.equal((await cy.call('PATCH', '/account', { default_reminder_days: '0' })).status, 200);
  assert.equal((await cy.get('/me')).data.account.default_reminder_days, 0);
  assert.equal((await cy.call('PATCH', '/account', { default_reminder_days: 999, default_expire_days: 0 })).status, 200);
  const a = (await cy.get('/me')).data.account;
  assert.deepEqual([a.default_reminder_days, a.default_expire_days], [60, 1], 'a number outside the limits is brought to the nearest one, as before');
});

test('repair: a video that would give an empty player gives no block', () => {
  const there = (p: string) => fs.existsSync(`public${p}`);
  assert.equal(homeVideo({ HOME_VIDEO_URL: '/videos/nope.mp4' }, there), null, 'a file name that is not under public/videos');
  assert.equal(homeVideo({ HOME_VIDEO_URL: '/videos/tree-count.mp4' }, there)!.src, '/videos/tree-count.mp4');
  assert.equal(homeVideo({ HOME_VIDEO_URL: '/videos/tree-count.mp4', HOME_VIDEO_POSTER: '/videos/nope.webp' }, there)!.poster, null, 'a poster that is not there is left out');
  assert.equal(homeVideo({}, () => false), null, 'the shipped video too, if someone deleted it');
  assert.deepEqual(homeVideo({}, (p) => p.endsWith('.mp4')), { src: '/videos/tree-count.mp4', type: 'video/mp4', poster: null, preload: 'metadata' });
  // http plays on a site that itself runs on http (localhost), and nowhere else.
  assert.equal(homeVideo({ HOME_VIDEO_URL: 'http://cdn.example.org/a.mp4' }), null);
  assert.equal(homeVideo({ HOME_VIDEO_URL: 'http://cdn.example.org/a.mp4', APP_URL: 'https://sign.example.org' }), null);
  assert.equal(homeVideo({ HOME_VIDEO_URL: 'http://localhost:9000/a.mp4', APP_URL: 'http://localhost:3000' })!.src, 'http://localhost:9000/a.mp4');
  assert.equal(homeVideo({ HOME_VIDEO_URL: 'https://cdn.example.org/a.mp4', HOME_VIDEO_POSTER: 'http://cdn.example.org/a.jpg', APP_URL: 'https://sign.example.org' })!.poster, null);
  assert.match(read('src/app/page.tsx'), /homeVideo\(process\.env, \(sitePath\) => fs\.existsSync\(path\.join\(process\.cwd\(\), 'public', sitePath\)\)\)/, 'the home page looks on disk');
});

test('repair: dates on app screens and in the records put the day first with the month as a word', () => {
  // fmtDate (every list, Settings, the security record): day first for any English browser, the browser's own way otherwise.
  assert.equal(fmtDateTag('en-US'), 'en-GB');
  assert.equal(fmtDateTag('en'), 'en-GB');
  assert.equal(fmtDateTag(''), 'en-GB');
  assert.equal(fmtDateTag('fr-FR'), undefined);
  assert.equal(new Date('2026-11-21T12:05:00Z').toLocaleDateString(fmtDateTag('en-US'), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), '21 Nov 2026');
  assert.match(read('src/components/ui.tsx'), /const tag = fmtDateTag\(typeof navigator === 'undefined' \? '' : navigator\.language\);/);
  // The security record, the deletion record and the data processing page.
  assert.match(read('src/lib/seclog.ts'), /w\('closes_on', \{ day: dayText\(/);
  const records = read('src/server/records.ts');
  assert.doesNotMatch(records, /detail: `[^`]*\$\{day\(/, 'no line of the deletion record carries a day cut out of a timestamp');
  assert.equal((records.match(/Goes on \$\{dayText\(goes\)\}/g) || []).length, 2);
  assert.match(records, /Kept\$\{until \? ` until \$\{dayText\(until\)\}` : ''\}/);
  assert.match(read('src/app/security/processing/page.tsx'), /const today = dayText\(new Date\(\)\);/);
});

test('repair: a deletion that was asked for is written into its record as "Goes on 5 Dec 2026"', async () => {
  const dan = await signUp('Dan Record', 'dan.record@example.com', '10.61.0.4');
  const env = await simple(dan, 'eve.record@example.com');
  db.run("UPDATE envelopes SET status='voided' WHERE id=?", env.id);
  const level = (await import('../src/lib/retention.ts')).PURGE_LEVELS[0];
  const asked = await dan.call('POST', `/envelopes/${env.id}/purge`, { level });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const line = db.get("SELECT detail FROM retention_log WHERE envelope_id=? AND what='purge_asked'", env.id);
  assert.match(line.detail, /^Goes on \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
});

test('repair: Settings says document, the fold labels differ, and developer text is with the API keys', () => {
  const page = read('src/app/app/settings/page.tsx');
  const mine = page.slice(0, page.indexOf('function Team()')) + page.slice(page.indexOf('function WhatIsKept()'));
  assert.doesNotMatch(mine.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, ''), /(your|the|every|an|new|its) envelopes?\b|envelope\(s\)|audit trail/i, 'no "envelope" or "audit trail" in the words of Profile, Security, Account or Your data');
  assert.match(page, /<h2 style=\{\{ marginBottom: 4 \}\}>Emails about your documents<\/h2>/);
  assert.match(page, /the full history of every document/);
  assert.doesNotMatch(page, /envelope\(s\)/);
  assert.equal(closingCount(0), 'everything in it');
  assert.equal(closingCount(1), 'its 1 document');
  assert.equal(closingCount(12), 'its 12 documents');
  // One "More options" a screen: the folds inside a card are named for their card.
  assert.match(read('src/components/settings/RetentionSettings.tsx'), /<summary>More about keeping and deleting<\/summary>/);
  assert.equal(JSON.parse(read('src/locales/en.json'))['settings.security.more'], 'More about the security record');
  // The sentence about API keys left the two-step cards every member reads and stands with the keys.
  const two = read('src/app/app/settings/TwoStep.tsx');
  assert.doesNotMatch(two, /TWO_STEP_API_KEYS/);
  assert.match(page, /<p className="muted small">\{KEYS_AND_TWO_STEP\}<\/p>/);
  assert.match(KEYS_AND_TWO_STEP, /^Two-step login does not apply to API keys: a program that uses one is never asked for a code\./);
  // Where you are signed in: one line, the full rule behind "How this works".
  assert.equal(sessionShort(30, 90), 'A browser is signed out after 30 days without use, or 90 days after you signed in on it.');
  assert.equal(sessionShort(30, 30), 'A browser is signed out 30 days after you signed in on it.');
  assert.match(read('src/app/app/settings/SignedIn.tsx'), /<p className="muted small">\{sessionShort\(d\.days, d\.max_days\)\}<\/p>\s*<details data-fold="">\s*<summary className="set-fold">How this works<\/summary>/);
  // Team: one filled button, and the cards are marked so the 4-card rule is measured there too.
  const team = page.slice(page.indexOf('function Team()'), page.indexOf('function Developers()'));
  assert.equal((team.replace(/<Modal[\s\S]*?<\/Modal>/g, '').match(/btn primary/g) || []).length, 1, 'Send invite');
  assert.doesNotMatch(two.slice(two.indexOf('export function TeamTwoStep')).split('<Modal')[0], /btn primary/);
  assert.match(team, /className="card row wrap set-invite" data-item="card"/);
  assert.match(read('src/app/styles/settings.css'), /\.set-invite > label\.f, \.set-invite > \.btn \{ flex: 1 1 100%; \}/);
});

test('repair: the sections are real tabs for the keyboard, and a member can still read the plan and the stamps', async () => {
  const keys = ['profile', 'security', 'team', 'developers'];
  assert.equal(nextTab(keys, 'profile', 'ArrowRight'), 'security');
  assert.equal(nextTab(keys, 'developers', 'ArrowRight'), 'profile', 'round to the first');
  assert.equal(nextTab(keys, 'profile', 'ArrowLeft'), 'developers');
  assert.equal(nextTab(keys, 'team', 'Home'), 'profile');
  assert.equal(nextTab(keys, 'team', 'End'), 'developers');
  assert.equal(nextTab(keys, 'team', 'Enter'), null);
  assert.equal(nextTab(keys, 'team', 'a'), null);
  const page = read('src/app/app/settings/page.tsx');
  assert.match(page, /role="tab" aria-selected=\{tab === k\} aria-controls="set-panel" tabIndex=\{/);
  assert.match(page, /<div id="set-panel" role="tabpanel"/);
  // A member has four sections and no tab for Plan or Stamps, and reads both from Profile, More options.
  assert.deepEqual(MEMBER_READS.map(([k]) => k), ['billing', 'stamps']);
  assert.equal(sectionsFor('member').length, 4);
  for (const [k] of MEMBER_READS) {
    const to = landingFor('member', k);
    assert.equal(to.tab, k);
    assert.match(to.note!, /You can read it here, and they are the ones who change it\.$/);
    assert.equal(landingFor('admin', k).note, undefined);
  }
  for (const k of ['account', 'sending', 'data']) assert.equal(landingFor('member', k).tab, 'profile', `${k} was "admins only" for a member before too`);
  assert.match(page, /\{MEMBER_READS\.map\(\(\[k, l\]\) => <Link key=\{k\} className="btn sm"/);
  // The server lets a member read both and change neither.
  const owner = await signUp('Olu Owner', 'olu.owner@example.com', '10.61.0.5');
  assert.equal((await owner.post('/account/invites', { email: 'mia.member@example.com', role: 'member' })).status, 200);
  const mem = new Client();
  mem.ip = '10.61.0.6';
  const joined = await mem.post('/auth/signup', { name: 'Mia Member', email: 'mia.member@example.com', password: 'correct horse battery', invite: db.get('SELECT token FROM invites WHERE email=?', 'mia.member@example.com').token });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  assert.equal((await mem.get('/me')).data.role, 'member');
  assert.equal((await mem.get('/billing')).status, 200);
  assert.equal((await mem.get('/stamps')).data.may_change, false);
  assert.equal((await mem.call('PATCH', '/account', { default_reminder_days: 0 })).status, 403);
});

test('repair: on a phone Sign in stays in the top bar, and the public pages say document, Send to many and Forms', () => {
  const pub = read('src/components/Public.tsx');
  const css = read('src/app/styles/public.css');
  assert.doesNotMatch(css, /\.pub-signin \{ display: none; \}/, 'Sign in is never hidden');
  const menu = pub.slice(pub.indexOf('<nav id="pub-menu"'), pub.indexOf('</header>'));
  assert.doesNotMatch(menu, /href="\/login"/, 'so the menu does not repeat it');
  assert.match(pub, /<Logo height=\{26\} \/><Mark size=\{30\} label="GrowSigning" className="pub-logo-mark" \/>/);
  assert.match(css, /@media \(max-width: 379px\) \{\s*\.pub-head \.logo > svg:not\(\.pub-logo-mark\) \{ display: none; \}\s*\.pub-logo-mark \{ display: block; \}/);
  // Trust holds trust matters only. Stopping a subscription is still one press from every public page, with the prices.
  const trust = pub.slice(pub.indexOf('<nav aria-label="Trust">'), pub.indexOf('</footer>'));
  assert.doesNotMatch(trust, /help#cancel/);
  assert.match(pub.slice(pub.indexOf('<nav aria-label="Product">'), pub.indexOf('<nav aria-label="Trust">')), /<Link href="\/help#cancel">Stop a subscription<\/Link>/);
  const pricing = read('src/app/pricing/page.tsx'), features = read('src/app/features/page.tsx');
  for (const [f, src] of [['pricing', pricing], ['features', features]] as const)
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\benvelopes?\b|\bvoid(ed|ing)?\b|bulk send|PowerForm|audit trail/i, f);
  // /pricing: three rules open, the rest behind "All the rules", and a link to one of the folded rules opens the fold.
  const open = pricing.slice(pricing.indexOf('<h2 id="rules">'), pricing.indexOf('<details className="pub-fold"'));
  assert.equal((open.match(/<li/g) || []).length, 3);
  assert.match(pricing, /<details className="pub-fold" id="all-rules" data-fold="">\s*<summary>All the rules<\/summary>/);
  assert.match(pricing, /<\/details>\s*<OpenOnHash \/>/);
  const fold = pricing.slice(pricing.indexOf('<details className="pub-fold"'), pricing.indexOf('</details>'));
  for (const id of ['id="expiry"', 'id="bulk-cost"', 'id="not-for-patients"']) assert.ok(fold.includes(id), `${id} is inside the fold`);
  assert.match(read('src/components/OpenOnHash.tsx'), /fold\.open = true;\s*el\.scrollIntoView/);
  // /features names the rule it leans on with a link.
  assert.match(features, /\['\/pricing#not-for-patients', 'Why not for patient forms'\]/);
});
