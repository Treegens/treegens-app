// STUB
import type { Booking, EventType, Job, SendResult } from '../../shared/types';
import type { Ctx } from './ctx';

export type JobHandler = (ctx: Ctx, job: Job) => Promise<SendResult>;

export function registerJobHandler(type: Job['type'], handler: JobHandler): void {
  throw new Error('not implemented');
}

export async function enqueueJob(ctx: Ctx, j: Omit<Job, 'key' | 'id' | 'attempt' | 'createdAt'>): Promise<Job> {
  throw new Error('not implemented');
}

export async function scheduleBookingJobs(ctx: Ctx, booking: Booking, eventType: EventType, immediate: 'created' | 'rescheduled' | null): Promise<void> {
  throw new Error('not implemented');
}

/** removes pending reminder jobs for the booking */
export async function cancelBookingJobs(ctx: Ctx, bookingId: string): Promise<void> {
  throw new Error('not implemented');
}

export async function runDueJobs(
  ctx: Ctx,
  opts?: { budgetMs?: number; onlyBookingId?: string },
): Promise<{ processed: number; failed: number; remaining: number }> {
  throw new Error('not implemented');
}

/** the built-in 'message' handler */
export async function deliverMessage(ctx: Ctx, job: Job): Promise<SendResult> {
  throw new Error('not implemented');
}
