// STUB
import type { AssistantSettings, Booking, IanaZone, SendResult } from '../../shared/types';
import type { Ctx } from './ctx';

export const VOICE_OPTIONS: { id: string; label: string }[] = [];

export function withinCallWindow(nowMs: number, tz: IanaZone, a: AssistantSettings): boolean {
  throw new Error('not implemented');
}

export async function startReminderCall(ctx: Ctx, p: { booking: Booking; purpose: 'reminder' | 'test'; to?: string }): Promise<SendResult> {
  throw new Error('not implemented');
}

export async function handleVoiceWebhook(ctx: Ctx, req: Request, step: 'start' | 'turn' | 'status' | 'amd'): Promise<Response> {
  throw new Error('not implemented');
}
