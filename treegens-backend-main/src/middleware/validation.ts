import { NextFunction, Request, Response } from 'express'
import Joi from 'joi'
import { MAX_SPECIES_PER_PLANTING, parseSpeciesIds } from '../services/siteGate'
import {
  ANSWER_LIMITS,
  ANSWER_OPTIONS,
  SITE_GEOMETRY_LIMITS,
  SITE_PHOTO_KINDS,
} from '../services/siteRules'

const submissionUploadSchema = Joi.object({
  type: Joi.string().required().valid('land', 'plant'),
  latitude: Joi.number().required().min(-90).max(90),
  longitude: Joi.number().required().min(-180).max(180),
  submissionId: Joi.string().optional().trim().allow(''),
  treesPlanted: Joi.number().optional().min(0),
  treeType: Joi.string().optional().trim().min(1).max(100),
  treetype: Joi.string().optional().trim().min(1).max(100),
  reverseGeocode: Joi.string().optional().trim().min(1).max(500),
  siteId: Joi.string()
    .optional()
    .trim()
    .allow('')
    .pattern(/^[a-fA-F0-9]{24}$/)
    .messages({
      'string.pattern.base': 'siteId must be a 24-character hex id',
    }),
  species: Joi.alternatives(
    Joi.string().allow(''),
    Joi.array().items(Joi.string()),
  ).optional(),
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
      const species = parseSpeciesIds(value.species)
      if (species.unknown.length) {
        return helpers.error('custom.speciesUnknown', {
          ids: species.unknown.join(', '),
        })
      }
      if (species.ids.length > MAX_SPECIES_PER_PLANTING) {
        return helpers.error('custom.speciesTooMany')
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
    'custom.speciesUnknown': 'Unknown species: {#ids}',
    'custom.speciesTooMany': `species accepts at most ${MAX_SPECIES_PER_PLANTING} ids`,
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

/** Validates req.body against a schema; responds 400 with every problem. */
const validateBody =
  (schema: Joi.ObjectSchema) =>
  (req: Request, res: Response, next: NextFunction) => {
    const { error } = schema.validate(req.body, { abortEarly: false })
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details.map(detail => detail.message),
      })
    }
    next()
  }

const choiceAnswer = (values: string[]) =>
  Joi.string()
    .valid(...values)
    .allow(null)

const rangeAnswer = (range: { min: number; max: number }) =>
  Joi.number().min(range.min).max(range.max).allow(null)

/** Site questionnaire; unknown keys pass here and are dropped by the service. */
const siteAnswersSchema = Joi.object({
  previousUse: choiceAnswer(ANSWER_OPTIONS.previousUse),
  currentCover: choiceAnswer(ANSWER_OPTIONS.currentCover),
  tideReach: choiceAnswer(ANSWER_OPTIONS.tideReach),
  depthVsReference: choiceAnswer(ANSWER_OPTIONS.depthVsReference),
  flowBlocked: choiceAnswer(ANSWER_OPTIONS.flowBlocked),
  lossCauses: Joi.array()
    .items(Joi.string().valid(...ANSWER_OPTIONS.lossCauses))
    .max(ANSWER_OPTIONS.lossCauses.length)
    .allow(null),
  causeStillActive: choiceAnswer(ANSWER_OPTIONS.causeStillActive),
  naturalRecruitment: choiceAnswer(ANSWER_OPTIONS.naturalRecruitment),
  shoreExposure: choiceAnswer(ANSWER_OPTIONS.shoreExposure),
  erosionScarps: Joi.boolean().allow(null),
  substrate: choiceAnswer(ANSWER_OPTIONS.substrate),
  nearestMangroves: choiceAnswer(ANSWER_OPTIONS.nearestMangroves),
  nearbyCanopyImpact: rangeAnswer(ANSWER_LIMITS.nearbyCanopyImpact),
  tideMarkCm: rangeAnswer(ANSWER_LIMITS.tideMarkCm),
  notes: Joi.string().trim().allow('', null).max(ANSWER_LIMITS.notesMaxLength),
}).unknown(true)

/** [longitude, latitude], GeoJSON order. */
const lonLatSchema = Joi.array()
  .ordered(
    Joi.number().min(-180).max(180).required(),
    Joi.number().min(-90).max(90).required(),
  )
  .length(2)

const siteFields = {
  name: Joi.string().trim().min(1).max(80),
  boundaryMethod: Joi.string().valid('walked', 'pin_radius'),
  ring: Joi.array().items(lonLatSchema).min(3).max(500),
  center: Joi.object({
    latitude: Joi.number().required().min(-90).max(90),
    longitude: Joi.number().required().min(-180).max(180),
  }),
  radiusM: Joi.number()
    .min(SITE_GEOMETRY_LIMITS.minRadiusM)
    .max(SITE_GEOMETRY_LIMITS.maxRadiusM),
  countryCode: Joi.string()
    .trim()
    .pattern(/^[A-Za-z]{2}$/)
    .allow('', null),
  reverseGeocode: Joi.string().trim().max(500).allow('', null),
  answers: siteAnswersSchema,
}

const siteCreateSchema = Joi.object({
  ...siteFields,
  name: siteFields.name.required(),
  boundaryMethod: siteFields.boundaryMethod.required(),
  ring: siteFields.ring.when('boundaryMethod', {
    is: 'walked',
    then: Joi.required(),
  }),
  center: siteFields.center.when('boundaryMethod', {
    is: 'pin_radius',
    then: Joi.required(),
  }),
  radiusM: siteFields.radiusM.when('boundaryMethod', {
    is: 'pin_radius',
    then: Joi.required(),
  }),
})

const siteUpdateSchema = Joi.object(siteFields).min(1)

/** Multipart fields sent with a site photo. */
const sitePhotoSchema = Joi.object({
  kind: Joi.string()
    .required()
    .valid(...SITE_PHOTO_KINDS),
  latitude: Joi.number().min(-90).max(90).allow(''),
  longitude: Joi.number().min(-180).max(180).allow(''),
})

const validateSiteCreate = validateBody(siteCreateSchema)
const validateSiteUpdate = validateBody(siteUpdateSchema)
const validateSitePhoto = validateBody(sitePhotoSchema)
const validateSiteVote = validateBody(healthCheckVoteSchema)

export {
  validateChallengeRequest,
  validateCoordinates,
  validateGmailSignIn,
  validateHealthCheckUpload,
  validateHealthCheckVote,
  validateSiteCreate,
  validateSitePhoto,
  validateSiteUpdate,
  validateSiteVote,
  validateUpdateProfile,
  validateThirdwebSignIn,
  validateSubmissionUpload,
  validateWalletSignIn,
}
