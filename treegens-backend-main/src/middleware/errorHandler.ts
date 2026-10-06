import { NextFunction, Request, Response } from 'express'
import env from '../config/environment'

type AnyError = any

const errorHandler = (
  err: AnyError,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  console.error(err?.stack || err)

  if ((err as any).name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      details: Object.values((err as any).errors).map((e: any) => e.message),
    })
  }

  if ((err as any).name === 'CastError') {
    return res.status(400).json({
      error: 'Invalid ID format',
    })
  }

  if ((err as any).code === 11000) {
    return res.status(409).json({
      error: 'Duplicate entry',
      details: 'A video with this IPFS hash already exists',
    })
  }

  // Multer v2 uses error.code for limit errors (e.g., 'LIMIT_FILE_SIZE')
  if (
    (err as any).code === 'LIMIT_FILE_SIZE' ||
    (err as any).message === 'LIMIT_FILE_SIZE'
  ) {
    return res.status(413).json({
      error: 'File too large',
      details: 'Videos must be under 100MB and photos under 15MB',
    })
  }

  if ((err as any).code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: 'Invalid file upload',
      details: 'Unexpected file field or invalid file',
    })
  }

  if ((err as any).message === 'Only video files are allowed') {
    return res.status(400).json({
      error: 'Invalid file type',
      details: 'Only video files are allowed',
    })
  }

  if ((err as any).message === 'Only image files are allowed') {
    return res.status(400).json({
      error: 'Invalid file type',
      details: 'Only image files are allowed',
    })
  }

  res.status(500).json({
    error: 'Internal server error',
    message: env.isDevelopment
      ? (err as any)?.message || 'Unknown error'
      : 'Something went wrong',
  })
}

export default errorHandler
