import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headText, injectHead, shortHead, shortPagesPlugin } from '../../scripts/shortPages';
import { SHORT_LINKS } from '../../shared/shortLinks';

const ROOT = path.resolve(__dirname, '../..');
const SHELL = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function headOf(html: string): string {
  return html.slice(0, html.indexOf('</head>'));
}
function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body>'));
}
function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}
function metaContent(html: string, attr: 'name' | 'property', key: string): string | null {
  const m = new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`).exec(html);
  return m ? m[1] : null;
}

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the /pod page head', () => {
  const html = injectHead(SHELL, shortHead('pod'));

  it('carries every preview tag, pointing at jimicohen.com', () => {
    expect(count(html, '<title>')).toBe(1);
    expect(html).toContain('<title>Eco Champions conversation</title>');
    const description = SHORT_LINKS.pod.description;
    expect(metaContent(html, 'name', 'description')).toBe(description);
    expect(metaContent(html, 'name', 'color-scheme')).toBe('light');
    expect(metaContent(html, 'property', 'og:type')).toBe('website');
    expect(metaContent(html, 'property', 'og:site_name')).toBe('Eco Champions');
    expect(metaContent(html, 'property', 'og:title')).toBe('Eco Champions conversation');
    expect(metaContent(html, 'property', 'og:description')).toBe(description);
    expect(metaContent(html, 'property', 'og:url')).toBe('https://jimicohen.com/pod');
    expect(metaContent(html, 'property', 'og:image')).toBe('https://jimicohen.com/meeting/brand/eco-champions/og.png');
    expect(metaContent(html, 'property', 'og:image:type')).toBe('image/png');
    expect(metaContent(html, 'property', 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
    expect(metaContent(html, 'property', 'og:image:alt')).toBe('Eco Champions logo with the words Book a conversation');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'name', 'twitter:title')).toBe('Eco Champions conversation');
    expect(metaContent(html, 'name', 'twitter:description')).toBe(description);
    expect(metaContent(html, 'name', 'twitter:image')).toBe('https://jimicohen.com/meeting/brand/eco-champions/og.png');
    expect(metaContent(html, 'name', 'twitter:image:alt')).toBe('Eco Champions logo with the words Book a conversation');
    expect(html).toContain('<link rel="icon" href="/meeting/brand/eco-champions/favicon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="icon" href="/meeting/brand/eco-champions/favicon-32.png" sizes="32x32" type="image/png">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/meeting/brand/eco-champions/apple-touch-icon.png">');
    expect(metaContent(html, 'name', 'theme-color')).toBe('#FAF5E6');
    expect(metaContent(html, 'name', 'meeting-boot-brand')).toBe('brand_eco_champions');
    expect(metaContent(html, 'name', 'meeting-boot-bg')).toBe('#FAF5E6');
    expect(metaContent(html, 'name', 'meeting-boot-scheme')).toBe('light');
  });

  it('replaces the shell tags instead of adding second ones, and leaves the body and the scripts alone', () => {
    expect(html).not.toContain('Book a meeting');
    expect(html).not.toContain('/meeting/favicon.svg');
    expect(html).not.toContain('content="light dark"');
    expect(count(html, 'name="description"')).toBe(1);
    expect(count(html, 'name="color-scheme"')).toBe(1);
    expect(bodyOf(html)).toBe(bodyOf(SHELL));
    expect(count(html, '<script')).toBe(count(SHELL, '<script'));
    // Every tag of the shell that is not replaced is still there, unchanged (the preconnects, the viewport, the module script).
    for (const line of SHELL.split('\n').map((l) => l.trim())) {
      if (!line || /<title>|name="description"|rel="icon"|name="color-scheme"/.test(line)) continue;
      expect(html).toContain(line);
    }
    expect(headOf(html).indexOf('og:title')).toBeGreaterThan(0);
  });

  it('keeps the script and stylesheet tags of a built shell exactly as they are', () => {
    const built = SHELL.replace('</head>', '  <script type="module" crossorigin src="/meeting/assets/index-AbC123.js"></script>\n    <link rel="stylesheet" crossorigin href="/meeting/assets/index-XyZ.css">\n  </head>');
    const out = injectHead(built, shortHead('pod'));
    expect(out).toContain('<script type="module" crossorigin src="/meeting/assets/index-AbC123.js"></script>');
    expect(out).toContain('<link rel="stylesheet" crossorigin href="/meeting/assets/index-XyZ.css">');
  });
});

describe('the /meet page head', () => {
  const html = injectHead(SHELL, shortHead('meet'));

  it("is Jimi's own: his preview card, the forest boot colours and no brand", () => {
    expect(html).toContain('<title>Meet with Jimi</title>');
    expect(metaContent(html, 'property', 'og:site_name')).toBe('Jimi Cohen');
    expect(metaContent(html, 'property', 'og:url')).toBe('https://jimicohen.com/meet');
    expect(metaContent(html, 'property', 'og:image')).toBe('https://jimicohen.com/meeting/og/meet.png');
    expect(metaContent(html, 'name', 'description')).toBe(SHORT_LINKS.meet.description);
    expect(metaContent(html, 'name', 'color-scheme')).toBe('dark');
    expect(metaContent(html, 'name', 'meeting-boot-brand')).toBeNull();
    expect(metaContent(html, 'name', 'meeting-boot-bg')).toBe('#0b1d14');
    expect(html).toContain('<link rel="icon" href="/meeting/favicon.svg" type="image/svg+xml">');
    expect(html).not.toContain('apple-touch-icon');
    expect(html).not.toContain('eco-champions');
  });

  it('the preview pictures exist where the tags point', () => {
    for (const name of ['meet', 'pod'] as const) {
      const file = path.join(ROOT, 'public', SHORT_LINKS[name].image.path.replace(/^\/meeting\//, ''));
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      // IHDR: width and height, big-endian, at bytes 16 and 20.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    }
  });
});

describe('escaping and refusing a shell that changed shape', () => {
  it('escapes every value and keeps it on one line', () => {
    expect(headText(`He said "hi" <b> & it's\nfine`)).toBe('He said &quot;hi&quot; &lt;b&gt; &amp; it&#39;s fine');
    expect(headText('x'.repeat(500), 10)).toBe('x'.repeat(10));
    expect(headText('a\u0000b\u2028c')).toBe('a b c');
  });

  it('throws when the shell lacks a tag it replaces, or has two', () => {
    const head = shortHead('pod');
    for (const pattern of [/<title>[^<]*<\/title>/, /<meta\s+name="description"[^>]*>/, /<link\s+rel="icon"[^>]*>/, /<meta\s+name="color-scheme"[^>]*>/]) {
      const without = SHELL.replace(pattern, '');
      expect(() => injectHead(without, head)).toThrow(/short pages/);
    }
    const twice = SHELL.replace('</head>', '<title>Again</title></head>');
    expect(() => injectHead(twice, head)).toThrow(/more than one <title>/);
    expect(() => injectHead(SHELL.replace('</head>', ''), head)).toThrow(/<\/head>/);
  });
});

describe('the build plugin', () => {
  it('writes a page for every short link next to the app folder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'short-pages-'));
    temps.push(root);
    const outDir = path.join(root, 'meeting');
    await mkdir(outDir);
    await writeFile(path.join(outDir, 'index.html'), SHELL, 'utf8');
    const plugin = shortPagesPlugin();
    expect(plugin.apply).toBe('build');
    await (plugin.writeBundle as (o: { dir: string }) => Promise<void>)({ dir: outDir });
    const pod = await readFile(path.join(root, 'pod', 'index.html'), 'utf8');
    const meet = await readFile(path.join(root, 'meet', 'index.html'), 'utf8');
    expect(pod).toContain('<title>Eco Champions conversation</title>');
    expect(meet).toContain('<title>Meet with Jimi</title>');
    // The app's own page is not touched.
    expect(await readFile(path.join(outDir, 'index.html'), 'utf8')).toBe(SHELL);
  });
});
