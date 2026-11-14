// STUB
import type {
  Booking,
  CreateBookingRequest,
  EventType,
  Host,
  IanaZone,
  PublicBooking,
  PublicEventType,
  PublicSite,
  SlotsResponse,
} from '../../shared/types';
import type { Ctx } from './ctx';

/** hmacHex(ctx, 'manage', bookingId) */
export function manageToken(ctx: Ctx, bookingId: string): string {
  throw new Error('not implemented');
}

export function verifyManageToken(ctx: Ctx, bookingId: string, token: string | null): boolean {
  throw new Error('not implemented');
}

export async function toPublicSite(ctx: Ctx): Promise<PublicSite> {
  throw new Error('not implemented');
}

export function toPublicEventType(ctx: Ctx, et: EventType, hosts: Host[]): PublicEventType {
  throw new Error('not implemented');
}

export async function toPublicBooking(ctx: Ctx, b: Booking): Promise<PublicBooking> {
  throw new Error('not implemented');
}

export async function getSlots(
  ctx: Ctx,
  p: { slug: string; durationMin: number; fromMs: number; toMs: number; rescheduleBookingId?: string },
): Promise<SlotsResponse> {
  throw new Error('not implemented');
}

export async function createBooking(ctx: Ctx, req: CreateBookingRequest): Promise<{ booking: Booking; manageToken: string }> {
  throw new Error('not implemented');
}

export async function cancelBooking(ctx: Ctx, bookingId: string, p: { by: 'invitee' | 'host' | 'assistant'; reason?: string }): Promise<Booking> {
  throw new Error('not implemented');
}

export async function rescheduleBooking(
  ctx: Ctx,
  bookingId: string,
  p: { startIso: string; by: 'invitee' | 'host'; timezone?: IanaZone },
): Promise<Booking> {
  throw new Error('not implemented');
}

export async function confirmAttendance(ctx: Ctx, bookingId: string, via: 'call' | 'sms' | 'link'): Promise<Booking> {
  throw new Error('not implemented');
}

export async function syncBookingToCalendar(ctx: Ctx, bookingId: string): Promise<void> {
  throw new Error('not implemented');
}
