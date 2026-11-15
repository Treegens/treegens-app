/**
 * The static pages behind the short links (jimicohen.com/meet and /pod, see shared/shortLinks.ts).
 *
 * `npm run build` writes <outDir>/../<name>/index.html for every short link: the app's own built shell
 * with that link's title, description, link preview tags, icons and boot colours filled in. Crawlers
 * (LinkedIn, Slack, iMessage) do not run scripts, so the preview has to be in the file. Nothing in <body>
 * changes and no script is added, so jimicohen.com's CSP allows the page exactly as it allows /meeting/.
 *
 * The build fails when the shell lacks a tag this replaces, so a changed index.html can never ship pages
 * without their previews.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { PUBLIC_ORIGIN, SHORT_LINKS, SHORT_LINK_NAMES, type ShortName } from '../shared/shortLinks';

export interface ShortHead {
  /** the <title>, escaped */
  title: string;
  /** escaped, ready to insert */
  description: string;
  colorScheme: string;
  icon: string;
  /** every other tag, ready to insert before </head> */
  tags: string[];
}

/** Control characters out, whitespace collapsed, clipped by characters, then escaped for HTML. */
export function headText(value: string, max = 300): string {
  const line = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(line)
    .slice(0, max)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const meta = (attr: 'name' | 'property', key: string, content: string, max = 300): string => `<meta ${attr}="${key}" content="${headText(content, max)}">`;

/** Everything the head of one short page says. Pure. */
export function shortHead(name: ShortName, origin: string = PUBLIC_ORIGIN): ShortHead {
  const spec = SHORT_LINKS[name];
  const at = (p: string): string => `${origin}${p}`;
  const tags = [
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', spec.siteName),
    meta('property', 'og:title', spec.title),
    meta('property', 'og:description', spec.description, 200),
    meta('property', 'og:url', at(`/${name}`)),
    meta('property', 'og:image', at(spec.image.path)),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', String(spec.image.width)),
    meta('property', 'og:image:height', String(spec.image.height)),
    meta('property', 'og:image:alt', spec.image.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', spec.title),
    meta('name', 'twitter:description', spec.description, 200),
    meta('name', 'twitter:image', at(spec.image.path)),
    meta('name', 'twitter:image:alt', spec.image.alt),
  ];
  if (spec.icons.png32) tags.push(`<link rel="icon" href="${headText(spec.icons.png32)}" sizes="32x32" type="image/png">`);
  if (spec.icons.touch) tags.push(`<link rel="apple-touch-icon" href="${headText(spec.icons.touch)}">`);
  tags.push(meta('name', 'theme-color', spec.boot.bg));
  // Read by src/main.tsx before React starts, so the first paint is already in this link's look.
  if (spec.brandId) tags.push(meta('name', 'meeting-boot-brand', spec.brandId));
  tags.push(meta('name', 'meeting-boot-bg', spec.boot.bg), meta('name', 'meeting-boot-scheme', spec.boot.scheme));
  return {
    title: headText(spec.title, 120),
    description: headText(spec.description, 200),
    colorScheme: spec.boot.scheme,
    icon: headText(spec.icons.svg),
    tags,
  };
}

const REPLACED: { what: string; pattern: RegExp; make: (h: ShortHead) => string }[] = [
  { what: '<title>', pattern: /<title>[^<]*<\/title>/g, make: (h) => `<title>${h.title}</title>` },
  { what: 'the description meta tag', pattern: /<meta\s+name="description"[^>]*>/g, make: (h) => `<meta name="description" content="${h.description}">` },
  { what: 'the icon link', pattern: /<link\s+rel="icon"[^>]*>/g, make: (h) => `<link rel="icon" href="${h.icon}" type="image/svg+xml">` },
  { what: 'the color-scheme meta tag', pattern: /<meta\s+name="color-scheme"[^>]*>/g, make: (h) => `<meta name="color-scheme" content="${h.colorScheme}">` },
];

/** The shell with the short page's head. Pure. Throws when the shell lacks one of the tags it replaces. */
export function injectHead(shell: string, head: ShortHead): string {
  let html = shell;
  for (const r of REPLACED) {
    const found = html.match(r.pattern) ?? [];
    if (found.length !== 1) throw new Error(`short pages: the app shell has ${found.length === 0 ? 'no' : 'more than one'} ${r.what}`);
    html = html.replace(r.pattern, r.make(head));
  }
  const end = html.indexOf('</head>');
  if (end === -1 || html.indexOf('</head>', end + 1) !== -1) throw new Error('short pages: the app shell needs exactly one </head>');
  return `${html.slice(0, end).replace(/\s*$/, '')}\n    ${head.tags.join('\n    ')}\n  ${html.slice(end)}`;
}

/** Writes <outDir>/../<name>/index.html for every short link from the built <outDir>/index.html. */
export async function writeShortPages(outDir: string): Promise<string[]> {
  const shell = await readFile(path.join(outDir, 'index.html'), 'utf8');
  const written: string[] = [];
  for (const name of SHORT_LINK_NAMES) {
    const dir = path.resolve(outDir, '..', name);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'index.html');
    await writeFile(file, injectHead(shell, shortHead(name)), 'utf8');
    written.push(file);
  }
  return written;
}

/** The Vite plugin: after the bundle is written, the short pages are written next to it. */
export function shortPagesPlugin(): Plugin {
  return {
    name: 'meeting-short-pages',
    apply: 'build',
    async writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) throw new Error('short pages: the build has no output folder');
      await writeShortPages(outDir);
    },
  };
}
