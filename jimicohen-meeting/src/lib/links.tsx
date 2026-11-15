/**
 * Links to app routes that work both inside the app (router mounted at /meeting) and on a short link's
 * page (router mounted at /meet or /pod, see App.tsx). On a short path a router link would point at
 * /pod/booking/..., which is not a page of the app, so it becomes a plain link to /meeting/... instead
 * (a full page load, which is also what an email link opens).
 */
import { createContext, useCallback, useContext } from 'react';
import type { AnchorHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { APP_BASE } from './api';

/** true while the router is mounted on a short path instead of /meeting */
export const OutsideAppBase = createContext(false);

/** "/booking/x" → "/booking/x" for a router inside the app, "/meeting/booking/x" for a plain link from a short path. */
export function appPath(to: string): string {
  return `${APP_BASE}${to.startsWith('/') ? to : `/${to}`}`;
}

/** For ButtonLink-style props: the href to use for an app route where this component is rendered. */
export function useAppHref(): { outside: boolean; href: (to: string) => string } {
  const outside = useContext(OutsideAppBase);
  const href = useCallback((to: string) => (outside ? appPath(to) : to), [outside]);
  return { outside, href };
}

export type AppLinkProps = { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

/** A link to an app route ("/booking/...", "/"). Inside the app a router Link; on a short path a plain <a href="/meeting/...">. */
export function AppLink({ to, children, ...rest }: AppLinkProps) {
  const outside = useContext(OutsideAppBase);
  if (outside) {
    return (
      <a href={appPath(to)} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} {...rest}>
      {children}
    </Link>
  );
}
