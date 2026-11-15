import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS } from '../../shared/defaults';
import { PUBLIC_ORIGIN, SHORT_LINKS, SHORT_LINK_NAMES, isShortName, shortLabelOf, shortLinkTarget, shortNameFor, shortNameOfPath, shortUrlOf } from '../../shared/shortLinks';

const ROOT = path.resolve(__dirname, '../..');

describe('short link names', () => {
  it('finds the name in a root path, and nothing else', () => {
    expect(shortNameOfPath('/pod')).toBe('pod');
    expect(shortNameOfPath('/pod/')).toBe('pod');
    expect(shortNameOfPath('/pod/x')).toBe('pod');
    expect(shortNameOfPath('/pod/booking/abc')).toBe('pod');
    expect(shortNameOfPath('/meet')).toBe('meet');
    expect(shortNameOfPath('/meeting/pod')).toBeNull();
    expect(shortNameOfPath('/pods')).toBeNull();
    expect(shortNameOfPath('/POD')).toBeNull();
    expect(shortNameOfPath('/Meet')).toBeNull();
    expect(shortNameOfPath('/')).toBeNull();
    expect(shortNameOfPath('/meeting')).toBeNull();
    expect(shortNameOfPath('/meeting/')).toBeNull();
    expect(isShortName('pod')).toBe(true);
    expect(isShortName('meeting')).toBe(false);
    expect(isShortName(undefined)).toBe(false);
  });

  it('builds the short address from the origin of the public base address', () => {
    expect(shortUrlOf('https://jimicohen.com/meeting', 'pod')).toBe('https://jimicohen.com/pod');
    expect(shortUrlOf('http://localhost:8800/meeting', 'meet')).toBe('http://localhost:8800/meet');
    expect(shortLabelOf('https://jimicohen.com/meeting', 'pod')).toBe('jimicohen.com/pod');
    expect(shortLabelOf('http://localhost:8800/meeting', 'meet')).toBe('localhost:8800/meet');
  });

  it('reads what a link opens from the site settings: missing, turned off, or an event', () => {
    expect(shortLinkTarget({}, 'pod')).toBeNull();
    expect(shortLinkTarget({ shortLinks: { pod: null } }, 'pod')).toBeNull();
    expect(shortLinkTarget({ shortLinks: { pod: 'evt_eco_champions' } }, 'pod')).toBe('evt_eco_champions');
    expect(shortNameFor({ shortLinks: { meet: 'evt_meeting', pod: 'evt_eco_champions' } }, 'evt_eco_champions')).toBe('pod');
    expect(shortNameFor({ shortLinks: { meet: 'evt_meeting' } }, 'evt_intro')).toBeNull();
  });

  it('every name follows the rule, is not the app path, and is a reserved slug', () => {
    for (const name of SHORT_LINK_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9-]{1,30}$/);
      expect(name).not.toBe('meeting');
      expect(RESERVED_SLUGS).toContain(name);
    }
    // The static folders under /meeting are reserved too.
    expect(RESERVED_SLUGS).toEqual(expect.arrayContaining(['brand', 'og']));
    expect(Object.keys(SHORT_LINKS).sort()).toEqual([...SHORT_LINK_NAMES].sort());
  });

  it('points previews at the production origin named in the README', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const row = readme.split('\n').find((line) => line.startsWith('| `PUBLIC_BASE_URL`'));
    const url = /`(https:\/\/[^`]+)`/.exec(row ?? '')?.[1];
    expect(url).toBeDefined();
    expect(new URL(url!).origin).toBe(PUBLIC_ORIGIN);
  });

  it('writes previews people can read: short descriptions without dashes as punctuation', () => {
    for (const name of SHORT_LINK_NAMES) {
      const spec = SHORT_LINKS[name];
      expect(spec.description.length).toBeLessThanOrEqual(200);
      for (const text of [spec.title, spec.description, spec.image.alt, spec.siteName]) expect(text).not.toMatch(/[\u2013\u2014]/);
      expect(spec.image).toMatchObject({ width: 1200, height: 630 });
      expect(spec.image.path).toMatch(/^\/meeting\/.+\.png$/);
    }
    expect(SHORT_LINKS.pod.brandId).toBe('brand_eco_champions');
    expect(SHORT_LINKS.meet.brandId).toBeNull();
  });
});

// ───────────────────────── netlify.toml ─────────────────────────

interface Block {
  kind: 'redirects' | 'headers';
  fields: Record<string, string>;
  values: Record<string, string>;
}

/** The [[redirects]] and [[headers]] blocks, read the way scripts/dev-server.ts reads them. */
function netlifyBlocks(): Block[] {
  const toml = readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const blocks: Block[] = [];
  let current: Block | null = null;
  let inValues = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inValues = false;
      if (line === '[[redirects]]' || line === '[[headers]]') {
        current = { kind: line === '[[redirects]]' ? 'redirects' : 'headers', fields: {}, values: {} };
        blocks.push(current);
      } else if (line === '[headers.values]' && current) inValues = true;
      else current = null;
      continue;
    }
    if (!current) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\d+))\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const value = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, '$1') : m[3];
    if (inValues) current.values[m[1]] = value;
    else current.fields[m[1]] = value;
  }
  return blocks;
}

function directives(csp: string): string[] {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .sort();
}

describe('netlify.toml for the short pages', () => {
  const blocks = netlifyBlocks();
  const meeting = blocks.find((b) => b.kind === 'headers' && b.fields.for === '/meeting/*');

  it('serves every short page, and anything below it, from its static file', () => {
    for (const name of SHORT_LINK_NAMES) {
      const redirect = blocks.find((b) => b.kind === 'redirects' && b.fields.from === `/${name}/*`);
      expect(redirect, `redirect for /${name}/*`).toBeDefined();
      expect(redirect!.fields).toMatchObject({ to: `/${name}/index.html`, status: '200' });
      // Not forced: the page itself is served as the file.
      expect(redirect!.fields.force).toBeUndefined();
    }
  });

  it('forbids framing every short page, with the /meeting/* policy otherwise', () => {
    expect(meeting).toBeDefined();
    const base = directives(meeting!.values['Content-Security-Policy']);
    expect(base.some((d) => d.startsWith('frame-ancestors'))).toBe(false);
    for (const name of SHORT_LINK_NAMES) {
      const block = blocks.find((b) => b.kind === 'headers' && b.fields.for === `/${name}/*`);
      expect(block, `headers for /${name}/*`).toBeDefined();
      expect(directives(block!.values['Content-Security-Policy'])).toEqual([...base, "frame-ancestors 'none'"].sort());
      expect(block!.values['X-Frame-Options']).toBe('DENY');
      expect(block!.values['Cross-Origin-Opener-Policy']).toBe('same-origin');
      expect(block!.values['Cache-Control']).toBe('public, max-age=0, must-revalidate');
      expect(block!.values['Permissions-Policy']).toBe(meeting!.values['Permissions-Policy']);
    }
  });
});
