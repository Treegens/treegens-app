import { createContext, useContext, useEffect, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { BUILTIN_BRANDS, isBrandId } from '../../shared/brands';
import { DEFAULT_THEME } from '../../shared/defaults';
import { SHORT_LINKS, type ShortName } from '../../shared/shortLinks';
import { NO_ASSETS, googleFontsHref, googleFontsHrefFor, resolveTheme, sanitizeCustomCss, scopeCss, themeDataAttrs, themeToCssVars } from '../../shared/theme';
import type { ThemeAssets } from '../../shared/theme';
import type { Theme } from '../../shared/types';
import { PortalHost } from '../ui/Portal';
import { ToastProvider } from '../ui/Toast';
import { cx, useMediaQuery } from '../ui/util';
import { APP_BASE } from './api';
import { OWN_BOOT_THEME_KEY, STORAGE_KEYS, brandBootThemeKey, storageGetJson, storageSetJson } from './storage';
import { uses12h, weekStartsOn } from './tz';
import type { Weekday } from '../../shared/types';

// ───────────── font loading ─────────────

const loadedFontHrefs = new Set<string>();

/** Adds a Google Fonts stylesheet to <head> once. Safe to call during render effects. */
export function ensureFontStylesheet(href: string | null): void {
  if (!href || typeof document === 'undefined' || loadedFontHrefs.has(href)) return;
  loadedFontHrefs.add(href);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.mtgFont = '';
  document.head.appendChild(link);
}

/** Loads catalog fonts by key, e.g. to preview a font in the design editor before it is chosen. */
export function loadFonts(keys: string[]): void {
  ensureFontStylesheet(googleFontsHrefFor(keys));
}

// ───────────── boot theme cache ─────────────

interface BootTheme {
  theme: Theme;
  assets: ThemeAssets;
}

/**
 * The public theme seen on the last visit (or the default forest theme). Render loading
 * states inside <ThemeScope {...cachedTheme()}> so returning visitors never see a flash of
 * the wrong colours while the site settings load.
 */
export function cachedTheme(): BootTheme {
  return savedTheme(STORAGE_KEYS.bootTheme) ?? { theme: DEFAULT_THEME, assets: NO_ASSETS };
}

/** `ownOnly`: a look remembered from a brand's page does not count (a value from before brands has no `brand`). */
function savedTheme(key: string, opts?: { ownOnly?: boolean }): BootTheme | null {
  const saved = storageGetJson<BootTheme & { brand?: unknown }>(key);
  if (opts?.ownOnly && saved && isBrandId(saved.brand)) return null;
  if (saved && saved.theme && typeof saved.theme === 'object' && saved.theme.colors) {
    return { theme: resolveTheme(saved.theme), assets: { ...NO_ASSETS, ...(saved.assets ?? {}) } };
  }
  return null;
}

/**
 * The owner's own look seen last, for a short link in that look (jimicohen.com/meet): never a brand's look seen
 * since (after a visit to /pod, /meet still boots in Jimi's colours), else the default forest look.
 */
export function ownBootTheme(): BootTheme {
  return savedTheme(OWN_BOOT_THEME_KEY) ?? savedTheme(STORAGE_KEYS.bootTheme, { ownOnly: true }) ?? { theme: DEFAULT_THEME, assets: NO_ASSETS };
}

/** A built-in brand's look as it ships, with its built-in logo: for the moment before its page has data. */
export function builtinBrandTheme(brandId: string): BootTheme | null {
  if (!isBrandId(brandId)) return null;
  const brand = BUILTIN_BRANDS[brandId];
  return { theme: brand.theme, assets: { ...NO_ASSETS, logoUrl: `${APP_BASE}/${brand.art.logo}` } };
}

/**
 * The look of a short link's loading, offline and error screens, before the API answers: the look of the
 * link's brand seen last, else the brand's built-in look. A link in the owner's own look (/meet) boots in the
 * owner's look seen last, never in a brand's.
 */
export function shortBootTheme(name: ShortName): BootTheme {
  const brandId = SHORT_LINKS[name].brandId;
  if (!brandId) return ownBootTheme();
  return savedTheme(brandBootThemeKey(brandId)) ?? builtinBrandTheme(brandId) ?? cachedTheme();
}

function rememberTheme(theme: Theme, assets: ThemeAssets, bg: string, scheme: string, brandId?: string | null): void {
  // Data URLs (unsaved previews) are too big to cache and never appear on real public pages.
  const safe = (u: string | null) => (u && !u.startsWith('data:') ? u : null);
  const brand = brandId && isBrandId(brandId) ? brandId : null;
  const value = {
    theme: { ...theme, customCss: '' },
    assets: { coverUrl: safe(assets.coverUrl), logoUrl: safe(assets.logoUrl), backgroundUrl: safe(assets.backgroundUrl) },
    bg,
    scheme,
    brand,
  };
  // The look seen last, which a guest's manage page from an email boots in; and under its own key the look of
  // that brand, or the owner's own look, so each short link boots in its own (main.tsx prepaint, shortBootTheme).
  storageSetJson(STORAGE_KEYS.bootTheme, value);
  storageSetJson(brand ? brandBootThemeKey(brand) : OWN_BOOT_THEME_KEY, value);
}

// ───────────── theme context ─────────────

export interface ThemeContextValue {
  /** the resolved theme being rendered */
  theme: Theme;
  assets: ThemeAssets;
  /** true when the dark palette is active (scheme "auto" + visitor prefers dark) */
  dark: boolean;
  /** true when the page background is dark, whichever palette produced it */
  darkUi: boolean;
  /** theme.timeFormat resolved against the visitor's locale */
  hour12: boolean;
  /** theme.weekStart resolved against the visitor's locale: 0 Sunday, 1 Monday, 6 Saturday */
  weekStart: Weekday;
  /** false when the theme turns animations off or the visitor prefers reduced motion */
  motion: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The active public theme. Throws outside <ThemeScope>, because every public screen needs one. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used inside <ThemeScope>');
  return ctx;
}

/** Same as useTheme() but returns null outside a ThemeScope (for components shared with the dashboard). */
export function useThemeOptional(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

// ───────────── ThemeScope ─────────────

export interface ThemeScopeProps {
  /** site theme, already merged with any per-event override via resolveTheme() */
  theme: Theme;
  /** resolved image URLs (PublicSite.themeAssets). Data URLs work for unsaved previews. */
  assets?: ThemeAssets | null;
  /**
   * page      = owns the document: paints the page background behind everything, fills the
   *             viewport, sets the browser chrome colour and remembers the theme for next time.
   * contained = stays inside its parent box (the live preview in the design editor, the host page card).
   */
  mode?: 'page' | 'contained';
  /** ignore the visitor's colour-scheme preference (preview toggles) */
  forceScheme?: 'light' | 'dark';
  /**
   * false = do not paint the theme's page background (and leave the document background
   * transparent in page mode). For `?embed=1`, where the host site's own background shows through.
   */
  backdrop?: boolean;
  /** extra class on the scope element, e.g. your page layout class */
  className?: string;
  style?: CSSProperties;
  /**
   * false = do not remember this look for the next first paint. For loading, offline and error screens shown
   * before the page has its data: their look is only a guess, and must not become the next visit's.
   */
  remember?: boolean;
  /** the brand this look belongs to (PublicSite.brand), remembered under its own key as well */
  brandId?: string | null;
  children: ReactNode;
}

/**
 * Applies a Theme to everything inside it:
 *  - sets every `--m-*` CSS variable and the `data-*` switches (data-layout, data-calendar, ...)
 *    on a `.m-scope` wrapper, which also maps them to the `--c-*` variables the UI kit reads
 *  - loads the theme's Google Fonts
 *  - follows the visitor's dark mode when the theme's scheme is "auto"
 *  - applies the owner's custom CSS, sanitised and scoped to `.m-scope`
 *  - hosts overlays (Modal, Menu, Toast, ...) so they are themed too, and provides useToast()
 */
export function ThemeScope({ theme, assets, mode = 'page', forceScheme, backdrop = true, className, style, remember = true, brandId = null, children }: ThemeScopeProps) {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // Callers often build the theme inline (resolveTheme(site.theme, event.themeOverride)), so key
  // the memo on content rather than identity: everything below then only recomputes on real changes.
  const themeKey = JSON.stringify(theme);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => resolveTheme(theme), [themeKey]);
  const coverUrl = assets?.coverUrl ?? null;
  const logoUrl = assets?.logoUrl ?? null;
  const backgroundUrl = assets?.backgroundUrl ?? null;
  const a = useMemo<ThemeAssets>(() => ({ coverUrl, logoUrl, backgroundUrl }), [coverUrl, logoUrl, backgroundUrl]);
  const wantsDark = forceScheme ? forceScheme === 'dark' : prefersDark;
  const dark = resolved.scheme === 'auto' && !!resolved.darkColors && wantsDark;

  const vars = useMemo(() => themeToCssVars(resolved, a, dark), [resolved, a, dark]);
  const attrs = useMemo(() => themeDataAttrs(resolved, dark), [resolved, dark]);
  const fontsHref = useMemo(() => googleFontsHref(resolved), [resolved]);
  const css = useMemo(() => {
    const clean = sanitizeCustomCss(resolved.customCss);
    return clean ? scopeCss(clean, '.m-scope') : '';
  }, [resolved.customCss]);

  useEffect(() => ensureFontStylesheet(fontsHref), [fontsHref]);

  const bg = vars['--m-bg'];
  const scheme = vars['--m-color-scheme'];
  useEffect(() => {
    if (mode !== 'page') return;
    const root = document.documentElement;
    const prevBg = root.style.backgroundColor;
    const prevScheme = root.style.colorScheme;
    root.style.backgroundColor = backdrop ? bg : 'transparent';
    root.style.colorScheme = scheme;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    const prevMeta = meta.content;
    meta.content = bg;
    return () => {
      root.style.backgroundColor = prevBg;
      root.style.colorScheme = prevScheme;
      if (created) meta?.remove();
      else if (meta) meta.content = prevMeta;
    };
  }, [mode, bg, scheme, backdrop]);

  useEffect(() => {
    if (mode === 'page' && backdrop && remember) rememberTheme(resolved, a, bg, scheme, brandId);
  }, [mode, backdrop, remember, brandId, resolved, a, bg, scheme]);

  const context = useMemo<ThemeContextValue>(
    () => ({
      theme: resolved,
      assets: a,
      dark,
      darkUi: attrs['data-scheme'] === 'dark',
      hour12: resolved.timeFormat === 'auto' ? uses12h() : resolved.timeFormat === '12h',
      weekStart: resolved.weekStart === 'auto' ? weekStartsOn() : resolved.weekStart === 'monday' ? 1 : 0,
      motion: resolved.animations !== 'none' && !reducedMotion,
    }),
    [resolved, a, dark, attrs, reducedMotion],
  );

  return (
    <ThemeContext.Provider value={context}>
      <PortalHost className="m-scope" style={vars as CSSProperties} attrs={attrs}>
        <ToastProvider>
          <div
            className={cx('m-scope', mode === 'page' ? 'm-page' : 'm-contained', !backdrop && 'm-bare', className)}
            style={{ ...(vars as CSSProperties), ...style }}
            {...attrs}
          >
            {backdrop ? <div className="m-backdrop" aria-hidden="true" /> : null}
            {css ? <style>{css}</style> : null}
            {children}
          </div>
        </ToastProvider>
      </PortalHost>
    </ThemeContext.Provider>
  );
}

// ───────────── AdminScope ─────────────

export interface AdminScopeProps {
  /** auto follows the device. light / dark pin the dashboard palette. */
  colorScheme?: 'auto' | 'light' | 'dark';
  className?: string;
  children: ReactNode;
}

/**
 * The dashboard's counterpart to ThemeScope: an `.a-scope` wrapper that maps the `--a-*`
 * tokens (light and dark, see ui.css) to the UI kit's `--c-*` variables, loads the dashboard
 * fonts, hosts overlays and provides useToast().
 */
export function AdminScope({ colorScheme = 'auto', className, children }: AdminScopeProps) {
  useEffect(() => loadFonts(['inter', 'fraunces']), []);

  useEffect(() => {
    const root = document.documentElement;
    const prevSurface = root.dataset.surface;
    const prevTheme = root.dataset.aTheme;
    root.dataset.surface = 'admin';
    if (colorScheme === 'auto') delete root.dataset.aTheme;
    else root.dataset.aTheme = colorScheme;
    return () => {
      if (prevSurface === undefined) delete root.dataset.surface;
      else root.dataset.surface = prevSurface;
      if (prevTheme === undefined) delete root.dataset.aTheme;
      else root.dataset.aTheme = prevTheme;
    };
  }, [colorScheme]);

  return (
    <PortalHost className="a-scope">
      <ToastProvider>
        <div className={cx('a-scope a-page', className)}>{children}</div>
      </ToastProvider>
    </PortalHost>
  );
}
