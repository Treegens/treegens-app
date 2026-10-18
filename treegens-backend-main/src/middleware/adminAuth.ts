import crypto from 'crypto'
import { NextFunction, Request, Response } from 'express'
import env from '../config/environment'

/**
 * Guards the admin API with a single shared bearer token (`ADMIN_API_TOKEN`).
 *
 * The token is never handed to a browser: the notifications console keeps it
 * in a Netlify function and the operator only ever sees a password. If the
 * token is unset the routes stay closed rather than open — an unconfigured
 * deploy must not become an open broadcast endpoint.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on length mismatch, so compare digests of fixed size.
  const hashA = crypto.createHash('sha256').update(bufA).digest()
  const hashB = crypto.createHash('sha256').update(bufB).digest()
  return crypto.timingSafeEqual(hashA, hashB)
}

export function adminAuth(req: Request, res: Response, next: NextFunction) {
  const expected = env.ADMIN_API_TOKEN

  if (!expected) {
    console.error('Admin API called but ADMIN_API_TOKEN is not configured')
    return res.status(503).json({
      error: 'Admin API is not configured on this deployment',
      code: 'ADMIN_NOT_CONFIGURED',
    })
  }

  const header = req.header('Authorization') || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (!provided || !timingSafeEqual(provided, expected)) {
    console.warn('Admin authentication failed', {
      path: req.path,
      method: req.method,
      ip: req.ip,
    })
    return res.status(401).json({
      error: 'Access denied.',
      code: 'ADMIN_UNAUTHORIZED',
    })
  }

  return next()
}

export default adminAuth
