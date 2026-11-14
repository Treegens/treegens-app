/**
 * The live preview of the design editor: the real BookingWidget in preview mode, inside a
 * ThemeScope with the draft theme.
 *
 * Our pages may not be framed (see spec section 7), so there is no iframe here. Instead the
 * widget is laid out in a box of a fixed "device" width (1180px desktop, 390px phone) and that
 * box is scaled to fit the space the dashboard has. The widget's own container queries see the
 * device width, so the layout is the real one, just smaller.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ThemeAssets } from '../../../../shared/theme';
import type { PublicEventType, PublicSite, Theme } from '../../../../shared/types';
import { ThemeScope } from '../../../lib/theme';
import BookingWidget from '../../../public/BookingWidget';
import type { BookingWidgetStep } from '../../../public/BookingWidget';
import { cx } from '../../../ui';

export type PreviewDevice = 'desktop' | 'mobile';

const DEVICE_WIDTH: Record<PreviewDevice, number> = { desktop: 1040, mobile: 390 };
const PHONE_HEIGHT = 780;

export interface PreviewStageProps {
  /** the theme to show, already merged with the event's own override when it has one */
  theme: Theme;
  assets: ThemeAssets;
  site: PublicSite;
  eventType: PublicEventType;
  device: PreviewDevice;
  step: BookingWidgetStep;
  /** which visitor preference to simulate when the theme has two palettes */
  forceScheme?: 'light' | 'dark';
  /** address shown in the frame's bar, e.g. "jimicohen.com/meeting/intro" */
  address: string;
  className?: string;
}

export function PreviewStage({ theme, assets, site, eventType, device, step, forceScheme, address, className }: PreviewStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [contentH, setContentH] = useState(0);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => setContentH((prev) => (prev === el.offsetHeight ? prev : el.offsetHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box.w > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Going back to the top when the screen or device changes keeps the interesting part in view.
  useEffect(() => {
    stageRef.current?.scrollTo({ top: 0 });
  }, [device, step, eventType.id]);

  const width = DEVICE_WIDTH[device];
  const margin = device === 'mobile' ? 20 : 0;
  const ready = box.w > 0;
  const scale = ready ? Math.min(1, Math.max(0.2, (box.w - margin * 2) / width)) : 1;
  const minHeight = device === 'mobile' ? PHONE_HEIGHT : Math.max(320, box.h / scale);
  const sizer: CSSProperties = { width: Math.floor(width * scale), height: Math.ceil(Math.max(contentH, minHeight) * scale) };
  // Always transformed, even at 100%: a transformed box contains fixed-position children, so
  // nothing from the widget can escape the frame.
  const canvas: CSSProperties = { width, minHeight, transform: `scale(${scale})` };

  return (
    <div className={cx('dx-frame', `dx-frame--${device}`, className)}>
      <div className="dx-frame__bar" aria-hidden="true">
        <span className="dx-frame__dots">
          <span />
          <span />
          <span />
        </span>
        <span className="dx-frame__url">{address}</span>
        <span className="dx-frame__zoom">{scale < 0.995 ? `${Math.round(scale * 100)}%` : ''}</span>
      </div>
      <div ref={stageRef} className="dx-stage" tabIndex={0} role="region" aria-label="Live preview of your booking page">
        {ready ? (
          <div className="dx-stage__sizer" style={sizer}>
            <div ref={canvasRef} className="dx-stage__canvas" style={canvas}>
              <ThemeScope theme={theme} assets={assets} mode="contained" forceScheme={forceScheme} className="dx-stage__scope" style={{ minHeight }}>
                <div className="pp pp--wide dx-stage__page">
                  <BookingWidget key={eventType.id} site={site} eventType={eventType} mode="preview" previewStep={step} />
                </div>
              </ThemeScope>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
