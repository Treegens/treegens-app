// Two of the help chat's sources, read from the files the people who use them read, so the helper cannot drift from
// them (src/server/chatkb.ts builds the system prompt):
//   - the topics of /help: every question with its anchor, read from the help page's own source (src/app/help/*.tsx),
//     exactly as the page writes it;
//   - what is not in the product: README.md "What is not in it", bullet by bullet, made plain.
// Each is read again when its file changes, so an edit to the help page or to README reaches the next question
// without a restart. Where a file is not shipped with the server (a build that copies only .next), that part is left
// out and the model is told so: it then says it does not know and offers a person, instead of reading a copy that
// could be out of date. The server log says it once.
import fs from 'node:fs';
import path from 'node:path';

const root = () => process.cwd();
const said = new Set<string>();
const sayOnce = (k: string, msg: string) => {
  if (said.has(k)) return;
  said.add(k);
  console.warn(msg);
};

// ---- The topics of /help ---------------------------------------------------------------------------------------
export type HelpTopic = { id: string; q: string };
const HELP_DIR = () => path.join(root(), 'src', 'app', 'help');
const entity = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The questions in the help page's source, in the order of the files and of the page. */
export function topicsFromSource(sources: string[]): HelpTopic[] {
  const out: HelpTopic[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    const found: { at: number; id: string; q: string }[] = [];
    for (const m of src.matchAll(/<QA id="([^"]+)" q="([^"]+)"/g)) found.push({ at: m.index, id: m[1], q: m[2] });
    for (const m of src.matchAll(/<article className="pub-qa" id="([^"]+)">\s*<h3>([^<]+)<\/h3>/g)) found.push({ at: m.index, id: m[1], q: m[2] });
    for (const f of found.sort((a, b) => a.at - b.at)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ id: f.id, q: entity(f.q).replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

let topicCache: { sig: string; topics: HelpTopic[] | null } | null = null;
/** The topics of /help as the page has them now, or null when the page's source is not on this server. */
export function helpTopics(): HelpTopic[] | null {
  let files: string[];
  try {
    // The page first, then the parts it is made of, each in name order.
    files = fs.readdirSync(HELP_DIR()).filter((f) => f.endsWith('.tsx')).sort((a, b) => (a === 'page.tsx' ? -1 : b === 'page.tsx' ? 1 : a.localeCompare(b)));
  } catch {
    sayOnce('help', '[chat] The help page\'s source (src/app/help) is not on this server, so the help chat does not know the topics of /help. It points to the help page instead.');
    return null;
  }
  let sig = '';
  try {
    sig = files.map((f) => `${f}:${fs.statSync(path.join(HELP_DIR(), f)).mtimeMs}`).join('|');
  } catch {}
  if (topicCache && topicCache.sig === sig) return topicCache.topics;
  let topics: HelpTopic[] | null = null;
  try {
    topics = topicsFromSource(files.map((f) => fs.readFileSync(path.join(HELP_DIR(), f), 'utf8')));
    if (!topics.length) topics = null;
  } catch {
    topics = null;
  }
  topicCache = { sig, topics };
  return topics;
}

// ---- README "What is not in it" ---------------------------------------------------------------------------------
/** One bullet of a Markdown section, made plain: no bold, no code marks, no links, no notes about files. */
export function plainBullet(md: string): string {
  return md
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\*\*/g, '')
    // "(see "Signing")" and "(`NO_BAA_TEXT` in `src/lib/policy.ts`)" point at this README and the code, not at the product.
    .replace(/\s*\((?:see\s[^()]*|[^()]*`[^()]*)\)/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The bullets of a README's "What is not in it", made plain. */
export function notInItFromReadme(readme: string): string[] {
  const part = readme.split(/\n## What is not in it\s*\n/)[1];
  if (!part) return [];
  const section = part.split(/\n## /)[0];
  const bullets: string[] = [];
  let open = false;
  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) (bullets.push(line.slice(2)), (open = true));
    else if (open && /^\s+\S/.test(line)) bullets[bullets.length - 1] += `\n${line}`;
    else open = false;
  }
  return bullets.map(plainBullet).filter(Boolean);
}

let readmeCache: { sig: string; list: string[] | null } | null = null;
/** What the product does not have, as README says it now, or null when README is not on this server. */
export function notInIt(): string[] | null {
  const file = path.join(root(), 'README.md');
  let sig = '';
  try {
    sig = String(fs.statSync(file).mtimeMs);
  } catch {
    sayOnce('readme', '[chat] README.md is not on this server, so the help chat does not have the list of what the product does not do. It says it does not know and offers a person instead.');
    return null;
  }
  if (readmeCache && readmeCache.sig === sig) return readmeCache.list;
  let list: string[] | null = null;
  try {
    list = notInItFromReadme(fs.readFileSync(file, 'utf8'));
    if (!list.length) list = null;
  } catch {
    list = null;
  }
  readmeCache = { sig, list };
  return list;
}
