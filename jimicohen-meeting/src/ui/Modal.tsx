import { useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
import { Portal } from './Portal';
import { useDialogBehavior, usePresence } from './overlay';
import { cx } from './util';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** one or two sentences under the title */
  description?: ReactNode;
  children?: ReactNode;
  /** action row. Put the primary action last. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** clicking the dimmed area closes the dialog (default true) */
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  /** hide the close button, e.g. while a blocking action runs */
  hideClose?: boolean;
  /** element to focus first. Otherwise the element marked data-autofocus, then the dialog. */
  initialFocusRef?: RefObject<HTMLElement>;
  /** remove body padding for edge-to-edge content such as lists */
  flush?: boolean;
  className?: string;
}

/**
 * Centered dialog on desktop, bottom sheet on phones. Traps focus, locks scroll,
 * closes on Escape and returns focus to the trigger.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEscape = true,
  hideClose = false,
  initialFocusRef,
  flush = false,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();
  const { mounted, state } = usePresence(open);
  useDialogBehavior({ open, onClose, panelRef, initialFocusRef, closeOnEscape });

  if (!mounted) return null;

  return (
    <Portal>
      <div
        className="ui-overlay ui-overlay--modal"
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
          className={cx('ui-modal', `ui-modal--${size}`, className)}
        >
          <header className="ui-modal__header">
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
            {hideClose ? null : (
              <button type="button" className="ui-iconbtn ui-iconbtn--ghost ui-modal__close" aria-label="Close" onClick={onClose}>
                <X size={18} aria-hidden="true" />
              </button>
            )}
          </header>
          {children !== undefined && children !== null ? <div className={cx('ui-modal__body', flush && 'ui-modal__body--flush')}>{children}</div> : null}
          {footer ? <footer className="ui-modal__footer">{footer}</footer> : null}
        </div>
      </div>
    </Portal>
  );
}
