/**
 * The frame every integration shares: icon, name, one line of what it is for, a status badge,
 * and a body that opens and closes. Plus the hook behind every "Send test" button.
 */
import { useCallback, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { IntegrationTestRequest } from '../../../../shared/types';
import { errorMessage, testIntegration } from '../../../lib/api';
import { Badge, cx } from '../../../ui';
import type { BadgeTone } from '../../../ui';
import type { TestState } from './bits';

export interface IntegrationStatus {
  tone: BadgeTone;
  label: string;
}

export interface IntegrationCardProps {
  /** anchor id, so other pages can link to "#google" */
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  status: IntegrationStatus;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function IntegrationCard({ id, icon, title, description, status, open, onToggle, children }: IntegrationCardProps) {
  const base = useId();
  return (
    <section className={cx('ix-card', open && 'is-open')} id={id} aria-labelledby={`${base}-title`}>
      {/* The button holds only the name (so the heading reads well); its ::after makes the whole row clickable. */}
      <div className="ix-card__head">
        <span className="ix-card__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="ix-card__text">
          <h2 className="ix-card__h">
            <button type="button" className="ix-card__toggle" id={`${base}-title`} aria-expanded={open} aria-controls={`${base}-body`} aria-describedby={`${base}-desc ${base}-status`} onClick={onToggle}>
              {title}
            </button>
          </h2>
          <p className="ix-card__desc" id={`${base}-desc`}>
            {description}
          </p>
        </div>
        <span className="ix-card__status" id={`${base}-status`}>
          <Badge tone={status.tone} dot>
            {status.label}
          </Badge>
        </span>
        <ChevronDown size={18} aria-hidden="true" className="ix-card__chev" />
      </div>
      {open ? (
        <div className="ix-card__body" id={`${base}-body`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** A titled block inside a card body. */
export function IxBlock({ title, children, aside }: { title?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="ix-block">
      {title ? (
        <div className="ix-block__head">
          <h3 className="ix-block__title">{title}</h3>
          {aside}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Runs POST /admin/integrations/test and keeps the answer for the inline result. */
export function useIntegrationTest(): [TestState, (req: IntegrationTestRequest) => Promise<void>, () => void] {
  const [state, setState] = useState<TestState>({ status: 'idle' });
  const run = useRef(0);
  const start = useCallback(async (req: IntegrationTestRequest) => {
    const mine = ++run.current;
    setState({ status: 'running' });
    try {
      const res = await testIntegration(req);
      if (run.current === mine) setState({ status: 'done', ok: res.ok, detail: res.detail });
    } catch (e) {
      if (run.current === mine) setState({ status: 'done', ok: false, detail: errorMessage(e, 'The test could not run. Please try again.') });
    }
  }, []);
  const reset = useCallback(() => {
    run.current++;
    setState({ status: 'idle' });
  }, []);
  return [state, start, reset];
}
