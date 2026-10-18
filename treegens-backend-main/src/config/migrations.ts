import mongoose from 'mongoose'

import {
  SOCIAL_TASK_CATALOG,
  SOCIAL_TASK_KEYS,
} from '../constants/socialRewardsCatalog'

// Migration tracking schema
const migrationSchema = new mongoose.Schema({
  version: { type: String, required: true, unique: true },
  appliedAt: { type: Date, default: Date.now },
  description: String,
})

const Migration = mongoose.model('Migration', migrationSchema)

// Available migrations
const migrations = [
  {
    version: '1.0.0',
    description: 'Initial video schema with videoCID field',
    up: async () => {
      // Ensure we're using the correct database
      const db = mongoose.connection.db
      console.log('Using database:', db.databaseName)

      // Simply ensure the collection exists (let Mongoose handle validation)
      const collections = await db.listCollections({ name: 'videos' }).toArray()

      if (collections.length === 0) {
        // Create collection without validators (rely on Mongoose schema validation)
        await db.createCollection('videos')
        console.log('✅ Videos collection created')
      } else {
        console.log('✅ Videos collection already exists')
      }

      // Create indexes
      const collection = db.collection('videos')

      try {
        await collection.createIndex({ uploadTimestamp: -1 })
        console.log('✅ uploadTimestamp index created')
      } catch {
        console.log('✅ uploadTimestamp index already exists')
      }

      try {
        await collection.createIndex({ ipfsHash: 1 }, { unique: true })
        console.log('✅ ipfsHash unique index created')
      } catch {
        console.log('✅ ipfsHash unique index already exists')
      }

      try {
        await collection.createIndex({ videoCID: 1 }, { unique: true })
        console.log('✅ videoCID unique index created')
      } catch {
        console.log('✅ videoCID unique index already exists')
      }

      console.log('✅ Video collection and indexes are ready')
    },
    down: async () => {
      const db = mongoose.connection.db
      try {
        await db.collection('videos').drop()
        console.log('❌ Video collection dropped')
      } catch {
        console.log('❌ Video collection did not exist or could not be dropped')
      }
    },
  },
  {
    version: '1.1.0',
    description: 'Add type and userId fields to video schema',
    up: async () => {
      const db = mongoose.connection.db
      console.log('Using database:', db.databaseName)

      const collection = db.collection('videos')

      // Add userId index for efficient user video lookups
      try {
        const existingIndexes = await collection.indexes()
        const hasUserIdIndex = existingIndexes.some(
          index => index.key && index.key.userId === 1,
        )

        if (!hasUserIdIndex) {
          await collection.createIndex({ userId: 1 })
          console.log('✅ userId index created')
        } else {
          console.log('✅ userId index already exists')
        }
      } catch (error) {
        console.log('✅ userId index creation skipped:', error.message)
      }

      // No need to modify existing documents - new fields will be required for new uploads only
      // Mongoose will handle schema validation for new documents
      console.log('✅ Schema updated to support type and userId fields')
      console.log(
        '📋 Note: Existing documents are preserved. New uploads will require type and userId fields.',
      )
    },
    down: async () => {
      const db = mongoose.connection.db
      const collection = db.collection('videos')

      try {
        await collection.dropIndex('userId_1')
        console.log('❌ userId index dropped')
      } catch {
        console.log('❌ userId index did not exist or could not be dropped')
      }
    },
  },
  {
    version: '1.2.0',
    description: 'Add status field to video schema for content moderation',
    up: async () => {
      const db = mongoose.connection.db
      console.log('Using database:', db.databaseName)

      // No need to modify existing documents - new fields are optional with default values
      // Mongoose schema will handle validation and default values for new uploads
      console.log(
        '✅ Schema updated to support status field with enum [rejected, pending, approved]',
      )
      console.log(
        '📋 Note: Existing documents preserved. New uploads can optionally specify status (defaults to "pending")',
      )
    },
    down: async () => {
      const db = mongoose.connection.db
      const collection = db.collection('videos')

      // Remove status field from existing documents
      try {
        const result = await collection.updateMany(
          {},
          { $unset: { status: '' } },
        )
        console.log(
          `❌ Status field removed from ${result.modifiedCount} documents`,
        )
      } catch (error) {
        console.log('❌ Could not remove status field:', error.message)
      }
    },
  },
  {
    version: '1.3.0',
    description: 'Create users collection for user management',
    up: async () => {
      const db = mongoose.connection.db
      console.log('Using database:', db.databaseName)

      // Ensure users collection exists
      const collections = await db.listCollections({ name: 'users' }).toArray()

      if (collections.length === 0) {
        await db.createCollection('users')
        console.log('✅ Users collection created')
      } else {
        console.log('✅ Users collection already exists')
      }

      // Create indexes for users collection
      const collection = db.collection('users')

      try {
        const existingIndexes = await collection.indexes()

        // Check and create walletAddress unique index
        const hasWalletAddressIndex = existingIndexes.some(
          index => index.key && index.key.walletAddress === 1 && index.unique,
        )

        if (!hasWalletAddressIndex) {
          await collection.createIndex({ walletAddress: 1 }, { unique: true })
          console.log('✅ walletAddress unique index created')
        } else {
          console.log('✅ walletAddress unique index already exists')
        }

        // Check and create createdAt index
        const hasCreatedAtIndex = existingIndexes.some(
          index => index.key && index.key.createdAt === -1,
        )

        if (!hasCreatedAtIndex) {
          await collection.createIndex({ createdAt: -1 })
          console.log('✅ createdAt index created')
        } else {
          console.log('✅ createdAt index already exists')
        }
      } catch (error) {
        console.log('✅ Index creation handled:', error.message)
      }

      console.log('✅ Users collection and indexes are ready')
      console.log('📋 Users collection ready (see /api/users routes in app)')
    },
    down: async () => {
      const db = mongoose.connection.db
      try {
        await db.collection('users').drop()
        console.log('❌ Users collection dropped')
      } catch {
        console.log('❌ Users collection did not exist or could not be dropped')
      }
    },
  },
  {
    version: '1.4.0',
    description:
      'Add submissionId, treesPlanted, and treetype fields to video schema',
    up: async () => {
      const db = mongoose.connection.db
      console.log('Using database:', db.databaseName)

      // No need to modify existing documents - new fields are optional with appropriate defaults
      // Mongoose schema will handle validation for new uploads
      console.log(
        '✅ Schema updated to support submissionId, treesPlanted, and treetype fields',
      )
      console.log(
        '📋 Note: Existing documents preserved. New uploads can include these optional fields',
      )
      console.log(
        '📋 treesPlanted will be conditionally required when type="after" via validation middleware',
      )
    },
    down: async () => {
      const db = mongoose.connection.db
      const collection = db.collection('videos')

      // Remove new fields from existing documents
      try {
        const result = await collection.updateMany(
          {},
          {
            $unset: {
              submissionId: '',
              treesPlanted: '',
              treetype: '',
            },
          },
        )
        console.log(
          `❌ New fields removed from ${result.modifiedCount} documents`,
        )
      } catch (error) {
        console.log('❌ Could not remove new fields:', error.message)
      }
    },
  },
  {
    version: '1.5.0',
    description: 'Add authentication fields to user schema',
    up: async () => {
      const db = mongoose.connection.db
      console.log('Using database:', db.databaseName)

      // No need to modify existing documents - new fields are optional
      // Mongoose schema will handle validation for new fields
      console.log('✅ Schema updated to support authentication fields')
      console.log(
        '📋 New authentication fields: email, authProvider, currentToken, tokenExpiration, lastLoginAt',
      )
      console.log(
        '📋 Note: Existing documents preserved. New sign-ins will populate authentication fields',
      )
    },
    down: async () => {
      const db = mongoose.connection.db
      const collection = db.collection('users')

      // Remove authentication fields from existing documents
      try {
        const result = await collection.updateMany(
          {},
          {
            $unset: {
              email: '',
              authProvider: '',
              currentToken: '',
              tokenExpiration: '',
              lastLoginAt: '',
            },
          },
        )
        console.log(
          `❌ Authentication fields removed from ${result.modifiedCount} users`,
        )
      } catch (error) {
        console.log('❌ Could not remove authentication fields:', error.message)
      }
    },
  },
  {
    version: '1.8.0',
    description: 'Rename video.userId to userWalletAddress and update indexes',
    up: async () => {
      const db = mongoose.connection.db
      const videos = db.collection('videos')

      // Migrate field: set userWalletAddress from userId when missing, then unset userId
      try {
        const result = await videos.updateMany({}, [
          {
            $set: {
              userWalletAddress: { $ifNull: ['$userWalletAddress', '$userId'] },
            },
          },
          { $unset: 'userId' },
        ])
        console.log(
          `✅ Renamed userId -> userWalletAddress in ${result.modifiedCount} documents`,
        )
      } catch (e) {
        console.log('⚠️ Video field rename skipped or failed:', e.message)
      }

      // Create index on userWalletAddress
      try {
        await videos.createIndex({ userWalletAddress: 1 })
        console.log('✅ videos.userWalletAddress index created')
      } catch {
        console.log('✅ videos.userWalletAddress index exists')
      }

      // Drop old index on userId if exists
      try {
        await videos.dropIndex('userId_1')
        console.log('❌ videos.userId index dropped')
      } catch {
        console.log('❌ videos.userId index not dropped (may not exist)')
      }
    },
    down: async () => {
      const db = mongoose.connection.db
      const videos = db.collection('videos')

      // Revert field rename
      try {
        const result = await videos.updateMany({}, [
          { $set: { userId: { $ifNull: ['$userId', '$userWalletAddress'] } } },
          { $unset: 'userWalletAddress' },
        ])
        console.log(
          `⏪ Renamed userWalletAddress -> userId in ${result.modifiedCount} documents`,
        )
      } catch (e) {
        console.log(
          '⚠️ Reverse video field rename skipped or failed:',
          e.message,
        )
      }

      // Restore userId index and drop userWalletAddress index
      try {
        await videos.createIndex({ userId: 1 })
        console.log('✅ videos.userId index created')
      } catch {
        console.log('✅ videos.userId index exists')
      }

      try {
        await videos.dropIndex('userWalletAddress_1')
        console.log('❌ videos.userWalletAddress index dropped')
      } catch {
        console.log(
          '❌ videos.userWalletAddress index not dropped (may not exist)',
        )
      }
    },
  },
  {
    version: '1.6.0',
    description: 'Add verifier fields and votes indexes',
    up: async () => {
      const db = mongoose.connection.db
      const users = db.collection('users')
      const videos = db.collection('videos')

      try {
        await users.createIndex({ isVerifier: 1 })
        console.log('✅ users.isVerifier index created')
      } catch {
        console.log('✅ users.isVerifier index exists')
      }

      try {
        await videos.createIndex({ 'votes.voterUserId': 1 })
        console.log('✅ videos.votes.voterUserId index created')
      } catch {
        console.log('✅ videos.votes.voterUserId index exists')
      }
    },
    down: async () => {
      const db = mongoose.connection.db
      const users = db.collection('users')
      const videos = db.collection('videos')
      try {
        await users.dropIndex('isVerifier_1')
        console.log('❌ users.isVerifier index dropped')
      } catch {
        console.log('❌ users.isVerifier index not dropped')
      }
      try {
        await videos.dropIndex('votes.voterUserId_1')
        console.log('❌ videos.votes.voterUserId index dropped')
      } catch {
        console.log('❌ videos.votes.voterUserId index not dropped')
      }
    },
  },
  {
    version: '1.7.0',
    description:
      'Rename votes.voterUserId to votes.voterWalletAddress and reindex',
    up: async () => {
      const db = mongoose.connection.db
      const videos = db.collection('videos')

      // Transform votes array to use voterWalletAddress
      try {
        const result = await videos.updateMany({}, [
          {
            $set: {
              votes: {
                $map: {
                  input: { $ifNull: ['$votes', []] },
                  as: 'v',
                  in: {
                    voterWalletAddress: '$$v.voterUserId',
                    vote: '$$v.vote',
                    reasons: { $ifNull: ['$$v.reasons', []] },
                    createdAt: { $ifNull: ['$$v.createdAt', '$$NOW'] },
                  },
                },
              },
            },
          },
        ])
        console.log(
          `✅ Renamed voterUserId to voterWalletAddress in ${result.modifiedCount} documents`,
        )
      } catch (e) {
        console.log('⚠️ Rename transformation skipped or failed:', e.message)
      }

      // Create new index on voterWalletAddress
      try {
        await videos.createIndex({ 'votes.voterWalletAddress': 1 })
        console.log('✅ videos.votes.voterWalletAddress index created')
      } catch {
        console.log('✅ videos.votes.voterWalletAddress index exists')
      }

      // Drop old index if exists
      try {
        await videos.dropIndex('votes.voterUserId_1')
        console.log('❌ videos.votes.voterUserId index dropped')
      } catch {
        console.log('❌ videos.votes.voterUserId index not dropped')
      }
    },
    down: async () => {
      const db = mongoose.connection.db
      const videos = db.collection('videos')

      // Transform votes array back to voterUserId
      try {
        const result = await videos.updateMany({}, [
          {
            $set: {
              votes: {
                $map: {
                  input: { $ifNull: ['$votes', []] },
                  as: 'v',
                  in: {
                    voterUserId: '$$v.voterWalletAddress',
                    vote: '$$v.vote',
                    reasons: { $ifNull: ['$$v.reasons', []] },
                    createdAt: { $ifNull: ['$$v.createdAt', '$$NOW'] },
                  },
                },
              },
            },
          },
        ])
        console.log(
          `⏪ Renamed voterWalletAddress back to voterUserId in ${result.modifiedCount} documents`,
        )
      } catch (e) {
        console.log('⚠️ Reverse rename skipped or failed:', e.message)
      }

      // Restore old index and drop new one
      try {
        await videos.createIndex({ 'votes.voterUserId': 1 })
        console.log('✅ videos.votes.voterUserId index created')
      } catch {
        console.log('✅ videos.votes.voterUserId index exists')
      }

      try {
        await videos.dropIndex('votes.voterWalletAddress_1')
        console.log('❌ videos.votes.voterWalletAddress index dropped')
      } catch {
        console.log('❌ videos.votes.voterWalletAddress index not dropped')
      }
    },
  },
  {
    version: '2.0.0',
    description:
      'Submission-first model: drop videos; ensure submissions indexes; rename rewardallocations/rewardclaimjobs videoId -> submissionId',
    up: async () => {
      const db = mongoose.connection.db

      try {
        await db.collection('videos').drop()
        console.log('Dropped legacy videos collection')
      } catch (e: any) {
        console.log('videos collection not dropped:', e?.message || e)
      }

      const subs = db.collection('submissions')
      const ensureIndex = async (
        key: Record<string, number>,
        options?: Record<string, unknown>,
      ) => {
        try {
          await subs.createIndex(key, options)
        } catch (e: any) {
          console.log('submissions index skipped:', e?.message || e)
        }
      }

      await ensureIndex({ userWalletAddress: 1, createdAt: -1 })
      await ensureIndex({ status: 1, updatedAt: -1 })
      await ensureIndex({ 'votes.voterWalletAddress': 1 })
      await ensureIndex({ 'land.videoCID': 1 }, { unique: true, sparse: true })
      await ensureIndex({ 'plant.videoCID': 1 }, { unique: true, sparse: true })
      await ensureIndex({ 'land.ipfsHash': 1 }, { unique: true, sparse: true })
      await ensureIndex({ 'plant.ipfsHash': 1 }, { unique: true, sparse: true })
      console.log('submissions collection indexes ensured')

      const renameVideoIdToSubmissionId = async (collName: string) => {
        const coll = db.collection(collName)
        const cols = await db.listCollections({ name: collName }).toArray()
        if (cols.length === 0) return
        const sample = await coll.findOne({ videoId: { $exists: true } })
        if (!sample) return
        try {
          const r = await coll.updateMany(
            { videoId: { $exists: true } },
            { $rename: { videoId: 'submissionId' } },
          )
          console.log(
            `${collName}: renamed videoId -> submissionId (${r.modifiedCount} docs)`,
          )
        } catch (e: any) {
          console.log(`${collName} rename skipped:`, e?.message || e)
        }
      }

      await renameVideoIdToSubmissionId('rewardallocations')
      await renameVideoIdToSubmissionId('rewardclaimjobs')
    },
    down: async () => {
      console.log(
        'Migration 2.0.0 down is a no-op (legacy videos were dropped). Restore from backup if needed.',
      )
    },
  },
  {
    version: '2.1.0',
    description:
      'Drop legacy unique index on rewardallocations.videoId (conflicts with submissionId-only docs)',
    up: async () => {
      const db = mongoose.connection.db
      const ra = db.collection('rewardallocations')
      const cols = await db
        .listCollections({ name: 'rewardallocations' })
        .toArray()
      if (cols.length === 0) {
        console.log(
          'rewardallocations collection missing; skip videoId index drop',
        )
        return
      }
      const indexes = await ra.indexes()
      for (const idx of indexes) {
        const key = idx.key as Record<string, number> | undefined
        if (key && Object.prototype.hasOwnProperty.call(key, 'videoId')) {
          try {
            await ra.dropIndex(idx.name)
            console.log(
              `Dropped stale rewardallocations index ${idx.name} (videoId)`,
            )
          } catch (e: any) {
            console.log(
              `rewardallocations dropIndex ${idx.name} skipped:`,
              e?.message || e,
            )
          }
        }
      }
    },
    down: async () => {
      console.log('Migration 2.1.0 down is a no-op')
    },
  },
  {
    version: '2.2.0',
    description:
      'Add verifier warning/slash fields and collections for verifier warnings and slash jobs',
    up: async () => {
      const db = mongoose.connection.db

      try {
        await db
          .collection('users')
          .updateMany(
            { verifierWarningCount: { $exists: false } },
            { $set: { verifierWarningCount: 0 } },
          )
        await db
          .collection('users')
          .updateMany(
            { verifierSlashCount: { $exists: false } },
            { $set: { verifierSlashCount: 0 } },
          )
        console.log('users verifier discipline fields ensured')
      } catch (e: any) {
        console.log(
          'users verifier discipline backfill skipped:',
          e?.message || e,
        )
      }

      const warnings = db.collection('verifierwarnings')
      const slashJobs = db.collection('slashjobs')

      const ensureIndex = async (
        coll: ReturnType<typeof db.collection>,
        key: Record<string, number>,
        options?: Record<string, unknown>,
      ) => {
        try {
          await coll.createIndex(key, options)
        } catch (e: any) {
          console.log('index skipped:', e?.message || e)
        }
      }

      await ensureIndex(
        warnings,
        { walletAddress: 1, submissionId: 1, reason: 1 },
        { unique: true },
      )
      await ensureIndex(warnings, { walletAddress: 1, createdAt: -1 })
      await ensureIndex(warnings, { submissionId: 1, createdAt: -1 })
      console.log('verifierwarnings collection indexes ensured')

      await ensureIndex(slashJobs, { jobId: 1 }, { unique: true })
      await ensureIndex(slashJobs, { idempotencyKey: 1 }, { unique: true })
      await ensureIndex(slashJobs, { walletAddress: 1, createdAt: -1 })
      await ensureIndex(slashJobs, { status: 1, createdAt: -1 })
      await ensureIndex(slashJobs, { submissionId: 1, walletAddress: 1 })
      console.log('slashjobs collection indexes ensured')
    },
    down: async () => {
      console.log('Migration 2.2.0 down is a no-op')
    },
  },
  {
    version: '2.3.0',
    description:
      'Remove legacy Filebase clip fields and stale ipfsHash submission indexes',
    up: async () => {
      const db = mongoose.connection.db
      const submissions = db.collection('submissions')

      try {
        const result = await submissions.updateMany(
          {
            $or: [
              { 'land.filebaseUrl': { $exists: true } },
              { 'plant.filebaseUrl': { $exists: true } },
              { 'land.ipfsHash': { $exists: true } },
              { 'plant.ipfsHash': { $exists: true } },
            ],
          },
          {
            $unset: {
              'land.filebaseUrl': '',
              'plant.filebaseUrl': '',
              'land.ipfsHash': '',
              'plant.ipfsHash': '',
            },
          },
        )
        console.log(
          `Removed legacy Filebase clip fields from ${result.modifiedCount} submissions`,
        )
      } catch (e: any) {
        console.log(
          'submission Filebase field cleanup skipped:',
          e?.message || e,
        )
      }

      const indexes = await submissions.indexes()
      for (const idx of indexes) {
        const key = idx.key as Record<string, number> | undefined
        if (
          key &&
          (Object.prototype.hasOwnProperty.call(key, 'land.ipfsHash') ||
            Object.prototype.hasOwnProperty.call(key, 'plant.ipfsHash'))
        ) {
          try {
            await submissions.dropIndex(idx.name)
            console.log(`Dropped stale submissions index ${idx.name}`)
          } catch (e: any) {
            console.log(
              `submissions dropIndex ${idx.name} skipped:`,
              e?.message || e,
            )
          }
        }
      }
    },
    down: async () => {
      console.log('Migration 2.3.0 down is a no-op')
    },
  },
  {
    version: '2.4.0',
    description:
      'VerifierWarning: remove reason field; unique index on walletAddress, submissionId, healthCheckId',
    up: async () => {
      const db = mongoose.connection.db
      const warnings = db.collection('verifierwarnings')
      try {
        await warnings.updateMany(
          { reason: { $exists: true } },
          { $unset: { reason: '' } },
        )
      } catch (e: any) {
        console.log('verifierwarnings unset reason skipped:', e?.message || e)
      }
      const indexes = await warnings.indexes()
      for (const idx of indexes) {
        const key = idx.key as Record<string, number> | undefined
        if (key && Object.prototype.hasOwnProperty.call(key, 'reason')) {
          try {
            await warnings.dropIndex(idx.name)
            console.log(`Dropped verifierwarnings index ${idx.name}`)
          } catch (e: any) {
            console.log(
              `verifierwarnings dropIndex ${idx.name} skipped:`,
              e?.message || e,
            )
          }
        }
      }
      try {
        await warnings.createIndex(
          { walletAddress: 1, submissionId: 1, healthCheckId: 1 },
          { unique: true },
        )
        console.log('verifierwarnings compound unique index created')
      } catch (e: any) {
        console.log('verifierwarnings index skipped:', e?.message || e)
      }
    },
    down: async () => {
      console.log('Migration 2.4.0 down is a no-op')
    },
  },
  {
    version: '2.5.0',
    description:
      'RewardAllocation: planterCumulativePaidWei and zero unpaid tranche amounts for survival schedule',
    up: async () => {
      const db = mongoose.connection.db
      const coll = db.collection('rewardallocations')
      const cursor = coll.find({})
      for await (const doc of cursor) {
        const tranches = (doc.tranches || []) as Array<{
          index?: number
          amountWei?: string
          status?: string
          unlockAt?: Date
          [k: string]: unknown
        }>
        let cum = 0n
        const newTranches = tranches.map(t => {
          if (t.status === 'paid') {
            const w = String(t.amountWei || '0')
            const bi = /^\d+$/.test(w) ? BigInt(w) : 0n
            cum += bi
            return t
          }
          return { ...t, amountWei: '0' }
        })
        await coll.updateOne(
          { _id: doc._id },
          {
            $set: {
              planterCumulativePaidWei: cum.toString(),
              tranches: newTranches,
            },
          },
        )
      }
      console.log('rewardallocations survival backfill completed')
    },
    down: async () => {
      console.log('Migration 2.5.0 down is a no-op')
    },
  },
  {
    version: '2.6.0',
    description:
      'HealthCheck: renumber legacy checkpointIndex 1 to 2 (first HC is now checkpoint 2; tranche 0 has no HC)',
    up: async () => {
      const db = mongoose.connection.db
      const coll = db.collection('healthchecks')
      const cursor = coll.find({ checkpointIndex: 1 })
      for await (const doc of cursor) {
        const sid = doc.submissionId
        const conflict = await coll.findOne({
          submissionId: sid,
          checkpointIndex: 2,
        })
        if (conflict) {
          console.log(
            'HealthCheck 2.6.0: skip renumber submission',
            String(sid),
            '(checkpoint 2 already exists)',
          )
          continue
        }
        await coll.updateOne({ _id: doc._id }, { $set: { checkpointIndex: 2 } })
      }
      console.log('healthchecks checkpointIndex 1→2 migration completed')
    },
    down: async () => {
      console.log('Migration 2.6.0 down is a no-op')
    },
  },
  {
    version: '2.7.0',
    description:
      'Submission: planterRewardClaimedWei backfill from RewardAllocation.planterCumulativePaidWei',
    up: async () => {
      const db = mongoose.connection.db
      const alloc = db.collection('rewardallocations')
      const subs = db.collection('submissions')
      const cursor = alloc.find({})
      for await (const doc of cursor) {
        const sid = doc.submissionId
        if (!sid) continue
        const cum = String(doc.planterCumulativePaidWei ?? '0')
        if (!/^\d+$/.test(cum)) continue
        await subs.updateOne(
          { _id: sid },
          { $set: { planterRewardClaimedWei: cum } },
        )
      }
      console.log('submissions planterRewardClaimedWei backfill completed')
    },
    down: async () => {
      console.log('Migration 2.7.0 down is a no-op')
    },
  },
  {
    version: '2.8.0',
    description:
      'Seed socialrewardtasks collection from SOCIAL_TASK_CATALOG (quest copy + ordering in MongoDB)',
    up: async () => {
      const db = mongoose.connection.db
      const coll = db.collection('socialrewardtasks')
      const indexes = await coll.indexes().catch(() => [] as { key?: Record<string, number> }[])
      const hasTaskKeyUnique = indexes.some(
        idx =>
          idx.key &&
          Object.keys(idx.key).length === 1 &&
          idx.key!.taskKey === 1,
      )
      if (!hasTaskKeyUnique) {
        try {
          await coll.createIndex({ taskKey: 1 }, { unique: true })
          console.log('socialrewardtasks taskKey unique index created')
        } catch (e: unknown) {
          console.log(
            'socialrewardtasks taskKey index:',
            e instanceof Error ? e.message : e,
          )
        }
      }

      for (let i = 0; i < SOCIAL_TASK_KEYS.length; i++) {
        const taskKey = SOCIAL_TASK_KEYS[i]
        const entry = SOCIAL_TASK_CATALOG[taskKey]
        await coll.updateOne(
          { taskKey },
          {
            $set: {
              taskKey,
              title: entry.title,
              description: entry.description,
              points: entry.points,
              sortOrder: i,
              active: true,
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true },
        )
      }
      console.log(
        `socialrewardtasks seeded (${SOCIAL_TASK_KEYS.length} tasks)`,
      )
    },
    down: async () => {
      const db = mongoose.connection.db
      try {
        await db.collection('socialrewardtasks').drop()
        console.log('socialrewardtasks collection dropped')
      } catch {
        console.log('socialrewardtasks drop skipped')
      }
    },
  },
  {
    version: '2.9.0',
    description:
      'Audit: dailycheckins + socialtaskcompletions indexes; backfill from users.completedSocialTasks and lastCheckinAt',
    up: async () => {
      const db = mongoose.connection.db
      const daily = db.collection('dailycheckins')
      const social = db.collection('socialtaskcompletions')

      try {
        await daily.createIndex(
          { walletAddress: 1, utcDay: 1 },
          { unique: true },
        )
        console.log('dailycheckins compound unique index ensured')
      } catch (e: unknown) {
        console.log(
          'dailycheckins index:',
          e instanceof Error ? e.message : e,
        )
      }

      try {
        await social.createIndex(
          { walletAddress: 1, taskKey: 1 },
          { unique: true },
        )
        console.log('socialtaskcompletions compound unique index ensured')
      } catch (e: unknown) {
        console.log(
          'socialtaskcompletions index:',
          e instanceof Error ? e.message : e,
        )
      }

      const catalogKeys = new Set(Object.keys(SOCIAL_TASK_CATALOG))
      const users = db.collection('users')
      const cursor = users.find({
        $or: [
          { 'completedSocialTasks.0': { $exists: true } },
          { lastCheckinAt: { $exists: true, $ne: null } },
        ],
      })

      let socialUpserts = 0
      let dailyUpserts = 0

      for await (const u of cursor) {
        const waRaw = u.walletAddress
        const wa =
          typeof waRaw === 'string' ? waRaw.toLowerCase().trim() : ''
        if (!wa) continue

        const tasks = (u.completedSocialTasks ?? []) as Array<{
          taskKey: string
          completedAt?: Date
        }>

        for (const t of tasks) {
          if (!t?.taskKey || !catalogKeys.has(t.taskKey)) continue
          if (t.taskKey === 'daily_checkin') continue

          const pts =
            SOCIAL_TASK_CATALOG[
              t.taskKey as keyof typeof SOCIAL_TASK_CATALOG
            ].points

          try {
            const res = await social.updateOne(
              { walletAddress: wa, taskKey: t.taskKey },
              {
                $setOnInsert: {
                  walletAddress: wa,
                  taskKey: t.taskKey,
                  pointsEarned: pts,
                  createdAt: t.completedAt
                    ? new Date(t.completedAt)
                    : new Date(),
                  updatedAt: new Date(),
                },
              },
              { upsert: true },
            )
            if (
              res.upsertedCount ||
              (res as { upsertedId?: unknown }).upsertedId
            ) {
              socialUpserts += 1
            }
          } catch (e: unknown) {
            console.log(
              'socialtaskcompletions backfill row:',
              e instanceof Error ? e.message : e,
            )
          }
        }

        if (u.lastCheckinAt) {
          const utcDay = new Date(u.lastCheckinAt).toISOString().slice(0, 10)
          const pts = SOCIAL_TASK_CATALOG.daily_checkin.points
          try {
            const res = await daily.updateOne(
              { walletAddress: wa, utcDay },
              {
                $setOnInsert: {
                  walletAddress: wa,
                  utcDay,
                  pointsEarned: pts,
                  createdAt: new Date(u.lastCheckinAt),
                  updatedAt: new Date(),
                },
              },
              { upsert: true },
            )
            if (
              res.upsertedCount ||
              (res as { upsertedId?: unknown }).upsertedId
            ) {
              dailyUpserts += 1
            }
          } catch (e: unknown) {
            console.log(
              'dailycheckins backfill row:',
              e instanceof Error ? e.message : e,
            )
          }
        }
      }

      console.log(
        `Migration 2.9.0 backfill upserts: socialtaskcompletions≈${socialUpserts} dailycheckins≈${dailyUpserts}`,
      )
    },
    down: async () => {
      const db = mongoose.connection.db
      try {
        await db.collection('dailycheckins').drop()
        console.log('dailycheckins collection dropped')
      } catch {
        console.log('dailycheckins drop skipped')
      }
      try {
        await db.collection('socialtaskcompletions').drop()
        console.log('socialtaskcompletions collection dropped')
      } catch {
        console.log('socialtaskcompletions drop skipped')
      }
    },
  },
  {
    version: '2.10.0',
    description:
      'Site Check: sites collection indexes (incl. 2dsphere boundary) and sparse submissions.siteId index',
    up: async () => {
      const db = mongoose.connection.db
      const sites = db.collection('sites')

      const ensureIndex = async (
        coll: ReturnType<typeof db.collection>,
        key: Record<string, 1 | -1 | '2dsphere'>,
        options?: Record<string, unknown>,
      ) => {
        try {
          await coll.createIndex(key, options)
        } catch (e: any) {
          console.log(`${coll.collectionName} index skipped:`, e?.message || e)
        }
      }

      await ensureIndex(sites, { userWalletAddress: 1 })
      await ensureIndex(sites, { status: 1 })
      await ensureIndex(sites, { userWalletAddress: 1, createdAt: -1 })
      await ensureIndex(sites, { status: 1, updatedAt: -1 })
      await ensureIndex(sites, { 'votes.voterWalletAddress': 1 })
      await ensureIndex(sites, { boundary: '2dsphere' })
      await ensureIndex(sites, { 'hydrology.status': 1, updatedAt: 1 })
      console.log('sites collection indexes ensured')

      await ensureIndex(
        db.collection('submissions'),
        { siteId: 1 },
        { sparse: true },
      )
      console.log('submissions siteId index ensured')
    },
    down: async () => {
      // Sites hold planters' field work, so a rollback keeps the collection.
      const db = mongoose.connection.db
      try {
        await db.collection('submissions').dropIndex('siteId_1')
        console.log('submissions siteId index dropped')
      } catch {
        console.log('submissions siteId index drop skipped')
      }
    },
  },
]

// Run migrations with distributed locking
const runMigrations = async () => {
  const processId = `${process.env.HOSTNAME || 'unknown'}-${process.pid}-${Date.now()}`

  try {
    console.log(`🔄 Checking for pending migrations... (Process: ${processId})`)

    // Get applied migrations
    const appliedMigrations = await Migration.find().sort({ version: 1 })
    const appliedVersions = appliedMigrations.map(m => m.version)

    // Find pending migrations
    const pendingMigrations = migrations.filter(
      m => !appliedVersions.includes(m.version),
    )

    if (pendingMigrations.length === 0) {
      console.log('✅ No pending migrations')
      return
    }

    console.log(`📋 Found ${pendingMigrations.length} pending migrations`)

    // Run each pending migration
    for (const migration of pendingMigrations) {
      console.log(
        `🚀 Running migration: ${migration.version} - ${migration.description}`,
      )

      try {
        // Check if migration was already applied by another container (race condition)
        const existingMigration = await Migration.findOne({
          version: migration.version,
        })
        if (existingMigration) {
          console.log(
            `✅ Migration ${migration.version} already completed by another instance`,
          )
          continue
        }

        await migration.up()

        // Record migration as applied with error handling for race conditions
        try {
          await Migration.create({
            version: migration.version,
            description: migration.description,
          })
          console.log(
            `✅ Migration ${migration.version} completed successfully`,
          )
        } catch (createError) {
          // Handle race condition where another container already recorded this migration
          if (createError.code === 11000) {
            console.log(
              `✅ Migration ${migration.version} already recorded by another instance`,
            )
          } else {
            throw createError
          }
        }
      } catch (error) {
        // Only fail if it's not a duplicate key error for migration record
        if (
          error.code === 11000 &&
          error.keyValue &&
          error.keyValue.version === migration.version
        ) {
          console.log(
            `✅ Migration ${migration.version} already completed by another instance`,
          )
        } else {
          console.error(`❌ Migration ${migration.version} failed:`, error)
          throw error
        }
      }
    }

    console.log('🎉 All migrations completed successfully')
  } catch (error) {
    console.error('💥 Migration failed:', error)
    throw error
  }
}

// Rollback last migration
const rollbackMigration = async () => {
  try {
    const lastMigration = await Migration.findOne().sort({ appliedAt: -1 })

    if (!lastMigration) {
      console.log('No migrations to rollback')
      return
    }

    const migration = migrations.find(m => m.version === lastMigration.version)
    if (!migration) {
      console.error(
        `Migration ${lastMigration.version} not found in migration files`,
      )
      return
    }

    console.log(`⏪ Rolling back migration: ${migration.version}`)
    await migration.down()
    await Migration.deleteOne({ version: migration.version })
    console.log(`✅ Migration ${migration.version} rolled back successfully`)
  } catch (error) {
    console.error('❌ Rollback failed:', error)
    throw error
  }
}

export { rollbackMigration, runMigrations }
