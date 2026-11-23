// The rest of the sender's screens and the public pages in the sender's language (research/docusign-gaps.json, batch
// "lang-sender-rest"). The same rules as tests/ds-lang-sender.test.ts: the words come from en.json through T() (or
// t() with the screen's language), never written into the code, so a second language changes them all at once. Only
// English is switched on, so with zero setup every screen reads as before: the English texts in en.json are the very
// sentences the screens said, and where a sentence also lives in src/lib (shared with the server and emails) this
// test holds the two equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseMessage } from '../src/lib/i18n.ts';
import { senderT } from '../src/lib/senderlang.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const en: Record<string, string> = JSON.parse(read('src/locales/en.json'));

/**
 * Words written as English in a file rather than asked for by key: JSX text, shown attributes, and string literals
 * that read as a sentence or a label of two words or more. Brand names, units and example addresses are allowed.
 * Stricter than the scan in tests/ds-lang-sender.test.ts, which reads JSX text and attributes only.
 */
export function untranslated(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const ALLOW = /^(GrowSigning|growsigning|PDF|PNG|JPEG|ZIP|CSV|px|mm|·|&apos;|%|Promise)$/;
  const out: string[] = [];
  for (const m of code.matchAll(/>([^<>{}]*?[A-Za-z]{2}[^<>{}]*?)</g)) {
    const t = m[1].trim();
    if (t && !ALLOW.test(t) && !/=>|&&|\|\||\)\s*[;,]?$|[?:]\s*\(\s*$|[;=]|\)\s*return\b/.test(m[1]) && !/^\(\w+: /.test(t) && !/^new \w+$|\s\|\s/.test(t) && !/^,|:$|\?$/.test(t)) out.push(t);
  }
  for (const m of code.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z]{2}[^"]*)"/g)) if (!/example\.|^https:/.test(m[2])) out.push(`${m[1]}="${m[2]}"`);
  for (const m of code.matchAll(/(['`])([A-Z][a-z']*(?: [^'`\n]*?)?[a-z.!?…:)])\1/g)) if (/ /.test(m[2]) || /[.!?…]$/.test(m[2])) out.push(`'${m[2]}'`);
  return out;
}

// The files of this batch whose every word goes through the catalogue now. A file joins this list when it is done;
// the ones still to do are named in README "What is not in it".
export const DONE = [
  'src/components/settings/AgreementPlan.tsx',
  'src/components/settings/AiSettings.tsx',
  'src/components/settings/ArchiveFormat.tsx',
  'src/components/settings/ArchiveSettings.tsx',
  'src/components/settings/BroughtInLink.tsx',
  'src/components/settings/ChannelsStatus.tsx',
  'src/components/settings/CopyValue.tsx',
  'src/components/settings/CustomFieldSettings.tsx',
  'src/components/settings/Frame.tsx',
  'src/components/settings/KeyDatesSetting.tsx',
  'src/components/settings/LanguageSettings.tsx',
  'src/components/settings/OrgDirectory.tsx',
  'src/components/settings/OrgSaml.tsx',
  'src/components/settings/OrgSso.tsx',
  'src/components/settings/OwnDocsDefault.tsx',
  'src/components/settings/SealStatus.tsx',
  'src/components/settings/SecurityLog.tsx',
  'src/components/settings/SecurityPolicy.tsx',
  'src/components/settings/TenantSwitches.tsx',
  'src/components/settings/TreesOnRecord.tsx',
  'src/components/settings/Organisation.tsx',
  'src/components/settings/RetentionSettings.tsx',
  'src/components/settings/Profiles.tsx',
  'src/components/settings/TakePayments.tsx',
  'src/components/settings/Shares.tsx',
  'src/components/settings/SendingDefaults.tsx',
  'src/components/settings/ScreenLanguage.tsx',
  'src/components/settings/SavedFieldSettings.tsx',
  'src/components/settings/ExportImport.tsx',
  'src/components/settings/EmbedSites.tsx',
  'src/components/settings/Disclosure.tsx',
  'src/components/settings/Delegate.tsx',
  'src/components/settings/CounterSettings.tsx',
  'src/components/stamps/StampDialog.tsx',
  'src/components/stamps/StampMaker.tsx',
  'src/components/stamps/StampSettings.tsx',
  'src/components/stamps/words.tsx',
  'src/app/app/templates/page.tsx',
  'src/app/app/bulk/page.tsx',
  'src/app/app/bulk/BatchCost.tsx',
  'src/app/app/powerforms/page.tsx',
  'src/app/app/agreements/page.tsx',
  'src/app/app/contacts/page.tsx',
  'src/app/app/reports/page.tsx',
  'src/app/app/inbox/page.tsx',
  'src/components/sender/SigningGroups.tsx',
  'src/components/AuthForm.tsx',
  'src/components/publicLang.tsx',
  'src/components/requestLang.tsx',
  'src/app/page.tsx',
  'src/app/impact/page.tsx',
  // Repair pass: the "When people sign" switches, the monthly report line and the ready-made templates list.
  'src/components/settings/Switches.tsx',
  'src/components/reports/MonthlyReport.tsx',
  'src/components/templates/Starters.tsx',
];

// The files of this batch that still have English written into them. Each is named in README "What is not in it",
// and each must still hold English: once one is done it moves to DONE above, so this list never says more or less
// than is true. A second sender language waits until this list is empty.
export const LEFT: [file: string, readme: string][] = [
  ['src/app/app/settings/page.tsx', 'src/app/app/settings/page.tsx'],
  ['src/app/app/settings/SignedIn.tsx', 'SignedIn.tsx'],
  ['src/app/app/settings/TwoStep.tsx', 'TwoStep.tsx'],
  ['src/app/app/agreements/[id]/page.tsx', '/app/agreements/<id>'],
  ['src/components/templates/WhoCanUse.tsx', 'WhoCanUse.tsx'],
  ['src/components/templates/AddTemplate.tsx', 'AddTemplate.tsx'],
  ['src/components/forms/FormLimits.tsx', 'FormLimits.tsx'],
  ['src/app/app/powerforms/[id]/qr/page.tsx', "the form's printable sheet"],
  ['src/components/reports/SavedLists.tsx', 'SavedLists.tsx'],
  ['src/components/ImpactView.tsx', 'ImpactView.tsx'],
  ['src/app/help/page.tsx', '/help'],
  ['src/app/security/page.tsx', '/security'],
];

test('the finished screens show no English written into the code', () => {
  for (const f of DONE) assert.deepEqual(untranslated(read(f)), [], f);
});

test('the finished screens ask for their words in the screen\'s language, never in English by force', () => {
  for (const f of DONE) {
    const src = read(f);
    assert.doesNotMatch(src, /const ui = SOURCE_LOCALE|t\(SOURCE_LOCALE,/, `${f} still asks for English whatever the sender reads`);
    // A key the file asks for is in en.json, so nothing shows empty.
    for (const m of src.matchAll(/\b(?:T|say|t\(ui,)\(?\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g)) assert.ok(Object.hasOwn(en, m[1]), `${f}: ${m[1]}`);
  }
});

test('every key the files ask for reads, in English and in the long and right-to-left test languages', () => {
  const keys = new Set<string>();
  for (const f of DONE) for (const m of read(f).matchAll(/'((?:settings|imported|owndocs|ai|keydates|stamps|auth|public|perm|templates|bulk|forms|terms|contacts|reports|inbox|starters)\.[a-z0-9_.]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size > 30, `${keys.size}`);
  for (const k of keys) {
    assert.ok(Object.hasOwn(en, k), k);
    assert.doesNotThrow(() => parseMessage(en[k]), k);
    assert.doesNotMatch(en[k], /—/, k);
    assert.ok(senderT('en-XA', k, { count: 2, who: 'Ada', provider: 'X', button: 'B' }).startsWith('['), k);
    assert.ok(senderT('ar-XB', k, { count: 2, who: 'Ada', provider: 'X', button: 'B' }).length > 0, k);
  }
});

test('a sentence that also lives in src/lib reads the same from the catalogue', async () => {
  const owndocs = await import('../src/lib/owndocs.ts');
  const ai = await import('../src/lib/aiassist.ts');
  const kd = await import('../src/lib/keydates.ts');
  assert.equal(en['owndocs.label'], owndocs.OWN_DOCS_LABEL);
  assert.equal(en['owndocs.note'], owndocs.OWN_DOCS_NOTE);
  assert.equal(en['ai.read_switch'], ai.READ_SWITCH);
  assert.equal(en['ai.read_hint'], ai.READ_HINT);
  assert.equal(en['keydates.name'], kd.KEY_DATES);
  assert.equal(en['keydates.switch_hint'], kd.KEY_SWITCH_HINT);
  assert.equal(en['keydates.off_warning'], kd.KEY_OFF_WARNING);
  assert.equal(en['keydates.older_button'], kd.OLDER_BUTTON);
  assert.equal(en['keydates.find_button'], kd.FIND_BUTTON);
  const button = kd.FIND_BUTTON;
  assert.equal(senderT('en', 'keydates.auto_all', { button }), kd.autoLine(true, true));
  assert.equal(senderT('en', 'keydates.auto_new', { button }), kd.autoLine(true, false));
  assert.equal(senderT('en', 'keydates.auto_off', { button }), kd.autoLine(false, false));
});

test('English with zero setup: the words the screens said before', () => {
  assert.equal(senderT('en', 'settings.saved'), 'Saved');
  assert.equal(senderT('en', 'settings.more_options'), 'More options');
  assert.equal(senderT('en', 'settings.keydates.older_waiting', { count: 1 }), 'Saved. 1 document will be read over the next hours.');
  assert.equal(senderT('en', 'settings.keydates.older_waiting', { count: 3 }), 'Saved. 3 documents will be read over the next hours.');
  assert.equal(senderT('en', 'imported.link', { count: '4' }), 'Documents brought in (4)');
  assert.equal(senderT('en', 'settings.channels.whatsapp', { what: 'WhatsApp:', count: 100 }), 'WhatsApp: senders can have us send the signing link by WhatsApp to people who agreed to it, chosen under “How they get it”. Up to 100 messages a day for this account.');
});

// ---- lang-sender-rest, second pass: the stamps, Team's roles, Keep and delete, Organisation, templates, Send to many,
// forms, website terms, contacts and groups, reports, To sign, the sign-in forms, the home page and /impact.

test('English with zero setup: the new keys say what the screens said before, plurals included', () => {
  const T = (k: string, v: Record<string, string | number> = {}) => senderT('en', k, v);
  assert.equal(T('templates.count', { count: 1 }), '1 template.');
  assert.equal(T('templates.count_match', { count: 3 }), '3 templates match.');
  assert.equal(T('templates.count_page', { count: 200 }), '200 most recently updated templates. Search to find older ones.');
  assert.equal(T('templates.row_sm_folder', { roles: 'Client', count: 2, folder: 'Texas' }), 'Roles: Client · 2 pages · Folder: Texas');
  assert.equal(T('bulk.sent_so_far', { count: 1, waiting: 4 }), '1 document sent so far, 4 still going out. Nobody is sent to twice.');
  assert.equal(T('bulk.rows_fix', { count: 1 }), '1 row needs a fix.');
  assert.equal(T('bulk.rows_fix', { count: 2 }), '2 rows need a fix.');
  assert.equal(T('bulk.failed_rows', { count: 1 }), '1 row could not be sent and was saved as a draft in the batch, so nothing is lost:');
  assert.equal(T('bulk.each_get', { count: 1, name: 'Lease' }), 'One person gets their own copy of “Lease” by email, straight away.');
  assert.equal(T('bulk.each_get', { count: 5, name: 'Lease' }), '5 people each get their own copy of “Lease” by email, straight away.');
  assert.equal(T('bulk.cost.short', { count: 3, have: 1, short: 2 }), 'This batch holds 3 signatures and you have 1 ready, so 2 are missing.');
  assert.equal(T('bulk.cost.short', { count: 2, have: 1, short: 1 }), 'This batch holds 2 signatures and you have 1 ready, so 1 is missing.');
  assert.equal(T('stamps.saved_kept', { count: 1 }), 'Saved. The document that already has it keeps the old picture.');
  assert.equal(T('stamps.saved_kept', { count: 4 }), 'Saved. The 4 documents that already have it keep the old picture.');
  assert.equal(T('forms.unlabelled', { count: 1 }), '1 field has no label, so people fill this in on the document. Add labels in the template to ask them as questions.');
  assert.equal(T('settings.ret.older', { count: 1, notice: 14 }), 'One finished document is already older than this. It is in the next email, and is deleted 14 days after it unless someone keeps it.');
  assert.equal(T('settings.roles.people', { count: 2, names: 'Ada, Ben' }), '2 people have it: Ada, Ben.');
  assert.equal(T('contacts.groups.used_by', { count: 1 }), '1 draft or template names this group.');
  assert.equal(T('inbox.waiting', { count: 1 }), '1 is waiting for you.');
  assert.equal(T('public.home.note', { count: 5 }), '5 signatures free, no card needed. They plant trees too.');
  assert.equal(T('settings.org.reach', { agencies: 1, people: 3 }), '1 agency (3 people)');
  // The ink names say what INK_WORD says, so a stamp is named the same on every screen.
  return import('../src/lib/stampink.ts').then(({ INK_WORD }) => {
    for (const [k, v] of Object.entries(INK_WORD)) {
      assert.equal(en[`stamps.ink.${k}`], v);
      assert.equal(en[`stamps.ink_lower.${k}`], v.toLowerCase());
    }
  });
});

test('what a role can do reads the same from the catalogue as from src/lib/perm.ts, which the server checks', async () => {
  const { THING_WORDS } = await import('../src/lib/perm.ts');
  for (const [k, v] of Object.entries(THING_WORDS)) {
    assert.equal(en[`perm.thing.${k}.name`], v.name, k);
    assert.equal(en[`perm.thing.${k}.covers`], v.covers, k);
  }
});

test('the charter\'s words: no "envelope" or "void" in what these screens now say, and no em dash', () => {
  const PREFIX = /^(stamps|templates|bulk|forms|terms|contacts|reports\.(status|sheets|water|per_month|chart_label|month_bar|key_|by_status|title|loading)|inbox|auth|public\.(home|impact)|perm|settings\.(roles|mgroups|ret|org|role)\.)/;
  for (const [k, v] of Object.entries(en).filter(([k]) => PREFIX.test(k))) {
    assert.doesNotMatch(v, /\benvelopes?\b|\bvoid(ed|ing)?\b/i, k);
    assert.doesNotMatch(v, /—/, k);
  }
});

test('the sign-in forms and the public pages follow the visitor\'s browser, never a saved choice, and English with one language', async () => {
  const { senderLocale, senderChoiceShown } = await import('../src/lib/senderlang.ts');
  assert.equal(senderChoiceShown(), false, 'English is the only sender language');
  assert.equal(senderLocale({ chosen: undefined, browser: 'fr-FR,fr;q=0.9' }), 'en');
  // The public hook asks with no person; the server pages read the request only once a second language ships.
  assert.match(read('src/components/publicLang.tsx'), /useSenderLang\(null\)/);
  assert.match(read('src/components/requestLang.tsx'), /if \(!senderChoiceShown\(\)\) return SOURCE_LOCALE;/);
  // Shared by the signing page and Settings: the stamp maker speaks the language of the page around it.
  assert.match(read('src/components/stamps/words.tsx'), /const lang = signer !== 'en' \? signer : sender;/);
});

test('english() in tests/words.ts puts the words back where a screen asks for them', async () => {
  const { english } = await import('./words.ts');
  assert.equal(english("<h2>{T('templates.title')}</h2>"), '<h2>Templates</h2>');
  assert.equal(english("<input aria-label={T('templates.search_label')} />"), '<input aria-label="Search templates" />');
  assert.equal(english("aria-label={T('templates.use_label', { name })}"), 'aria-label={`Use ${name}`}');
  assert.equal(english("toast(T('templates.moved_to', { folder: name.trim() }));"), 'toast(`Moved to ${name.trim()}.`);');
  assert.equal(english("<p>{T('stamps.how_max', { max: Number(max) })}</p>"), '<p>Your team can keep up to {Number(max)}.</p>');
  assert.equal(english("T('no.such.key')"), "T('no.such.key')", 'a key that is not there stays as written');
});

// ---- Repair pass (tests/out/verify-ds-lang-sender-rest, tests/out/ux-ds-lang-sender-rest) ----------------------------

test('the files still to do are each named in README "What is not in it" and each still holds English', () => {
  const readme = read('README.md');
  const notIn = readme.slice(readme.indexOf('## What is not in it'));
  assert.ok(notIn.length > 1000, 'README has its "What is not in it" section');
  for (const [f, name] of LEFT) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is still there`);
    assert.ok(notIn.includes(name), `${f} is named in README "What is not in it" (as ${name})`);
    assert.ok(untranslated(read(f)).length > 0, `${f} has no English left: move it to DONE and out of README "What is not in it"`);
    assert.ok(!DONE.includes(f), f);
  }
  // README says what is done exactly: the top of /impact, not its working.
  assert.match(readme, /the top of `\/impact`/);
});

test('no file of the batch in src/components/settings is forgotten: each is DONE or LEFT', () => {
  const named = new Set([...DONE, ...LEFT.map(([f]) => f)]);
  for (const name of fs.readdirSync(path.join(root, 'src/components/settings')).filter((n) => n.endsWith('.tsx'))) {
    const f = `src/components/settings/${name}`;
    if (untranslated(read(f)).length === 0) continue; // nothing written in English (a helper, or done)
    assert.ok(named.has(f), `${f} shows English and is in neither DONE nor LEFT: convert it, or list it in LEFT and in README`);
  }
});

test('the group rule on Contacts reads the same from the catalogue as from src/lib/policy.ts, which the helper and /help say', async () => {
  const { GROUP_RULE } = await import('../src/lib/policy.ts');
  assert.equal(en['contacts.groups.rule'], GROUP_RULE);
  assert.match(read('src/components/sender/SigningGroups.tsx'), /\{T\('contacts\.groups\.rule'\)\}/);
  assert.ok(senderT('en-XA', 'contacts.groups.rule').startsWith('['));
});

test('the switches, the monthly line and the ready-made list read as before in English, and follow the screen\'s language', () => {
  assert.equal(senderT('en', 'settings.switches.mark_hint', { words: 'NOT COMPLETED YET' }),
    'Written large across every page of a copy downloaded before everyone has signed, with "Not everyone has signed" under it. Empty goes back to NOT COMPLETED YET.');
  assert.equal(senderT('en', 'settings.switches.stamps'), 'Members may place stamps');
  assert.equal(senderT('en', 'reports.monthly.not_saved'), 'That did not save. Try again.');
  // The ready-made list asks in the language AppShell decided, never English by force.
  const starters = read('src/components/templates/Starters.tsx');
  assert.match(starters, /import \{ senderT as t \} from '@\/lib\/senderlang';/);
  assert.equal((starters.match(/const ui = useSenderLangHere\(\);/g) || []).length, 4, 'every component of the list asks for the language');
  assert.doesNotMatch(starters, /SOURCE_LOCALE/);
});

test('a key built from a value is one of a bounded set, so a typo or an odd URL value never leaves a blank label', () => {
  // Every T(`prefix.${x}`) in a finished file: the prefix has keys in en.json, and the file guards the value with a
  // fixed list (tests above hold those lists equal) or a check such as isSamlWhy before it asks.
  const GUARDED: Record<string, RegExp> = {
    'saml.why.': /isSamlWhy\(q\.get\('sso_why'\)\) \? say\(`saml\.why\.\$\{q\.get\('sso_why'\)\}`\)/,
  };
  for (const f of DONE) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:T|say|t)\(\s*(?:ui,\s*)?`([a-z0-9_.]+)\$\{/g)) {
      const prefix = m[1];
      assert.ok(Object.keys(en).some((k) => k.startsWith(prefix)), `${f}: no key starts with ${prefix}`);
      if (GUARDED[prefix]) assert.match(src, GUARDED[prefix], `${f}: ${prefix} is asked for only after the value is checked`);
    }
  }
});

test('the long test language breaks its extra length into words, so a phone screenshot tests the layout, not the padding', async () => {
  const { pseudoMessage } = await import('../src/lib/signlang.ts');
  const long = pseudoMessage(en['contacts.groups.rule'], 'en-XA');
  assert.ok(long.length >= en['contacts.groups.rule'].length * 1.4, 'still 40 percent longer');
  assert.ok(Math.max(...long.split(/\s+/).map((w) => w.length)) <= 20, 'no run longer than a long word');
  assert.match(pseudoMessage('Hand this device to {name} now.', 'en-XA'), / ~+\]$/, 'a short text keeps one run');
});

test('Reports says UTC by its name, not "world time"', () => {
  assert.doesNotMatch(en['reports.counted'], /world time/);
  assert.match(en['reports.counted'], /\bUTC\b/);
});
