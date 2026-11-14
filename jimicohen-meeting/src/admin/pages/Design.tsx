/**
 * Design: every Theme setting on the left, the real booking widget on the right, updating as
 * you go. Nothing is saved until "Save", every step can be undone, and leaving with unsaved
 * changes asks first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, ExternalLink, Monitor, Moon, Redo2, Smartphone, Sun, Undo2 } from 'lucide-react';
import { resolveTheme } from '../../../shared/theme';
import type { ThemeAssets } from '../../../shared/theme';
import type { Theme } from '../../../shared/types';
import { assetUrl, errorMessage, saveSite } from '../../lib/api';
import type { BookingWidgetStep } from '../../public/BookingWidget';
import { Button, IconButton, SegmentedControl, Select, Tooltip, cx, useMediaQuery, useToast } from '../../ui';
import { ThemeControls } from '../components/ThemeControls';
import type { ThemeChangeMeta } from '../components/ThemeControls';
import { useUnsavedGuard } from '../components/UnsavedGuard';
import { PreviewStage } from '../components/x/PreviewStage';
import type { PreviewDevice } from '../components/x/PreviewStage';
import { contrastProblems } from '../components/x/contrast';
import { previewEventTypes, toPreviewSite } from '../components/x/previewData';
import { displayUrl, sameJson } from '../format';
import { useAdmin } from '../state';
import '../../styles/adminx.css';

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
  const { data, setData, ownerHost } = useAdmin();
  const toast = useToast();
  const latest = useRef(data);
  latest.current = data;

  const saved = useMemo(() => resolveTheme(data.site.theme), [data.site.theme]);
  const [history, setHistory] = useState<History>(() => ({ past: [], present: saved, future: [] }));
  const lastEdit = useRef<{ key: string; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [step, setStep] = useState<BookingWidgetStep>('pick');
  const [palette, setPalette] = useState<'light' | 'dark'>('light');
  const [eventId, setEventId] = useState<string | null>(null);
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');
  const narrow = useMediaQuery('(max-width: 1099.98px)');

  /** preview URLs of images uploaded in this session, by asset id */
  const [urls, setUrls] = useState<Record<string, string>>({});

  const draft = history.present;
  const dirty = !sameJson(draft, saved);
  useUnsavedGuard(dirty);

  const commit = useCallback((next: Theme, meta?: ThemeChangeMeta) => {
    const key = meta?.key ?? '';
    const now = Date.now();
    setHistory((h) => {
      if (sameJson(next, h.present)) return h;
      const merge = !!key && lastEdit.current?.key === key && now - lastEdit.current.at < COALESCE_MS && h.past.length > 0;
      lastEdit.current = { key, at: now };
      if (merge) return { past: h.past, present: next, future: [] };
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
    commit(saved, { key: 'discard' });
    lastEdit.current = null;
    toast.show({ title: 'Back to the saved design', tone: 'info', action: { label: 'Undo', onClick: undo } });
  };

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setProblem(null);
    try {
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
  }, [saving, dirty, draft, setData, toast]);

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
    () => ({ coverUrl: urlOf(draft.coverAssetId), logoUrl: urlOf(draft.logoAssetId), backgroundUrl: urlOf(draft.background?.imageAssetId) }),
    [urlOf, draft.coverAssetId, draft.logoAssetId, draft.background?.imageAssetId],
  );
  const events = useMemo(() => previewEventTypes(data, ownerHost), [data, ownerHost]);
  const event = events.find((e) => e.id === eventId) ?? events.find((e) => !e.color && !e.themeOverride) ?? events[0];
  const site = useMemo(() => toPreviewSite(data, ownerHost, draft, assets, events), [data, ownerHost, draft, assets, events]);
  const shown = useMemo(() => resolveTheme(draft, event.themeOverride, event.color), [draft, event.themeOverride, event.color]);
  const hasOwnLook = !!event.color || !!(event.themeOverride && Object.keys(event.themeOverride).length);

  const auto = draft.scheme === 'auto' && !!draft.darkColors;
  useEffect(() => {
    if (!auto && palette !== 'light') setPalette('light');
  }, [auto, palette]);

  const problems = contrastProblems(draft.colors) + (auto && draft.darkColors ? contrastProblems(draft.darkColors) : 0);
  const address = `${displayUrl(data.publicUrl)}/${event.slug}`;

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
          <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>
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
          <ThemeControls
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
            <Tooltip content="Open the live page in a new tab" labelled>
              <a className="ui-iconbtn ui-iconbtn--ghost dx-tools__open" href={`${data.publicUrl}/${event.slug}`} target="_blank" rel="noopener noreferrer" aria-label="Open the live page in a new tab">
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            </Tooltip>
          </div>
          {hasOwnLook ? <p className="dx-tools__note">{event.title} has its own colour, set on the event type. Pick another event above to see the site colours.</p> : null}
          <PreviewStage theme={shown} assets={assets} site={site} eventType={event} device={device} step={step} forceScheme={auto ? palette : undefined} address={address} />
        </div>
      </div>
    </div>
  );
}
