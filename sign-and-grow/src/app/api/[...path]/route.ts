import '@/server/routes-account';
import '@/server/routes-signin';
import '@/server/routes-envelopes';
import '@/server/routes-sign';
import '@/server/routes-signercode';
import '@/server/routes-groups';
import '@/server/routes-bounces';
import '@/server/routes-billing';
import '@/server/routes-trust';
import '@/server/routes-support';
import '@/server/routes-paylink';
import '@/server/routes-templates';
import '@/server/routes-evidence';
import '@/server/openapi';
import { handle } from '@/server/router';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
