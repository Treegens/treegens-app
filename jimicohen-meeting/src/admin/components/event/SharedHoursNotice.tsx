import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { checkSharedHours } from '../../../lib/api';
import { ButtonLink } from '../../../ui';
import { useAdmin } from '../../state';
import { Notice } from '../Page';
import { askSharedHours, currentAnswer, sharedHoursKey } from './sharedHours';
import type { HeldAnswer, SharedHoursAnswer } from './sharedHours';
import type { TabProps } from './shared';

/** How long the editor waits after the last change before asking. */
const DEBOUNCE_MS = 400;

/**
 * For a joint meeting: do the hosts' working hours ever line up? Asked of the server, which runs the
 * booking page's own slot engine, a moment after the hosts, lengths or anything on the Scheduling tab
 * changes. Null when there is nothing to show yet: no joint meeting, or a check still under way.
 */
export function useSharedHours(draft: TabProps['draft']): SharedHoursAnswer | null {
  const { data } = useAdmin();
  const key = sharedHoursKey(draft, data.hosts);
  const [held, setHeld] = useState<HeldAnswer | null>(null);
  const latest = useRef(draft);
  latest.current = draft;

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void askSharedHours(latest.current, checkSharedHours, controller.signal).then((answer) => {
        if (answer) setHeld({ key, answer });
      });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return currentAnswer(key, held);
}

/** The editor's warning that nobody can book a joint meeting, or a quiet line when that could not be checked. Saving is never held up by it. */
export function SharedHoursNotice({ answer }: { answer: SharedHoursAnswer | null }) {
  if (answer === 'failed') {
    return (
      <p className="adm-quiet" role="status">
        Could not check whether the hosts&apos; working hours meet.
      </p>
    );
  }
  if (!answer || answer.ok || !answer.message) return null;
  return (
    <Notice
      tone="warning"
      title="Nobody can book this meeting"
      action={
        answer.href ? (
          <ButtonLink variant="secondary" size="sm" to={answer.href} iconRight={<ChevronRight size={15} />}>
            {answer.href === '/admin/availability' ? 'Your hours' : 'Team'}
          </ButtonLink>
        ) : undefined
      }
    >
      {answer.message}
    </Notice>
  );
}
