import express, { Request, Response } from 'express'
import { testStorageConnection } from '../config/gcs'
import HealthService from '../services/healthService'
import { sendError } from '../utils/responseHelpers'
import env from '../config/environment'

const router = express.Router()
const healthService = new HealthService()

/**
 * @swagger
 * tags:
 *   name: Health
 *   description: Health check and system status endpoints
 */

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Get overall system health status
 *     description: Comprehensive health check of all system services including MongoDB and Pinata
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: System is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [OK, DEGRADED, UNHEALTHY]
 *                   description: Overall system status
 *                   example: OK
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Health check timestamp
 *                 services:
 *                   type: object
 *                   properties:
 *                     mongodb:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [OK, ERROR]
 *                         responseTime:
 *                           type: number
 *                           description: Response time in milliseconds
 *                     pinata:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           enum: [OK, ERROR]
 *                         responseTime:
 *                           type: number
 *                           description: Response time in milliseconds
 *       503:
 *         description: System is degraded - some services unavailable
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: DEGRADED
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 services:
 *                   type: object
 *                   description: Service status details
 *       500:
 *         description: System is unhealthy - critical services down
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const healthStatus = await healthService.getOverallHealth()
    const statusCode = healthService.getStatusCode(healthStatus.status as any)

    res.status(statusCode).json(healthStatus)
  } catch {
    return sendError(res, 'Health check failed')
  }
})

/**
 * @swagger
 * /health/pinata-test:
 *   get:
 *     summary: Test Pinata connection
 *     description: Test connectivity to Pinata using the configured JWT
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Pinata connection test completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pinataConnected:
 *                   type: boolean
 *                   description: Whether Pinata connection is successful
 *                   example: true
 *                 message:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Test execution timestamp
 *       500:
 *         description: Pinata connection test failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
// Kept the legacy path as an alias so existing monitors don't 404.
router.get(['/storage-test', '/pinata-test'], async (req: Request, res: Response) => {
  try {
    const connectionResult = await testStorageConnection()
    res.json({
      storageConnected: connectionResult.connected,
      message: connectionResult.message,
      timestamp: new Date().toISOString(),
    })
  } catch {
    return sendError(res, 'Storage connection test failed')
  }
})

/**
 * @swagger
 * /health/contracts:
 *   get:
 *     summary: On-chain addresses this instance is configured to use
 *     description: >
 *       Every address here is public on-chain data. Exposed because a stale
 *       VERIFIER_MINTER_ADDRESS silently pointing at a revoked minter is
 *       otherwise invisible from outside until a mint fails.
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Configured contract addresses
 */
router.get('/contracts', (_req: Request, res: Response) => {
  res.json({
    chain: 'base-mainnet',
    mgro: env.MGRO_TOKEN_ADDRESS,
    verifierMinter: env.VERIFIER_MINTER_ADDRESS,
    delegationRegistry: env.TGN_DELEGATION_REGISTRY_ADDRESS,
    tgnVault: env.TGN_VAULT_ADDRESS,
    mintMode: env.MGRO_MINT_MODE,
    timestamp: new Date().toISOString(),
  })
})

export default router
