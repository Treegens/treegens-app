import { Queue, QueueEvents } from 'bullmq'
import IORedis, { RedisOptions } from 'ioredis'
import env from '../config/environment'

export type SlashJobPayload = {
  jobId: string
  submissionId: string
  walletAddress: string
  reason: string
}

export const SLASH_QUEUE_NAME = 'verifier-slashes'

export function getSlashRedisOptions(): string | RedisOptions {
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

const redisOptions = getSlashRedisOptions()

let slashRedisConnection: IORedis | null = null
let slashQueue: Queue<SlashJobPayload> | null = null
let slashQueueEvents: QueueEvents | null = null

export function getSlashRedisConnection(): IORedis {
  if (!slashRedisConnection) {
    slashRedisConnection =
      typeof redisOptions === 'string'
        ? new IORedis(redisOptions, { maxRetriesPerRequest: null })
        : new IORedis(redisOptions)
    slashRedisConnection.on('error', err => {
      console.error('[SlashQueue] Redis error', { message: err?.message })
    })
  }
  return slashRedisConnection
}

export function getSlashQueue(): Queue<SlashJobPayload> {
  if (!slashQueue) {
    slashQueue = new Queue<SlashJobPayload>(SLASH_QUEUE_NAME, {
      connection: getSlashRedisConnection(),
      defaultJobOptions: {
        attempts: 6,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    })
  }
  return slashQueue
}

export function getSlashQueueEvents(): QueueEvents {
  if (!slashQueueEvents) {
    slashQueueEvents = new QueueEvents(SLASH_QUEUE_NAME, {
      connection: getSlashRedisConnection(),
    })
  }
  return slashQueueEvents
}
