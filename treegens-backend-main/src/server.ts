import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import cron from 'node-cron'
import connectDB from './config/database'
import env from './config/environment'
import { swaggerSpec, swaggerUi, swaggerUiOptions } from './config/swagger'
import errorHandler from './middleware/errorHandler'
import { globalApiLimiter } from './middleware/rateLimits'
import authRoutes from './routes/auth'
import conversationsRoutes from './routes/conversations'
import healthRoutes from './routes/health'
import notificationsRoutes from './routes/notifications'
import pushRoutes from './routes/push'
import distributionsRoutes from './routes/distributions'
import rewardsRoutes from './routes/rewards'
import submissionsRoutes from './routes/submissions'
import userRoutes from './routes/users'
import BurnIndexerService from './services/burnIndexerService'
import VerifierService from './services/verifierService'
import { startRewardClaimWorker } from './workers/rewardClaimWorker'
import { startSlashWorker } from './workers/slashWorker'

const app = express()

app.set('trust proxy', 1)

app.use(helmet())
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

app.use('/api', globalApiLimiter)

// Swagger API Documentation
app.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, swaggerUiOptions),
)

app.use('/api/submissions', submissionsRoutes)
app.use('/api/rewards', rewardsRoutes)
app.use('/api/distributions', distributionsRoutes)
app.use('/api/users', userRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/conversations', conversationsRoutes)
app.use('/api/auth', authRoutes)
app.use('/health', healthRoutes)

/**
 * @swagger
 * /:
 *   get:
 *     summary: API root endpoint
 *     description: Get basic API information and status
 *     tags: [General]
 *     responses:
 *       200:
 *         description: API information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Treegens Backend API"
 *                 version:
 *                   type: string
 *                   example: "1.0.0"
 *                 status:
 *                   type: string
 *                   example: "running"
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 documentation:
 *                   type: string
 *                   example: "/docs"
 */
app.get('/', (req, res) => {
  res.json({
    message: 'Treegens Backend API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    documentation: '/docs',
  })
})

app.use(errorHandler)

async function start() {
  try {
    await connectDB()
  } catch {
    console.error('Refusing to start API without MongoDB. Fix MONGODB_URI and retry.')
    process.exit(1)
    return
  }

  app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`)
  })
}

void start()

if (env.ENABLE_REWARD_CLAIM_WORKER === 'true') {
  startRewardClaimWorker()
  console.log('[RewardClaimWorker] Started in API process')
}

if (env.ENABLE_SLASH_WORKER === 'true') {
  startSlashWorker()
  console.log('[SlashWorker] Started in API process')
}

if (env.ENABLE_BURN_INDEXER === 'true') {
  try {
    const burnIndexerService = new BurnIndexerService()
    burnIndexerService.start()
    console.log('[BurnIndexer] Started in API process')
  } catch (error: any) {
    console.error('[BurnIndexer] Failed to start', {
      message: error?.message || String(error),
    })
  }
}

// Daily cron to refresh verifiers at 02:13 UTC
if (env.ENABLE_CRONJOBS === 'true') {
  try {
    const verifierService = new VerifierService()
    cron.schedule(
      env.TGN_STAKE_VERIFIER_CRON_TIME,
      async () => {
        try {
          console.log('[Cron] Refreshing verifiers...')
          const results = await verifierService.refreshVerifiers()
          console.log('[Cron] Verifier refresh completed', {
            count: results.length,
          })
        } catch (err) {
          console.error('[Cron] Verifier refresh error:', err.message)
        }
      },
      { timezone: 'UTC' },
    )
  } catch {
    console.warn(
      'VerifierService not initialized. Set BASE_RPC_URL to enable cron.',
    )
  }
}
