import { Queue, QueueEvents } from 'bullmq'
import IORedis, { RedisOptions } from 'ioredis'
import env from '../config/environment'

export type RewardClaimType = 'planter' | 'verifier' | 'both'

export type RewardClaimJobPayload = {
  jobId: string
  submissionId: string
  walletAddress: string
  claimType: RewardClaimType
}

export const REWARD_CLAIM_QUEUE_NAME = 'reward-claims'

export function getRewardClaimRedisOptions(): string | RedisOptions {
  const redisUrl = env.REDIS_URL?.trim()
  if (redisUrl) return redisUrl

  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
    db: env.REDIS_DB,
    tls: env.REDIS_TLS ? {} : undefined,
    maxRetriesPerRequest: null,
  }
}

const redisOptions = getRewardClaimRedisOptions()

let rewardClaimRedisConnection: IORedis | null = null
let rewardClaimQueue: Queue<RewardClaimJobPayload> | null = null
let rewardClaimQueueEvents: QueueEvents | null = null

export function getRewardClaimRedisConnection(): IORedis {
  if (!rewardClaimRedisConnection) {
    rewardClaimRedisConnection =
      typeof redisOptions === 'string'
        ? new IORedis(redisOptions, { maxRetriesPerRequest: null })
        : new IORedis(redisOptions)
    rewardClaimRedisConnection.on('error', err => {
      console.error('[RewardClaimQueue] Redis error', { message: err?.message })
    })
  }
  return rewardClaimRedisConnection
}

export function getRewardClaimQueue(): Queue<RewardClaimJobPayload> {
  if (!rewardClaimQueue) {
    rewardClaimQueue = new Queue<RewardClaimJobPayload>(
      REWARD_CLAIM_QUEUE_NAME,
      {
        connection: getRewardClaimRedisConnection(),
        defaultJobOptions: {
          attempts: 6,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      },
    )
  }
  return rewardClaimQueue
}

export function getRewardClaimQueueEvents(): QueueEvents {
  if (!rewardClaimQueueEvents) {
    rewardClaimQueueEvents = new QueueEvents(REWARD_CLAIM_QUEUE_NAME, {
      connection: getRewardClaimRedisConnection(),
    })
  }
  return rewardClaimQueueEvents
}
