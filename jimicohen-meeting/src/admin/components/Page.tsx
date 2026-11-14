/**
 * Page furniture shared by the dashboard screens: the page wrapper and header, the
 * two-column settings section, inline notices and the sticky "unsaved changes" bar.
 * Styles live in src/styles/admin.css (classes prefixed adm-).
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, cx } from '../../ui';

export interface PageProps {
  /** narrow = forms and lists, wide = dashboards */
  width?: 'narrow' | 'default' | 'wide';
  className?: string;
  children: ReactNode;
}

export function Page({ width = 'default', className, children }: PageProps) {
  return <div className={cx('adm-page', `adm-page--${width}`, className)}>{children}</div>;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** small line above the title, e.g. a back link */
  back?: { to: string; label: string };
  /** buttons on the right */
  actions?: ReactNode;
  /** badges after the title */
  meta?: ReactNode;
}

export function PageHeader({ title, description, back, actions, meta }: PageHeaderProps) {
  return (
    <header className="adm-pagehead">
      <div className="adm-pagehead__text">
        {back ? (
          <Link to={back.to} className="adm-pagehead__back">
            <ArrowLeft size={15} aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}
        <div className="adm-pagehead__titlerow">
          <h1 className="adm-pagehead__title">{title}</h1>
          {meta ? <div className="adm-pagehead__meta">{meta}</div> : null}
        </div>
        {description ? <p className="adm-pagehead__desc">{description}</p> : null}
      </div>
      {actions ? <div className="adm-pagehead__actions">{actions}</div> : null}
    </header>
  );
}

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** extra content under the description (a link, a diagram) */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Settings section: heading and explanation on the left, the controls on the right. */
export function Section({ title, description, aside, children, className }: SectionProps) {
  return (
    <section className={cx('adm-section', className)}>
      <div className="adm-section__intro">
        <h2 className="adm-section__title">{title}</h2>
        {description ? <p className="adm-section__desc">{description}</p> : null}
        {aside}
      </div>
      <div className="adm-section__body">{children}</div>
    </section>
  );
}

export interface FieldGroupProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** right side of the label row */
  action?: ReactNode;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

/** Like <Field>, for a label that sits above several controls (chips, a list of rows). */
export function FieldGroup({ label, hint, error, action, optional, className, children }: FieldGroupProps) {
  const id = useId();
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  return (
    <div className={cx('ui-field adm-fieldgroup', hasError && 'is-invalid', className)} role="group" aria-labelledby={id}>
      <div className="ui-field__top">
        <span className="ui-field__label" id={id}>
          {label}
          {optional ? <span className="ui-field__optional">Optional</span> : null}
        </span>
        {action ? <div className="ui-field__action">{action}</div> : null}
      </div>
      {children}
      {hasError ? (
        <p className="ui-field__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p className="ui-field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

export interface NoticeProps {
  tone?: 'info' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  /** a link or button on the right */
  action?: ReactNode;
  className?: string;
}

/** A quiet inline message: something is not connected yet, or needs attention. */
export function Notice({ tone = 'info', title, children, action, className }: NoticeProps) {
  const Icon = tone === 'info' ? Info : tone === 'warning' ? TriangleAlert : CircleAlert;
  return (
    <div className={cx('adm-notice', `adm-notice--${tone}`, className)} role={tone === 'danger' ? 'alert' : 'note'}>
      <Icon size={16} aria-hidden="true" className="adm-notice__icon" />
      <div className="adm-notice__text">
        {title ? <p className="adm-notice__title">{title}</p> : null}
        {children ? <div className="adm-notice__body">{children}</div> : null}
      </div>
      {action ? <div className="adm-notice__action">{action}</div> : null}
    </div>
  );
}

export interface SaveBarProps {
  /** show the bar */
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** why saving is blocked, shown instead of the default text */
  problem?: string | null;
  saveLabel?: string;
  discardLabel?: string;
  /** replaces "You have unsaved changes" (a new, untouched form) */
  idleText?: string;
}

/** Sticky bar at the bottom of a form page. Appears as soon as something changed. */
export function SaveBar({ dirty, saving, onSave, onDiscard, problem, saveLabel = 'Save changes', discardLabel = 'Discard', idleText }: SaveBarProps) {
  if (!dirty) return null;
  return (
    <div className="adm-savebar" role="region" aria-label="Unsaved changes">
      <div className="adm-savebar__inner">
        <p className={cx('adm-savebar__text', problem && 'is-problem')}>
          {problem ? <CircleAlert size={15} aria-hidden="true" /> : <span className="adm-savebar__dot" aria-hidden="true" />}
          <span>{problem || idleText || 'You have unsaved changes'}</span>
        </p>
        <div className="adm-savebar__actions">
          <Button variant="ghost" onClick={onDiscard} disabled={saving}>
            {discardLabel}
          </Button>
          <Button variant="primary" onClick={onSave} loading={saving} loadingLabel="Saving" disabled={!!problem}>
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
