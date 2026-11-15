/**
 * Small building blocks shared by the ADMINX screens (design editor, integrations, team,
 * settings, co-host page). Styles are in src/styles/adminx.css. Everything here reads the
 * semantic --c-* variables, so it works inside <AdminScope> and inside <ThemeScope>.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { Check, CircleAlert, CircleCheck, Eye, EyeOff, ImagePlus, Lock, RotateCcw, Trash2 } from 'lucide-react';
import { ApiFailure, errorMessage, uploadImageFile } from '../../../lib/api';
import type { AssetPurpose } from '../../../lib/api';
import { Button, CopyButton, IconButton, Input, Spinner, cx } from '../../../ui';

// ───────────── visibility ─────────────

/** True once the element has been on screen. Used to load fonts only for samples people can see. */
export function useSeen<T extends HTMLElement>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

// ───────────── control row (design editor) ─────────────

export interface ControlProps {
  label: ReactNode;
  hint?: ReactNode;
  /** the value differs from the saved one: shows the reset button */
  changed?: boolean;
  onReset?: () => void;
  /** what reset goes back to, for the tooltip */
  resetLabel?: string;
  /** the control already renders its own visible label (Slider, ColorInput) */
  ownLabel?: boolean;
  className?: string;
  children: ReactNode;
}

/** One setting in the design editor: label, per-control reset, the control, and a hint. */
export function Control({ label, hint, changed = false, onReset, resetLabel = 'Back to the saved value', ownLabel = false, className, children }: ControlProps) {
  const id = useId();
  return (
    <div className={cx('dx-ctl', changed && 'is-changed', ownLabel && 'dx-ctl--own', className)} role="group" aria-labelledby={ownLabel ? undefined : id} aria-label={ownLabel && typeof label === 'string' ? label : undefined}>
      {ownLabel ? null : (
        <div className="dx-ctl__top">
          <span className="dx-ctl__label" id={id}>
            {label}
          </span>
        </div>
      )}
      {changed && onReset ? (
        <span className="dx-ctl__reset">
          <IconButton label={resetLabel} icon={<RotateCcw size={14} />} size="sm" onClick={onReset} />
        </span>
      ) : null}
      {children}
      {hint ? <p className="dx-ctl__hint">{hint}</p> : null}
    </div>
  );
}

// ───────────── option tiles ─────────────

export interface TileOption<T extends string> {
  value: T;
  label: string;
  /** drawing or sample shown above the label */
  art?: ReactNode;
  /** inline style for the art box (background previews) */
  artStyle?: CSSProperties;
}

export interface OptionTilesProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: TileOption<T>[];
  /** names the group for screen readers */
  label: string;
  columns?: 2 | 3 | 4 | 5 | 6;
  /** smaller art box, for swatches */
  compact?: boolean;
}

/** A visual choice between a few options: native radios underneath, pictures on top. */
export function OptionTiles<T extends string>({ value, onChange, options, label, columns = 3, compact = false }: OptionTilesProps<T>) {
  const name = useId();
  return (
    <div className={cx('dx-tiles', compact && 'dx-tiles--compact')} role="radiogroup" aria-label={label} style={{ '--_cols': columns } as CSSProperties}>
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <label key={o.value} className={cx('dx-tile', checked && 'is-checked')}>
            <input type="radio" className="dx-tile__input" name={name} value={o.value} checked={checked} onChange={() => onChange(o.value)} />
            <span className="dx-tile__art" style={o.artStyle} aria-hidden="true">
              {o.art}
              {checked ? (
                <span className="dx-tile__tick">
                  <Check size={11} strokeWidth={3.2} />
                </span>
              ) : null}
            </span>
            <span className="dx-tile__label">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

// ───────────── image upload ─────────────

export interface ImageFieldProps {
  label: string;
  /** current image URL (asset URL or data URL), or null */
  url: string | null;
  purpose: AssetPurpose;
  /** called once the upload finished */
  onUploaded: (asset: { id: string; url: string; dataUrl: string }) => void;
  onRemove: () => void;
  hint?: ReactNode;
  /** wide = banner-like preview (cover, background). square = logo or avatar. */
  shape?: 'wide' | 'square' | 'round';
  uploadLabel?: string;
  /** the remove button's label ("Use the built-in logo"); default "Remove" */
  removeLabel?: string;
  /** false hides the remove button, e.g. while a built-in image is shown */
  removable?: boolean;
  disabled?: boolean;
}

/**
 * Pick an image, preview it from a data: URL, upload it through the API (POST /admin/assets).
 * Files can also be dropped on the box. Nothing leaves the browser except to our own API.
 */
export function ImageField({ label, url, purpose, onUploaded, onRemove, hint, shape = 'wide', uploadLabel, removeLabel, removable = true, disabled = false }: ImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [broken, setBroken] = useState(false);
  const errorId = useId();

  useEffect(() => setBroken(false), [url]);

  const upload = async (file: File | undefined | null) => {
    if (!file || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const asset = await uploadImageFile(file, purpose);
      onUploaded(asset);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : errorMessage(e, 'That image could not be uploaded. Please try again.'));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const has = !!url && !broken;

  return (
    <div className={cx('x-image', `x-image--${shape}`, over && 'is-over', has && 'has-image')}>
      <div
        className="x-image__box"
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files?.[0]);
        }}
      >
        {has ? <img className="x-image__img" src={url ?? undefined} alt="" onError={() => setBroken(true)} /> : <ImagePlus size={shape === 'wide' ? 22 : 18} aria-hidden="true" />}
        {busy ? (
          <span className="x-image__busy">
            <Spinner size={18} label="Uploading" />
          </span>
        ) : null}
      </div>
      <div className="x-image__side">
        <p className="x-image__label">{label}</p>
        {hint ? <p className="x-image__hint">{hint}</p> : null}
        <div className="x-image__actions">
          <input
            ref={inputRef}
            type="file"
            className="u-vh"
            accept="image/png,image/jpeg,image/webp,image/gif"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void upload(e.target.files?.[0])}
          />
          <Button size="sm" variant="secondary" loading={busy} loadingLabel="Uploading" disabled={disabled} aria-describedby={error ? errorId : undefined} onClick={() => inputRef.current?.click()}>
            {uploadLabel ?? (has ? 'Replace' : 'Upload image')}
          </Button>
          {url && removable ? (
            <Button size="sm" variant="ghost" iconLeft={removeLabel ? undefined : <Trash2 size={14} />} disabled={busy || disabled} onClick={onRemove}>
              {removeLabel ?? 'Remove'}
            </Button>
          ) : null}
        </div>
        {error ? (
          <p className="x-image__error" id={errorId} role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : broken && url ? (
          <p className="x-image__error" role="status">
            <CircleAlert size={14} aria-hidden="true" />
            <span>This image did not load. Upload it again.</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ───────────── copyable value ─────────────

export interface CopyFieldProps {
  value: string;
  /** names the value for screen readers: "Redirect address" */
  label: string;
  copyLabel?: string;
  /** wrap long values instead of cutting them off (snippets) */
  multiline?: boolean;
  className?: string;
}

/** A value the owner has to paste somewhere else, with a copy button. Selects itself on click. */
export function CopyField({ value, label, copyLabel = 'Copy', multiline = false, className }: CopyFieldProps) {
  return (
    <div className={cx('x-copy', multiline && 'x-copy--multi', className)}>
      {multiline ? (
        <pre className="x-copy__value" tabIndex={0} aria-label={label}>
          <code>{value}</code>
        </pre>
      ) : (
        <input className="x-copy__value" type="text" readOnly value={value} aria-label={label} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
      )}
      <CopyButton value={value} label={copyLabel} size="sm" variant="secondary" className="x-copy__btn" />
    </div>
  );
}

// ───────────── secret input ─────────────

export interface SecretFieldProps {
  /** a value is stored on the server (we never get it back) */
  saved: boolean;
  /** masked hint to show while saved, e.g. "AC12••••89" */
  masked?: string;
  /** what the owner typed. Empty = keep what is saved. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** called when the owner asks to delete the stored value */
  onClear?: () => void;
  id?: string;
  invalid?: boolean;
  autoComplete?: string;
  /** show what is typed from the start (identifiers that are not really secret, like a client ID) */
  plain?: boolean;
  /**
   * The value comes from the deployment's environment, which wins over anything saved here.
   * Shown as set, without Replace or Remove: changing it in the dashboard would do nothing.
   */
  fixed?: boolean;
}

/**
 * Password-style input for API keys. It is never pre-filled: when a key is already stored it
 * shows a "Saved" row with Replace, and only what the owner types is ever sent.
 */
export function SecretField({ saved, masked, value, onChange, placeholder, onClear, id, invalid, autoComplete = 'off', plain = false, fixed = false }: SecretFieldProps) {
  const [editing, setEditing] = useState(false);
  const [visible, setVisible] = useState(plain);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusNext = useRef(false);

  // After a save the typed value is cleared by the parent: fall back to the "Saved" row.
  useEffect(() => {
    if (saved && value === '' && !focusNext.current) setEditing(false);
  }, [saved, value]);

  useEffect(() => {
    if (editing && focusNext.current) {
      focusNext.current = false;
      inputRef.current?.focus();
    }
  }, [editing]);

  if (fixed) {
    return (
      <div className="x-secret x-secret--saved">
        <span className="x-secret__mask" aria-hidden="true">
          {masked || '••••••••••••'}
        </span>
        <span className="x-secret__state">
          <Lock size={14} aria-hidden="true" />
          Set in your deployment
        </span>
      </div>
    );
  }

  if (saved && !editing) {
    return (
      <div className="x-secret x-secret--saved">
        <span className="x-secret__mask" aria-hidden="true">
          {masked || '••••••••••••'}
        </span>
        <span className="x-secret__state">
          <CircleCheck size={14} aria-hidden="true" />
          Saved
        </span>
        <span className="x-secret__actions">
          <Button
            size="sm"
            variant="ghost"
            id={id}
            onClick={() => {
              focusNext.current = true;
              setEditing(true);
            }}
          >
            Replace
          </Button>
          {onClear ? (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Remove
            </Button>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div className="x-secret">
      <Input
        ref={inputRef}
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        invalid={invalid}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore="true"
        data-lpignore="true"
        className="x-secret__input"
        onChange={(e) => onChange(e.target.value)}
        trailing={
          plain ? undefined : (
            <button type="button" className="x-secret__eye" aria-label={visible ? 'Hide what I typed' : 'Show what I typed'} aria-pressed={visible} onClick={() => setVisible((v) => !v)}>
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )
        }
      />
      {saved ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange('');
            setEditing(false);
          }}
        >
          Keep the saved one
        </Button>
      ) : null}
    </div>
  );
}

// ───────────── numbered steps ─────────────

export function Steps({ children, className }: { children: ReactNode; className?: string }) {
  return <ol className={cx('x-steps', className)}>{children}</ol>;
}

export interface StepProps {
  title: ReactNode;
  /** tick instead of the number */
  done?: boolean;
  children?: ReactNode;
}

export function Step({ title, done = false, children }: StepProps) {
  return (
    <li className={cx('x-step', done && 'is-done')}>
      <span className="x-step__num" aria-hidden="true">
        {done ? <Check size={13} strokeWidth={3} /> : null}
      </span>
      <div className="x-step__body">
        <p className="x-step__title">
          {title}
          {done ? <span className="u-vh"> (done)</span> : null}
        </p>
        {children ? <div className="x-step__text">{children}</div> : null}
      </div>
    </li>
  );
}

// ───────────── inline result of a test ─────────────

export type TestState = { status: 'idle' } | { status: 'running' } | { status: 'done'; ok: boolean; detail: string };

/** The answer to a "Send test" button, shown right where it was pressed. */
export function TestResult({ state }: { state: TestState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'running') {
    return (
      <p className="x-result x-result--running" role="status">
        <Spinner size={14} label="" />
        <span>Testing, one moment.</span>
      </p>
    );
  }
  return (
    <p className={cx('x-result', state.ok ? 'x-result--ok' : 'x-result--fail')} role={state.ok ? 'status' : 'alert'}>
      {state.ok ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
      <span>{state.detail}</span>
    </p>
  );
}

/** External link that opens in a new tab, styled as text. */
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="x-ext" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
