import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import type { Request } from 'express'

const defaults = {
  standardHeaders: true,
  legacyHeaders: false,
} as const

/**
 * Field events put many planters and verifiers behind ONE shared IP — the
 * event's wifi or a cellular carrier's NAT. Keying limits by IP would pool
 * everyone on that network into a single budget and throttle real users mid
 * event. So authenticated routes key by wallet: each person gets their own
 * budget regardless of the network they share. Requests without an
 * authenticated user fall back to an IPv6-safe IP key.
 */
const userOrIpKey = (req: Request): string => {
  const wallet = (req as unknown as { user?: { walletAddress?: string } }).user
    ?.walletAddress
  if (wallet) return `usr:${String(wallet).toLowerCase()}`
  return `ip:${ipKeyGenerator(req.ip ?? '')}`
}

// Allow tuning without a redeploy. RATE_LIMIT_MULTIPLIER scales every
// per-route max (e.g. set to "2" for a big field event); GLOBAL_RATE_LIMIT_MAX
// overrides the shared-IP safety net outright.
const MULT = Math.max(1, Number(process.env.RATE_LIMIT_MULTIPLIER) || 1)
const scaled = (n: number) => Math.ceil(n * MULT)

/** Per-wallet limiter for authenticated routes (see userOrIpKey). */
const userLimiter = (perMinute: number) =>
  rateLimit({
    ...defaults,
    windowMs: 60 * 1000,
    max: scaled(perMinute),
    keyGenerator: userOrIpKey,
  })

/**
 * Broad safety net for all `/api/*` routes. This runs before auth, so it can
 * only key by IP — which means a whole field event shares one bucket. Sized
 * generously for that (was 500/15min, which a single busy event would trip)
 * and overridable via GLOBAL_RATE_LIMIT_MAX. Per-wallet limiters below do the
 * real per-user fairness once a request is authenticated.
 */
export const globalApiLimiter = rateLimit({
  ...defaults,
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.GLOBAL_RATE_LIMIT_MAX) || scaled(5000),
})

/** POST /api/auth/challenge — challenge storage and signing prep (pre-auth → IP). */
export const authChallengeLimiter = rateLimit({
  ...defaults,
  windowMs: 60 * 1000,
  max: scaled(20),
})

/** POST /api/auth/signin — signature verification (pre-auth → IP). */
export const authSignInLimiter = rateLimit({
  ...defaults,
  windowMs: 60 * 1000,
  max: scaled(20),
})

/** POST /api/submissions/upload — multipart + storage. */
export const submissionUploadLimiter = userLimiter(30)

/** POST /api/users/verifier/check | /verifier/request — RPC reads. */
export const verifierPublicLimiter = userLimiter(40)

/** POST /api/submissions/:id/vote — verifier votes. */
export const submissionVoteLimiter = userLimiter(60)

/** POST /api/rewards/claim — queue + chain work. */
export const rewardClaimLimiter = userLimiter(30)

/** POST /api/users/me/social-rewards/tasks/:taskKey/complete */
export const socialTaskCompleteLimiter = userLimiter(20)

/** GET /api/notifications*, polling unread counts. */
export const notificationPollLimiter = userLimiter(200)

/** POST /api/push/subscribe|unsubscribe */
export const pushSubscribeLimiter = userLimiter(30)

/** POST /api/submissions/:id/conversation/messages */
export const conversationMessageLimiter = userLimiter(60)
