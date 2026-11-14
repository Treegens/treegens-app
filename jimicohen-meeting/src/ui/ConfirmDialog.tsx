import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** may return a promise: the dialog shows progress, closes when it resolves and stays open when it rejects */
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  /** what will happen, in plain words */
  description?: ReactNode;
  /** extra content between the description and the buttons (a reason field, a summary) */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger = destructive action, the confirm button turns red */
  tone?: 'default' | 'danger';
  /** disable the confirm button, e.g. until a required field is filled */
  confirmDisabled?: boolean;
}

/** "Are you sure?" with a clear verb on the confirm button. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const confirm = async () => {
    if (busy) return;
    try {
      const result = onConfirm();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        setBusy(true);
        await result;
      }
      if (alive.current) onClose();
    } catch {
      // The caller reports the failure (usually a toast). Keep the dialog open so they can retry.
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      description={description}
      size="sm"
      hideClose
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      initialFocusRef={tone === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={confirm} loading={busy} disabled={confirmDisabled} data-autofocus={tone === 'danger' ? undefined : ''}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
