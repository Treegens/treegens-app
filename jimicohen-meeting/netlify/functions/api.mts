import type { Config, Context } from '@netlify/functions';
import { handle } from '../../server/api';
import { netlifyCtx } from '../../server/lib/runtime';

export default (req: Request, context: Context) => handle(req, netlifyCtx(req, context));

export const config: Config = { path: '/meeting/api/*' };
