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
        SubmissionRejection: {
          type: 'object',
          description:
            'Present only when status is rejected: planter-facing summary of the verifier no votes',
          properties: {
            rejectedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description:
                'When the verifier majority rejected it (reviewedAt)',
            },
            reasons: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Distinct reasons given by the verifiers who voted no, in vote order',
            },
            noVotes: { type: 'number' },
            yesVotes: { type: 'number' },
            totalVotes: { type: 'number' },
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
            rejection: {
              $ref: '#/components/schemas/SubmissionRejection',
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
