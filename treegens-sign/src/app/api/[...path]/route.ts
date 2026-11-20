import '@/server/routes-account';
import '@/server/routes-envelopes';
import '@/server/routes-sign';
import { handle } from '@/server/router';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
