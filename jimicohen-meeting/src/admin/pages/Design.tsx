/**
 * Design: every Theme setting on the left, the real booking widget on the right, updating as
 * you go. Nothing is saved until "Save", every step can be undone, and leaving with unsaved
 * changes asks first.
 *
 * "Look for" switches between the owner's own look and a built-in brand's (?brand=<id>): the same
 * controls and preview, plus the brand's details (logo, sender name). A brand saves through
 * PUT /admin/brands/:id and never touches the owner's look.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Monitor, Moon, Redo2, Smartphone, Sun, Undo2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { BUILTIN_BRANDS, brandOf, isBrandId } from '../../../shared/brands';
import { resolveTheme } from '../../../shared/theme';
import type { ThemeAssets } from '../../../shared/theme';
import type { BrandId, Theme } from '../../../shared/types';
import { APP_BASE, assetUrl, errorMessage, saveSite, updateBrand } from '../../lib/api';
import type { BookingWidgetStep } from '../../public/BookingWidget';
import { Button, Field, IconButton, Input, SegmentedControl, Select, cx, useMediaQuery, useToast } from '../../ui';
import { BRAND_CHOICES, shortLinkOf, shortLinkRows } from '../brands';
import { ThemeControls } from '../components/ThemeControls';
import type { ThemeChangeMeta } from '../components/ThemeControls';
import { useUnsavedGuard } from '../components/UnsavedGuard';
import { PreviewStage } from '../components/x/PreviewStage';
import type { PreviewDevice } from '../components/x/PreviewStage';
import { contrastProblems } from '../components/x/contrast';
import { previewEventTypes, toBrandPreviewSite, toPreviewSite } from '../components/x/previewData';
import { displayUrl, sameJson } from '../format';
import { useAdmin } from '../state';
import '../../styles/adminx.css';
import '../../styles/adminbrands.css';

interface History {
  past: Theme[];
  present: Theme;
  future: Theme[];
}

const MAX_HISTORY = 80;
/** Changes from the same control this close together are one undo step (a slider drag, typing a word). */
const COALESCE_MS = 900;

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'color', 'button', 'file'].includes(target.type);
}

export default function DesignPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('brand');
  const brand = isBrandId(raw) ? raw : null;
  // A new editor for each look: its own draft and its own undo history.
  return (
    <DesignEditor
      key={brand ?? 'own'}
      brand={brand}
      onSwitch={(next) => {
        const p = new URLSearchParams(params);
        if (next) p.set('brand', next);
        else p.delete('brand');
        setParams(p);
      }}
    />
  );
}

function DesignEditor({ brand, onSwitch }: { brand: BrandId | null; onSwitch: (next: BrandId | null) => void }) {
  const { data, setData, ownerHost } = useAdmin();
  const toast = useToast();
  const latest = useRef(data);
  latest.current = data;

  const brandInfo = brand ? BUILTIN_BRANDS[brand] : null;
  const builtinLogo = brandInfo ? `${APP_BASE}/${brandInfo.art.logo}` : null;
  const storedBrand = brand ? (data.site.brands ?? []).find((b) => b.id === brand) : undefined;
  const savedSender = storedBrand?.emailFromName ?? '';
  const [sender, setSender] = useState(savedSender);
  const senderDirty = !!brand && sender.trim() !== savedSender.trim();

  const saved = useMemo(() => (brand ? brandOf(data.site, { brandId: brand })!.theme : resolveTheme(data.site.theme)), [brand, data.site]);
  const [history, setHistory] = useState<History>(() => ({ past: [], present: saved, future: [] }));
  const lastEdit = useRef<{ key: string; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const narrow = useMediaQuery('(max-width: 1179.98px)');
  const phone = useMediaQuery('(max-width: 519.98px)');
  const [device, setDevice] = useState<PreviewDevice>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 719.98px)').matches ? 'mobile' : 'desktop'));
  const [step, setStep] = useState<BookingWidgetStep>('pick');
  const [palette, setPalette] = useState<'light' | 'dark'>('light');
  const [eventId, setEventId] = useState<string | null>(null);
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');

  /** preview URLs of images uploaded in this session, by asset id */
  const [urls, setUrls] = useState<Record<string, string>>({});

  // The saved theme changed underneath (a refresh, another tab): follow it unless there are edits.
  const lastSaved = useRef(saved);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = saved;
    if (previous === saved) return;
    setHistory((h) => (sameJson(h.present, previous) ? { ...h, present: saved } : h));
  }, [saved]);

  const draft = history.present;
  const dirty = !sameJson(draft, saved) || senderDirty;
  const guard = useUnsavedGuard(dirty);

  const commit = useCallback((next: Theme, meta?: ThemeChangeMeta) => {
    const key = meta?.key ?? '';
    const now = Date.now();
    const last = lastEdit.current;
    // Decided out here so the state updater below stays pure.
    const sameControl = !!key && last?.key === key && now - last.at < COALESCE_MS;
    lastEdit.current = { key, at: now };
    setHistory((h) => {
      if (sameJson(next, h.present)) return h;
      if (sameControl && h.past.length > 0) return { past: h.past, present: next, future: [] };
      return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [] };
    });
    setProblem(null);
  }, []);

  const undo = useCallback(() => {
    lastEdit.current = null;
    setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
  }, []);

  const redo = useCallback(() => {
    lastEdit.current = null;
    setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
  }, []);

  const discard = () => {
    if (!dirty) return;
    setSender(savedSender);
    commit(saved, { key: 'discard' });
    lastEdit.current = null;
    toast.show({ title: 'Back to the saved design', tone: 'info', action: { label: 'Undo', onClick: undo } });
  };

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setProblem(null);
    try {
      if (brand) {
        const site = await updateBrand(brand, { theme: draft, emailFromName: sender.trim() });
        setData({ ...latest.current, site });
        setHistory((h) => ({ ...h, present: brandOf(site, { brandId: brand })!.theme }));
        setSender((site.brands ?? []).find((b) => b.id === brand)?.emailFromName ?? '');
        lastEdit.current = null;
        toast.success('Design saved', `${brandInfo!.name} pages, emails and texts now look like this.`);
        return;
      }
      const site = await saveSite({ theme: draft });
      setData({ ...latest.current, site });
      // What the server stored is the new baseline. Keep the undo history: it still makes sense.
      setHistory((h) => ({ ...h, present: resolveTheme(site.theme) }));
      lastEdit.current = null;
      toast.success('Design saved', 'Your booking page now looks like this.');
    } catch (e) {
      const message = errorMessage(e, 'Your design could not be saved. Please try again.');
      setProblem(message);
      toast.error('Your design was not saved', message);
    } finally {
      setSaving(false);
    }
  }, [saving, dirty, draft, setData, toast, brand, brandInfo, sender]);

  // Undo, redo and save from the keyboard. Text fields keep their own undo.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void save();
        return;
      }
      if (isTextTarget(e.target)) return;
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save, undo, redo]);

  // ── preview data, built here from the bootstrap: the server is not asked for anything
  const urlOf = useCallback((id: string | null | undefined) => (id ? (urls[id] ?? assetUrl(id)) : null), [urls]);
  const assets = useMemo<ThemeAssets>(
    () => ({ coverUrl: urlOf(draft.coverAssetId), logoUrl: urlOf(draft.logoAssetId) ?? builtinLogo, backgroundUrl: urlOf(draft.background?.imageAssetId) }),
    [urlOf, draft.coverAssetId, draft.logoAssetId, draft.background?.imageAssetId, builtinLogo],
  );
  const events = useMemo(() => previewEventTypes(data, ownerHost, brand), [data, ownerHost, brand]);
  const event = events.find((e) => e.id === eventId) ?? events.find((e) => !e.color && !e.themeOverride) ?? events[0];
  const site = useMemo(
    () => (brand ? toBrandPreviewSite(data, ownerHost, brand, draft, assets) : toPreviewSite(data, ownerHost, draft, assets, events)),
    [data, ownerHost, draft, assets, events, brand],
  );
  const shown = useMemo(() => resolveTheme(draft, event.themeOverride, event.color), [draft, event.themeOverride, event.color]);
  const hasOwnLook = !!event.color || !!(event.themeOverride && Object.keys(event.themeOverride).length);

  const auto = draft.scheme === 'auto' && !!draft.darkColors;
  useEffect(() => {
    if (!auto && palette !== 'light') setPalette('light');
  }, [auto, palette]);

  const problems = contrastProblems(draft.colors) + (auto && draft.darkColors ? contrastProblems(draft.darkColors) : 0);
  // The preview's address bar shows the short link when one opens this meeting (jimicohen.com/pod), as people see it.
  const short = shortLinkOf(data, event.id);
  const address = short ? short.label : `${displayUrl(data.publicUrl)}/${event.slug}`;
  const openHref = short ? short.url : `${data.publicUrl}/${event.slug}`;

  return (
    <div className="adm-page dx" data-pane={pane}>
      <header className="dx-head">
        <div className="dx-head__text">
          <h1 className="adm-pagehead__title">Design</h1>
          <p className={cx('dx-head__status', dirty && 'is-dirty', problem && 'is-problem')} role="status">
            {problem ? (
              <>
                <CircleAlert size={14} aria-hidden="true" />
                <span>{problem}</span>
              </>
            ) : dirty ? (
              <>
                <span className="dx-head__dot" aria-hidden="true" />
                <span>Unsaved changes</span>
              </>
            ) : (
              <span>Everything is saved</span>
            )}
          </p>
        </div>
        <div className="dx-head__actions">
          {problems > 0 ? (
            <span className="dx-head__warn" title="Open Colours to see what is hard to read">
              <CircleAlert size={14} aria-hidden="true" />
              {problems === 1 ? '1 readability warning' : `${problems} readability warnings`}
            </span>
          ) : null}
          <div className="dx-head__history" role="group" aria-label="History">
            <IconButton label="Undo the last change" icon={<Undo2 size={17} />} disabled={!history.past.length} onClick={undo} />
            <IconButton label="Redo" icon={<Redo2 size={17} />} disabled={!history.future.length} onClick={redo} />
          </div>
          <Button variant="ghost" className="dx-head__discard" disabled={!dirty || saving} onClick={discard}>
            Discard
          </Button>
          <Button variant="primary" disabled={!dirty} loading={saving} loadingLabel="Saving" onClick={() => void save()}>
            Save
          </Button>
        </div>
      </header>

      {narrow ? (
        <SegmentedControl<'edit' | 'preview'>
          aria-label="Show"
          block
          className="dx-panes"
          value={pane}
          onChange={setPane}
          options={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      ) : null}

      <div className="dx-body">
        <div className="dx-side" hidden={narrow && pane !== 'edit'}>
          <LookFor brand={brand} onSwitch={(next) => guard.confirmLeave(() => onSwitch(next))} />
          {brand ? <BrandDetails brand={brand} sender={sender} onSender={setSender} /> : null}
          <ThemeControls
            logoFallback={brandInfo && builtinLogo ? { url: builtinLogo, label: `The ${brandInfo.name} logo is built in.`, restoreLabel: 'Use the built-in logo' } : undefined}
            clockFrom={brand ? `your own look (${data.site.profile.name})` : undefined}
            theme={draft}
            baseline={saved}
            assets={assets}
            palette={palette}
            onPaletteChange={setPalette}
            onChange={commit}
            onAssetUploaded={(id, url) => setUrls((prev) => ({ ...prev, [id]: url }))}
          />
        </div>

        <div className="dx-main" hidden={narrow && pane !== 'preview'}>
          <div className="dx-tools">
            <SegmentedControl<PreviewDevice>
              aria-label="Preview size"
              size="sm"
              iconOnly={phone}
              value={device}
              onChange={setDevice}
              options={[
                { value: 'desktop', label: 'Desktop', icon: <Monitor size={15} /> },
                { value: 'mobile', label: 'Mobile', icon: <Smartphone size={15} /> },
              ]}
            />
            <SegmentedControl<BookingWidgetStep>
              aria-label="Screen"
              size="sm"
              className="dx-tools__step"
              value={step}
              onChange={setStep}
              options={[
                { value: 'pick', label: 'Times' },
                { value: 'details', label: 'Details' },
                { value: 'done', label: 'Confirmed' },
              ]}
            />
            {auto ? (
              <SegmentedControl<'light' | 'dark'>
                aria-label="Visitor's device setting"
                size="sm"
                iconOnly
                value={palette}
                onChange={setPalette}
                options={[
                  { value: 'light', label: 'Light', icon: <Sun size={15} /> },
                  { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
                ]}
              />
            ) : null}
            {events.length > 1 ? (
              <Select aria-label="Event type to preview" size="sm" wrapperClassName="dx-tools__event" value={event.id} onChange={(e) => setEventId(e.target.value)} options={events.map((e) => ({ value: e.id, label: e.title }))} />
            ) : null}
          </div>
          {hasOwnLook ? <p className="dx-tools__note">{event.title} has its own colour, set on the event type. Pick another event above to see the site colours.</p> : null}
          <PreviewStage theme={shown} assets={assets} site={site} eventType={event} device={device} step={step} forceScheme={auto ? palette : undefined} address={address} openHref={openHref} />
        </div>
      </div>
    </div>
  );
}

/** "Look for": the owner's own look or a built-in brand's, with what each one is used by. */
function LookFor({ brand, onSwitch }: { brand: BrandId | null; onSwitch: (next: BrandId | null) => void }) {
  const { data } = useAdmin();
  const rows = shortLinkRows(data) ?? [];
  const meet = rows.find((r) => r.name === 'meet');
  const own = [displayUrl(data.publicUrl), ...(meet ? [meet.label] : [])];
  const users = brand ? data.eventTypes.filter((e) => e.brandId === brand) : [];
  const usedBy = users.map((e) => {
    const link = rows.find((r) => r.eventType?.id === e.id);
    return link ? `${e.title} (${link.label})` : e.title;
  });
  return (
    <div className="ab-lookfor">
      <span className="ab-lookfor__label" aria-hidden="true">
        Look for
      </span>
      <SegmentedControl<string>
        aria-label="Look for"
        size="sm"
        value={brand ?? ''}
        onChange={(v) => onSwitch(isBrandId(v) ? v : null)}
        options={[{ value: '', label: data.site.profile.name }, ...BRAND_CHOICES.map((b) => ({ value: b.id, label: b.name }))]}
      />
      <p className="ab-lookfor__note">
        {brand
          ? usedBy.length
            ? `Used by ${usedBy.join(', ')}.`
            : "No meeting uses this look yet. Choose it on a meeting's Basics tab."
          : `Your own look: ${own.join(', ')} and every meeting without a brand.`}
      </p>
    </div>
  );
}

/** The brand's own details: its logo and the sender name on its emails. Its name and preview picture are built in. */
function BrandDetails({ brand, sender, onSender }: { brand: BrandId; sender: string; onSender: (v: string) => void }) {
  const { data, ownerHost } = useAdmin();
  const info = BUILTIN_BRANDS[brand];
  const replies = data.site.email.replyTo || ownerHost.email || 'your own address';
  return (
    <section className="adm-panel ab-brandcard" aria-labelledby="dx-brand-details">
      <div className="adm-panel__head">
        <div>
          <h2 className="adm-panel__title" id="dx-brand-details">
            Brand details
          </h2>
          <p className="adm-panel__desc">The name {info.name} and the link preview picture are built in. Its logo is under Images below.</p>
        </div>
      </div>
      <Field label="Sender name" hint={`Whose name is on emails about these meetings. Replies still go to ${replies}.`}>
        <Input value={sender} maxLength={80} placeholder={info.emailFromName} onChange={(e) => onSender(e.target.value)} />
      </Field>
    </section>
  );
}
