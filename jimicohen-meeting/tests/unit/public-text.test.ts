/**
 * What the confirmation and booking pages say about the invitee's calendar, from what really reaches them:
 * Google's invitation (with the one tap Google may ask for), the invitation in our email, or neither.
 */
import { describe, expect, it } from 'vitest';
import type { PublicBooking } from '../../shared/types';
import { calendarBlock, calendarHint, calendarNote, deliveryLine } from '../../src/public/lib/text';

function booking(delivery: PublicBooking['delivery']): PublicBooking {
  return { invitee: { name: 'Ada', email: 'ada@gmail.com', timezone: 'UTC' }, delivery } as PublicBooking;
}

const GOOGLE = booking({ email: true, calendarInvite: true });
const GOOGLE_ONLY = booking({ email: false, calendarInvite: true });
const EMAIL = booking({ email: true, calendarInvite: false });
const NEITHER = booking({ email: false, calendarInvite: false });

describe('the invitee calendar wording', () => {
  it('says Google is adding it, and the one tap it may need, only while Google invites them', () => {
    expect(deliveryLine(GOOGLE, false)).toBe('This meeting is being added to your calendar with a Google Calendar invitation sent to ada@gmail.com. Your confirmation email is on its way there too.');
    expect(deliveryLine(GOOGLE_ONLY, false)).toBe('This meeting is being added to your calendar with a Google Calendar invitation sent to ada@gmail.com.');
    expect(calendarHint(GOOGLE)).toBe('Don\'t see it in your calendar? If the invitation says it is from an unknown sender, tap "I know the sender", then Yes.');
    expect(calendarHint(EMAIL)).toBeNull();
    expect(calendarHint(NEITHER)).toBeNull();
    expect(deliveryLine(GOOGLE, true)).toBe('Google Calendar is sending an updated invitation to ada@gmail.com, which moves the meeting in your calendar.');
  });

  it('offers only the calendar file next to a Google invitation, as a backup for people without Google Calendar', () => {
    expect(calendarBlock(GOOGLE)).toEqual({ label: 'Not using Google Calendar?', fileOnly: true });
    // Our email carries the invitation: the buttons are a second way.
    expect(calendarBlock(EMAIL)).toEqual({ label: 'Or add it yourself', fileOnly: false });
    // Nothing reaches them: the buttons are the way.
    expect(calendarBlock(NEITHER)).toEqual({ label: 'Add to your calendar', fileOnly: false });
  });

  it('says where the invitation is, when one went out', () => {
    expect(deliveryLine(EMAIL, false)).toBe('A confirmation email with a calendar invitation is on its way to ada@gmail.com. Open the invitation to add the meeting to your calendar.');
    expect(deliveryLine(EMAIL, true)).toBe('An email with the new time and an updated calendar invitation is on its way to ada@gmail.com.');
    expect(deliveryLine(NEITHER, false)).toBe('No confirmation email is sent for this booking, so please add it to your calendar with the buttons below.');
    expect(calendarNote(GOOGLE)).toBe('Google Calendar sent the invitation for this meeting to ada@gmail.com.');
    expect(calendarNote(EMAIL)).toBe('The calendar invitation is in your confirmation email to ada@gmail.com.');
    expect(calendarNote(NEITHER)).toBeNull();
  });

  it('uses no dashes a person would read as an em dash', () => {
    for (const b of [GOOGLE, GOOGLE_ONLY, EMAIL, NEITHER]) {
      for (const text of [deliveryLine(b, false), deliveryLine(b, true), calendarHint(b) ?? '', calendarNote(b) ?? '', calendarBlock(b).label]) expect(text).not.toMatch(/[‒-―]/);
    }
  });
});

describe("the Hosts tab's summary", () => {
  it('only promises a calendar when a host can write to Google', async () => {
    const { hostsSummary } = await import('../../src/admin/components/event/HostsTab');
    expect(hostsSummary('solo', ['Jimi'], [true])).toBe("People book Jimi. The meeting goes on Jimi's calendar.");
    expect(hostsSummary('solo', ['Jimi'], [false])).toBe('People book Jimi. Until Jimi connects Google Calendar, the meeting goes on no calendar.');
    expect(hostsSummary('collective', ['Jimi', 'Ian'], [false, false])).toBe('People only see times when Jimi and Ian are both free. Until one of them connects Google Calendar, bookings go on no calendar.');
    expect(hostsSummary('collective', ['Jimi', 'Ian'], [true, false])).toBe('People only see times when Jimi and Ian are both free. One booking puts the meeting on both calendars.');
    expect(hostsSummary('round_robin', ['Jimi', 'Ian'], [true, false])).toBe(
      'People see every time when Jimi or Ian is free. Each booking goes to one of them, and bookings are shared out evenly. Until Ian connects Google Calendar, their bookings go on no calendar.',
    );
  });
});
