import { forwardRef } from 'react';
import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import { cx } from './util';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** element to render, default div */
  as?: ElementType;
  /**
   * themed = follows the theme's card style on public pages (flat, bordered, elevated, glass)
   * and a quiet bordered panel in the dashboard. The others force a look.
   */
  variant?: 'themed' | 'outline' | 'raised' | 'sunken' | 'plain';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** hover and focus treatment for cards that are links or buttons */
  interactive?: boolean;
  /** highlighted outline, e.g. the chosen option */
  selected?: boolean;
  /** optional header: title on the left */
  title?: ReactNode;
  description?: ReactNode;
  /** header controls on the right */
  actions?: ReactNode;
  /** heading level for the title */
  titleAs?: 'h2' | 'h3' | 'h4';
}

/** A surface that groups related content. */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Tag = 'div', variant = 'themed', padding = 'md', interactive = false, selected = false, title, description, actions, titleAs: TitleTag = 'h3', className, children, ...rest },
  ref,
) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <Tag
      ref={ref}
      className={cx('ui-card', `ui-card--${variant}`, `ui-card--pad-${padding}`, interactive && 'ui-card--interactive', selected && 'is-selected', className)}
      {...rest}
    >
      {hasHeader ? (
        <div className="ui-card__header">
          <div className="ui-card__heading">
            {title !== undefined ? <TitleTag className="ui-card__title">{title}</TitleTag> : null}
            {description ? <p className="ui-card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="ui-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  );
});
