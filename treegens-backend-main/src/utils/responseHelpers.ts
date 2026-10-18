import { Response } from 'express'

const sendSuccess = (
  res: Response,
  message: string,
  data: any = null,
  statusCode: number = 200,
) => {
  const response: { message: string; data?: any } = { message }
  // Include payloads like `0`, `false`, or `{ pointsTotal: 0, tasks: [] }`
  // (`if (data)` incorrectly dropped valid objects when only some fields are set).
  if (data !== undefined && data !== null) response.data = data
  return res.status(statusCode).json(response)
}

const sendError = (
  res: Response,
  error: any,
  statusCode: number = 500,
  /** The original exception, when the message shown is a safe generic string. */
  cause?: unknown,
) => {
  console.error(`Error ${statusCode}:`, cause ?? error)
  return res.status(statusCode).json({
    error:
      typeof error === 'string'
        ? error
        : error.message || 'Internal server error',
  })
}

const sendNotFound = (res: Response, resource: string = 'Resource') => {
  return res.status(404).json({ error: `${resource} not found` })
}

const sendBadRequest = (res: Response, message: string) => {
  return res.status(400).json({ error: message })
}

const sendCreated = (res: Response, message: string, data: any) => {
  return sendSuccess(res, message, data, 201)
}

export { sendBadRequest, sendCreated, sendError, sendNotFound, sendSuccess }
