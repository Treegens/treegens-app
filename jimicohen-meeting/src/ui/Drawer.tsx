import { useId, useRef } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
import { Portal } from './Portal';
import { useDialogBehavior, usePresence } from './overlay';
import { cx } from './util';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** sticky action row at the bottom */
  footer?: ReactNode;
  /** edge it slides in from. On phones a side drawer covers the full width. */
  side?: 'right' | 'left' | 'bottom';
  /** panel width in px for side drawers (default 480) */
  width?: number;
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  /** extra controls in the header, left of the close button */
  headerActions?: ReactNode;
  className?: string;
}

/** A panel that slides over the page for detail views and longer forms. Same focus rules as Modal. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'right',
  width = 480,
  closeOnBackdrop = true,
  initialFocusRef,
  headerActions,
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();
  const { mounted, state } = usePresence(open, 220);
  useDialogBehavior({ open, onClose, panelRef, initialFocusRef });

  if (!mounted) return null;

  return (
    <Portal>
      <div
        className={cx('ui-overlay ui-overlay--drawer', `ui-overlay--${side}`)}
        data-state={state}
        onPointerDown={(e) => {
          pressedBackdrop.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (closeOnBackdrop && pressedBackdrop.current && e.target === e.currentTarget) onClose();
          pressedBackdrop.current = false;
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          data-state={state}
          className={cx('ui-drawer', `ui-drawer--${side}`, className)}
          style={{ '--_w': `${width}px` } as CSSProperties}
        >
          <header className="ui-drawer__header">
            <div className="ui-modal__heading">
              <h2 className="ui-modal__title" id={titleId}>
                {title}
              </h2>
              {description ? (
                <p className="ui-modal__desc" id={descId}>
                  {description}
                </p>
              ) : null}
            </div>
            <div className="ui-drawer__actions">
              {headerActions}
              <button type="button" className="ui-iconbtn ui-iconbtn--ghost" aria-label="Close" onClick={onClose}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="ui-drawer__body">{children}</div>
          {footer ? <footer className="ui-drawer__footer">{footer}</footer> : null}
        </div>
      </div>
    </Portal>
  );
}
