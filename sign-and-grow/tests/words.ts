// A screen's source with its words put back in English (research/docusign-gaps.json, batch "lang-sender-rest").
// Once a screen asks the catalogue for its words (T('stamps.adjust'), say('...'), senderT(lang, '...')), an older
// test that looks for a sentence in the source finds a key instead. english(src) writes the English text of each key
// back where the key is asked for, so such a test keeps checking the words a person reads:
//   <summary>{T('stamps.adjust')}</summary>        becomes   <summary>Adjust the look</summary>
//   setError(T('stamps.need_name'))                becomes   setError('Give the stamp a name, ...')
// Placeholders stay as they are ({name}), so a test of a sentence with a value in it matches up to the value.
// Quotes in a text are written as the JSX source wrote them (&ldquo; and &rdquo; for “ and ”) inside JSX text.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const en: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, 'src/locales/en.json'), 'utf8'));

const CALL = String.raw`\b(?:T|say|T\.say|senderT\([^,()]+,\s*|t\([^,()]+,\s*|signT\([^,()]+,\s*)`;
const entities = (s: string) => s.replace(/“/g, '&ldquo;').replace(/”/g, '&rdquo;').replace(/’/g, '&rsquo;');

/** { name, count: rows.length } as [["name", "name"], ["count", "rows.length"]]. */
function varsOf(obj: string | undefined): [string, string][] {
  if (!obj) return [];
  const inner = obj.trim().replace(/^\{|\}$/g, '');
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of inner) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) (parts.push(cur), (cur = ''));
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf(':');
    return i < 0 ? [x, x] : [x.slice(0, i).trim(), x.slice(i + 1).trim()];
  });
}
const fill = (text: string, vars: [string, string][], wrap: (expr: string) => string) =>
  vars.reduce((t, [k, expr]) => t.split(`{${k}}`).join(wrap(expr)), text);

export function english(src: string): string {
  const KEY = String.raw`'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'`;
  const VARS = String.raw`(?:,\s*(\{[^{}]*\}))?`;
  // aria-label={T('key')} as an attribute: aria-label="words", or aria-label={`words ${name}`} with values.
  let out = src.replace(new RegExp(String.raw`([A-Za-z][\w-]*)=\{${CALL}\(?${KEY}${VARS}\)\}`, 'g'), (m, attr, k, obj) => {
    if (!Object.hasOwn(en, k)) return m;
    const vars = varsOf(obj);
    return vars.length ? `${attr}={\`${fill(en[k], vars, (e) => `\${${e}}`)}\`}` : `${attr}="${en[k]}"`;
  });
  // {T('key')} or {T('key', { ... })} as JSX text: the words themselves, with {value} where a value goes.
  out = out.replace(new RegExp(String.raw`\{${CALL}\(?${KEY}${VARS}\)\}`, 'g'), (m, k, obj) => (Object.hasOwn(en, k) ? fill(entities(en[k]), varsOf(obj), (e) => `{${e}}`) : m));
  // T('key') anywhere else (a toast, a ternary): the words in quotes, or a template string with values.
  out = out.replace(new RegExp(String.raw`${CALL}\(?${KEY}${VARS}\)`, 'g'), (m, k, obj) => {
    if (!Object.hasOwn(en, k)) return m;
    const vars = varsOf(obj);
    return vars.length ? `\`${fill(en[k], vars, (e) => `\${${e}}`)}\`` : `'${en[k].replace(/'/g, "\\'")}'`;
  });
  return out;
}

// The screens moved into the catalogue by lang-sender-rest. Only these are read with their English put back: other
// screens asked the catalogue for their words before, and their own tests look for those calls as written.
export const CONVERTED = new Set([
  'src/components/stamps/StampDialog.tsx', 'src/components/stamps/StampMaker.tsx', 'src/components/stamps/StampSettings.tsx',
  'src/components/settings/Profiles.tsx', 'src/components/settings/RetentionSettings.tsx', 'src/components/settings/Organisation.tsx',
  'src/components/settings/AgreementPlan.tsx', 'src/components/settings/AiSettings.tsx', 'src/components/settings/BroughtInLink.tsx',
  'src/components/settings/ChannelsStatus.tsx', 'src/components/settings/CounterSettings.tsx', 'src/components/settings/Delegate.tsx',
  'src/components/settings/Disclosure.tsx', 'src/components/settings/ExportImport.tsx', 'src/components/settings/Frame.tsx',
  'src/components/settings/KeyDatesSetting.tsx', 'src/components/settings/OwnDocsDefault.tsx', 'src/components/settings/SealStatus.tsx',
  'src/components/settings/SecurityPolicy.tsx', 'src/components/settings/SendingDefaults.tsx', 'src/components/settings/Shares.tsx',
  'src/components/settings/TenantSwitches.tsx', 'src/components/settings/TreesOnRecord.tsx',
  'src/app/app/templates/page.tsx', 'src/app/app/bulk/page.tsx', 'src/app/app/bulk/BatchCost.tsx', 'src/app/app/powerforms/page.tsx',
  'src/app/app/agreements/page.tsx', 'src/app/app/contacts/page.tsx', 'src/app/app/reports/page.tsx', 'src/app/app/inbox/page.tsx',
  'src/components/AuthForm.tsx', 'src/app/page.tsx', 'src/app/impact/page.tsx', 'src/components/sender/SigningGroups.tsx',
]);

/** `src` as read from `f`, with its English put back when `f` is one of the CONVERTED screens. */
export const englishIf = (f: string, src: string): string => (CONVERTED.has(f.replace(/^\.\.?\//, '')) ? english(src) : src);

/** A file of the app read with its words in English (see above). */
export const readEnglish = (f: string): string => englishIf(f, fs.readFileSync(path.join(root, f), 'utf8'));
