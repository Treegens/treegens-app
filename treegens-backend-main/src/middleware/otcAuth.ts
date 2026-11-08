import { NextFunction, Request, Response } from 'express'
import env from '../config/environment'
import { isOtcBuyerWallet } from '../services/otcDealRules'

/**
 * Only wallets listed in OTC_BUYER_WALLETS may run the OTC desk: create
 * invite links, read planters' M-Pesa numbers, upload payment proof, cancel
 * deals. Must run after `authenticate`. The allowlist is read per request so
 * a dashboard env change takes effect on the next deploy without code edits.
 */
export function requireOtcBuyer(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const wallet = req.user?.walletAddress
  if (!wallet) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
    })
  }
  if (!isOtcBuyerWallet(wallet, env.OTC_BUYER_WALLETS)) {
    return res.status(403).json({
      error: 'Access denied. OTC buyer role required.',
      code: 'OTC_BUYER_REQUIRED',
    })
  }
  return next()
}

export function isOtcBuyer(wallet: string | null | undefined): boolean {
  return isOtcBuyerWallet(wallet, env.OTC_BUYER_WALLETS)
}
