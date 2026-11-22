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
    if (t && !ALLOW.test(t) && !/=>|&&|\|\||\)\s*[;,]?$|[?:]\s*\(\s*$|[;=]|\)\s*return\b/.test(m[1]) && !/^\(\w+: /.test(t) && !/^,|:$|\?$/.test(t)) out.push(t);
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
  for (const f of DONE) for (const m of read(f).matchAll(/'((?:settings|imported|owndocs|ai|keydates|stamps|auth|public)\.[a-z0-9_.]+)'/g)) keys.add(m[1]);
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
