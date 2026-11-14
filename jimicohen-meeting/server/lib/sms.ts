// STUB
import type { SendResult } from '../../shared/types';
import type { Ctx } from './ctx';

export async function sendSms(ctx: Ctx, p: { to: string; body: string }): Promise<SendResult> {
  throw new Error('not implemented');
}

/** TwiML response */
export async function handleInboundSms(ctx: Ctx, req: Request): Promise<Response> {
  throw new Error('not implemented');
}
