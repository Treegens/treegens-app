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
import DelegationRegistryService from '../services/delegationRegistryService'
import SlashQueueService from '../services/slashQueueService'
import VaultSlashService from '../services/vaultSlashService'
import VerifierMinterService from '../services/verifierMinterService'

const vaultSlashService = new VaultSlashService()
const delegationRegistry = new DelegationRegistryService()
const slashQueueService = new SlashQueueService()
const verifierMinter = new VerifierMinterService()

const DELEGATOR_REASON_PREFIX = 'delegator_of:'

/**
 * Jimi's ruling 2026-07-25: delegated stake is slashable skin-in-the-game.
 * When a verifier is slashed, everyone whose stake backed them is slashed
 * too — each as its own idempotent, retryable queue job. One hop only: a
 * delegator's slash never cascades further.
 */
async function cascadeToDelegators(job: Job<SlashJobPayload>): Promise<void> {
  const { walletAddress, submissionId, reason } = job.data
  if (!env.SLASH_DELEGATORS) return
  if (reason?.startsWith(DELEGATOR_REASON_PREFIX)) return
  try {
    const delegators = await delegationRegistry.delegatorsOf(walletAddress)
    for (const delegator of delegators) {
      await slashQueueService.enqueueOrReuseSlashJob({
        submissionId,
        walletAddress: delegator,
        reason: `${DELEGATOR_REASON_PREFIX}${walletAddress.toLowerCase()}`,
      })
    }
    if (delegators.length > 0) {
      console.log('[SlashWorker] Queued delegator slashes', {
        verifier: walletAddress,
        delegators: delegators.length,
      })
    }
  } catch (error: any) {
    // Never fail the verifier's own slash over the cascade; jobs are
    // idempotent, so the next slash of this wallet retries the sweep.
    console.error('[SlashWorker] Delegator cascade failed', {
      verifier: walletAddress,
      message: error?.message,
    })
  }
}

/** Keep the VerifierMinter set honest after stake was destroyed. */
async function evictFromVerifierSetIfBelowFloor(
  walletAddress: string,
): Promise<void> {
  try {
    const evicted = await verifierMinter.evictIfBelowFloor(walletAddress)
    if (evicted) {
      console.log('[SlashWorker] Evicted slashed verifier from mint set', {
        walletAddress,
      })
    }
  } catch (error: any) {
    console.error('[SlashWorker] Evict after slash failed', {
      walletAddress,
      message: error?.message,
    })
  }
}

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

    await cascadeToDelegators(job)
    await evictFromVerifierSetIfBelowFloor(walletAddress)
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
