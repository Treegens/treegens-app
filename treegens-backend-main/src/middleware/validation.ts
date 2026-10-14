import { NextFunction, Request, Response } from 'express'
import Joi from 'joi'

const submissionUploadSchema = Joi.object({
  type: Joi.string().required().valid('land', 'plant'),
  latitude: Joi.number().required().min(-90).max(90),
  longitude: Joi.number().required().min(-180).max(180),
  submissionId: Joi.string().optional().trim().allow(''),
  treesPlanted: Joi.number().optional().min(0),
  treeType: Joi.string().optional().trim().min(1).max(100),
  treetype: Joi.string().optional().trim().min(1).max(100),
  reverseGeocode: Joi.string().optional().trim().min(1).max(500),
})
  .custom((value, helpers) => {
    if (value.type === 'land' && value.submissionId) {
      return helpers.error('custom.landNoSubmissionId')
    }
    if (value.type === 'plant') {
      const sid = value.submissionId?.trim()
      if (!sid || !/^[a-fA-F0-9]{24}$/.test(sid)) {
        return helpers.error('custom.plantNeedsSubmissionId')
      }
      if (value.treesPlanted === undefined || value.treesPlanted === null) {
        return helpers.error('custom.treesPlantedRequired')
      }
      const treeTypeRaw = `${value.treeType ?? ''}`.trim()
      const treetypeRaw = `${value.treetype ?? ''}`.trim()
      if (!treeTypeRaw && !treetypeRaw) {
        return helpers.error('custom.treeTypeRequired')
      }
    }
    return value
  })
  .messages({
    'custom.landNoSubmissionId':
      'submissionId must not be set when uploading land',
    'custom.plantNeedsSubmissionId':
      'Valid submissionId (24-char hex ObjectId) is required when uploading plant',
    'custom.treesPlantedRequired':
      'treesPlanted is required when type is plant',
    'custom.treeTypeRequired':
      'treeType or treetype is required when type is plant',
  })

const validateSubmissionUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = submissionUploadSchema.validate(req.body)

  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }

  next()
}

const validateCoordinates = (latitude: any, longitude: any) => {
  const lat = parseFloat(latitude)
  const lng = parseFloat(longitude)

  if (isNaN(lat) || isNaN(lng)) {
    return false
  }

  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// Authentication validation schemas
const challengeRequestSchema = Joi.object({
  walletAddress: Joi.string().required().trim().min(1).max(200),
})

const walletSignInSchema = Joi.object({
  walletAddress: Joi.string().required().trim().min(1).max(200),
  signature: Joi.string().required().trim().min(1),
  message: Joi.string().required().trim().min(1),
})

const thirdwebSignInSchema = Joi.object({
  address: Joi.string().required().trim().min(1).max(200),
  chainId: Joi.number().optional(),
})

const gmailSignInSchema = Joi.object({
  idToken: Joi.string().required().trim().min(1),
})

const updateProfileSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100),
  phone: Joi.string().trim().min(1).max(30),
  experience: Joi.string().trim().min(1).max(500),
})
  .min(1)
  .unknown(false)

// Authentication validation middleware
const validateChallengeRequest = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = challengeRequestSchema.validate(req.body)

  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }

  next()
}

const validateWalletSignIn = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = walletSignInSchema.validate(req.body)

  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }

  next()
}

const validateThirdwebSignIn = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = thirdwebSignInSchema.validate(req.body)

  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }

  next()
}

const validateGmailSignIn = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = gmailSignInSchema.validate(req.body)

  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }

  next()
}

const validateUpdateProfile = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = updateProfileSchema.validate(req.body)

  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }

  next()
}

const healthCheckUploadSchema = Joi.object({
  latitude: Joi.number().required().min(-90).max(90),
  longitude: Joi.number().required().min(-180).max(180),
  treesAlive: Joi.number().required().min(0).integer(),
  reverseGeocode: Joi.string().optional().trim().min(1).max(500),
})

const validateHealthCheckUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = healthCheckUploadSchema.validate(req.body, {
    convert: true,
    abortEarly: false,
  })
  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }
  next()
}

const healthCheckVoteSchema = Joi.object({
  vote: Joi.string().required().valid('yes', 'no'),
  reasons: Joi.array().items(Joi.string().trim().min(1).max(500)).max(10),
})

const validateHealthCheckVote = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = healthCheckVoteSchema.validate(req.body)
  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }
  next()
}

const submissionVoteSchema = Joi.object({
  vote: Joi.string().required().valid('yes', 'no'),
  reasons: Joi.array().items(Joi.string().trim().min(1).max(500)).max(10),
})
  .custom((value, helpers) => {
    if (value.vote === 'no') {
      const hasReason =
        Array.isArray(value.reasons) &&
        value.reasons.some((r: unknown) => String(r ?? '').trim().length > 0)
      if (!hasReason) {
        return helpers.error('custom.rejectReasonRequired')
      }
    }
    return value
  })
  .messages({
    'custom.rejectReasonRequired':
      'At least one reason is required when rejecting a submission',
  })

/**
 * A "no" vote must say why. The planter is shown the reasons verbatim, so a
 * silent rejection would leave them with nothing to fix next time.
 */
const validateSubmissionVote = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { error } = submissionVoteSchema.validate(req.body)
  if (error) {
    return res.status(400).json({
      error: 'Validation error',
      details: error.details.map(detail => detail.message),
    })
  }
  next()
}

export {
  validateChallengeRequest,
  validateCoordinates,
  validateGmailSignIn,
  validateHealthCheckUpload,
  validateHealthCheckVote,
  validateUpdateProfile,
  validateThirdwebSignIn,
  validateSubmissionUpload,
  validateSubmissionVote,
  validateWalletSignIn,
}
