import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '../../shared/defaults';
import { FONT_CATALOG, THEME_PRESETS, applyPreset, fontByKey } from '../../shared/presets';
import {
  contrastRatio,
  deriveDarkColors,
  ensureContrast,
  googleFontsHref,
  googleFontsHrefFor,
  isDark,
  mix,
  normalizeHex,
  readableOn,
  resolveTheme,
  sanitizeCustomCss,
  scopeCss,
  themeDataAttrs,
  themeToCssVars,
} from '../../shared/theme';
import type { Theme, ThemeColors } from '../../shared/types';

const AA = 4.5;

function stops(theme: Theme, c: ThemeColors, dark: boolean): string[] {
  const type = theme.background.type;
  if (dark || type === 'solid' || type === 'image') return [c.background];
  return [c.background, theme.background.gradientFrom ?? c.background, theme.background.gradientTo ?? c.background];
}

describe('font catalog', () => {
  it('has unique keys, a stack for every entry and a healthy number of Google families', () => {
    const keys = FONT_CATALOG.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(FONT_CATALOG.filter((f) => f.google).length).toBeGreaterThanOrEqual(18);
    expect(FONT_CATALOG.some((f) => f.category === 'system' && f.google === null)).toBe(true);
    for (const f of FONT_CATALOG) {
      expect(f.stack.length).toBeGreaterThan(8);
      if (f.google) expect(f.google).not.toMatch(/\s/);
    }
  });

  it('falls back to Inter for unknown keys', () => {
    expect(fontByKey('nope').key).toBe('inter');
    expect(fontByKey('fraunces').label).toBe('Fraunces');
  });
});

describe('theme presets', () => {
  it('offers at least ten presets with unique keys, and forest is the default theme', () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(10);
    const keys = THEME_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(THEME_PRESETS.find((p) => p.key === 'forest')?.theme).toEqual(DEFAULT_THEME);
    for (const required of ['forest', 'daylight', 'midnight', 'paper', 'ocean', 'sunset', 'mono', 'contrast', 'pastel', 'brutalist']) {
      expect(keys).toContain(required);
    }
  });

  for (const preset of THEME_PRESETS) {
    const palettes: { name: string; colors: ThemeColors; dark: boolean }[] = [{ name: 'light palette', colors: preset.theme.colors, dark: false }];
    if (preset.theme.darkColors) palettes.push({ name: 'dark palette', colors: preset.theme.darkColors, dark: true });

    it(`${preset.key}: is a complete theme using catalog fonts`, () => {
      const t = preset.theme;
      expect(t.preset).toBe(preset.key);
      expect(Object.keys(t).sort()).toEqual(Object.keys(DEFAULT_THEME).sort());
      expect(FONT_CATALOG.some((f) => f.key === t.fontHeading)).toBe(true);
      expect(FONT_CATALOG.some((f) => f.key === t.fontBody)).toBe(true);
      if (t.scheme === 'auto') expect(t.darkColors).toBeTruthy();
    });

    for (const p of palettes) {
      it(`${preset.key} (${p.name}): body text passes WCAG AA everywhere it can sit`, () => {
        const c = p.colors;
        expect(contrastRatio(c.text, c.surface)).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(c.muted, c.surface)).toBeGreaterThanOrEqual(AA);
        for (const bg of stops(preset.theme, c, p.dark)) {
          expect(contrastRatio(c.text, bg)).toBeGreaterThanOrEqual(AA);
        }
        const vars = themeToCssVars(preset.theme, null, p.dark);
        for (const bg of stops(preset.theme, c, p.dark)) {
          expect(contrastRatio(vars['--m-text-on-bg'], bg)).toBeGreaterThanOrEqual(AA);
          expect(contrastRatio(vars['--m-muted-on-bg'], bg)).toBeGreaterThanOrEqual(AA);
        }
        expect(contrastRatio(vars['--m-on-primary'], vars['--m-primary'])).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(vars['--m-primary-text'], c.surface)).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(vars['--m-danger-text'], c.surface)).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(vars['--m-success-text'], c.surface)).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(vars['--m-on-danger'], vars['--m-danger'])).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(vars['--m-focus'], c.surface)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(vars['--m-focus'], c.background)).toBeGreaterThanOrEqual(3);
        if (preset.theme.buttonStyle === 'solid') {
          expect(contrastRatio(vars['--m-btn-fg'], vars['--m-btn-bg'])).toBeGreaterThanOrEqual(AA);
        }
        if (preset.theme.buttonStyle === 'soft') {
          expect(contrastRatio(vars['--m-btn-fg'], vars['--m-btn-bg'])).toBeGreaterThanOrEqual(AA);
          expect(contrastRatio(vars['--m-btn-fg'], vars['--m-btn-bg-hover'])).toBeGreaterThanOrEqual(AA);
        }
        if (preset.theme.buttonStyle === 'outline') {
          expect(contrastRatio(vars['--m-btn-fg'], c.surface)).toBeGreaterThanOrEqual(AA);
        }
        if (preset.theme.buttonStyle === 'gradient') {
          const g2 = mix(c.primary, c.accent, 0.62);
          expect(contrastRatio(vars['--m-btn-fg'], c.primary)).toBeGreaterThanOrEqual(AA);
          expect(contrastRatio(vars['--m-btn-fg'], g2)).toBeGreaterThanOrEqual(AA);
        }
      });
    }
  }

  it('applyPreset keeps content the owner wrote', () => {
    const current: Theme = {
      ...structuredClone(DEFAULT_THEME),
      customCss: '.x{color:red}',
      logoAssetId: 'asset_logo',
      coverAssetId: 'asset_cover',
      coverHeight: 180,
      hideBranding: true,
      texts: { ...DEFAULT_THEME.texts, ctaLabel: 'Lock it in' },
    };
    const next = applyPreset(current, 'paper');
    expect(next.preset).toBe('paper');
    expect(next.colors.background).toBe('#f3ecdf');
    expect(next.customCss).toBe('.x{color:red}');
    expect(next.logoAssetId).toBe('asset_logo');
    expect(next.coverHeight).toBe(180);
    expect(next.hideBranding).toBe(true);
    expect(next.texts.ctaLabel).toBe('Lock it in');
    expect(applyPreset(current, 'missing')).toBe(current);
  });
});

describe('colour helpers', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });

  it('picks readable text for any background', () => {
    expect(readableOn('#1c7449')).toBe('#ffffff');
    expect(isDark(readableOn('#5ede8e'))).toBe(true);
    expect(isDark(readableOn('#ffe600'))).toBe(true);
    for (const bg of ['#5ede8e', '#2450e0', '#ff5a1f', '#d8b36a', '#808080', '#ffffff', '#000000', '#c2371f']) {
      expect(contrastRatio(readableOn(bg), bg)).toBeGreaterThanOrEqual(AA);
    }
  });

  it('ensureContrast only changes colours that fail', () => {
    expect(ensureContrast('#111111', '#ffffff')).toBe('#111111');
    const fixed = ensureContrast('#9bd4b0', '#ffffff');
    expect(fixed).not.toBe('#9bd4b0');
    expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(AA);
    const both = ensureContrast('#777777', ['#101010', '#222222']);
    expect(contrastRatio(both, '#222222')).toBeGreaterThanOrEqual(AA);
  });

  it('normalizes hex input', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('5EDE8E')).toBe('#5ede8e');
    expect(normalizeHex('red', '#123456')).toBe('#123456');
  });

  it('derives a dark palette that stays readable', () => {
    const d = deriveDarkColors(THEME_PRESETS.find((p) => p.key === 'paper')!.theme.colors);
    expect(isDark(d.background)).toBe(true);
    expect(contrastRatio(d.text, d.surface)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(d.muted, d.surface)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(d.primary, d.surface)).toBeGreaterThanOrEqual(AA);
  });
});

describe('resolveTheme', () => {
  it('merges overrides field by field and applies the event colour', () => {
    const t = resolveTheme(DEFAULT_THEME, { radius: 4, colors: { accent: '#ff0000' } as ThemeColors, texts: { ctaLabel: 'Go' } as Theme['texts'] }, '#3366FF');
    expect(t.radius).toBe(4);
    expect(t.colors.accent).toBe('#ff0000');
    expect(t.colors.primary).toBe('#3366ff');
    expect(t.colors.background).toBe(DEFAULT_THEME.colors.background);
    expect(t.texts.ctaLabel).toBe('Go');
    expect(t.texts.pickTimeLabel).toBe(DEFAULT_THEME.texts.pickTimeLabel);
    expect(DEFAULT_THEME.colors.primary).toBe('#5ede8e');
  });

  it('ignores undefined override values and bad colours, and fills gaps from the default theme', () => {
    const partial = { ...structuredClone(DEFAULT_THEME) } as Partial<Theme>;
    delete partial.slotStyle;
    const t = resolveTheme(partial as Theme, { radius: undefined, layout: 'stacked' }, 'not-a-colour');
    expect(t.radius).toBe(DEFAULT_THEME.radius);
    expect(t.layout).toBe('stacked');
    expect(t.slotStyle).toBe(DEFAULT_THEME.slotStyle);
    expect(t.colors.primary).toBe(DEFAULT_THEME.colors.primary);
  });
});

describe('themeToCssVars', () => {
  it('gives every theme option a visible effect', () => {
    const base = themeToCssVars(DEFAULT_THEME, null);
    const changed = (patch: Partial<Theme>) => {
      const next = themeToCssVars({ ...DEFAULT_THEME, ...patch }, null);
      const attrs = themeDataAttrs({ ...DEFAULT_THEME, ...patch });
      const baseAttrs = themeDataAttrs(DEFAULT_THEME);
      return Object.keys(next).some((k) => next[k] !== base[k]) || Object.keys(attrs).some((k) => attrs[k] !== baseAttrs[k]);
    };
    expect(changed({ radius: 4 })).toBe(true);
    expect(changed({ shadow: 0 })).toBe(true);
    expect(changed({ buttonStyle: 'outline' })).toBe(true);
    expect(changed({ buttonStyle: 'soft' })).toBe(true);
    expect(changed({ buttonStyle: 'gradient' })).toBe(true);
    expect(changed({ buttonShape: 'square' })).toBe(true);
    expect(changed({ cardStyle: 'flat' })).toBe(true);
    expect(changed({ cardStyle: 'bordered' })).toBe(true);
    expect(changed({ cardStyle: 'elevated' })).toBe(true);
    expect(changed({ density: 'compact' })).toBe(true);
    expect(changed({ fontHeading: 'inter' })).toBe(true);
    expect(changed({ fontBody: 'lora' })).toBe(true);
    expect(changed({ fontScale: 1.1 })).toBe(true);
    expect(changed({ avatarShape: 'square' })).toBe(true);
    expect(changed({ animations: 'none' })).toBe(true);
    expect(changed({ layout: 'centered' })).toBe(true);
    expect(changed({ calendarStyle: 'grid' })).toBe(true);
    expect(changed({ slotStyle: 'chips' })).toBe(true);
    expect(changed({ colors: { ...DEFAULT_THEME.colors, border: '#ffffff' } })).toBe(true);
    for (const type of ['solid', 'gradient', 'pattern'] as const) {
      expect(changed({ background: { ...DEFAULT_THEME.background, type, pattern: 'dots' } })).toBe(true);
    }
  });

  it('builds background layers with matching list lengths', () => {
    for (const pattern of ['dots', 'grid', 'topo', 'leaves', 'waves'] as const) {
      const vars = themeToCssVars(
        { ...DEFAULT_THEME, background: { type: 'pattern', pattern, gradientFrom: '#0b1d14', gradientTo: '#143524', gradientAngle: 90 } },
        null,
      );
      const count = (v: string) => v.split(/,(?![^(]*\))/).length;
      expect(vars['--m-bg-image']).not.toBe('none');
      expect(vars['--m-bg-image']).not.toMatch(/https?:/);
      expect(count(vars['--m-bg-size'])).toBe(count(vars['--m-bg-position']));
      expect(count(vars['--m-bg-size'])).toBe(count(vars['--m-bg-repeat']));
    }
  });

  it('uses image assets only when a URL is present, and escapes it', () => {
    const theme: Theme = { ...DEFAULT_THEME, coverHeight: 200, background: { type: 'image', overlayOpacity: 0.5, blur: 8 } };
    const none = themeToCssVars(theme, null);
    expect(none['--m-bg-image']).toBe('none');
    expect(none['--m-cover-image']).toBe('none');
    const withAssets = themeToCssVars(theme, { coverUrl: '/meeting/api/assets/a1', logoUrl: null, backgroundUrl: '/meeting/api/assets/b"2' });
    expect(withAssets['--m-bg-image']).toBe('url("/meeting/api/assets/b%222")');
    expect(withAssets['--m-bg-blur']).toBe('8px');
    expect(withAssets['--m-cover-image']).toBe('url("/meeting/api/assets/a1")');
    expect(withAssets['--m-cover-height']).toBe('200px');
  });

  it('switches to the dark palette only when asked and available', () => {
    const daylight = THEME_PRESETS.find((p) => p.key === 'daylight')!.theme;
    expect(themeToCssVars(daylight, null, false)['--m-bg']).toBe(daylight.colors.background);
    expect(themeToCssVars(daylight, null, true)['--m-bg']).toBe(daylight.darkColors!.background);
    expect(themeDataAttrs(daylight, true)['data-scheme']).toBe('dark');
    expect(themeToCssVars(DEFAULT_THEME, null, true)['--m-bg']).toBe(DEFAULT_THEME.colors.background);
  });

  it('survives junk input', () => {
    const junk = { ...DEFAULT_THEME, radius: Number.NaN, fontHeading: 'missing', colors: { ...DEFAULT_THEME.colors, primary: 'javascript:alert(1)' } } as Theme;
    const vars = themeToCssVars(junk, null);
    expect(vars['--m-primary']).toBe(DEFAULT_THEME.colors.primary);
    expect(vars['--m-radius']).toBe('18px');
    expect(vars['--m-font-heading']).toContain('Inter');
  });
});

describe('fonts href', () => {
  it('builds one stylesheet URL for both fonts and none for system stacks', () => {
    const href = googleFontsHref(DEFAULT_THEME)!;
    expect(href.startsWith('https://fonts.googleapis.com/css2?family=Fraunces')).toBe(true);
    expect(href).toContain('&family=Inter:wght@400..700');
    expect(href.endsWith('&display=swap')).toBe(true);
    expect(googleFontsHref({ ...DEFAULT_THEME, fontHeading: 'system-serif', fontBody: 'system-sans' })).toBeNull();
    expect(googleFontsHrefFor(['inter', 'inter'])!.match(/family=/g)!.length).toBe(1);
  });
});

describe('custom css', () => {
  it('removes anything that could leave the style element or load remote content', () => {
    const dirty = [
      '@import url("https://evil.example/x.css");',
      '.a{color:red}</style><script>alert(1)</script>',
      '.b{background:url(https://evil.example/p.png)}',
      '.c{background:url("//evil.example/p.png")}',
      '.d{background:url(/meeting/api/assets/abc)}',
      '.e{background:url("data:image/png;base64,AAAA")}',
      '.f{width:expression(alert(1));behavior:url(x.htc)}',
      '.g{background:url(javascript:alert(1))}',
    ].join('\n');
    const clean = sanitizeCustomCss(dirty);
    expect(clean).not.toMatch(/<\/?style/i);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/@import/i);
    expect(clean).not.toMatch(/evil\.example/);
    expect(clean).not.toMatch(/expression\(/i);
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).not.toMatch(/behavior/i);
    expect(clean).toContain('url(/meeting/api/assets/abc)');
    expect(clean).toContain('url("data:image/png;base64,AAAA")');
    expect(clean).toContain('.a{color:red}');
    expect(sanitizeCustomCss(undefined)).toBe('');
    expect(sanitizeCustomCss('x'.repeat(30_000)).length).toBeLessThanOrEqual(20_000);
  });

  it('keeps ordinary CSS intact, including child combinators and range queries', () => {
    const css = '.a > .b{color:red}\n@media (width < 600px){.c{display:none}}';
    expect(sanitizeCustomCss(css)).toBe(css);
  });

  it('scopes every selector to the themed wrapper', () => {
    const scoped = scopeCss(
      [
        '/* note */',
        ':root{--m-primary:#f00}',
        'body, .card:hover , h1{margin:0}',
        '.m-scope[data-layout="split"] .x{gap:1px}',
        '@media (max-width:600px){ button{color:red} .a,.b{top:0} }',
        '@keyframes spin{from{opacity:0}to{opacity:1}}',
        '@font-face{font-family:x}',
        '@page{margin:0}',
        '.q::after{content:"}{,"}',
        '} html{display:none}',
        'a:is(.x,.y){color:blue}',
      ].join('\n'),
    );
    expect(scoped).toContain('.m-scope{--m-primary:#f00}');
    expect(scoped).toContain('.m-scope,.m-scope .card:hover,.m-scope h1{margin:0}');
    expect(scoped).toContain('.m-scope[data-layout="split"] .x{gap:1px}');
    expect(scoped).toContain('@media (max-width:600px){.m-scope button{color:red}.m-scope .a,.m-scope .b{top:0}}');
    expect(scoped).toContain('@keyframes spin{from{opacity:0}to{opacity:1}}');
    expect(scoped).toContain('@font-face{font-family:x}');
    expect(scoped).not.toContain('@page');
    expect(scoped).toContain('.m-scope .q::after{content:"}{,"}');
    expect(scoped).toContain('.m-scope{display:none}');
    expect(scoped).toContain('.m-scope a:is(.x,.y){color:blue}');
    expect(scoped).not.toContain('note');
  });
});
