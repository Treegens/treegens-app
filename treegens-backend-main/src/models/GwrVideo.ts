import mongoose from 'mongoose'

/**
 * A clip filmed at the Guinness World Record attempt, AFTER the trees went in.
 *
 * Deliberately not a Submission: there is no before clip, no verifier vote and
 * no MGRO reward attached to these. They exist so the record evidence can be
 * collected from everyone on site at treegens.app/gwr and pulled down in one
 * place at treegens.app/gwr-vids.
 */
const gpsSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    /** Browser-reported accuracy radius in metres, when available. */
    accuracyMeters: { type: Number, required: false, min: 0 },
  },
  { _id: false },
)

const gwrVideoSchema = new mongoose.Schema(
  {
    /** Object path in the GCS bucket (`gwr/<uuid>.<ext>`). */
    objectName: { type: String, required: true, unique: true, index: true },
    /** The phone's own id for this upload (`x-gwr-upload-id`). A retry after
     * a lost response finds the first copy instead of storing a second. */
    clientUploadId: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
    },
    /** Public https URL of the object. Serves with Content-Disposition:
     * attachment, so opening it in a browser downloads the file. */
    publicUrl: { type: String, required: true },
    /** The filename the browser saves the clip under. */
    downloadFilename: { type: String, required: true },
    originalFilename: { type: String, required: false },
    mimeType: { type: String, required: false },
    sizeBytes: { type: Number, required: false, min: 0 },
    gpsCoordinates: { type: gpsSchema, required: false },
    reverseGeocode: { type: String, required: false, maxlength: 500 },
    /** Free-text name of the person filming — optional on purpose: nobody on
     * site should need an account or a wallet to hand in a clip. */
    uploaderName: { type: String, required: false, maxlength: 120 },
    note: { type: String, required: false, maxlength: 500 },
    /** The file's own modification time as reported by the phone, if the
     * browser exposed it. Not trusted, just kept. */
    recordedAt: { type: Date, required: false },
    uploadedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
)

gwrVideoSchema.index({ uploadedAt: -1, _id: -1 })

export type GwrVideoDoc = mongoose.InferSchemaType<typeof gwrVideoSchema> & {
  _id: mongoose.Types.ObjectId
}

const GwrVideo = mongoose.model('GwrVideo', gwrVideoSchema)

export default GwrVideo
