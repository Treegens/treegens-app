import { Job, Worker } from 'bullmq'
import IORedis from 'ioredis'
import mongoose from 'mongoose'
import env from '../config/environment'
import SlashJob from '../models/SlashJob'
import User from '../models/User'
import VerifierWarning from '../models/VerifierWarning'
import {
  getSlashRedisOptions,
  SLASH_QUEUE_NAME,
  SlashJobPayload,
} from '../queues/slashQueue'
import VaultSlashService from '../services/vaultSlashService'

const vaultSlashService = new VaultSlashService()

async function processSlashJob(job: Job<SlashJobPayload>) {
  const { jobId, walletAddress } = job.data
  const doc = await SlashJob.findOne({ jobId })
  if (!doc) {
    throw new Error(`Slash job document not found for jobId=${jobId}`)
  }

  await SlashJob.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: 'processing',
        startedAt: doc.startedAt || new Date(),
        lastError: undefined,
      },
      $inc: { attempts: 1 },
    },
  )

  try {
    const result = await vaultSlashService.slash(walletAddress)
    const slashedAt = new Date()
    await Promise.all([
      SlashJob.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: 'completed',
            txHash: result.txHash,
            completedAt: slashedAt,
            lastError: undefined,
          },
        },
      ),
      User.updateOne(
        { walletAddress },
        {
          $set: {
            verifierWarningCount: 0,
            lastSlashedAt: slashedAt,
          },
          $inc: {
            verifierSlashCount: 1,
          },
        },
      ),
      VerifierWarning.updateMany(
        {
          walletAddress,
          consumedBySlashAt: { $exists: false },
        },
        {
          $set: {
            consumedBySlashAt: slashedAt,
          },
        },
      ),
    ])
  } catch (error: any) {
    const message = error?.message || String(error)
    await SlashJob.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: 'failed',
          lastError: message,
          completedAt: new Date(),
        },
      },
    )
    throw error
  }
}

export function startSlashWorker() {
  const redisOptions = getSlashRedisOptions()
  const connection =
    typeof redisOptions === 'string'
      ? new IORedis(redisOptions, { maxRetriesPerRequest: null })
      : new IORedis(redisOptions)
  connection.on('error', err => {
    console.error('[SlashWorker] Redis error', { message: err?.message })
  })

  const worker = new Worker<SlashJobPayload>(
    SLASH_QUEUE_NAME,
    processSlashJob,
    {
      connection,
      concurrency: 1,
    },
  )

  worker.on('completed', job => {
    console.log('[SlashWorker] Job completed', {
      jobId: job.id,
      walletAddress: job.data.walletAddress,
      submissionId: job.data.submissionId,
    })
  })

  worker.on('failed', (job, err) => {
    console.error('[SlashWorker] Job failed', {
      jobId: job?.id,
      walletAddress: job?.data.walletAddress,
      submissionId: job?.data.submissionId,
      message: err?.message,
      attemptsMade: job?.attemptsMade,
    })
  })

  return worker
}

if (process.env.RUN_SLASH_WORKER === 'true') {
  mongoose
    .connect(env.MONGODB_URI)
    .then(() => {
      startSlashWorker()
      console.log('[SlashWorker] Started standalone worker')
    })
    .catch(error => {
      console.error('[SlashWorker] Failed to start', error)
      process.exit(1)
    })
}
