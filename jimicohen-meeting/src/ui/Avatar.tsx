import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { cx, initialsOf } from './util';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;

const SIZES: Record<Exclude<AvatarSize, number>, number> = { xs: 24, sm: 32, md: 40, lg: 56, xl: 88 };

export interface AvatarProps {
  /** used for the initials fallback and the image alt text */
  name: string;
  /** same-origin or data: URL (the CSP blocks everything else) */
  src?: string | null;
  size?: AvatarSize;
  /** defaults to the theme's avatar shape on public pages and a circle in the dashboard */
  shape?: 'circle' | 'rounded' | 'square';
  /** treat as decoration: no alt text, hidden from screen readers (use next to a visible name) */
  decorative?: boolean;
  className?: string;
}

/** A person's picture, or their initials on a tinted tile when there is no picture. */
export function Avatar({ name, src, size = 'md', shape, decorative = false, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const px = typeof size === 'number' ? size : SIZES[size];
  const showImage = !!src && !failed;
  return (
    <span
      className={cx('ui-avatar', shape && `ui-avatar--${shape}`, className)}
      style={{ '--_s': `${px}px` } as CSSProperties}
      role={decorative || showImage ? undefined : 'img'}
      aria-label={decorative || showImage ? undefined : name}
      aria-hidden={decorative || undefined}
    >
      {showImage ? (
        <img src={src ?? undefined} alt={decorative ? '' : name} width={px} height={px} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="ui-avatar__initials" aria-hidden="true">
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}

export interface AvatarGroupProps {
  people: { name: string; avatarUrl?: string | null }[];
  size?: AvatarSize;
  shape?: AvatarProps['shape'];
  /** show at most this many, then "+N" */
  max?: number;
  className?: string;
}

/** Overlapping avatars for meetings with several hosts. Announced as one list of names. */
export function AvatarGroup({ people, size = 'md', shape, max = 4, className }: AvatarGroupProps) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const px = typeof size === 'number' ? size : SIZES[size];
  return (
    <span className={cx('ui-avatar-group', className)} role="img" aria-label={people.map((p) => p.name).join(', ')} style={{ '--_s': `${px}px` } as CSSProperties}>
      {shown.map((p, i) => (
        <Avatar key={`${p.name}-${i}`} name={p.name} src={p.avatarUrl} size={size} shape={shape} decorative />
      ))}
      {extra > 0 ? (
        <span className={cx('ui-avatar ui-avatar--more', shape && `ui-avatar--${shape}`)} aria-hidden="true">
          <span className="ui-avatar__initials">+{extra}</span>
        </span>
      ) : null}
    </span>
  );
}
