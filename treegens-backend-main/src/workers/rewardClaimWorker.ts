import { Job, Worker } from 'bullmq'
import IORedis from 'ioredis'
import mongoose from 'mongoose'
import env from '../config/environment'
import RewardClaimJob from '../models/RewardClaimJob'
import {
  REWARD_CLAIM_QUEUE_NAME,
  RewardClaimJobPayload,
  getRewardClaimRedisOptions,
} from '../queues/rewardClaimQueue'
import { enqueueNotification } from '../services/notificationService'
import RewardService from '../services/rewardService'

const rewardService = new RewardService()

function extractTxHashes(result: {
  verifier?: { txHash?: string }
  planter?: { txHashes: string[] }
}) {
  const hashes: string[] = []
  if (result.verifier?.txHash) hashes.push(result.verifier.txHash)
  if (result.planter?.txHashes?.length) hashes.push(...result.planter.txHashes)
  return hashes
}

async function processClaimJob(job: Job<RewardClaimJobPayload>) {
  const { jobId, submissionId, walletAddress } = job.data
  const doc = await RewardClaimJob.findOne({ jobId })
  if (!doc) {
    throw new Error(`Claim job document not found for jobId=${jobId}`)
  }

  await RewardClaimJob.updateOne(
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
    const result = await rewardService.claimForWallet(
      submissionId,
      walletAddress,
    )
    const txHashes = extractTxHashes(result)
    await RewardClaimJob.updateOne(
      { _id: doc._id },
      {
        $set: {
          status: 'completed',
          txHashes,
          result,
          completedAt: new Date(),
          lastError: undefined,
        },
      },
    )

    await enqueueNotification({
      recipientWalletAddress: walletAddress.toLowerCase(),
      kind: 'reward_ready',
      title: 'Rewards processed',
      body: 'Your TreeGens on-chain reward claim finished.',
      link: `/submissions/${submissionId}`,
      payload: { submissionId, jobId },
    }).catch(() => {})
  } catch (error: any) {
    const message = error?.message || String(error)
    await RewardClaimJob.updateOne(
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

export function startRewardClaimWorker() {
  const redisOptions = getRewardClaimRedisOptions()
  const connection =
    typeof redisOptions === 'string'
      ? new IORedis(redisOptions, { maxRetriesPerRequest: null })
      : new IORedis(redisOptions)
  connection.on('error', err => {
    console.error('[RewardClaimWorker] Redis error', { message: err?.message })
  })

  const worker = new Worker<RewardClaimJobPayload>(
    REWARD_CLAIM_QUEUE_NAME,
    processClaimJob,
    {
      connection,
      concurrency: 1,
    },
  )

  worker.on('completed', job => {
    console.log('[RewardClaimWorker] Job completed', {
      jobId: job.id,
      walletAddress: job.data.walletAddress,
      submissionId: job.data.submissionId,
    })
  })

  worker.on('failed', (job, err) => {
    console.error('[RewardClaimWorker] Job failed', {
      jobId: job?.id,
      walletAddress: job?.data.walletAddress,
      submissionId: job?.data.submissionId,
      message: err?.message,
      attemptsMade: job?.attemptsMade,
    })
  })

  return worker
}

if (process.env.RUN_REWARD_CLAIM_WORKER === 'true') {
  mongoose
    .connect(env.MONGODB_URI)
    .then(() => {
      startRewardClaimWorker()
      console.log('[RewardClaimWorker] Started standalone worker')
    })
    .catch(error => {
      console.error('[RewardClaimWorker] Failed to start', error)
      process.exit(1)
    })
}
