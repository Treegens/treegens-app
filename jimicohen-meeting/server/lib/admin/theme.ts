/**
 * Validation of theme settings, field by field. Used for the site theme (PUT /admin/site,
 * where the patch is merged onto the stored theme) and for the per-event override (where only
 * the validated fields are kept).
 *
 * Nothing unknown gets through: every field is read by name, enums are closed lists, numbers
 * have ranges, colours are hex, texts have length limits, and image ids must exist.
 */
import { FONT_CATALOG, THEME_PRESETS } from '../../../shared/presets';
import { sanitizeCustomCss } from '../../../shared/theme';
import type { Theme, ThemeBackground, ThemeColors } from '../../../shared/types';
import { FieldErrors } from '../validate';
import { type AssetRef, type Bag, given, readAssetId, readBool, readEnum, readHex, readNumber, readObject, readText } from './fields';

export const MAX_CUSTOM_CSS_BYTES = 20_000;

const COLOR_KEYS: (keyof ThemeColors)[] = ['primary', 'accent', 'background', 'surface', 'text', 'muted', 'border'];
const TEXT_LIMITS: Record<keyof Theme['texts'], { max: number; multiline: boolean }> = {
  ctaLabel: { max: 40, multiline: false },
  pickTimeLabel: { max: 40, multiline: false },
  confirmationTitle: { max: 60, multiline: false },
  confirmationBody: { max: 400, multiline: true },
  footerNote: { max: 240, multiline: true },
};

const FONT_KEYS = FONT_CATALOG.map((f) => f.key);
const PRESET_KEYS = ['custom', ...THEME_PRESETS.map((p) => p.key)];

/** A theme patch: top-level fields as given, nested groups possibly partial. */
export type ThemePatch = Omit<Partial<Theme>, 'colors' | 'darkColors' | 'background' | 'texts'> & {
  colors?: Partial<ThemeColors>;
  darkColors?: Partial<ThemeColors> | null;
  background?: Partial<ThemeBackground>;
  texts?: Partial<Theme['texts']>;
};

/** What the theme points at today, so unchanged image ids are not looked up again on every save. */
export interface ThemeAssetIds {
  coverAssetId?: string | null;
  logoAssetId?: string | null;
  backgroundImageAssetId?: string | null;
}

function readColors(value: unknown, path: string, errors: FieldErrors): Partial<ThemeColors> | undefined {
  const bag = readObject(value, path, errors);
  if (!bag) return undefined;
  const out: Partial<ThemeColors> = {};
  for (const key of COLOR_KEYS) {
    const hex = readHex(bag, key, `${path}.${key}`, errors);
    if (hex !== undefined) out[key] = hex;
  }
  return out;
}

function readBackground(value: unknown, path: string, current: ThemeAssetIds, refs: AssetRef[], errors: FieldErrors): Partial<ThemeBackground> | undefined {
  const bag = readObject(value, path, errors);
  if (!bag) return undefined;
  const out: Partial<ThemeBackground> = {};
  // Optional fields may be sent as null, which means "not set".
  const present = (key: string): boolean => given(bag, key) && bag[key] !== null;

  const type = readEnum(bag, 'type', `${path}.type`, ['solid', 'gradient', 'mesh', 'pattern', 'image'] as const, errors);
  if (type !== undefined) out.type = type;
  if (present('gradientFrom')) out.gradientFrom = readHex(bag, 'gradientFrom', `${path}.gradientFrom`, errors);
  else if (given(bag, 'gradientFrom')) out.gradientFrom = undefined;
  if (present('gradientTo')) out.gradientTo = readHex(bag, 'gradientTo', `${path}.gradientTo`, errors);
  else if (given(bag, 'gradientTo')) out.gradientTo = undefined;
  if (present('gradientAngle')) out.gradientAngle = readNumber(bag, 'gradientAngle', `${path}.gradientAngle`, 0, 360, errors, 0);
  if (present('pattern')) out.pattern = readEnum(bag, 'pattern', `${path}.pattern`, ['dots', 'grid', 'topo', 'leaves', 'waves', 'none'] as const, errors);
  if (present('overlayOpacity')) out.overlayOpacity = readNumber(bag, 'overlayOpacity', `${path}.overlayOpacity`, 0, 1, errors, 2);
  if (present('blur')) out.blur = readNumber(bag, 'blur', `${path}.blur`, 0, 40, errors, 0);
  const image = readAssetId(bag, 'imageAssetId', `${path}.imageAssetId`, current.backgroundImageAssetId, refs, errors);
  if (image !== undefined) out.imageAssetId = image;
  return out;
}

function readTexts(value: unknown, path: string, errors: FieldErrors): Partial<Theme['texts']> | undefined {
  const bag = readObject(value, path, errors);
  if (!bag) return undefined;
  const out: Partial<Theme['texts']> = {};
  for (const key of Object.keys(TEXT_LIMITS) as (keyof Theme['texts'])[]) {
    const text = readText(bag, key, `${path}.${key}`, TEXT_LIMITS[key].max, errors, { multiline: TEXT_LIMITS[key].multiline });
    if (text !== undefined) out[key] = text;
  }
  return out;
}

/**
 * Reads whatever theme fields were sent. Problems are recorded under `path` ("theme" or
 * "themeOverride") plus the field name. New image ids are queued in `refs`.
 */
export function parseThemePatch(value: unknown, path: string, current: ThemeAssetIds, refs: AssetRef[], errors: FieldErrors): ThemePatch | null {
  const bag: Bag | null = readObject(value, path, errors);
  if (!bag) return null;
  const out: ThemePatch = {};
  const at = (key: string): string => `${path}.${key}`;
  const set = <K extends keyof ThemePatch>(key: K, v: ThemePatch[K] | undefined): void => {
    if (v !== undefined) out[key] = v;
  };

  set('preset', readEnum(bag, 'preset', at('preset'), PRESET_KEYS, errors));
  set('scheme', readEnum(bag, 'scheme', at('scheme'), ['fixed', 'auto'] as const, errors));
  if (given(bag, 'colors')) set('colors', readColors(bag.colors, at('colors'), errors));
  if (given(bag, 'darkColors')) {
    if (bag.darkColors === null) out.darkColors = null;
    else set('darkColors', readColors(bag.darkColors, at('darkColors'), errors));
  }
  if (given(bag, 'background')) set('background', readBackground(bag.background, at('background'), current, refs, errors));
  set('fontHeading', readEnum(bag, 'fontHeading', at('fontHeading'), FONT_KEYS, errors));
  set('fontBody', readEnum(bag, 'fontBody', at('fontBody'), FONT_KEYS, errors));
  set('fontScale', readNumber(bag, 'fontScale', at('fontScale'), 0.9, 1.15, errors, 3));
  set('radius', readNumber(bag, 'radius', at('radius'), 0, 28, errors, 0));
  set('buttonStyle', readEnum(bag, 'buttonStyle', at('buttonStyle'), ['solid', 'outline', 'soft', 'gradient'] as const, errors));
  set('buttonShape', readEnum(bag, 'buttonShape', at('buttonShape'), ['rounded', 'pill', 'square'] as const, errors));
  set('cardStyle', readEnum(bag, 'cardStyle', at('cardStyle'), ['flat', 'bordered', 'elevated', 'glass'] as const, errors));
  if (given(bag, 'shadow')) {
    if (bag.shadow === 0 || bag.shadow === 1 || bag.shadow === 2 || bag.shadow === 3) out.shadow = bag.shadow;
    else errors.add(at('shadow'), 'Choose a shadow from 0 to 3.');
  }
  set('layout', readEnum(bag, 'layout', at('layout'), ['split', 'stacked', 'centered'] as const, errors));
  set('calendarStyle', readEnum(bag, 'calendarStyle', at('calendarStyle'), ['grid', 'minimal', 'bubbles'] as const, errors));
  set('slotStyle', readEnum(bag, 'slotStyle', at('slotStyle'), ['list', 'grid', 'chips'] as const, errors));
  set('density', readEnum(bag, 'density', at('density'), ['comfortable', 'compact'] as const, errors));
  set('avatarShape', readEnum(bag, 'avatarShape', at('avatarShape'), ['circle', 'rounded', 'square'] as const, errors));
  set('showAvatar', readBool(bag, 'showAvatar', at('showAvatar'), errors));
  set('coverAssetId', readAssetId(bag, 'coverAssetId', at('coverAssetId'), current.coverAssetId, refs, errors));
  set('coverHeight', readNumber(bag, 'coverHeight', at('coverHeight'), 0, 480, errors, 0));
  set('logoAssetId', readAssetId(bag, 'logoAssetId', at('logoAssetId'), current.logoAssetId, refs, errors));
  set('timeFormat', readEnum(bag, 'timeFormat', at('timeFormat'), ['auto', '12h', '24h'] as const, errors));
  set('weekStart', readEnum(bag, 'weekStart', at('weekStart'), ['auto', 'sunday', 'monday'] as const, errors));
  set('animations', readEnum(bag, 'animations', at('animations'), ['none', 'subtle', 'lively'] as const, errors));
  set('confetti', readBool(bag, 'confetti', at('confetti'), errors));
  if (given(bag, 'texts')) set('texts', readTexts(bag.texts, at('texts'), errors));
  if (given(bag, 'customCss')) {
    const css = bag.customCss;
    if (typeof css !== 'string') errors.add(at('customCss'), 'Expected text here.');
    else if (Buffer.byteLength(css, 'utf8') > MAX_CUSTOM_CSS_BYTES) errors.add(at('customCss'), 'Custom CSS can be at most 20 kB. Please shorten it.');
    else out.customCss = cleanCustomCss(css);
  }
  set('hideBranding', readBool(bag, 'hideBranding', at('hideBranding'), errors));
  return out;
}

/**
 * The CSS as it is stored and later written into a <style> element: run through the shared
 * sanitiser, and with anything that could close that element removed once more for good measure.
 */
export function cleanCustomCss(css: string): string {
  let out = sanitizeCustomCss(css);
  // Repeat until stable, so a nested spelling ("</sty</stylele") cannot leave a closing tag behind.
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(/<\s*\/\s*style/gi, '');
  }
  return out.trim();
}

/** The stored theme with a validated patch laid over it. Nested groups merge field by field. */
export function mergeTheme(base: Theme, patch: ThemePatch): Theme {
  const { colors, darkColors, background, texts, ...top } = patch;
  const mergedColors: ThemeColors = { ...base.colors, ...(colors ?? {}) };
  let mergedDark: ThemeColors | null = base.darkColors ?? null;
  if (darkColors === null) mergedDark = null;
  else if (darkColors !== undefined) mergedDark = { ...(base.darkColors ?? mergedColors), ...darkColors };
  return {
    ...base,
    ...top,
    colors: mergedColors,
    darkColors: mergedDark,
    background: { ...base.background, ...(background ?? {}) },
    texts: { ...base.texts, ...(texts ?? {}) },
  };
}

export function themeAssetIds(theme: Partial<Theme> | null | undefined): ThemeAssetIds {
  return {
    coverAssetId: theme?.coverAssetId ?? null,
    logoAssetId: theme?.logoAssetId ?? null,
    backgroundImageAssetId: theme?.background?.imageAssetId ?? null,
  };
}

/** Drops empty nested groups so an override with nothing in it can be stored as null. */
export function compactOverride(patch: ThemePatch): Partial<Theme> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
      if (Object.keys(inner).length > 0) out[key] = inner;
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? (out as Partial<Theme>) : null;
}
