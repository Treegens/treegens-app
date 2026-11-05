import { NextFunction, Request, Response } from 'express'
import Joi from 'joi'

/** Request validation for /api/otc. Same 400 envelope as validation.ts. */

const MAX_RATE_KES = 100_000

const rate = Joi.number().greater(0).max(MAX_RATE_KES).precision(2)
const mpesaName = Joi.string().trim().min(2).max(120)
// Phone is normalised in the service; here we only bound the raw input.
const mpesaNumber = Joi.string().trim().min(7).max(32)
const reason = Joi.string().trim().min(1).max(500)
const objectId = Joi.string().trim().pattern(/^[a-fA-F0-9]{24}$/)
const inviteCode = Joi.string().trim().uppercase().length(10)

const schemas = {
  join: Joi.object({
    code: inviteCode.required(),
    mpesaNumber: mpesaNumber.required(),
    mpesaName: mpesaName.required(),
  }),
  mePatch: Joi.object({
    mpesaNumber,
    mpesaName,
  })
    .min(1)
    .unknown(false),
  inviteCreate: Joi.object({
    label: Joi.string().trim().allow('').max(120),
    ratePerTreeKes: rate.required(),
    maxUses: Joi.number().integer().min(1).max(100_000).allow(null),
    expiresAt: Joi.date().iso().greater('now').allow(null),
  }),
  invitePatch: Joi.object({
    isActive: Joi.boolean(),
    ratePerTreeKes: rate,
    label: Joi.string().trim().allow('').max(120),
    maxUses: Joi.number().integer().min(1).max(100_000).allow(null),
    expiresAt: Joi.date().iso().allow(null),
  })
    .min(1)
    .unknown(false),
  enrollmentPatch: Joi.object({
    ratePerTreeKes: rate,
    status: Joi.string().valid('active', 'paused'),
  })
    .min(1)
    .unknown(false),
  dealCreate: Joi.object({
    submissionId: objectId.required(),
  }),
  dispute: Joi.object({
    reason: reason.required(),
  }),
  cancel: Joi.object({
    reason: reason.allow(''),
  }),
  // Multipart fields arrive as strings; convert.
  paymentFields: Joi.object({
    mpesaRef: Joi.string().trim().allow('').max(40),
    amountKes: Joi.number().min(0).max(100_000_000),
    note: Joi.string().trim().allow('').max(500),
  }).unknown(true),
} as const

function validator(schema: Joi.ObjectSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body ?? {}, {
      convert: true,
      abortEarly: false,
      stripUnknown: false,
    })
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details.map(d => d.message),
      })
    }
    req.body = value
    return next()
  }
}

export const validateOtcJoin = validator(schemas.join)
export const validateOtcMePatch = validator(schemas.mePatch)
export const validateOtcInviteCreate = validator(schemas.inviteCreate)
export const validateOtcInvitePatch = validator(schemas.invitePatch)
export const validateOtcEnrollmentPatch = validator(schemas.enrollmentPatch)
export const validateOtcDealCreate = validator(schemas.dealCreate)
export const validateOtcDispute = validator(schemas.dispute)
export const validateOtcCancel = validator(schemas.cancel)
export const validateOtcPaymentFields = validator(schemas.paymentFields)
