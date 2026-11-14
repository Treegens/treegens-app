// STUB
import type { Booking, EventType, Host, MessageKind, ReminderChannel, SiteSettings } from '../../shared/types';
import type { Ctx } from './ctx';

export type TemplateVars = Record<string, string>;

export const TEMPLATE_VARIABLES: { key: string; description: string }[] = [];

export function buildVars(
  ctx: Ctx,
  p: { booking: Booking; eventType: EventType | null; hosts: Host[]; site: SiteSettings; audience: 'invitee' | 'host' },
): TemplateVars {
  throw new Error('not implemented');
}

/** {{var}}; unknown vars render empty; html=true escapes values */
export function renderTemplate(tpl: string, vars: TemplateVars, opts?: { html?: boolean }): string {
  throw new Error('not implemented');
}

export function defaultMessage(kind: MessageKind, channel: ReminderChannel, audience: 'invitee' | 'host'): { subject: string; body: string } {
  throw new Error('not implemented');
}
