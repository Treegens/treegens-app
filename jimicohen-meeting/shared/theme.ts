/**
 * Theme engine shared by the public pages, the admin design editor and the server (emails).
 * Pure functions only: no DOM, no Node APIs.
 *
 * themeToCssVars() turns a Theme into the complete `--m-*` token set the public UI is written
 * against. themeDataAttrs() gives the matching data attributes (layout, calendar style, ...)
 * so CSS can switch structure with attribute selectors.
 */
import { DEFAULT_THEME } from './defaults';
import { fontByKey } from './presets';
import type { Theme, ThemeBackground, ThemeColors } from './types';

export interface ThemeAssets {
  coverUrl: string | null;
  logoUrl: string | null;
  backgroundUrl: string | null;
}

export const NO_ASSETS: ThemeAssets = { coverUrl: null, logoUrl: null, backgroundUrl: null };

// ───────────────────────────── Colour math ─────────────────────────────

type RGB = [number, number, number];

export function parseHex(input: unknown): RGB | null {
  if (typeof input !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function isHex(input: unknown): input is string {
  return parseHex(input) !== null;
}

function toHex(rgb: RGB): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

/** Lowercase `#rrggbb`, or the fallback when the input is not a hex colour. */
export function normalizeHex(input: unknown, fallback = '#000000'): string {
  const rgb = parseHex(input);
  return rgb ? toHex(rgb) : fallback;
}

/** Blend `amount` (0..1) of `b` into `a`. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a) ?? [0, 0, 0];
  const y = parseHex(b) ?? [0, 0, 0];
  const t = Math.max(0, Math.min(1, amount));
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** CSS colour with alpha, e.g. `rgb(94 222 142 / 0.14)`. */
export function alpha(color: string, a: number): string {
  const [r, g, b] = parseHex(color) ?? [0, 0, 0];
  return `rgb(${r} ${g} ${b} / ${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(color: string): number {
  const rgb = parseHex(color) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, 1 .. 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean distance in sRGB, 0 .. 441. Small values mean two colours are hard to tell apart. */
export function colorDistance(a: string, b: string): number {
  const x = parseHex(a) ?? [0, 0, 0];
  const y = parseHex(b) ?? [0, 0, 0];
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
}

/** True when white text reads better on this colour than black text. */
export function isDark(color: string): boolean {
  return luminance(color) < 0.179;
}

/**
 * Text colour for content placed on `bg`. White whenever white passes AA (it is what people
 * expect on saturated brand colours), otherwise a deep ink tinted with the background hue.
 */
export function readableOn(bg: string): string {
  const white = contrastRatio('#ffffff', bg);
  if (white >= 4.5) return '#ffffff';
  const ink = mix(bg, '#000000', 0.88);
  return contrastRatio(ink, bg) >= white ? ink : '#ffffff';
}

/** Nudges `fg` towards black or white until it reaches `min` contrast on every background given. */
export function ensureContrast(fg: string, bg: string | string[], min = 4.5): string {
  const bgs = (Array.isArray(bg) ? bg : [bg]).filter(isHex);
  const color = normalizeHex(fg);
  if (!bgs.length) return color;
  const passes = (c: string) => bgs.every((b) => contrastRatio(c, b) >= min);
  if (passes(color)) return color;
  const avg = bgs.reduce((sum, b) => sum + luminance(b), 0) / bgs.length;
  const pole = avg < 0.179 ? '#ffffff' : '#000000';
  for (let i = 1; i <= 24; i++) {
    const c = mix(color, pole, i / 24);
    if (passes(c)) return c;
  }
  return pole;
}

// ───────────────────────────── Theme resolution ─────────────────────────────

function defined<T extends object>(obj: T | null | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/**
 * Site theme + optional per-event override + optional event colour → the theme to render.
 * Nested groups (colors, background, texts) merge field by field. Missing fields fall back to
 * DEFAULT_THEME, so a theme saved by an older version still renders.
 */
export function resolveTheme(base: Theme, override?: Partial<Theme> | null, eventColor?: string): Theme {
  const b = defined(base);
  const o = defined(override);
  const theme: Theme = {
    ...DEFAULT_THEME,
    ...b,
    ...o,
    colors: { ...DEFAULT_THEME.colors, ...defined(base?.colors), ...defined(override?.colors) },
    background: { ...DEFAULT_THEME.background, ...defined(base?.background), ...defined(override?.background) },
    texts: { ...DEFAULT_THEME.texts, ...defined(base?.texts), ...defined(override?.texts) },
  };
  const darkBase = override && 'darkColors' in o ? override.darkColors : base?.darkColors;
  theme.darkColors = darkBase ? { ...theme.colors, ...defined(darkBase) } : null;
  if (eventColor && isHex(eventColor)) {
    const primary = normalizeHex(eventColor);
    theme.colors = { ...theme.colors, primary };
    if (theme.darkColors) {
      theme.darkColors = { ...theme.darkColors, primary: ensureContrast(primary, theme.darkColors.background, 3) };
    }
  }
  return theme;
}

/** A reasonable dark palette for a light theme. Used by "Generate dark colours" in the editor. */
export function deriveDarkColors(colors: ThemeColors): ThemeColors {
  const background = mix('#0c0e11', colors.primary, 0.05);
  const surface = mix(background, '#ffffff', 0.055);
  return {
    background,
    surface,
    text: mix('#f1f2f4', colors.primary, 0.04),
    muted: mix('#a1a7b0', colors.primary, 0.06),
    border: mix(background, '#ffffff', 0.15),
    primary: ensureContrast(mix(colors.primary, '#ffffff', 0.35), [background, surface], 6),
    accent: ensureContrast(mix(colors.accent, '#ffffff', 0.3), [background, surface], 5),
  };
}

// ───────────────────────────── CSS variables ─────────────────────────────

const MONO_STACK = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.max(lo, Math.min(hi, n));
};

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const rem = (n: number) => `${Math.round(n * 1000) / 1000}rem`;

function cssUrl(url: string): string {
  return `url("${url.replace(/[\\"\n\r\f]/g, (ch) => encodeURIComponent(ch))}")`;
}

function cleanColors(input: ThemeColors | null | undefined): ThemeColors {
  const d = DEFAULT_THEME.colors;
  const c = input ?? d;
  return {
    primary: normalizeHex(c.primary, d.primary),
    accent: normalizeHex(c.accent, d.accent),
    background: normalizeHex(c.background, d.background),
    surface: normalizeHex(c.surface, d.surface),
    text: normalizeHex(c.text, d.text),
    muted: normalizeHex(c.muted, d.muted),
    border: normalizeHex(c.border, d.border),
  };
}

/** Sharp corners plus outlined cards read as "brutalist": shadows become hard offsets instead of blurs. */
function isHardEdged(theme: Theme): boolean {
  return theme.radius === 0 && theme.cardStyle === 'bordered';
}

interface Shadows {
  sm: string;
  md: string;
  lg: string;
  overlay: string;
}

function shadowScale(level: number, darkUi: boolean, ink: string, hardColor: string | null): Shadows {
  if (hardColor) {
    const o = [0, 3, 5, 7][level] ?? 0;
    return {
      sm: o ? `${Math.max(2, o - 2)}px ${Math.max(2, o - 2)}px 0 0 ${hardColor}` : 'none',
      md: o ? `${o}px ${o}px 0 0 ${hardColor}` : 'none',
      lg: o ? `${o + 3}px ${o + 3}px 0 0 ${hardColor}` : 'none',
      overlay: `${Math.max(6, o + 3)}px ${Math.max(6, o + 3)}px 0 0 ${hardColor}`,
    };
  }
  const k = darkUi ? 2.6 : 1;
  const a = (v: number) => alpha(ink, Math.min(0.9, v * k));
  const overlay = `0 2px 6px ${a(0.06)}, 0 18px 48px ${a(0.2)}`;
  switch (level) {
    case 0:
      return { sm: 'none', md: 'none', lg: 'none', overlay };
    case 1:
      return {
        sm: `0 1px 2px ${a(0.05)}`,
        md: `0 1px 2px ${a(0.04)}, 0 4px 14px ${a(0.06)}`,
        lg: `0 2px 4px ${a(0.04)}, 0 12px 30px ${a(0.1)}`,
        overlay,
      };
    case 3:
      return {
        sm: `0 2px 4px ${a(0.07)}, 0 5px 12px ${a(0.07)}`,
        md: `0 3px 6px ${a(0.06)}, 0 20px 44px ${a(0.16)}`,
        lg: `0 6px 12px ${a(0.07)}, 0 36px 80px ${a(0.24)}`,
        overlay: `0 6px 12px ${a(0.07)}, 0 36px 80px ${a(0.26)}`,
      };
    default:
      return {
        sm: `0 1px 2px ${a(0.06)}, 0 2px 6px ${a(0.05)}`,
        md: `0 2px 4px ${a(0.05)}, 0 10px 26px ${a(0.1)}`,
        lg: `0 4px 8px ${a(0.05)}, 0 24px 52px ${a(0.16)}`,
        overlay,
      };
  }
}

interface Layers {
  image: string[];
  size: string[];
  position: string[];
  repeat: string[];
}

function pushLayer(l: Layers, image: string, size = 'auto', position = '0 0', repeat = 'repeat') {
  l.image.push(image);
  l.size.push(size);
  l.position.push(position);
  l.repeat.push(repeat);
}

function leafTile(color: string, opacity: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='148' height='148' viewBox='0 0 148 148'>` +
    `<g fill='none' stroke='${color}' stroke-opacity='${opacity}' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M14 44c0-15 10-25 26-26 1 16-9 26-26 26zm0 0 16-16'/>` +
    `<path d='M92 132c-5-12 2-23 15-28 5 12-2 23-15 28zm0 0 10-17'/>` +
    `<path d='M112 52c-8-6-10-15-6-24 9 6 11 15 6 24zm0 0-1-14'/>` +
    `<path d='M40 112c-9 1-16-4-19-12 9-1 16 4 19 12zm0 0-11-7'/>` +
    `</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function patternLayers(l: Layers, pattern: ThemeBackground['pattern'], inkColor: string, darkUi: boolean) {
  const ink = alpha(inkColor, darkUi ? 0.085 : 0.075);
  const faint = alpha(inkColor, darkUi ? 0.055 : 0.05);
  switch (pattern) {
    case 'dots':
      pushLayer(l, `radial-gradient(circle at center, ${alpha(inkColor, darkUi ? 0.16 : 0.14)} 1.1px, transparent 1.7px)`, '22px 22px');
      break;
    case 'grid':
      pushLayer(l, `linear-gradient(${ink} 1px, transparent 1px)`, '32px 32px', '-1px -1px');
      pushLayer(l, `linear-gradient(90deg, ${ink} 1px, transparent 1px)`, '32px 32px', '-1px -1px');
      break;
    case 'topo':
      pushLayer(l, `repeating-radial-gradient(ellipse 120% 90% at 12% 18%, transparent 0 27px, ${ink} 27px 28px)`, '100% 100%', '0 0', 'no-repeat');
      pushLayer(l, `repeating-radial-gradient(ellipse 90% 130% at 92% 84%, transparent 0 35px, ${faint} 35px 36px)`, '100% 100%', '0 0', 'no-repeat');
      break;
    case 'waves':
      pushLayer(l, `radial-gradient(circle at 50% 100%, transparent 15px, ${ink} 15px, ${ink} 16.2px, transparent 16.2px)`, '48px 24px');
      pushLayer(l, `radial-gradient(circle at 50% 100%, transparent 15px, ${faint} 15px, ${faint} 16.2px, transparent 16.2px)`, '48px 24px', '24px 12px');
      break;
    case 'leaves':
      // The one pattern that is not a pure gradient: a tiny inline SVG tile (data: URL, allowed by the CSP).
      pushLayer(l, leafTile(inkColor, darkUi ? 0.13 : 0.12), '148px 148px');
      break;
    default:
      break;
  }
}

/**
 * Every `--m-*` custom property the public UI reads. Pass `dark = true` only when the theme's
 * scheme is "auto" and the visitor prefers dark (ThemeScope does this for you).
 */
export function themeToCssVars(theme: Theme, assets?: ThemeAssets | null, dark = false): Record<string, string> {
  const t = resolveTheme(theme);
  const usingDarkPalette = dark && !!t.darkColors;
  const c = cleanColors(usingDarkPalette ? t.darkColors : t.colors);
  const a = assets ?? NO_ASSETS;
  const bgConf = t.background ?? { type: 'solid' };

  const darkUi = isDark(c.background);
  const surfaceDark = isDark(c.surface);
  const hard = isHardEdged(t);

  // Gradient stops belong to the light palette. With the dark palette they are derived instead.
  const from = usingDarkPalette ? c.background : normalizeHex(bgConf.gradientFrom, c.background);
  const to = usingDarkPalette ? mix(c.background, c.primary, 0.1) : normalizeHex(bgConf.gradientTo, c.background);
  const angle = clamp(bgConf.gradientAngle, 0, 360, 160);

  const hasImage = bgConf.type === 'image' && !!a.backgroundUrl;
  const bgType: ThemeBackground['type'] = bgConf.type === 'image' && !hasImage ? 'solid' : bgConf.type;
  const usesStops = bgType === 'gradient' || bgType === 'mesh' || bgType === 'pattern';
  const bgStops = usesStops ? [c.background, from, to] : [c.background];

  // ── colours
  const onPrimary = readableOn(c.primary);
  const onAccent = readableOn(c.accent);
  const primaryHover = mix(c.primary, onPrimary, 0.12);
  const primaryText = ensureContrast(c.primary, c.surface, 4.5);
  const accentText = ensureContrast(c.accent, c.surface, 4.5);
  const surface2 = mix(c.surface, c.text, surfaceDark ? 0.06 : 0.035);
  const surfaceHover = mix(c.surface, c.text, surfaceDark ? 0.1 : 0.06);
  const overlay = surfaceDark ? mix(c.surface, c.text, 0.04) : c.surface;
  const borderStrong = mix(c.border, c.text, 0.24);
  const faint = ensureContrast(mix(c.muted, c.surface, 0.32), c.surface, 3.1);
  const fieldBg = surfaceDark ? mix(c.surface, '#000000', 0.22) : mix(c.surface, '#ffffff', 0.6);
  const focus = ensureContrast(c.primary, [c.background, c.surface], 3);

  const dangerBase = surfaceDark ? '#ff8f80' : '#c5281c';
  const successBase = surfaceDark ? '#6fdd9a' : '#17734a';
  const warningBase = surfaceDark ? '#f3c267' : '#8a5a00';
  const dangerText = ensureContrast(dangerBase, c.surface, 4.5);
  const successText = ensureContrast(successBase, c.surface, 4.5);
  const warningText = ensureContrast(warningBase, c.surface, 4.5);
  const dangerFill = surfaceDark ? '#ff7d6b' : '#c5281c';

  // ── shape
  const r = clamp(t.radius, 0, 28, 18);
  const control = Math.min(Math.round(r * 0.66), 14);
  const btnRadius = t.buttonShape === 'pill' ? '999px' : t.buttonShape === 'square' ? px(Math.min(r, 2)) : px(control);
  const avatarRadius = t.avatarShape === 'circle' ? '50%' : t.avatarShape === 'square' ? px(Math.min(r, 4)) : '28%';

  const shadowInk = darkUi ? '#000000' : mix(c.text, '#000000', 0.35);
  const sh = shadowScale(clamp(t.shadow, 0, 3, 2), darkUi, shadowInk, hard ? c.border : null);

  // ── cards
  let cardBg = c.surface;
  let cardBorder = 'transparent';
  let cardShadow = 'none';
  let cardBlur = 'none';
  switch (t.cardStyle) {
    case 'bordered':
      cardBorder = c.border;
      cardShadow = hard ? sh.md : t.shadow >= 2 ? sh.sm : 'none';
      break;
    case 'elevated':
      cardBorder = alpha(c.text, surfaceDark ? 0.09 : 0.05);
      cardShadow = sh.md;
      break;
    case 'glass':
      cardBg = alpha(c.surface, surfaceDark ? 0.62 : 0.68);
      cardBorder = surfaceDark ? alpha(c.text, 0.11) : alpha('#ffffff', 0.7);
      cardShadow = sh.md;
      cardBlur = 'blur(18px) saturate(1.25)';
      break;
    default:
      break;
  }

  // ── primary button
  const g2 = mix(c.primary, c.accent, 0.62);
  let btnBg = c.primary;
  let btnBgHover = primaryHover;
  let btnFg = onPrimary;
  let btnBorder = hard ? c.border : 'transparent';
  let btnShadow = hard ? sh.sm : t.shadow > 0 ? `0 1px 2px ${alpha(shadowInk, darkUi ? 0.4 : 0.14)}` : 'none';
  switch (t.buttonStyle) {
    case 'outline':
      btnBg = 'transparent';
      btnBgHover = alpha(c.primary, 0.14);
      btnFg = primaryText;
      btnBorder = hard ? c.border : primaryText;
      btnShadow = hard ? sh.sm : 'none';
      break;
    case 'soft': {
      const soft = mix(c.surface, c.primary, surfaceDark ? 0.22 : 0.14);
      btnBg = soft;
      btnBgHover = mix(c.surface, c.primary, surfaceDark ? 0.3 : 0.22);
      btnFg = ensureContrast(c.primary, [soft, btnBgHover], 4.5);
      btnShadow = hard ? sh.sm : 'none';
      break;
    }
    case 'gradient': {
      const white = Math.min(contrastRatio('#ffffff', c.primary), contrastRatio('#ffffff', g2));
      const ink = mix(c.primary, '#000000', 0.88);
      const inkMin = Math.min(contrastRatio(ink, c.primary), contrastRatio(ink, g2));
      btnFg = white >= 4.5 || white >= inkMin ? '#ffffff' : ink;
      btnBg = `linear-gradient(135deg, ${c.primary}, ${g2})`;
      btnBgHover = `linear-gradient(135deg, ${mix(c.primary, btnFg, 0.1)}, ${mix(g2, btnFg, 0.1)})`;
      if (!hard && t.shadow > 0) btnShadow = `0 1px 2px ${alpha(shadowInk, darkUi ? 0.4 : 0.14)}, 0 8px 22px ${alpha(c.primary, 0.28)}`;
      break;
    }
    default:
      break;
  }

  // ── type
  const heading = fontByKey(t.fontHeading);
  const body = fontByKey(t.fontBody);
  const s = clamp(t.fontScale, 0.85, 1.25, 1);
  const compact = t.density === 'compact';
  const d = compact ? 0.8 : 1;

  // ── motion
  const motion = t.animations === 'none' ? 0 : t.animations === 'lively' ? 2 : 1;
  const dur = motion === 0 ? [0, 0, 0] : motion === 2 ? [140, 260, 480] : [110, 190, 320];

  // ── page background
  const layers: Layers = { image: [], size: [], position: [], repeat: [] };
  let overlayColor = 'transparent';
  let blur = 0;
  if (bgType === 'image' && a.backgroundUrl) {
    pushLayer(layers, cssUrl(a.backgroundUrl), 'cover', 'center', 'no-repeat');
    overlayColor = alpha(c.background, clamp(bgConf.overlayOpacity, 0, 1, 0.4));
    blur = clamp(bgConf.blur, 0, 40, 0);
  } else if (bgType === 'gradient') {
    pushLayer(layers, `linear-gradient(${angle}deg, ${from}, ${to})`, '100% 100%', '0 0', 'no-repeat');
  } else if (bgType === 'mesh') {
    pushLayer(layers, `radial-gradient(55% 48% at 10% 4%, ${alpha(c.primary, darkUi ? 0.17 : 0.13)}, transparent 72%)`, '100% 100%', '0 0', 'no-repeat');
    pushLayer(layers, `radial-gradient(46% 42% at 94% 10%, ${alpha(c.accent, darkUi ? 0.11 : 0.12)}, transparent 70%)`, '100% 100%', '0 0', 'no-repeat');
    pushLayer(layers, `radial-gradient(70% 60% at 78% 104%, ${alpha(to, 0.95)}, transparent 74%)`, '100% 100%', '0 0', 'no-repeat');
    pushLayer(layers, `linear-gradient(${angle}deg, ${from}, ${mix(from, to, 0.55)})`, '100% 100%', '0 0', 'no-repeat');
  } else if (bgType === 'pattern') {
    patternLayers(layers, bgConf.pattern ?? 'none', c.text, darkUi);
    if (from !== to) pushLayer(layers, `linear-gradient(${angle}deg, ${from}, ${to})`, '100% 100%', '0 0', 'no-repeat');
  }
  const hasLayers = layers.image.length > 0;

  const vars: Record<string, string> = {
    // colours
    '--m-primary': c.primary,
    '--m-primary-hover': primaryHover,
    '--m-on-primary': onPrimary,
    '--m-primary-text': primaryText,
    '--m-primary-soft': alpha(c.primary, surfaceDark ? 0.16 : 0.12),
    '--m-primary-softer': alpha(c.primary, surfaceDark ? 0.08 : 0.06),
    '--m-primary-soft-solid': mix(c.surface, c.primary, surfaceDark ? 0.16 : 0.12),
    '--m-accent': c.accent,
    '--m-on-accent': onAccent,
    '--m-accent-text': accentText,
    '--m-accent-soft': alpha(c.accent, surfaceDark ? 0.16 : 0.14),
    '--m-bg': c.background,
    '--m-surface': c.surface,
    '--m-surface-2': surface2,
    '--m-surface-hover': surfaceHover,
    '--m-overlay': overlay,
    '--m-field-bg': fieldBg,
    '--m-text': c.text,
    '--m-muted': c.muted,
    '--m-faint': faint,
    '--m-text-on-bg': hasImage ? c.text : ensureContrast(c.text, bgStops, 4.5),
    '--m-muted-on-bg': hasImage ? c.muted : ensureContrast(c.muted, bgStops, 4.5),
    '--m-border': c.border,
    '--m-border-strong': borderStrong,
    '--m-hairline': alpha(c.text, surfaceDark ? 0.1 : 0.08),
    '--m-switch-off': mix(c.surface, c.text, surfaceDark ? 0.3 : 0.24),
    '--m-link-underline': colorDistance(primaryText, c.text) < 70 ? alpha(c.text, 0.5) : 'transparent',
    '--m-hover': alpha(c.text, surfaceDark ? 0.08 : 0.055),
    '--m-pressed': alpha(c.text, surfaceDark ? 0.14 : 0.1),
    '--m-danger': dangerFill,
    '--m-on-danger': readableOn(dangerFill),
    '--m-danger-text': dangerText,
    '--m-danger-soft': alpha(dangerBase, surfaceDark ? 0.16 : 0.1),
    '--m-success': successBase,
    '--m-success-text': successText,
    '--m-success-soft': alpha(successBase, surfaceDark ? 0.16 : 0.11),
    '--m-warning': warningBase,
    '--m-warning-text': warningText,
    '--m-warning-soft': alpha(warningBase, surfaceDark ? 0.16 : 0.12),
    '--m-focus': focus,
    '--m-focus-soft': alpha(focus, 0.28),
    '--m-scrim': darkUi ? 'rgb(0 0 0 / 0.62)' : alpha(mix(c.text, '#000000', 0.5), 0.44),
    '--m-tooltip-bg': c.text,
    '--m-tooltip-fg': readableOn(c.text) === '#ffffff' ? '#ffffff' : c.background,
    '--m-color-scheme': darkUi ? 'dark' : 'light',

    // shape
    '--m-radius': px(r),
    '--m-radius-xs': px(Math.min(Math.round(r * 0.3), 6)),
    '--m-radius-sm': px(Math.min(Math.round(r * 0.5), 10)),
    '--m-radius-md': px(Math.min(Math.round(r * 0.72), 16)),
    '--m-radius-lg': px(r),
    '--m-radius-xl': px(Math.min(Math.round(r * 1.35), 36)),
    '--m-radius-control': px(control),
    '--m-radius-btn': btnRadius,
    '--m-radius-chip': t.buttonShape === 'pill' ? '999px' : px(Math.min(Math.round(r * 0.5), 10)),
    '--m-radius-avatar': avatarRadius,
    '--m-border-width': hard ? '2px' : '1px',

    // elevation
    '--m-shadow-sm': sh.sm,
    '--m-shadow-md': sh.md,
    '--m-shadow-lg': sh.lg,
    '--m-shadow-overlay': sh.overlay,

    // cards
    '--m-card-bg': cardBg,
    '--m-card-bg-solid': c.surface,
    '--m-card-border': cardBorder,
    '--m-card-shadow': cardShadow,
    '--m-card-blur': cardBlur,

    // primary button
    '--m-btn-bg': btnBg,
    '--m-btn-bg-hover': btnBgHover,
    '--m-btn-fg': btnFg,
    '--m-btn-border': btnBorder,
    '--m-btn-shadow': btnShadow,
    '--m-btn-weight': hard ? '700' : '600',

    // selected states (calendar day, time slot)
    '--m-selected-bg': c.primary,
    '--m-selected-fg': onPrimary,

    // type
    '--m-font-heading': heading.stack,
    '--m-font-body': body.stack,
    '--m-font-mono': MONO_STACK,
    '--m-heading-weight': String(heading.headingWeight),
    '--m-heading-tracking': `${heading.headingTracking}em`,
    '--m-font-scale': String(s),
    '--m-text-xs': rem(0.75 * s),
    '--m-text-sm': rem(0.875 * s),
    '--m-text-base': rem((compact ? 0.9375 : 1) * s),
    '--m-text-md': rem(1.0625 * s),
    '--m-text-lg': rem(1.1875 * s),
    '--m-text-xl': rem(1.4375 * s),
    '--m-text-2xl': rem(1.8125 * s),
    '--m-text-3xl': `clamp(${rem(1.9 * s)}, ${rem(1.45 * s)} + 1.9vw, ${rem(2.5 * s)})`,
    '--m-text-display': `clamp(${rem(2.2 * s)}, ${rem(1.5 * s)} + 3vw, ${rem(3.5 * s)})`,

    // density
    '--m-density': String(d),
    '--m-control-h': compact ? '44px' : '48px',
    '--m-control-h-sm': compact ? '36px' : '40px',
    '--m-control-h-lg': compact ? '48px' : '54px',
    '--m-gap-xs': px(6 * d),
    '--m-gap-sm': px(10 * d),
    '--m-gap': px(16 * d),
    '--m-gap-lg': px(26 * d),
    '--m-gap-xl': px(42 * d),
    '--m-pad-card': compact ? 'clamp(16px, 3.2vw, 22px)' : 'clamp(20px, 4vw, 32px)',

    // motion
    '--m-motion': String(motion),
    '--m-dur-fast': `${dur[0]}ms`,
    '--m-dur': `${dur[1]}ms`,
    '--m-dur-slow': `${dur[2]}ms`,
    '--m-ease': 'cubic-bezier(0.2, 0.7, 0.2, 1)',
    '--m-ease-spring': motion === 2 ? 'cubic-bezier(0.34, 1.56, 0.64, 1)' : 'cubic-bezier(0.2, 0.7, 0.2, 1)',

    // page background layers
    '--m-bg-image': hasLayers ? layers.image.join(', ') : 'none',
    '--m-bg-size': hasLayers ? layers.size.join(', ') : 'auto',
    '--m-bg-position': hasLayers ? layers.position.join(', ') : '0 0',
    '--m-bg-repeat': hasLayers ? layers.repeat.join(', ') : 'repeat',
    '--m-bg-overlay': overlayColor,
    '--m-bg-blur': px(blur),

    // images
    '--m-cover-image': a.coverUrl && t.coverHeight > 0 ? cssUrl(a.coverUrl) : 'none',
    '--m-cover-height': px(a.coverUrl ? clamp(t.coverHeight, 0, 480, 0) : 0),
    '--m-logo-image': a.logoUrl ? cssUrl(a.logoUrl) : 'none',
  };
  return vars;
}

/** Data attributes for the element that carries the CSS variables. Lets CSS switch structure per theme option. */
export function themeDataAttrs(theme: Theme, dark = false): Record<string, string> {
  const t = resolveTheme(theme);
  const c = cleanColors(dark && t.darkColors ? t.darkColors : t.colors);
  const bgType = t.background?.type ?? 'solid';
  return {
    'data-preset': String(t.preset || 'custom'),
    'data-scheme': isDark(c.background) ? 'dark' : 'light',
    'data-layout': t.layout,
    'data-calendar': t.calendarStyle,
    'data-slots': t.slotStyle,
    'data-card': t.cardStyle,
    'data-button': t.buttonStyle,
    'data-button-shape': t.buttonShape,
    'data-density': t.density,
    'data-avatar': t.avatarShape,
    'data-animations': t.animations,
    'data-bg': bgType,
    'data-hard': isHardEdged(t) ? 'true' : 'false',
  };
}

// ───────────────────────────── Fonts ─────────────────────────────

/** Google Fonts stylesheet URL for arbitrary catalog keys, or null when all of them are system stacks. */
export function googleFontsHrefFor(keys: string[]): string | null {
  const specs: string[] = [];
  for (const key of keys) {
    const spec = fontByKey(key).google;
    if (spec && !specs.includes(spec)) specs.push(spec);
  }
  if (!specs.length) return null;
  return `https://fonts.googleapis.com/css2?${specs.map((sp) => `family=${sp}`).join('&')}&display=swap`;
}

/** Google Fonts stylesheet URL for the theme's heading and body fonts. */
export function googleFontsHref(theme: Theme): string | null {
  return googleFontsHrefFor([theme.fontHeading, theme.fontBody]);
}

// ───────────────────────────── Custom CSS ─────────────────────────────

const MAX_CUSTOM_CSS = 20_000;

/**
 * Makes owner-written CSS safe to place in a <style> element: no way out of the element, no
 * imports, no script-ish values, and only inline (data:image) or same-origin path URLs.
 */
export function sanitizeCustomCss(css: unknown): string {
  if (typeof css !== 'string') return '';
  let out = css.slice(0, MAX_CUSTOM_CSS);
  out = out.replace(/\u0000/g, '');
  out = out.replace(/<\/?\s*style/gi, '');
  out = out.replace(/<!--|-->/g, '');
  out = out.replace(/<(?=\s*\/?\s*[a-z!?])/gi, '');
  out = out.replace(/@(import|charset|namespace)\b[^;{}]*;?/gi, '');
  out = out.replace(/expression\s*\(/gi, '(');
  out = out.replace(/(javascript|vbscript)\s*:/gi, '');
  out = out.replace(/-moz-binding\s*:[^;}]*/gi, '');
  out = out.replace(/behavior\s*:[^;}]*/gi, '');
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q: string, target: string) => {
    const u = target.trim();
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i.test(u)) return whole;
    if (/^\/(?!\/)/.test(u)) return whole;
    return 'none';
  });
  return out.trim();
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function scopeSelector(selector: string, scope: string): string {
  const sel = selector.trim();
  if (!sel) return '';
  const root = /^(:root|html|body|\.m-scope)(?![\w-])/i.exec(sel);
  if (root) return scope + sel.slice(root[0].length);
  if (sel.startsWith('&')) return scope + sel.slice(1);
  return `${scope} ${sel}`;
}

function scopeBlock(src: string, scope: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    let j = i;
    let depth = 0;
    let quote: string | null = null;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if (depth === 0 && (ch === '{' || ch === ';' || ch === '}')) break;
    }
    if (j >= src.length) break;
    const prelude = src.slice(i, j).trim();
    if (src[j] !== '{') {
      i = j + 1; // a statement without a block, or a stray brace: drop it
      continue;
    }
    const end = matchBrace(src, j);
    const body = src.slice(j + 1, end);
    i = end + 1;
    if (!prelude) continue;
    if (prelude.startsWith('@')) {
      const name = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
      if (name === 'media' || name === 'supports' || name === 'container' || name === 'layer') {
        out += `${prelude}{${scopeBlock(body, scope)}}`;
      } else if (name === 'keyframes' || name === '-webkit-keyframes' || name === 'font-face') {
        out += `${prelude}{${body}}`;
      }
      continue;
    }
    const selectors = splitTopLevel(prelude, ',')
      .map((part) => scopeSelector(part, scope))
      .filter(Boolean);
    if (selectors.length) out += `${selectors.join(',')}{${body}}`;
  }
  return out;
}

/**
 * Prefixes every selector with `scope` so owner CSS only ever styles the themed booking UI,
 * never the dashboard around a live preview. `:root`, `html`, `body` and `.m-scope` map to the
 * scope element itself, so `:root { --m-primary: red }` works as people expect.
 */
export function scopeCss(css: string, scope = '.m-scope'): string {
  return scopeBlock(css.replace(/\/\*[\s\S]*?\*\//g, ''), scope);
}
