import { CalendarPlus, Download } from 'lucide-react';
import type { PublicBooking } from '../../../shared/types';
import { ButtonLink } from '../../ui';

export interface CalendarButtonsProps {
  links: PublicBooking['calendarLinks'];
  /** preview mode: buttons are shown but go nowhere */
  inert?: boolean;
}

/**
 * Add the meeting to Google Calendar, Outlook.com, Office 365 (work and school accounts), or any
 * calendar through an .ics file.
 */
export function CalendarButtons({ links, inert = false }: CalendarButtonsProps) {
  const stop = inert ? (e: { preventDefault: () => void }) => e.preventDefault() : undefined;
  return (
    <div className="bk-cal" role="group" aria-label="Add to your calendar">
      <ButtonLink href={inert ? '#' : links.google} external={!inert} variant="secondary" size="sm" iconLeft={<CalendarPlus size={16} />} onClick={stop}>
        Google
      </ButtonLink>
      <ButtonLink href={inert ? '#' : links.outlook} external={!inert} variant="secondary" size="sm" iconLeft={<CalendarPlus size={16} />} onClick={stop}>
        Outlook.com
      </ButtonLink>
      {links.office365 ? (
        <ButtonLink href={inert ? '#' : links.office365} external={!inert} variant="secondary" size="sm" iconLeft={<CalendarPlus size={16} />} onClick={stop}>
          Office 365
        </ButtonLink>
      ) : null}
      <ButtonLink href={inert ? '#' : links.ics} download="meeting.ics" variant="secondary" size="sm" iconLeft={<Download size={16} />} onClick={stop}>
        Apple or other
      </ButtonLink>
    </div>
  );
}
