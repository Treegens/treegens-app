// STUB
import type { Ctx } from './ctx';
import type { Interval } from './time';

/** https only, no IP literals, no localhost/.local/.internal, no credentials */
export function assertSafeFeedUrl(url: string): URL {
  throw new Error('not implemented');
}

export function parseIcsBusy(icsText: string, range: Interval): Interval[] {
  throw new Error('not implemented');
}

export async function fetchIcsBusy(ctx: Ctx, url: string, range: Interval): Promise<Interval[]> {
  throw new Error('not implemented');
}
