import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Compass } from 'lucide-react';
import { ThemeScope, cachedTheme } from '../lib/theme';
import { ButtonLink } from './Button';
import { Card } from './Card';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';

/** Shown while a lazy route chunk loads. Fades in late so fast loads never flash a spinner. */
export function RouteFallback() {
  return (
    <div className="app-boot" role="status">
      <Spinner size={24} label="Loading" />
    </div>
  );
}

/** Themed 404 for URLs that match no route. */
export function NotFound({ title = 'This page does not exist', description = 'The link may be old or mistyped. You can still pick a time from the main page.' }: { title?: string; description?: string }) {
  return (
    <ThemeScope {...cachedTheme()}>
      <main className="app-message">
        <Card padding="lg" style={{ width: 'min(100%, 460px)' }}>
          <EmptyState
            as="h2"
            icon={<Compass />}
            title={title}
            description={description}
            action={
              <ButtonLink to="/" variant="primary">
                See available meetings
              </ButtonLink>
            }
          />
        </Card>
      </main>
    </ThemeScope>
  );
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Last line of defence: a render error anywhere shows a plain, dependency-free message
 * instead of a blank page. A failed chunk load (new deploy while the tab was open) gets a
 * message that says so.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = /Loading chunk|dynamically imported module|Importing a module script failed/i.test(error.message);
    return (
      <div className="app-crash" role="alert">
        <div>
          <h1>{stale ? 'A newer version is ready' : 'Something went wrong'}</h1>
          <p>{stale ? 'This page was updated while you had it open. Reload to continue.' : 'Sorry about that. Reloading the page usually fixes it, and nothing you booked is lost.'}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
