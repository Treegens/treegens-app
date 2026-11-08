import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'

const storage = multer.memoryStorage()

const fileFilter: multer.Options['fileFilter'] = (req, file, cb) => {
  console.log('File details:', {
    originalname: file.originalname,
    mimetype: file.mimetype,
    encoding: file.encoding,
  })

  // Check file extension as fallback when MIME type is generic
  const allowedExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv']
  const fileExtension = file.originalname
    .toLowerCase()
    .substring(file.originalname.lastIndexOf('.'))

  if (
    file.mimetype.startsWith('video/') ||
    allowedExtensions.includes(fileExtension)
  ) {
    cb(null, true)
  } else {
    cb(new Error('Only video files are allowed') as any, false)
  }
}

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
})

const generateUniqueFileName = (originalName: string) => {
  const extension = originalName.split('.').pop()
  const uniqueName = `${uuidv4()}.${extension}`
  return uniqueName
}

export { upload, generateUniqueFileName, fileFilter }
