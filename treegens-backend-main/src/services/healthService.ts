import mongoose from 'mongoose'
import { testStorageConnection } from '../config/gcs'

type StorageStatus = {
  status: 'unknown' | 'healthy' | 'unhealthy'
  lastChecked: string | null
  message: string
}

class HealthService {
  private storageStatus: StorageStatus
  constructor() {
    this.storageStatus = {
      status: 'unknown',
      lastChecked: null,
      message: 'Not yet tested',
    }
    this.initializeStorageStatus()
  }

  async initializeStorageStatus() {
    await this.testStorageConnectivity()
  }

  async testStorageConnectivity() {
    try {
      const result = await testStorageConnection()
      this.storageStatus = {
        status: result.connected ? 'healthy' : 'unhealthy',
        lastChecked: new Date().toISOString(),
        message: result.message,
      }
      console.log(
        result.connected
          ? '✅ Google Cloud Storage connectivity verified'
          : '❌ Google Cloud Storage connectivity test failed',
        result.message,
      )
    } catch (error: any) {
      this.storageStatus = {
        status: 'unhealthy',
        lastChecked: new Date().toISOString(),
        message: error.message,
      }
      console.log('❌ Google Cloud Storage connectivity test failed:', error.message)
    }
  }

  async checkMongoDBHealth() {
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.admin().ping()
        return 'healthy'
      } else {
        return 'unhealthy'
      }
    } catch {
      return 'unhealthy'
    }
  }

  getStorageHealth() {
    return {
      status: this.storageStatus.status,
      lastChecked: this.storageStatus.lastChecked,
      message: this.storageStatus.message,
    }
  }

  async getOverallHealth() {
    const mongoStatus = await this.checkMongoDBHealth()
    const storageHealth = this.getStorageHealth()

    const healthStatus = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: mongoStatus,
        storage: storageHealth,
      },
    }

    // MongoDB is the only liveness-critical dependency: the liveness probe
    // (Render healthCheckPath) must stay 200 while Mongo is up. Storage health
    // is reported for humans but never flips the probe — a missing bucket
    // should not take the API down.
    if (mongoStatus === 'unhealthy') {
      healthStatus.status = 'UNHEALTHY'
    }

    return healthStatus
  }

  getStatusCode(status: 'OK' | 'DEGRADED' | 'UNHEALTHY') {
    switch (status) {
      case 'OK':
        return 200
      case 'DEGRADED':
        return 503
      case 'UNHEALTHY':
        return 500
      default:
        return 500
    }
  }
}

export default HealthService
