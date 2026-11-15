/**
 * Whether a reminder "to the host" can reach the hosts of an event. The server only sends a host
 * a text when they have a mobile number and texts switched on, and an email when they have an
 * address and emails switched on (server/lib/jobs.ts, hostReachable). These helpers say the same
 * thing in the editor, before the reminder silently goes nowhere.
 */
import type { AdminHost, ReminderChannel } from '../../../../shared/types';
import { firstName, namesList } from '../../format';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The hosts a reminder to the host cannot reach on this channel: no address or number, or that kind of message switched off. */
export function unreachableHosts(channel: ReminderChannel, hosts: AdminHost[]): AdminHost[] {
  if (channel === 'sms') return hosts.filter((h) => !h.phone?.trim() || !h.notify.sms);
  if (channel === 'email') return hosts.filter((h) => !EMAIL.test(h.email ?? '') || h.notify.email === false);
  return [];
}

export interface HostGap {
  /** a sentence or two for the reminder dialog */
  text: string;
  /** a few words for the reminder list */
  short: string;
  /** where it is fixed: Settings for the owner, Team for a co-host */
  href: string;
  /** the link's label */
  place: string;
}

/** Whether a host the reminder does not reach has no number or address at all (rather than that kind of message switched off). */
function lacksContact(channel: ReminderChannel, host: AdminHost): boolean {
  return channel === 'sms' ? !host.phone?.trim() : !EMAIL.test(host.email ?? '');
}

/** What to say about the hosts a reminder to the host does not reach, and where that is fixed. Null when it reaches everyone. */
export function hostGap(channel: ReminderChannel, missing: AdminHost[], ownerId: string): HostGap | null {
  if (missing.length === 0 || channel === 'call') return null;
  const you = missing.some((h) => h.id === ownerId);
  const others = missing.filter((h) => h.id !== ownerId).map((h) => firstName(h.name) || h.name);
  const what = channel === 'sms' ? 'text' : 'email';
  // Say what is actually missing: a number (or address), the switch, or, for several people, either.
  const noContact = missing.every((h) => lacksContact(channel, h));
  const switchedOff = missing.every((h) => !lacksContact(channel, h));
  const contact = channel === 'sms' ? 'no mobile number saved' : 'no email address saved';
  const off = channel === 'sms' ? 'texts about bookings switched off' : 'emails about bookings switched off';
  const lack = noContact ? contact : switchedOff ? off : `${contact}, or ${channel === 'sms' ? 'texts' : 'emails'} switched off`;
  const href = you ? '/admin/settings#notices' : '/admin/team';
  const place = you ? 'Open Settings' : 'Open Team';
  if (others.length === 0) {
    // The owner's mobile number and "Text me about bookings" sit beside "Send my booking notices to" in Settings.
    const fix =
      channel === 'email'
        ? switchedOff
          ? 'Check where your booking notices go under Settings.'
          : 'Add the address for your booking notices under Settings.'
        : switchedOff
          ? 'Switch texts on under Settings, next to where your booking notices go.'
          : 'Add it under Settings, next to where your booking notices go.';
    return { text: `You have ${lack}, so this ${what} does not reach you. ${fix}`, short: 'Does not reach you yet', href, place };
  }
  const names = namesList(others);
  if (!you) {
    // The Team dialog holds a co-host's address, number and texts switch. Emails are switched on on their own page.
    const fix = noContact
      ? 'Add it in their details on the Team page, or ask them to on their private page.'
      : !switchedOff
        ? 'Add what is missing in their details on the Team page, or ask them to on their private page.'
        : channel === 'sms'
          ? 'Switch their texts on in their details on the Team page, or ask them to on their private page.'
          : 'Ask them to switch emails about bookings on, on their private page.';
    return {
      text: `${names} ${others.length === 1 ? 'has' : 'have'} ${lack}, so this ${what} does not reach ${others.length === 1 ? 'them' : 'those hosts'}. ${fix}`,
      short: `Does not reach ${names} yet`,
      href,
      place,
    };
  }
  return {
    text: `You and ${names} have ${lack}, so this ${what} does not reach you or them. ${noContact ? 'Add yours under Settings, and theirs in their details on the Team page.' : 'Check yours under Settings, and theirs on the Team page.'}`,
    short: `Does not reach you and ${names} yet`,
    href,
    place,
  };
}
