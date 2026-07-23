import mongoose from 'mongoose'
import env from './environment'
import { runMigrations } from './migrations'

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(
      env.MONGODB_URI as string,
      env.MONGODB_DB_NAME ? { dbName: env.MONGODB_DB_NAME } : {}
    )

    console.log(`MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`)

    await runMigrations()
  } catch (error) {
    console.error('Database connection error:', error)
    throw error
  }
}

export default connectDB
