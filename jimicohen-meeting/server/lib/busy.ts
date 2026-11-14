// STUB
import type { Host } from '../../shared/types';
import type { Ctx } from './ctx';
import type { Interval } from './time';

export interface HostBusy {
  hostId: string;
  busy: Interval[];
  ok: boolean;
  error?: string;
}

export async function getHostBusy(ctx: Ctx, host: Host, range: Interval, opts?: { fresh?: boolean }): Promise<HostBusy> {
  throw new Error('not implemented');
}

export async function getBusyForHosts(ctx: Ctx, hosts: Host[], range: Interval, opts?: { fresh?: boolean }): Promise<HostBusy[]> {
  throw new Error('not implemented');
}

export async function syncHostTimezone(ctx: Ctx, host: Host): Promise<Host> {
  throw new Error('not implemented');
}
