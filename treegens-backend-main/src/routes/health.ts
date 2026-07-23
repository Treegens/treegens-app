import express, { Request, Response } from 'express'
import { testStorageConnection } from '../config/gcs'
import HealthService from '../services/healthService'
import { sendError } from '../utils/responseHelpers'

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

export default router
