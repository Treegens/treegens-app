// STUB
import type { Ctx } from './ctx';

export async function twilioConfigured(ctx: Ctx): Promise<boolean> {
  throw new Error('not implemented');
}

/** path under /2010-04-01/Accounts/<sid> */
export async function twilioRequest(ctx: Ctx, method: 'GET' | 'POST', path: string, params?: Record<string, string>): Promise<any> {
  throw new Error('not implemented');
}

export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  throw new Error('not implemented');
}

export async function verifyTwilioRequest(ctx: Ctx, req: Request, form: URLSearchParams): Promise<boolean> {
  throw new Error('not implemented');
}

/** E.164 via libphonenumber-js */
export function normalizePhone(input: string, defaultCountry?: string): string | null {
  throw new Error('not implemented');
}
