import { DEFAULT_THEME } from './defaults';
import type { Theme, ThemeBackground, ThemeColors } from './types';

// ───────────────────────────── Fonts ─────────────────────────────

export type FontCategory = 'sans' | 'serif' | 'display' | 'mono' | 'system';

export interface FontDef {
  /** value stored in Theme.fontHeading / Theme.fontBody */
  key: string;
  label: string;
  /** complete CSS font-family value, fallbacks included */
  stack: string;
  /** family spec for the Google Fonts css2 API ("Inter:wght@400..700"), null for system stacks */
  google: string | null;
  category: FontCategory;
  /** the weight headings look best at in this face */
  headingWeight: number;
  /** heading letter-spacing in em (negative tightens) */
  headingTracking: number;
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

function gf(
  key: string,
  label: string,
  category: Exclude<FontCategory, 'system'>,
  google: string,
  headingWeight: number,
  headingTracking: number,
): FontDef {
  const fallback = category === 'serif' ? SERIF : category === 'mono' ? MONO : SANS;
  return { key, label, stack: `"${label}", ${fallback}`, google, category, headingWeight, headingTracking };
}

/**
 * Every font the design editor offers. Google families are loaded on demand through
 * googleFontsHref() (the CSP allows fonts.googleapis.com / fonts.gstatic.com only).
 */
export const FONT_CATALOG: FontDef[] = [
  // Sans
  gf('inter', 'Inter', 'sans', 'Inter:wght@400..700', 650, -0.022),
  gf('dm-sans', 'DM Sans', 'sans', 'DM+Sans:opsz,wght@9..40,400..700', 650, -0.025),
  gf('manrope', 'Manrope', 'sans', 'Manrope:wght@400..800', 700, -0.025),
  gf('plus-jakarta-sans', 'Plus Jakarta Sans', 'sans', 'Plus+Jakarta+Sans:wght@400..800', 700, -0.028),
  gf('figtree', 'Figtree', 'sans', 'Figtree:wght@400..800', 700, -0.022),
  gf('outfit', 'Outfit', 'sans', 'Outfit:wght@400..700', 600, -0.02),
  gf('ibm-plex-sans', 'IBM Plex Sans', 'sans', 'IBM+Plex+Sans:wght@400;500;600;700', 600, -0.018),
  gf('nunito', 'Nunito', 'sans', 'Nunito:wght@400..800', 800, -0.015),
  gf('atkinson-hyperlegible', 'Atkinson Hyperlegible', 'sans', 'Atkinson+Hyperlegible:wght@400;700', 700, -0.01),
  // Display
  gf('space-grotesk', 'Space Grotesk', 'display', 'Space+Grotesk:wght@400..700', 600, -0.03),
  gf('bricolage-grotesque', 'Bricolage Grotesque', 'display', 'Bricolage+Grotesque:opsz,wght@12..96,400..800', 700, -0.03),
  gf('archivo', 'Archivo', 'display', 'Archivo:wght@400..900', 800, -0.035),
  // Serif
  gf('fraunces', 'Fraunces', 'serif', 'Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700', 500, -0.02),
  gf('playfair-display', 'Playfair Display', 'serif', 'Playfair+Display:ital,wght@0,400..800;1,400..800', 600, -0.012),
  gf('lora', 'Lora', 'serif', 'Lora:ital,wght@0,400..700;1,400..700', 600, -0.012),
  gf('newsreader', 'Newsreader', 'serif', 'Newsreader:ital,opsz,wght@0,6..72,400..700;1,6..72,400..700', 500, -0.02),
  gf('source-serif-4', 'Source Serif 4', 'serif', 'Source+Serif+4:ital,opsz,wght@0,8..60,400..700;1,8..60,400..700', 600, -0.015),
  gf('instrument-serif', 'Instrument Serif', 'serif', 'Instrument+Serif:ital@0;1', 400, -0.01),
  gf('dm-serif-display', 'DM Serif Display', 'serif', 'DM+Serif+Display:ital@0;1', 400, -0.008),
  gf('cormorant-garamond', 'Cormorant Garamond', 'serif', 'Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500;1,600', 600, -0.008),
  // Mono
  gf('jetbrains-mono', 'JetBrains Mono', 'mono', 'JetBrains+Mono:wght@400..700', 600, -0.03),
  gf('space-mono', 'Space Mono', 'mono', 'Space+Mono:wght@400;700', 700, -0.035),
  // System stacks: nothing to download
  { key: 'system-sans', label: 'System sans', stack: SANS, google: null, category: 'system', headingWeight: 650, headingTracking: -0.02 },
  { key: 'system-serif', label: 'System serif', stack: SERIF, google: null, category: 'system', headingWeight: 600, headingTracking: -0.012 },
  {
    key: 'system-rounded',
    label: 'System rounded',
    stack: `ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Nunito", ${SANS}`,
    google: null,
    category: 'system',
    headingWeight: 700,
    headingTracking: -0.015,
  },
  { key: 'system-mono', label: 'System mono', stack: MONO, google: null, category: 'system', headingWeight: 600, headingTracking: -0.03 },
];

const FONT_INDEX = new Map(FONT_CATALOG.map((f) => [f.key, f]));

/** Catalog entry for a key. Unknown keys fall back to Inter so a stale theme never breaks rendering. */
export function fontByKey(key: string | null | undefined): FontDef {
  return (key && FONT_INDEX.get(key)) || FONT_INDEX.get('inter')!;
}

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: 'Sans serif',
  display: 'Display',
  serif: 'Serif',
  mono: 'Monospace',
  system: 'System (no download)',
};

// ───────────────────────────── Theme presets ─────────────────────────────

export interface ThemePreset {
  key: string;
  label: string;
  /** one line for the preset gallery */
  description: string;
  theme: Theme;
}

type Look = Pick<
  Theme,
  | 'colors'
  | 'background'
  | 'fontHeading'
  | 'fontBody'
  | 'radius'
  | 'buttonStyle'
  | 'buttonShape'
  | 'cardStyle'
  | 'shadow'
  | 'layout'
  | 'calendarStyle'
  | 'slotStyle'
> &
  Partial<Pick<Theme, 'scheme' | 'darkColors' | 'fontScale' | 'density' | 'avatarShape' | 'animations' | 'confetti'>>;

/** Builds a complete Theme: the look comes from the preset, the content settings start neutral. */
function make(preset: string, look: Look): Theme {
  return {
    preset,
    scheme: look.scheme ?? 'fixed',
    colors: { ...look.colors },
    darkColors: look.darkColors ? { ...look.darkColors } : null,
    background: { pattern: 'none', overlayOpacity: 0.4, blur: 0, imageAssetId: null, ...look.background },
    fontHeading: look.fontHeading,
    fontBody: look.fontBody,
    fontScale: look.fontScale ?? 1,
    radius: look.radius,
    buttonStyle: look.buttonStyle,
    buttonShape: look.buttonShape,
    cardStyle: look.cardStyle,
    shadow: look.shadow,
    layout: look.layout,
    calendarStyle: look.calendarStyle,
    slotStyle: look.slotStyle,
    density: look.density ?? 'comfortable',
    avatarShape: look.avatarShape ?? 'circle',
    showAvatar: true,
    coverAssetId: null,
    coverHeight: 0,
    logoAssetId: null,
    timeFormat: 'auto',
    weekStart: 'auto',
    animations: look.animations ?? 'subtle',
    confetti: look.confetti ?? true,
    texts: { ...DEFAULT_THEME.texts },
    customCss: '',
    hideBranding: false,
  };
}

const colors = (
  primary: string,
  accent: string,
  background: string,
  surface: string,
  text: string,
  muted: string,
  border: string,
): ThemeColors => ({ primary, accent, background, surface, text, muted, border });

const solid: ThemeBackground = { type: 'solid' };

export const THEME_PRESETS: ThemePreset[] = [
  {
    key: 'forest',
    label: 'Forest',
    description: 'Deep green, cream ink and a leaf accent. The house style.',
    theme: structuredClone(DEFAULT_THEME),
  },
  {
    // From ecochampions.live and the LinkedIn picture: sand paper, forest ink, the logo green and a lime highlight.
    key: 'eco-champions',
    label: 'Eco Champions',
    description: 'Sand paper, forest ink and the Eco Champions green, with Fraunces headings.',
    theme: make('eco-champions', {
      colors: colors('#14432f', '#e1f250', '#faf5e6', '#ffffff', '#06210d', '#2f5838', '#dcdacb'),
      background: solid,
      fontHeading: 'fraunces',
      fontBody: 'inter',
      radius: 16,
      buttonStyle: 'solid',
      buttonShape: 'pill',
      cardStyle: 'elevated',
      shadow: 1,
      layout: 'split',
      calendarStyle: 'bubbles',
      slotStyle: 'list',
    }),
  },
  {
    key: 'meadow',
    label: 'Meadow',
    description: 'The daytime sibling of Forest: soft sage paper with a deep green.',
    theme: make('meadow', {
      colors: colors('#1c7449', '#a56a12', '#f1f4ea', '#ffffff', '#14251b', '#56645a', '#d6ddcd'),
      background: { type: 'mesh', gradientFrom: '#f4f6ee', gradientTo: '#dfead6', gradientAngle: 165 },
      fontHeading: 'fraunces',
      fontBody: 'inter',
      radius: 18,
      buttonStyle: 'solid',
      buttonShape: 'pill',
      cardStyle: 'elevated',
      shadow: 2,
      layout: 'split',
      calendarStyle: 'bubbles',
      slotStyle: 'grid',
    }),
  },
  {
    key: 'daylight',
    label: 'Daylight',
    description: 'Clean, bright and neutral. Follows the visitor into dark mode.',
    theme: make('daylight', {
      scheme: 'auto',
      colors: colors('#2450e0', '#b45309', '#f5f6f8', '#ffffff', '#12161c', '#596372', '#dfe3e9'),
      darkColors: colors('#8eabff', '#f6b756', '#0c1016', '#151a23', '#e8ecf2', '#9aa5b5', '#28303d'),
      background: solid,
      fontHeading: 'plus-jakarta-sans',
      fontBody: 'inter',
      radius: 12,
      buttonStyle: 'solid',
      buttonShape: 'rounded',
      cardStyle: 'bordered',
      shadow: 1,
      layout: 'split',
      calendarStyle: 'grid',
      slotStyle: 'list',
    }),
  },
  {
    key: 'midnight',
    label: 'Midnight',
    description: 'Ink blue glass with a cool glow. Quietly technical.',
    theme: make('midnight', {
      colors: colors('#8fb0ff', '#7fe0f2', '#080c19', '#111830', '#e9edf8', '#9ba7c4', '#242d4c'),
      background: { type: 'gradient', gradientFrom: '#080c19', gradientTo: '#16204a', gradientAngle: 200 },
      fontHeading: 'space-grotesk',
      fontBody: 'inter',
      radius: 14,
      buttonStyle: 'gradient',
      buttonShape: 'rounded',
      cardStyle: 'glass',
      shadow: 3,
      layout: 'centered',
      calendarStyle: 'grid',
      slotStyle: 'chips',
      animations: 'lively',
    }),
  },
  {
    key: 'paper',
    label: 'Warm paper',
    description: 'Cream stock, a bookish serif and a terracotta stamp.',
    theme: make('paper', {
      colors: colors('#a4451d', '#2f6b57', '#f3ecdf', '#fbf7ee', '#2a231c', '#685e52', '#dcd1be'),
      background: { type: 'pattern', pattern: 'dots', gradientFrom: '#f3ecdf', gradientTo: '#f3ecdf', gradientAngle: 180 },
      fontHeading: 'newsreader',
      fontBody: 'dm-sans',
      radius: 6,
      buttonStyle: 'solid',
      buttonShape: 'rounded',
      cardStyle: 'bordered',
      shadow: 0,
      layout: 'stacked',
      calendarStyle: 'minimal',
      slotStyle: 'list',
    }),
  },
  {
    key: 'ocean',
    label: 'Ocean',
    description: 'Deep teal water, sea glass buttons and a soft swell.',
    theme: make('ocean', {
      colors: colors('#5fe3d3', '#ffd27a', '#04212e', '#0a3342', '#e8f6f7', '#9cc0c7', '#1d4c5c'),
      background: { type: 'pattern', pattern: 'waves', gradientFrom: '#04212e', gradientTo: '#0a4254', gradientAngle: 180 },
      fontHeading: 'outfit',
      fontBody: 'dm-sans',
      radius: 20,
      buttonStyle: 'solid',
      buttonShape: 'pill',
      cardStyle: 'elevated',
      shadow: 2,
      layout: 'split',
      calendarStyle: 'bubbles',
      slotStyle: 'grid',
    }),
  },
  {
    key: 'sunset',
    label: 'Sunset',
    description: 'A warm peach to coral sky with confident, rounded type.',
    theme: make('sunset', {
      colors: colors('#c2371f', '#b45f06', '#ffe6d2', '#fffaf4', '#3a1c14', '#7a5447', '#f1d2bb'),
      background: { type: 'gradient', gradientFrom: '#ffdcba', gradientTo: '#ffa692', gradientAngle: 155 },
      fontHeading: 'bricolage-grotesque',
      fontBody: 'dm-sans',
      radius: 22,
      buttonStyle: 'gradient',
      buttonShape: 'pill',
      cardStyle: 'elevated',
      shadow: 3,
      layout: 'centered',
      calendarStyle: 'bubbles',
      slotStyle: 'chips',
      animations: 'lively',
    }),
  },
  {
    key: 'mono',
    label: 'Mono',
    description: 'Black, white and nothing else. Compact and exact.',
    theme: make('mono', {
      scheme: 'auto',
      colors: colors('#111111', '#111111', '#ffffff', '#ffffff', '#111111', '#636363', '#e3e3e3'),
      darkColors: colors('#f4f4f4', '#f4f4f4', '#0a0a0a', '#0a0a0a', '#f4f4f4', '#a3a3a3', '#2b2b2b'),
      background: solid,
      fontHeading: 'inter',
      fontBody: 'inter',
      radius: 8,
      buttonStyle: 'solid',
      buttonShape: 'rounded',
      cardStyle: 'flat',
      shadow: 0,
      layout: 'stacked',
      calendarStyle: 'minimal',
      slotStyle: 'grid',
      density: 'compact',
      avatarShape: 'rounded',
      confetti: false,
    }),
  },
  {
    key: 'contrast',
    label: 'High contrast',
    description: 'Maximum legibility: pure black, white text, strong outlines.',
    theme: make('contrast', {
      colors: colors('#ffe600', '#5cf2ff', '#000000', '#0b0b0b', '#ffffff', '#d6d6d6', '#ffffff'),
      background: solid,
      fontHeading: 'atkinson-hyperlegible',
      fontBody: 'atkinson-hyperlegible',
      fontScale: 1.08,
      radius: 6,
      buttonStyle: 'solid',
      buttonShape: 'rounded',
      cardStyle: 'bordered',
      shadow: 0,
      layout: 'stacked',
      calendarStyle: 'grid',
      slotStyle: 'list',
      animations: 'none',
      confetti: false,
    }),
  },
  {
    key: 'pastel',
    label: 'Pastel',
    description: 'Blush and mint with soft buttons and friendly round letters.',
    theme: make('pastel', {
      colors: colors('#b8356a', '#1f7f6d', '#fdf3ef', '#ffffff', '#3b2c38', '#756471', '#f0dde1'),
      background: { type: 'mesh', gradientFrom: '#ffe4ea', gradientTo: '#dcf1ea', gradientAngle: 135 },
      fontHeading: 'nunito',
      fontBody: 'nunito',
      radius: 24,
      buttonStyle: 'soft',
      buttonShape: 'pill',
      cardStyle: 'elevated',
      shadow: 1,
      layout: 'centered',
      calendarStyle: 'bubbles',
      slotStyle: 'chips',
      animations: 'lively',
    }),
  },
  {
    key: 'brutalist',
    label: 'Brutalist',
    description: 'Hard edges, heavy type, black rules and a loud orange.',
    theme: make('brutalist', {
      colors: colors('#ff5a1f', '#1f3bff', '#f3f0e6', '#ffffff', '#0a0a0a', '#474747', '#0a0a0a'),
      background: { type: 'pattern', pattern: 'grid', gradientFrom: '#f3f0e6', gradientTo: '#f3f0e6', gradientAngle: 180 },
      fontHeading: 'archivo',
      fontBody: 'space-grotesk',
      fontScale: 1.02,
      radius: 0,
      buttonStyle: 'solid',
      buttonShape: 'square',
      cardStyle: 'bordered',
      shadow: 3,
      layout: 'split',
      calendarStyle: 'grid',
      slotStyle: 'grid',
      avatarShape: 'square',
    }),
  },
  {
    key: 'noir',
    label: 'Noir',
    description: 'Charcoal and brass with a classic high-contrast serif.',
    theme: make('noir', {
      colors: colors('#d8b36a', '#c9694c', '#0d0c0b', '#171513', '#f2ece0', '#a8a091', '#302c26'),
      background: solid,
      fontHeading: 'playfair-display',
      fontBody: 'inter',
      radius: 3,
      buttonStyle: 'outline',
      buttonShape: 'square',
      cardStyle: 'bordered',
      shadow: 0,
      layout: 'split',
      calendarStyle: 'minimal',
      slotStyle: 'list',
      avatarShape: 'rounded',
    }),
  },
];

export function presetByKey(key: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.key === key);
}

/**
 * Applies a preset's look while keeping what the owner typed or uploaded: custom texts,
 * cover / logo / background image, custom CSS, time format, week start and branding choice.
 */
export function applyPreset(current: Theme, key: string): Theme {
  const preset = presetByKey(key);
  if (!preset) return current;
  const next = structuredClone(preset.theme);
  return {
    ...next,
    background: { ...next.background, imageAssetId: current.background.imageAssetId ?? null },
    coverAssetId: current.coverAssetId ?? null,
    coverHeight: current.coverHeight,
    logoAssetId: current.logoAssetId ?? null,
    showAvatar: current.showAvatar,
    timeFormat: current.timeFormat,
    weekStart: current.weekStart,
    texts: { ...current.texts },
    customCss: current.customCss,
    hideBranding: current.hideBranding,
  };
}
