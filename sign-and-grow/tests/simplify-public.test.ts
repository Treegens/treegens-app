// The public pages and Settings made simpler (brief "simplify-public", research/ux-charter.md 2.2 and 2.7, and the
// owner's notes of 21 November 2026): a home page that says one thing, the tree counting video, four entries in the
// top bar, Settings in sections a person can find, "Saved" next to what saved, and dates nobody can misread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple } from './helpers.ts';
import { homeVideo, HOME_VIDEO_CAPTION, HOME_VIDEO_TEXT } from '../src/lib/homevideo.ts';
import { sectionsFor, landingFor, SETTINGS_MAX, daysIn } from '../src/lib/settingsnav.ts';
import { DEFAULT_DATE_FORMAT, DATE_FORMATS, DATE_FORMAT_CHOICES, dayText, formatDate } from '../src/lib/dates.ts';
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
  const sent = landingFor('member', 'billing');
  assert.equal(sent.tab, 'profile');
  assert.equal(sent.note, 'Plan is set by the owner and the admins of this account, so it is not in your Settings. Ask one of them: Team lists who they are.');
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
  assert.match(profile, /\{member && <MoreOptions><YourData \/><\/MoreOptions>\}/);
  // Sending: reminders, deadline and date format left Account.
  assert.match(page, /\{tab === 'sending' && <div className="stack"><Card><SendingDefaults \/><\/Card><CustomFieldSettings \/><\/div>\}/);
  const account = page.slice(page.indexOf('function Account()'), page.indexOf('function Team()'));
  assert.doesNotMatch(account, /default_reminder_days|default_expire_days|default_date_format/);
  const sending = read('src/components/settings/SendingDefaults.tsx');
  assert.match(sending, /id="set-reminders"><b>New envelopes start like this\.<\/b> \{reminderText\(/);
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
  assert.match(read('src/components/settings/SendingDefaults.tsx'), /const n = daysIn\(f\[key\], lo, hi\);\s*if \(n == null\) return setBad/, 'the box is checked before anything is sent');
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
