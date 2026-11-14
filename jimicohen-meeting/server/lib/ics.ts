// STUB
import type { Booking, Host, SiteSettings } from '../../shared/types';

export function buildBookingIcs(p: {
  booking: Booking;
  hosts: Host[];
  site: SiteSettings;
  method: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  baseUrl: string;
}): string {
  throw new Error('not implemented');
}

export function calendarLinks(p: { booking: Booking; hosts: Host[]; baseUrl: string; manageToken: string }): {
  google: string;
  outlook: string;
  ics: string;
} {
  throw new Error('not implemented');
}
