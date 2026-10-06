import path from 'path'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'

import env from './environment'

// Swagger definition
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Treegens Backend API',
      version: '1.0.0',
      description:
        'Backend API for Treegens video upload application with IPFS storage and user management',
      contact: {
        name: 'Treegens Team',
        email: 'support@treegens.com',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: env.API_BASE_URL,
        description: 'Development server',
      },
      {
        url: 'https://api.treegens.com',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token obtained from authentication endpoints',
        },
      },
      schemas: {
        // Error Response Schema
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Error message',
            },
            code: {
              type: 'string',
              description: 'Error code',
            },
            details: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Detailed error information',
            },
          },
        },

        // Success Response Schema
        SuccessResponse: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Success message',
            },
            data: {
              type: 'object',
              description: 'Response data',
            },
          },
        },

        // User Schema
        User: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              description: 'User ID',
            },
            walletAddress: {
              type: 'string',
              description: 'Blockchain wallet address',
              example: '0x1234567890abcdef1234567890abcdef12345678',
            },
            name: {
              type: 'string',
              description: 'User display name',
              example: 'John Doe',
            },
            ensName: {
              type: 'string',
              description: 'ENS domain name',
              example: 'johndoe.eth',
            },
            phone: {
              type: 'string',
              description: 'Phone number',
              example: '+1234567890',
            },
            experience: {
              type: 'string',
              description: 'User experience description',
              example: 'Experienced tree planter with 5+ years',
            },
            authProvider: {
              type: 'string',
              enum: ['wallet'],
              description: 'Authentication provider (wallet only)',
              example: 'wallet',
            },
            treesPlanted: {
              type: 'number',
              minimum: 0,
              description: 'Number of trees planted',
              example: 10,
            },
            tokensClaimed: {
              type: 'string',
              description: 'Cumulative MGRO claimed in wei (integer string)',
              example: '250000000000000000000',
            },
            lastLoginAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last login timestamp',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Account creation timestamp',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
            },
          },
        },

        SubmissionClip: {
          type: 'object',
          description: 'Land or plant video clip metadata on a submission',
          properties: {
            uploaded: { type: 'boolean' },
            originalFilename: { type: 'string' },
            mimeType: { type: 'string' },
            sizeBytes: { type: 'number' },
            videoCID: { type: 'string' },
            publicUrl: { type: 'string' },
            reverseGeocode: { type: 'string' },
            uploadedAt: { type: 'string', format: 'date-time' },
            version: { type: 'number' },
            gpsCoordinates: {
              type: 'object',
              properties: {
                latitude: { type: 'number' },
                longitude: { type: 'number' },
              },
            },
          },
        },
        SubmissionVote: {
          type: 'object',
          properties: {
            voterWalletAddress: { type: 'string' },
            vote: { type: 'string', enum: ['yes', 'no'] },
            reasons: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        AiVerificationSnapshot: {
          type: 'object',
          description:
            'Mangrove plant clip AI counting / confidence (Ultralytics-style HTTP or Roboflow workflow)',
          properties: {
            status: {
              type: 'string',
              enum: ['skipped', 'processing', 'completed', 'failed'],
            },
            provider: {
              type: 'string',
              example: 'ultralytics',
              description:
                'Snapshot label: ultralytics (multipart predict) or roboflow_workflow',
            },
            countedMangroves: { type: 'number', minimum: 0 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            verifiedAt: { type: 'string', format: 'date-time' },
            decision: {
              type: 'string',
              enum: [
                'auto_approved',
                'pending_verifier',
                'skipped',
                'ai_failed',
              ],
            },
            error: { type: 'string' },
            skipReason: { type: 'string' },
            rawResponse: { type: 'string' },
            walletAddress: { type: 'string' },
            gpsCoordinates: {
              type: 'object',
              properties: {
                latitude: { type: 'number' },
                longitude: { type: 'number' },
              },
            },
            declaredTreesPlanted: { type: 'number' },
            autoApproveThreshold: {
              type: 'object',
              properties: {
                minConfidence: { type: 'number' },
                maxCountDelta: { type: 'number' },
              },
            },
          },
        },
        Submission: {
          type: 'object',
          properties: {
            _id: { type: 'string', description: 'Submission ID' },
            userWalletAddress: {
              type: 'string',
              example: '0x1234567890abcdef1234567890abcdef12345678',
            },
            status: {
              type: 'string',
              enum: [
                'draft',
                'awaiting_plant',
                'pending_review',
                'approved',
                'rejected',
              ],
            },
            reviewedAt: { type: 'string', format: 'date-time' },
            land: { $ref: '#/components/schemas/SubmissionClip' },
            plant: { $ref: '#/components/schemas/SubmissionClip' },
            treesPlanted: { type: 'number', minimum: 0 },
            treeType: {
              type: 'string',
              description:
                'Tree type; stored trimmed and lowercased. Verifier flow applies to mangrove only.',
            },
            votes: {
              type: 'array',
              items: { $ref: '#/components/schemas/SubmissionVote' },
            },
            aiVerification: {
              $ref: '#/components/schemas/AiVerificationSnapshot',
            },
            siteId: {
              type: 'string',
              description: 'Site Check this planting is linked to, if any',
            },
            siteCheck: {
              type: 'object',
              description:
                'Snapshot of the linked site, measured from the land clip GPS',
              properties: {
                siteId: { type: 'string' },
                siteStatus: {
                  type: 'string',
                  enum: ['draft', 'pending_review', 'approved', 'rejected'],
                },
                verdictCode: {
                  type: 'string',
                  enum: ['plant', 'fix_first', 'let_regrow', 'not_suitable'],
                },
                insideSite: {
                  type: 'boolean',
                  description: 'Within SITE_GPS_TOLERANCE_M of the boundary',
                },
                distanceToSiteM: { type: 'number', minimum: 0 },
                checkedAt: { type: 'string', format: 'date-time' },
              },
            },
            species: {
              type: 'array',
              items: { type: 'string' },
              description: 'Mangrove species ids planted (plant clip)',
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        SiteVerdict: {
          type: 'object',
          description:
            'Plain-language Site Check outcome from the field answers and, once run, the satellite check',
          properties: {
            code: {
              type: 'string',
              enum: ['plant', 'fix_first', 'let_regrow', 'not_suitable'],
            },
            headline: { type: 'string', example: 'Plant here' },
            reasons: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  severity: {
                    type: 'string',
                    enum: [
                      'protect',
                      'blocker',
                      'regrow',
                      'fix',
                      'check',
                      'good',
                      'info',
                    ],
                  },
                  source: { type: 'string', enum: ['field', 'satellite'] },
                  message: { type: 'string' },
                },
              },
            },
            needsFieldCheck: { type: 'boolean' },
            recommendedZone: {
              type: 'string',
              enum: ['seaward', 'middle', 'landward'],
              nullable: true,
            },
            recommendedSpeciesIds: { type: 'array', items: { type: 'string' } },
            hydrologyConsidered: { type: 'boolean' },
            rulesVersion: { type: 'string', example: 'site-rules-v1' },
          },
        },
        SiteHydrology: {
          type: 'object',
          description:
            'Background Sentinel-2 check of how often the site is wet, compared with the fringe of nearby natural mangroves',
          properties: {
            status: {
              type: 'string',
              enum: [
                'not_started',
                'queued',
                'processing',
                'completed',
                'failed',
                'skipped',
              ],
            },
            attempts: { type: 'number' },
            lastError: { type: 'string' },
            skipReason: { type: 'string' },
            startedAt: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', format: 'date-time' },
            result: {
              type: 'object',
              description:
                'HydrologyResult: hydrologyClass, confidence, notes, site, reference and imagery figures',
            },
          },
        },
        Site: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            userWalletAddress: { type: 'string' },
            name: { type: 'string' },
            boundary: {
              type: 'object',
              description: 'GeoJSON Polygon, one closed ring of [lon, lat]',
              properties: {
                type: { type: 'string', enum: ['Polygon'] },
                coordinates: {
                  type: 'array',
                  items: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'number' } },
                  },
                },
              },
            },
            boundaryMethod: { type: 'string', enum: ['walked', 'pin_radius'] },
            radiusM: { type: 'number' },
            center: {
              type: 'object',
              properties: {
                latitude: { type: 'number' },
                longitude: { type: 'number' },
              },
            },
            areaM2: { type: 'number' },
            countryCode: { type: 'string', example: 'KE' },
            reverseGeocode: { type: 'string' },
            answers: {
              type: 'object',
              description:
                'Field questionnaire (SiteAnswers in siteVerdict.ts)',
            },
            photos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['low_tide_360', 'ground', 'tide_mark', 'high_tide'],
                  },
                  objectPath: { type: 'string' },
                  publicUrl: { type: 'string' },
                  mimeType: { type: 'string' },
                  sizeBytes: { type: 'number' },
                  gpsCoordinates: {
                    type: 'object',
                    properties: {
                      latitude: { type: 'number' },
                      longitude: { type: 'number' },
                    },
                  },
                  uploadedAt: { type: 'string', format: 'date-time' },
                },
              },
            },
            hydrology: { $ref: '#/components/schemas/SiteHydrology' },
            verdict: { $ref: '#/components/schemas/SiteVerdict' },
            verdictComputedAt: { type: 'string', format: 'date-time' },
            status: {
              type: 'string',
              enum: ['draft', 'pending_review', 'approved', 'rejected'],
            },
            submittedAt: { type: 'string', format: 'date-time' },
            reviewedAt: { type: 'string', format: 'date-time' },
            votes: {
              type: 'array',
              items: { $ref: '#/components/schemas/SubmissionVote' },
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        // Authentication Schemas
        WalletSignInRequest: {
          type: 'object',
          properties: {
            walletAddress: {
              type: 'string',
              description: 'Ethereum wallet address',
              example: '0x1234567890abcdef1234567890abcdef12345678',
            },
            signature: {
              type: 'string',
              description: 'Wallet signature of the challenge message',
            },
            message: {
              type: 'string',
              description: 'Challenge message that was signed',
            },
          },
          required: ['walletAddress', 'signature', 'message'],
        },

        AuthResponse: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'JWT access token',
            },
            tokenExpiration: {
              type: 'string',
              format: 'date-time',
              description: 'Token expiration timestamp',
            },
            user: {
              $ref: '#/components/schemas/User',
            },
          },
        },

        SubmissionUploadResponse: {
          type: 'object',
          properties: {
            submissionId: {
              type: 'string',
              description: 'Mongo ObjectId of the submission',
            },
            videoCID: { type: 'string' },
            publicUrl: { type: 'string' },
            uploadTimestamp: {
              type: 'string',
              format: 'date-time',
            },
            type: {
              type: 'string',
              enum: ['land', 'plant'],
              description: 'Which clip slot was uploaded',
            },
            status: {
              type: 'string',
              enum: [
                'draft',
                'awaiting_plant',
                'pending_review',
                'approved',
                'rejected',
              ],
            },
            treesPlanted: { type: 'number' },
            treeType: {
              type: 'string',
              description:
                'Present after plant upload; required on plant upload. Normalized to lowercase.',
            },
            reverseGeocode: { type: 'string' },
            aiVerification: {
              $ref: '#/components/schemas/AiVerificationSnapshot',
            },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: [
    // Source files (dev)
    path.resolve(process.cwd(), 'src/routes/*.ts'),
    path.resolve(process.cwd(), 'src/server.ts'),
    // Built files (prod)
    path.resolve(process.cwd(), 'dist/routes/*.js'),
    path.resolve(process.cwd(), 'dist/server.js'),
  ],
}

// Generate swagger specification
const swaggerSpec = swaggerJsdoc(swaggerOptions)

// Swagger UI options
const swaggerUiOptions = {
  customCss: `
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info .title { color: #2E7D32; }
  `,
  customSiteTitle: 'Treegens API Documentation',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    tryItOutEnabled: true,
    filter: true,
    syntaxHighlight: {
      activated: true,
      theme: 'nord',
    },
  },
}

export { swaggerSpec, swaggerUi, swaggerUiOptions }
