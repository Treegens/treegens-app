/**
 * Every field of a Theme, with the right control for each, grouped the way people think about
 * a page: presets, colours, background, type, shape, layout, calendar, images, wording, advanced.
 *
 * Controlled: each edit calls `onChange(next, { key })` with the complete next theme. `key`
 * names the control that changed, so the page can fold a slider drag into one undo step.
 * With a `baseline` (the saved theme) every control that differs gets its own reset button.
 */
import { useId, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  CalendarDays,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Code2,
  Image as ImageIcon,
  LayoutTemplate,
  Moon,
  Paintbrush,
  Palette,
  Shapes,
  Sparkles,
  Sun,
  TextCursorInput,
  Type,
  Wand2,
} from 'lucide-react';
import { DEFAULT_THEME } from '../../../shared/defaults';
import { applyPreset, fontByKey, presetByKey } from '../../../shared/presets';
import {
  NO_ASSETS,
  colorDistance,
  deriveDarkColors,
  ensureContrast,
  isDark,
  isHex,
  mix,
  normalizeHex,
  sanitizeCustomCss,
  themeToCssVars,
} from '../../../shared/theme';
import type { ThemeAssets } from '../../../shared/theme';
import type { Theme, ThemeBackground, ThemeColors } from '../../../shared/types';
import { Badge, Button, ColorInput, Input, SegmentedControl, Slider, Switch, Textarea, cx } from '../../ui';
import { sameJson } from '../format';
import { FontPicker } from './x/FontPicker';
import { PresetGallery } from './x/PresetGallery';
import { Control, ImageField, OptionTiles } from './x/bits';
import { contrastChecks, formatRatio } from './x/contrast';
import { CalendarGlyph, CardGlyph, LayoutGlyph, SlotGlyph } from './x/glyphs';

export interface ThemeChangeMeta {
  /** which control changed: consecutive changes with the same key are one undo step */
  key: string;
}

export type ThemeGroupId = 'presets' | 'colours' | 'background' | 'type' | 'shape' | 'layout' | 'calendar' | 'images' | 'wording' | 'advanced';

export interface ThemeControlsProps {
  /** the draft theme being edited */
  theme: Theme;
  onChange: (next: Theme, meta?: ThemeChangeMeta) => void;
  /** preview URLs for cover / logo / background (data URLs right after picking a file) */
  assets?: ThemeAssets;
  onAssetsChange?: (next: ThemeAssets) => void;
  /** the saved theme: turns on per-control reset and the "changed" markers */
  baseline?: Theme;
  /** called after an image upload so the page can map the new asset id to a preview URL */
  onAssetUploaded?: (id: string, url: string) => void;
  /** which palette is being edited when the scheme is "auto" */
  palette?: 'light' | 'dark';
  onPaletteChange?: (palette: 'light' | 'dark') => void;
  /** groups that start open */
  defaultOpen?: ThemeGroupId[];
}

/** Fields that make up "the look". Touching one of them turns a preset into a custom theme. */
const LOOK_KEYS: (keyof Theme)[] = [
  'scheme',
  'colors',
  'darkColors',
  'background',
  'fontHeading',
  'fontBody',
  'fontScale',
  'radius',
  'buttonStyle',
  'buttonShape',
  'cardStyle',
  'shadow',
  'layout',
  'calendarStyle',
  'slotStyle',
  'density',
  'avatarShape',
  'animations',
  'confetti',
];

const COLOR_FIELDS: { key: keyof ThemeColors; label: string; hint: string }[] = [
  { key: 'primary', label: 'Brand', hint: 'Buttons, selected days and links' },
  { key: 'accent', label: 'Accent', hint: 'Small highlights' },
  { key: 'background', label: 'Page', hint: 'Behind everything' },
  { key: 'surface', label: 'Cards', hint: 'The booking card' },
  { key: 'text', label: 'Text', hint: 'Headings and body' },
  { key: 'muted', label: 'Secondary text', hint: 'Hints and small print' },
  { key: 'border', label: 'Lines', hint: 'Borders and dividers' },
];

const TEXT_LIMITS = { ctaLabel: 40, pickTimeLabel: 40, confirmationTitle: 60, confirmationBody: 400, footerNote: 240 } as const;
const MAX_CSS = 20000;

/** A readable light palette for a theme that started dark, for "Light and dark" mode. */
function deriveLightColors(c: ThemeColors): ThemeColors {
  const background = mix('#faf9f5', c.primary, 0.03);
  const surface = '#ffffff';
  return {
    background,
    surface,
    text: mix('#171a1d', c.primary, 0.08),
    muted: mix('#5c636b', c.primary, 0.06),
    border: mix(background, '#000000', 0.1),
    primary: ensureContrast(mix(c.primary, '#000000', 0.3), [background, surface], 4.5),
    accent: ensureContrast(mix(c.accent, '#000000', 0.25), [background, surface], 3),
  };
}

function lookOf(t: Theme): Partial<Theme> {
  const out: Record<string, unknown> = {};
  for (const k of LOOK_KEYS) out[k] = t[k];
  return out as Partial<Theme>;
}

interface GroupProps {
  id: ThemeGroupId;
  title: string;
  icon: ReactNode;
  summary?: ReactNode;
  /** number of settings in the group that differ from the saved theme */
  changed?: number;
  /** number of things that need attention */
  problems?: number;
  open: boolean;
  onToggle: (id: ThemeGroupId) => void;
  children: ReactNode;
}

function Group({ id, title, icon, summary, changed = 0, problems = 0, open, onToggle, children }: GroupProps) {
  const base = useId();
  return (
    <section className={cx('dx-group', open && 'is-open')} data-group={id}>
      <h2 className="dx-group__h">
        <button type="button" className="dx-group__head" aria-expanded={open} aria-controls={`${base}-panel`} id={`${base}-head`} onClick={() => onToggle(id)}>
          <span className="dx-group__icon" aria-hidden="true">
            {icon}
          </span>
          <span className="dx-group__title">{title}</span>
          {problems > 0 ? (
            <span className="dx-group__warn">
              <CircleAlert size={13} aria-hidden="true" />
              <span className="u-vh">{problems === 1 ? '1 thing to check' : `${problems} things to check`}</span>
            </span>
          ) : null}
          {changed > 0 ? (
            <span className="dx-group__changed">
              <span className="dx-group__dot" aria-hidden="true" />
              <span className="u-vh">{changed === 1 ? '1 unsaved change' : `${changed} unsaved changes`}</span>
            </span>
          ) : null}
          {summary && !open ? <span className="dx-group__summary">{summary}</span> : null}
          <ChevronDown size={16} aria-hidden="true" className="dx-group__chev" />
        </button>
      </h2>
      {open ? (
        <div className="dx-group__body" id={`${base}-panel`} role="region" aria-labelledby={`${base}-head`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function ThemeControls({ theme, onChange, assets, onAssetsChange, baseline, onAssetUploaded, palette = 'light', onPaletteChange, defaultOpen = ['presets'] }: ThemeControlsProps) {
  const [open, setOpen] = useState<Set<ThemeGroupId>>(() => new Set(defaultOpen));
  const base = baseline ?? null;
  const a = assets ?? NO_ASSETS;
  const bg = theme.background ?? DEFAULT_THEME.background;
  const auto = theme.scheme === 'auto';
  const editingDark = auto && palette === 'dark' && !!theme.darkColors;
  const colors: ThemeColors = editingDark && theme.darkColors ? theme.darkColors : theme.colors;
  const baseColors: ThemeColors | null = base ? (editingDark ? (base.darkColors ?? null) : base.colors) : null;

  const toggle = (id: ThemeGroupId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openGroup = (id: ThemeGroupId) => {
    setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-group="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  /** Applies a patch. Look changes turn the preset into "custom", unless the look is back to the saved one. */
  const set = (patch: Partial<Theme>, key: string) => {
    const touchesLook = (Object.keys(patch) as (keyof Theme)[]).some((k) => LOOK_KEYS.includes(k));
    const next: Theme = { ...theme, ...patch };
    if (touchesLook) {
      const preset = presetByKey(theme.preset);
      if (base && sameJson(lookOf(next), lookOf(base))) next.preset = base.preset;
      else if (preset && sameJson(lookOf(next), lookOf(preset.theme))) next.preset = preset.key;
      else next.preset = 'custom';
    }
    onChange(next, { key });
  };

  const changed = (k: keyof Theme) => !!base && !sameJson(theme[k], base[k]);
  const reset = (k: keyof Theme) => () => {
    if (base) set({ [k]: base[k] } as Partial<Theme>, `reset:${k}`);
  };

  // ── colours
  /** `step` names the undo step. Typing in one field is one step; a press of "Fix" is a step of its own. */
  const setColor = (field: keyof ThemeColors, value: string, step = 'color') => {
    if (editingDark && theme.darkColors) {
      set({ darkColors: { ...theme.darkColors, [field]: value } }, `${step === 'color' ? 'dark' : `${step}:dark`}:${field}`);
      return;
    }
    const nextColors = { ...theme.colors, [field]: value };
    const patch: Partial<Theme> = { colors: nextColors };
    // A gradient that starts at the page colour should follow the page colour, otherwise changing
    // "Page" would seem to do nothing on the default look.
    if (field === 'background' && bg.type !== 'solid' && bg.type !== 'image' && isHex(bg.gradientFrom) && isHex(value)) {
      const old = normalizeHex(theme.colors.background);
      if (normalizeHex(bg.gradientFrom) === old) {
        const follow: ThemeBackground = { ...bg, gradientFrom: value };
        if (isHex(bg.gradientTo) && colorDistance(bg.gradientTo as string, old) < 64) {
          follow.gradientTo = mix(mix(value, nextColors.primary, 0.08), isDark(value) ? '#ffffff' : '#000000', 0.035);
        }
        patch.background = follow;
      }
    }
    set(patch, `${step}:${field}`);
  };

  const colorChanged = (field: keyof ThemeColors) => !!baseColors && normalizeHex(colors[field]) !== normalizeHex(baseColors[field]);

  const setScheme = (next: Theme['scheme']) => {
    if (next === theme.scheme) return;
    if (next === 'fixed') {
      set({ scheme: 'fixed' }, 'scheme');
      onPaletteChange?.('light');
      return;
    }
    // Light and dark: keep what the owner has as one side and derive the other.
    if (theme.darkColors) {
      set({ scheme: 'auto' }, 'scheme');
    } else if (isDark(theme.colors.background)) {
      // The current colours become the dark side. Gradient stops belong to the light palette, so
      // they are rebuilt from the new light Page colour.
      const light = deriveLightColors(theme.colors);
      const stops = bg.type === 'gradient' || bg.type === 'mesh' || bg.type === 'pattern';
      const background: ThemeBackground = stops ? { ...bg, gradientFrom: light.background, gradientTo: mix(light.background, light.primary, 0.1) } : bg;
      set({ scheme: 'auto', darkColors: { ...theme.colors }, colors: light, background }, 'scheme');
    } else {
      set({ scheme: 'auto', darkColors: deriveDarkColors(theme.colors) }, 'scheme');
    }
  };

  const checks = useMemo(() => contrastChecks(colors), [colors]);
  const colourProblems = checks.filter((c) => c.level !== 'good').length;
  const coloursChanged = (changed('colors') ? 1 : 0) + (changed('darkColors') ? 1 : 0) + (changed('scheme') ? 1 : 0);

  // ── background
  const setBg = (patch: Partial<ThemeBackground>, key: string) => set({ background: { ...bg, ...patch } }, `bg:${key}`);
  const bgChanged = (k: keyof ThemeBackground) => !!base && !sameJson(bg[k] ?? null, base.background?.[k] ?? null);
  const resetBg = (k: keyof ThemeBackground) => () => {
    if (base) setBg({ [k]: base.background?.[k] } as Partial<ThemeBackground>, `reset:${k}`);
  };
  const usesStops = bg.type === 'gradient' || bg.type === 'mesh' || bg.type === 'pattern';

  const bgArt = useMemo(() => {
    const swatch = (background: ThemeBackground): CSSProperties => {
      const v = themeToCssVars({ ...theme, background }, a);
      return {
        backgroundColor: v['--m-bg'],
        backgroundImage: v['--m-bg-image'],
        backgroundSize: v['--m-bg-size'],
        backgroundPosition: v['--m-bg-position'],
        backgroundRepeat: v['--m-bg-repeat'],
      };
    };
    const from = isHex(bg.gradientFrom) ? (bg.gradientFrom as string) : theme.colors.background;
    const to = isHex(bg.gradientTo) && normalizeHex(bg.gradientTo) !== normalizeHex(from) ? (bg.gradientTo as string) : mix(from, theme.colors.primary, 0.3);
    const stops = { gradientFrom: from, gradientTo: to, gradientAngle: bg.gradientAngle ?? 160 };
    return {
      types: {
        solid: swatch({ ...bg, type: 'solid' }),
        gradient: swatch({ ...bg, ...stops, type: 'gradient' }),
        mesh: swatch({ ...bg, ...stops, type: 'mesh' }),
        pattern: swatch({ ...bg, type: 'pattern', pattern: bg.pattern && bg.pattern !== 'none' ? bg.pattern : 'dots' }),
        image: a.backgroundUrl ? ({ backgroundImage: `url("${a.backgroundUrl.replace(/["\\\n\r]/g, '')}")`, backgroundSize: 'cover', backgroundPosition: 'center' } as CSSProperties) : swatch({ ...bg, type: 'solid' }),
      },
      patterns: (['dots', 'grid', 'waves', 'topo', 'leaves'] as const).reduce(
        (acc, p) => {
          acc[p] = swatch({ ...bg, type: 'pattern', pattern: p });
          return acc;
        },
        {} as Record<string, CSSProperties>,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(theme.colors), JSON.stringify(bg), a.backgroundUrl]);

  const setBgType = (type: ThemeBackground['type']) => {
    const patch: Partial<ThemeBackground> = { type };
    if (type === 'gradient' || type === 'mesh') {
      const from = isHex(bg.gradientFrom) ? (bg.gradientFrom as string) : theme.colors.background;
      if (!isHex(bg.gradientFrom)) patch.gradientFrom = from;
      // A gradient between two identical colours looks like nothing happened: give it somewhere to go.
      if (!isHex(bg.gradientTo) || normalizeHex(bg.gradientTo) === normalizeHex(from)) patch.gradientTo = mix(from, theme.colors.primary, isDark(from) ? 0.22 : 0.16);
      if (bg.gradientAngle === undefined) patch.gradientAngle = 160;
    }
    if (type === 'pattern' && (!bg.pattern || bg.pattern === 'none')) patch.pattern = 'dots';
    setBg(patch, 'type');
  };

  // ── images
  const uploaded = (kind: 'cover' | 'logo' | 'background') => (asset: { id: string; url: string; dataUrl: string }) => {
    const url = asset.dataUrl || asset.url;
    onAssetUploaded?.(asset.id, url);
    if (kind === 'cover') {
      onAssetsChange?.({ ...a, coverUrl: url });
      set({ coverAssetId: asset.id, coverHeight: theme.coverHeight > 0 ? theme.coverHeight : 180 }, 'cover');
    } else if (kind === 'logo') {
      onAssetsChange?.({ ...a, logoUrl: url });
      set({ logoAssetId: asset.id }, 'logo');
    } else {
      onAssetsChange?.({ ...a, backgroundUrl: url });
      set({ background: { ...bg, type: 'image', imageAssetId: asset.id } }, 'bg:image');
    }
  };

  // ── wording
  const setText = (k: keyof Theme['texts'], value: string) => set({ texts: { ...theme.texts, [k]: value } }, `text:${k}`);
  const textChanged = (k: keyof Theme['texts']) => !!base && (theme.texts?.[k] ?? '') !== (base.texts?.[k] ?? '');
  const resetText = (k: keyof Theme['texts']) => () => {
    if (base) setText(k, base.texts?.[k] ?? '');
  };

  const css = theme.customCss ?? '';
  const cssCleaned = useMemo(() => sanitizeCustomCss(css), [css]);
  const cssStripped = css.trim() !== '' && cssCleaned !== css.trim();

  const count = (...keys: (keyof Theme)[]) => keys.filter((k) => changed(k)).length;
  const presetLabel = presetByKey(theme.preset)?.label ?? 'Custom';
  const heading = fontByKey(theme.fontHeading);
  const body = fontByKey(theme.fontBody);

  return (
    <div className="dx-controls">
      <Group id="presets" title="Presets" icon={<Sparkles size={16} />} summary={presetLabel} changed={changed('preset') ? 1 : 0} open={open.has('presets')} onToggle={toggle}>
        <p className="dx-note">A preset changes the whole look in one go. Your wording, logo and images stay as they are.</p>
        <PresetGallery value={theme.preset} onPick={(key) => onChange(applyPreset(theme, key), { key: `preset:${key}` })} />
        {theme.preset === 'custom' ? (
          <p className="dx-note dx-note--quiet">
            <Wand2 size={14} aria-hidden="true" />
            You are on a custom look. Picking a preset replaces colours, fonts and shapes.
          </p>
        ) : null}
      </Group>

      <Group id="colours" title="Colours" icon={<Palette size={16} />} summary={<Swatches colors={theme.colors} />} changed={coloursChanged} problems={colourProblems} open={open.has('colours')} onToggle={toggle}>
        <Control label="Palettes" changed={changed('scheme')} onReset={reset('scheme')} hint={auto ? 'Visitors get the palette that matches their device setting.' : 'Everyone sees the same colours.'}>
          <SegmentedControl<Theme['scheme']>
            aria-label="Palettes"
            block
            size="sm"
            value={theme.scheme}
            onChange={setScheme}
            options={[
              { value: 'fixed', label: 'One palette' },
              { value: 'auto', label: 'Light and dark' },
            ]}
          />
        </Control>

        {auto && theme.darkColors ? (
          <div className="dx-palette">
            <SegmentedControl<'light' | 'dark'>
              aria-label="Palette to edit"
              block
              size="sm"
              value={editingDark ? 'dark' : 'light'}
              onChange={(p) => onPaletteChange?.(p)}
              options={[
                { value: 'light', label: 'Light', icon: <Sun size={14} /> },
                { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
              ]}
            />
          </div>
        ) : null}

        <div className="dx-colors">
          {COLOR_FIELDS.map((f) => (
            <Control key={f.key} label={f.label} ownLabel changed={colorChanged(f.key)} onReset={() => baseColors && setColor(f.key, baseColors[f.key])} className="dx-color">
              <ColorInput label={f.label} value={colors[f.key]} onChange={(hex) => setColor(f.key, hex)} />
              <p className="dx-color__hint">{f.hint}</p>
            </Control>
          ))}
        </div>

        {usesStops && !editingDark ? (
          <p className="dx-note dx-note--quiet">
            Your page background is a {bg.type === 'mesh' ? 'soft glow' : bg.type}. Its colours live under{' '}
            <button type="button" className="dx-linkbtn" onClick={() => openGroup('background')}>
              Background
            </button>
            .
          </p>
        ) : null}

        <div className="dx-contrast" role="group" aria-label="Readability">
          <p className="dx-contrast__title">
            Readability
            {colourProblems === 0 ? (
              <Badge tone="success" size="sm" icon={<CircleCheck size={12} />}>
                All good
              </Badge>
            ) : (
              <Badge tone="warning" size="sm" icon={<CircleAlert size={12} />}>
                {colourProblems === 1 ? '1 to check' : `${colourProblems} to check`}
              </Badge>
            )}
          </p>
          <ul role="list" className="dx-contrast__list">
            {checks.map((c) => (
              <li key={c.id} className={cx('dx-contrast__row', `is-${c.level}`)}>
                <span className="dx-contrast__chip" style={{ background: c.bg, color: c.fg, borderColor: colors.border }} aria-hidden="true">
                  {c.id === 'primary' ? <span className="dx-contrast__blob" style={{ background: c.fg }} /> : 'Aa'}
                </span>
                <span className="dx-contrast__text">
                  <span className="dx-contrast__label">{c.label}</span>
                  <span className="dx-contrast__detail">{c.problem ?? (c.id === 'primary' ? 'Stands out clearly.' : 'Easy to read.')}</span>
                </span>
                <span className="dx-contrast__ratio" title={`Contrast ${formatRatio(c.ratio)}, aim for ${c.target}:1 or more`}>
                  {formatRatio(c.ratio)}
                </span>
                {c.fixed ? (
                  <Button size="sm" variant="secondary" onClick={() => setColor(c.field, c.fixed![c.field], 'fix')} aria-label={`Fix: ${c.label}`}>
                    Fix
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="dx-contrast__foot">Button labels and text on the page background adjust themselves to stay readable.</p>
        </div>

        {auto ? (
          <div className="dx-inline">
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<Wand2 size={14} />}
              onClick={() => {
                set({ darkColors: deriveDarkColors(theme.colors) }, 'dark:derive');
                onPaletteChange?.('dark');
              }}
            >
              Build the dark palette from the light one
            </Button>
          </div>
        ) : null}
      </Group>

      <Group id="background" title="Background" icon={<Paintbrush size={16} />} summary={BG_LABEL[bg.type]} changed={changed('background') ? 1 : 0} open={open.has('background')} onToggle={toggle}>
        <Control label="Style" changed={bgChanged('type')} onReset={resetBg('type')}>
          <OptionTiles<ThemeBackground['type']>
            label="Background style"
            columns={5}
            compact
            value={bg.type}
            onChange={setBgType}
            options={[
              { value: 'solid', label: 'Solid', artStyle: bgArt.types.solid },
              { value: 'gradient', label: 'Gradient', artStyle: bgArt.types.gradient },
              { value: 'mesh', label: 'Glow', artStyle: bgArt.types.mesh },
              { value: 'pattern', label: 'Pattern', artStyle: bgArt.types.pattern },
              { value: 'image', label: 'Image', artStyle: bgArt.types.image, art: a.backgroundUrl ? undefined : <ImageIcon size={16} /> },
            ]}
          />
        </Control>

        {bg.type === 'solid' ? <p className="dx-note dx-note--quiet">The page uses your Page colour from Colours.</p> : null}

        {bg.type === 'pattern' ? (
          <Control label="Pattern" changed={bgChanged('pattern')} onReset={resetBg('pattern')}>
            <OptionTiles<NonNullable<ThemeBackground['pattern']>>
              label="Pattern"
              columns={5}
              compact
              value={bg.pattern ?? 'dots'}
              onChange={(pattern) => setBg({ pattern }, 'pattern')}
              options={[
                { value: 'dots', label: 'Dots', artStyle: bgArt.patterns.dots },
                { value: 'grid', label: 'Grid', artStyle: bgArt.patterns.grid },
                { value: 'waves', label: 'Waves', artStyle: bgArt.patterns.waves },
                { value: 'topo', label: 'Contours', artStyle: bgArt.patterns.topo },
                { value: 'leaves', label: 'Leaves', artStyle: bgArt.patterns.leaves },
              ]}
            />
          </Control>
        ) : null}

        {usesStops ? (
          <>
            <div className="dx-colors">
              <Control label="From" ownLabel changed={bgChanged('gradientFrom')} onReset={resetBg('gradientFrom')} className="dx-color">
                <ColorInput label={bg.type === 'pattern' ? 'Base colour' : 'From'} value={isHex(bg.gradientFrom) ? (bg.gradientFrom as string) : theme.colors.background} onChange={(hex) => setBg({ gradientFrom: hex }, 'from')} />
              </Control>
              <Control label="To" ownLabel changed={bgChanged('gradientTo')} onReset={resetBg('gradientTo')} className="dx-color">
                <ColorInput label={bg.type === 'pattern' ? 'Fades to' : 'To'} value={isHex(bg.gradientTo) ? (bg.gradientTo as string) : theme.colors.background} onChange={(hex) => setBg({ gradientTo: hex }, 'to')} />
              </Control>
            </div>
            <Control label="Direction" ownLabel changed={bgChanged('gradientAngle')} onReset={resetBg('gradientAngle')}>
              <Slider label="Direction" min={0} max={360} step={5} value={bg.gradientAngle ?? 160} formatValue={(v) => `${v}°`} onChange={(gradientAngle) => setBg({ gradientAngle }, 'angle')} />
            </Control>
            {auto ? <p className="dx-note dx-note--quiet">These colours belong to the light palette. In dark mode the background is built from the dark Page colour.</p> : null}
          </>
        ) : null}

        {bg.type === 'image' ? (
          <>
            <ImageField
              label="Background image"
              shape="wide"
              purpose="background"
              url={a.backgroundUrl}
              hint="A wide photo works best. PNG, JPEG, WebP or GIF, up to 3 MB."
              onUploaded={uploaded('background')}
              onRemove={() => {
                onAssetsChange?.({ ...a, backgroundUrl: null });
                setBg({ imageAssetId: null }, 'image');
              }}
            />
            {a.backgroundUrl ? (
              <>
                <Control label="Colour wash" ownLabel changed={bgChanged('overlayOpacity')} onReset={resetBg('overlayOpacity')} hint="A layer of your Page colour over the photo keeps text readable.">
                  <Slider label="Colour wash" min={0} max={1} step={0.05} value={bg.overlayOpacity ?? 0.4} formatValue={pct} onChange={(overlayOpacity) => setBg({ overlayOpacity }, 'overlay')} />
                </Control>
                <Control label="Blur" ownLabel changed={bgChanged('blur')} onReset={resetBg('blur')}>
                  <Slider label="Blur" min={0} max={40} step={1} value={bg.blur ?? 0} formatValue={(v) => (v === 0 ? 'Off' : `${v}px`)} onChange={(blur) => setBg({ blur }, 'blur')} />
                </Control>
              </>
            ) : (
              <p className="dx-note dx-note--quiet">Until you upload an image the page shows your Page colour.</p>
            )}
          </>
        ) : null}
      </Group>

      <Group
        id="type"
        title="Typography"
        icon={<Type size={16} />}
        summary={heading.key === body.key ? heading.label : `${heading.label} + ${body.label}`}
        changed={count('fontHeading', 'fontBody', 'fontScale')}
        open={open.has('type')}
        onToggle={toggle}
      >
        <Control label="Headings" changed={changed('fontHeading')} onReset={reset('fontHeading')}>
          <FontPicker label="Heading font" value={theme.fontHeading} sample="Book a meeting" onChange={(fontHeading) => set({ fontHeading }, 'fontHeading')} />
        </Control>
        <Control label="Body text" changed={changed('fontBody')} onReset={reset('fontBody')}>
          <FontPicker label="Body font" value={theme.fontBody} sample="Pick a time that suits you" onChange={(fontBody) => set({ fontBody }, 'fontBody')} />
        </Control>
        <Control label="Text size" ownLabel changed={changed('fontScale')} onReset={reset('fontScale')}>
          <Slider label="Text size" min={0.9} max={1.15} step={0.01} value={theme.fontScale} formatValue={pct} onChange={(fontScale) => set({ fontScale }, 'fontScale')} />
        </Control>
      </Group>

      <Group id="shape" title="Shape" icon={<Shapes size={16} />} summary={`${theme.radius}px corners`} changed={count('radius', 'buttonStyle', 'buttonShape', 'cardStyle', 'shadow', 'avatarShape', 'showAvatar')} open={open.has('shape')} onToggle={toggle}>
        <Control label="Corner radius" ownLabel changed={changed('radius')} onReset={reset('radius')}>
          <Slider label="Corner radius" min={0} max={28} step={1} value={theme.radius} formatValue={(v) => (v === 0 ? 'Sharp' : `${v}px`)} onChange={(radius) => set({ radius }, 'radius')} />
        </Control>
        <Control label="Button fill" changed={changed('buttonStyle')} onReset={reset('buttonStyle')}>
          <OptionTiles<Theme['buttonStyle']>
            label="Button fill"
            columns={4}
            value={theme.buttonStyle}
            onChange={(buttonStyle) => set({ buttonStyle }, 'buttonStyle')}
            options={(['solid', 'outline', 'soft', 'gradient'] as const).map((v) => ({
              value: v,
              label: v === 'solid' ? 'Solid' : v === 'outline' ? 'Outline' : v === 'soft' ? 'Soft' : 'Gradient',
              art: <span className={`dx-btnart dx-btnart--${v}`} />,
            }))}
          />
        </Control>
        <Control label="Button shape" changed={changed('buttonShape')} onReset={reset('buttonShape')}>
          <OptionTiles<Theme['buttonShape']>
            label="Button shape"
            columns={3}
            value={theme.buttonShape}
            onChange={(buttonShape) => set({ buttonShape }, 'buttonShape')}
            options={[
              { value: 'rounded', label: 'Rounded', art: <span className="dx-btnart dx-btnart--solid dx-btnart--rounded" /> },
              { value: 'pill', label: 'Pill', art: <span className="dx-btnart dx-btnart--solid dx-btnart--pill" /> },
              { value: 'square', label: 'Square', art: <span className="dx-btnart dx-btnart--solid dx-btnart--square" /> },
            ]}
          />
        </Control>
        <Control label="Cards" changed={changed('cardStyle')} onReset={reset('cardStyle')}>
          <OptionTiles<Theme['cardStyle']>
            label="Card style"
            columns={4}
            value={theme.cardStyle}
            onChange={(cardStyle) => set({ cardStyle }, 'cardStyle')}
            options={[
              { value: 'flat', label: 'Flat', art: <CardGlyph value="flat" /> },
              { value: 'bordered', label: 'Outlined', art: <CardGlyph value="bordered" /> },
              { value: 'elevated', label: 'Raised', art: <CardGlyph value="elevated" /> },
              { value: 'glass', label: 'Glass', art: <CardGlyph value="glass" /> },
            ]}
          />
        </Control>
        <Control label="Shadow" changed={changed('shadow')} onReset={reset('shadow')}>
          <SegmentedControl<'0' | '1' | '2' | '3'>
            aria-label="Shadow"
            block
            size="sm"
            value={String(theme.shadow) as '0' | '1' | '2' | '3'}
            onChange={(v) => set({ shadow: Number(v) as Theme['shadow'] }, 'shadow')}
            options={[
              { value: '0', label: 'None' },
              { value: '1', label: 'Soft' },
              { value: '2', label: 'Medium' },
              { value: '3', label: 'Deep' },
            ]}
          />
        </Control>
        <Control label="Host photo" changed={changed('avatarShape') || changed('showAvatar')} onReset={() => base && set({ avatarShape: base.avatarShape, showAvatar: base.showAvatar }, 'reset:avatar')}>
          <OptionTiles<Theme['avatarShape']>
            label="Photo shape"
            columns={3}
            value={theme.avatarShape}
            onChange={(avatarShape) => set({ avatarShape }, 'avatarShape')}
            options={[
              { value: 'circle', label: 'Circle', art: <span className="dx-avatarart dx-avatarart--circle" /> },
              { value: 'rounded', label: 'Rounded', art: <span className="dx-avatarart dx-avatarart--rounded" /> },
              { value: 'square', label: 'Square', art: <span className="dx-avatarart dx-avatarart--square" /> },
            ]}
          />
          <Switch size="sm" labelSide="start" label="Show host photos" checked={theme.showAvatar} onChange={(showAvatar) => set({ showAvatar }, 'showAvatar')} className="dx-switch" />
        </Control>
      </Group>

      <Group id="layout" title="Layout" icon={<LayoutTemplate size={16} />} summary={LAYOUT_LABEL[theme.layout]} changed={count('layout', 'density', 'animations', 'confetti')} open={open.has('layout')} onToggle={toggle}>
        <Control label="Arrangement" changed={changed('layout')} onReset={reset('layout')} hint="On phones every layout becomes a single column.">
          <OptionTiles<Theme['layout']>
            label="Arrangement"
            columns={3}
            value={theme.layout}
            onChange={(layout) => set({ layout }, 'layout')}
            options={[
              { value: 'split', label: LAYOUT_LABEL.split, art: <LayoutGlyph value="split" /> },
              { value: 'stacked', label: LAYOUT_LABEL.stacked, art: <LayoutGlyph value="stacked" /> },
              { value: 'centered', label: LAYOUT_LABEL.centered, art: <LayoutGlyph value="centered" /> },
            ]}
          />
        </Control>
        <Control label="Spacing" changed={changed('density')} onReset={reset('density')}>
          <SegmentedControl<Theme['density']>
            aria-label="Spacing"
            block
            size="sm"
            value={theme.density}
            onChange={(density) => set({ density }, 'density')}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Control>
        <Control label="Motion" changed={changed('animations')} onReset={reset('animations')} hint="Visitors who ask their device for less motion never see animations.">
          <SegmentedControl<Theme['animations']>
            aria-label="Motion"
            block
            size="sm"
            value={theme.animations}
            onChange={(animations) => set({ animations }, 'animations')}
            options={[
              { value: 'none', label: 'None' },
              { value: 'subtle', label: 'Subtle' },
              { value: 'lively', label: 'Lively' },
            ]}
          />
        </Control>
        <Control label="Confetti" ownLabel changed={changed('confetti')} onReset={reset('confetti')}>
          <Switch size="sm" labelSide="start" label="Confetti when a booking is confirmed" checked={theme.confetti} onChange={(confetti) => set({ confetti }, 'confetti')} className="dx-switch" />
        </Control>
      </Group>

      <Group id="calendar" title="Calendar and times" icon={<CalendarDays size={16} />} summary={CAL_LABEL[theme.calendarStyle]} changed={count('calendarStyle', 'slotStyle', 'timeFormat', 'weekStart')} open={open.has('calendar')} onToggle={toggle}>
        <Control label="Calendar days" changed={changed('calendarStyle')} onReset={reset('calendarStyle')}>
          <OptionTiles<Theme['calendarStyle']>
            label="Calendar days"
            columns={3}
            value={theme.calendarStyle}
            onChange={(calendarStyle) => set({ calendarStyle }, 'calendarStyle')}
            options={[
              { value: 'grid', label: CAL_LABEL.grid, art: <CalendarGlyph value="grid" /> },
              { value: 'minimal', label: CAL_LABEL.minimal, art: <CalendarGlyph value="minimal" /> },
              { value: 'bubbles', label: CAL_LABEL.bubbles, art: <CalendarGlyph value="bubbles" /> },
            ]}
          />
        </Control>
        <Control label="Time slots" changed={changed('slotStyle')} onReset={reset('slotStyle')}>
          <OptionTiles<Theme['slotStyle']>
            label="Time slots"
            columns={3}
            value={theme.slotStyle}
            onChange={(slotStyle) => set({ slotStyle }, 'slotStyle')}
            options={[
              { value: 'list', label: 'List', art: <SlotGlyph value="list" /> },
              { value: 'grid', label: 'Two columns', art: <SlotGlyph value="grid" /> },
              { value: 'chips', label: 'Chips', art: <SlotGlyph value="chips" /> },
            ]}
          />
        </Control>
        <Control label="Clock" changed={changed('timeFormat')} onReset={reset('timeFormat')} hint="Automatic follows each visitor's region. They can always switch.">
          <SegmentedControl<Theme['timeFormat']>
            aria-label="Clock"
            block
            size="sm"
            value={theme.timeFormat}
            onChange={(timeFormat) => set({ timeFormat }, 'timeFormat')}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: '12h', label: '2:30 PM' },
              { value: '24h', label: '14:30' },
            ]}
          />
        </Control>
        <Control label="Week starts on" changed={changed('weekStart')} onReset={reset('weekStart')}>
          <SegmentedControl<Theme['weekStart']>
            aria-label="Week starts on"
            block
            size="sm"
            value={theme.weekStart}
            onChange={(weekStart) => set({ weekStart }, 'weekStart')}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'sunday', label: 'Sunday' },
              { value: 'monday', label: 'Monday' },
            ]}
          />
        </Control>
      </Group>

      <Group id="images" title="Images" icon={<ImageIcon size={16} />} summary={imageSummary(theme)} changed={count('logoAssetId', 'coverAssetId', 'coverHeight')} open={open.has('images')} onToggle={toggle}>
        <ImageField
          label="Logo"
          shape="square"
          purpose="logo"
          url={a.logoUrl}
          hint="Shown above your name. A PNG with a transparent background works best."
          onUploaded={uploaded('logo')}
          onRemove={() => {
            onAssetsChange?.({ ...a, logoUrl: null });
            set({ logoAssetId: null }, 'logo');
          }}
        />
        <ImageField
          label="Cover image"
          shape="wide"
          purpose="cover"
          url={a.coverUrl}
          hint="A banner across the top of your page. Up to 3 MB."
          onUploaded={uploaded('cover')}
          onRemove={() => {
            onAssetsChange?.({ ...a, coverUrl: null });
            set({ coverAssetId: null }, 'cover');
          }}
        />
        {a.coverUrl ? (
          <Control label="Cover height" ownLabel changed={changed('coverHeight')} onReset={reset('coverHeight')}>
            <Slider label="Cover height" min={0} max={360} step={10} value={theme.coverHeight} formatValue={(v) => (v === 0 ? 'Hidden' : `${v}px`)} onChange={(coverHeight) => set({ coverHeight }, 'coverHeight')} />
          </Control>
        ) : null}
        <p className="dx-note dx-note--quiet">
          Looking for a photo behind the whole page? That is under{' '}
          <button type="button" className="dx-linkbtn" onClick={() => openGroup('background')}>
            Background
          </button>
          .
        </p>
      </Group>

      <Group id="wording" title="Wording" icon={<TextCursorInput size={16} />} summary={theme.texts?.ctaLabel || DEFAULT_THEME.texts.ctaLabel} changed={changed('texts') ? 1 : 0} open={open.has('wording')} onToggle={toggle}>
        <TextControl label="Heading above the times" k="pickTimeLabel" theme={theme} changed={textChanged('pickTimeLabel')} onReset={resetText('pickTimeLabel')} onChange={setText} />
        <TextControl label="Booking button" k="ctaLabel" theme={theme} changed={textChanged('ctaLabel')} onReset={resetText('ctaLabel')} onChange={setText} />
        <TextControl label="Confirmation title" k="confirmationTitle" theme={theme} changed={textChanged('confirmationTitle')} onReset={resetText('confirmationTitle')} onChange={setText} />
        <TextControl
          label="Confirmation message"
          k="confirmationBody"
          multiline
          theme={theme}
          changed={textChanged('confirmationBody')}
          onReset={resetText('confirmationBody')}
          onChange={setText}
          hint={
            <>
              You can use <code>{'{{invitee_first_name}}'}</code>, <code>{'{{invitee_email}}'}</code>, <code>{'{{event_name}}'}</code>, <code>{'{{date}}'}</code> and <code>{'{{time}}'}</code>.
            </>
          }
        />
        <TextControl label="Footer note" k="footerNote" multiline theme={theme} changed={textChanged('footerNote')} onReset={resetText('footerNote')} onChange={setText} hint="A quiet line under the booking card. Leave it empty for none." />
      </Group>

      <Group id="advanced" title="Advanced" icon={<Code2 size={16} />} summary={css.trim() ? 'Custom CSS' : undefined} changed={count('customCss', 'hideBranding')} open={open.has('advanced')} onToggle={toggle}>
        <Control
          label="Custom CSS"
          changed={changed('customCss')}
          onReset={reset('customCss')}
          hint={
            <>
              Only styles your booking pages. Every colour and size is a variable, for example <code>--m-primary</code> or <code>--m-radius</code>.
            </>
          }
        >
          <Textarea
            className="dx-css"
            aria-label="Custom CSS"
            value={css}
            rows={9}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={MAX_CSS}
            placeholder={'/* Example */\n.bw__card {\n  border-width: 2px;\n}'}
            onChange={(e) => set({ customCss: e.target.value }, 'customCss')}
          />
          <div className="dx-css__meta">
            <span className={cx(css.length > MAX_CSS * 0.9 && 'is-near')}>
              {css.length.toLocaleString()} of {MAX_CSS.toLocaleString()} characters
            </span>
          </div>
          {cssStripped ? (
            <p className="dx-note dx-note--warn" role="status">
              <CircleAlert size={14} aria-hidden="true" />
              Some of this will be left out for safety: imports, HTML and links to other sites are not allowed.
            </p>
          ) : null}
        </Control>
        <Control label="Credit" ownLabel changed={changed('hideBranding')} onReset={reset('hideBranding')}>
          <Switch size="sm" labelSide="start" label="Hide the scheduling credit in the footer" checked={theme.hideBranding} onChange={(hideBranding) => set({ hideBranding }, 'hideBranding')} className="dx-switch" />
        </Control>
      </Group>
    </div>
  );
}

const BG_LABEL: Record<ThemeBackground['type'], string> = { solid: 'Solid', gradient: 'Gradient', mesh: 'Glow', pattern: 'Pattern', image: 'Image' };
const LAYOUT_LABEL: Record<Theme['layout'], string> = { split: 'Side by side', stacked: 'Stacked', centered: 'Centered' };
const CAL_LABEL: Record<Theme['calendarStyle'], string> = { grid: 'Boxes', minimal: 'Minimal', bubbles: 'Bubbles' };

function imageSummary(t: Theme): string | undefined {
  const parts = [t.logoAssetId ? 'Logo' : null, t.coverAssetId ? 'Cover' : null].filter(Boolean);
  return parts.length ? parts.join(' + ') : undefined;
}

function Swatches({ colors }: { colors: ThemeColors }) {
  return (
    <span className="dx-swatches" aria-hidden="true">
      {(['background', 'surface', 'primary', 'accent', 'text'] as const).map((k) => (
        <span key={k} style={{ background: colors[k] }} />
      ))}
    </span>
  );
}

interface TextControlProps {
  label: string;
  k: keyof Theme['texts'];
  theme: Theme;
  changed: boolean;
  onReset: () => void;
  onChange: (k: keyof Theme['texts'], value: string) => void;
  multiline?: boolean;
  hint?: ReactNode;
}

function TextControl({ label, k, theme, changed, onReset, onChange, multiline = false, hint }: TextControlProps) {
  const value = theme.texts?.[k] ?? '';
  const max = TEXT_LIMITS[k];
  const placeholder = DEFAULT_THEME.texts[k] || undefined;
  return (
    <Control label={label} changed={changed} onReset={onReset} hint={hint}>
      {multiline ? (
        <Textarea aria-label={label} value={value} rows={k === 'footerNote' ? 2 : 3} maxLength={max} placeholder={placeholder} autoGrow onChange={(e) => onChange(k, e.target.value)} />
      ) : (
        <Input aria-label={label} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(k, e.target.value)} />
      )}
    </Control>
  );
}

export default ThemeControls;
