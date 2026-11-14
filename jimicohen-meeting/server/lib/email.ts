// STUB
import type { SendResult, SiteSettings } from '../../shared/types';
import type { Ctx } from './ctx';

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  ics?: { filename: string; content: string; method: 'REQUEST' | 'CANCEL' | 'PUBLISH' };
}

export async function resolveEmailProvider(ctx: Ctx): Promise<'resend' | 'gmail' | 'none'> {
  throw new Error('not implemented');
}

export async function sendEmail(ctx: Ctx, msg: EmailMessage): Promise<SendResult> {
  throw new Error('not implemented');
}

export function renderEmailHtml(p: {
  site: SiteSettings;
  preheader?: string;
  heading: string;
  paragraphs: string[];
  details?: { label: string; value: string }[];
  actions?: { label: string; url: string; primary?: boolean }[];
  footer?: string;
}): string {
  throw new Error('not implemented');
}

export function buildMime(msg: EmailMessage, from: { name: string; email: string }): string {
  throw new Error('not implemented');
}
