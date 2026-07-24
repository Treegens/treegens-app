import 'dotenv/config'

/** Average Gregorian year in seconds (365.25 days). */
const AVG_YEAR_SEC = 365.25 * 86400
/** Default claim spacing: 6 calendar months (~½ average Gregorian year). */
const DEFAULT_MGRO_CLAIM_INTERVAL = Math.round((AVG_YEAR_SEC / 12) * 6)
/** Default number of vesting checkpoints/tranches over the schedule. */
const DEFAULT_MGRO_CLAIM_COUNT = 6
const DEFAULT_MGRO_BURN_START_BLOCK = 38440170

class EnvironmentConfig {
  constructor() {
    this.validateRequired()
  }

  get PORT() {
    return process.env.PORT || 5000
  }

  get NODE_ENV() {
    return process.env.NODE_ENV || 'development'
  }

  get MONGODB_URI() {
    return process.env.MONGODB_URI
  }

  // Optional. The Atlas cluster is shared with the other Treegens backends,
  // which have different schemas — set this to keep our collections in their
  // own database instead of whichever one the URI path happens to name.
  get MONGODB_DB_NAME() {
    return process.env.MONGODB_DB_NAME || ''
  }

  // Google Cloud Storage is the sole media backend (replaces Pinata/IPFS).
  get GCS_BUCKET() {
    return process.env.GCS_BUCKET || ''
  }

  get GCS_SERVICE_ACCOUNT_JSON() {
    return process.env.GCS_SERVICE_ACCOUNT_JSON || ''
  }

  get isDevelopment() {
    return this.NODE_ENV === 'development'
  }

  get isProduction() {
    return this.NODE_ENV === 'production'
  }

  /**
   * Base mainnet JSON-RPC URL for verifier reads, mint/slash workers, indexers.
   * Legacy: `BASE_SEPOLIA_RPC_URL` still works if unset (migration from testnet).
   */
  get BASE_RPC_URL() {
    return (
      process.env.BASE_RPC_URL?.trim() ||
      process.env.BASE_MAINNET_RPC_URL?.trim() ||
      process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
      process.env.RPC_URL?.trim()
    )
  }

  get TGN_VAULT_ADDRESS() {
    // TGNVault on Base mainnet (deployed 2026-07-23; treasury() points at the
    // 2-of-4 Safe 0x64b05503…584C, which is NOT itself stake/slash-capable).
    return (
      process.env.TGN_VAULT_ADDRESS ||
      '0x82a54F550131140Cc08Cf2b10Aa3a44fFDDa582C'
    )
  }

  get TGN_TOKEN_ADDRESS() {
    return (
      process.env.TGN_TOKEN_ADDRESS ||
      '0xD75dfa972C6136f1c594Fec1945302f885E1ab29'
    )
  }

  get DAO_CONTRACT_ADDRESS() {
    return (
      process.env.DAO_CONTRACT_ADDRESS ||
      '0xe0Eb9FCfccEaA66edE66F5B94bfAdC1c90CeDc4D'
    )
  }

  get MGRO_TOKEN_ADDRESS() {
    return (
      process.env.MGRO_TOKEN_ADDRESS ||
      '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568' // Base mainnet $MGRO
    )
  }

  /** Private key for wallet that mints MGRO rewards (must have minter role on contract). */
  get MGRO_MINTER_PRIVATE_KEY() {
    return process.env.MGRO_MINTER_PRIVATE_KEY || ''
  }

  /** Private key for wallet allowed to call TGNVault.slash. */
  get TGN_VAULT_SLASHER_PRIVATE_KEY() {
    return process.env.TGN_VAULT_SLASHER_PRIVATE_KEY || ''
  }

  get MGRO_DECIMALS() {
    const d = parseInt(process.env.MGRO_DECIMALS || '18', 10)
    return Number.isNaN(d) ? 18 : d
  }

  /**
   * Seconds between planter reward tranche unlock times.
   * Default: 6 calendar months.
   */
  get MGRO_CLAIM_INTERVAL() {
    const raw = process.env.MGRO_CLAIM_INTERVAL
    const n =
      raw !== undefined && raw !== ''
        ? parseInt(raw, 10)
        : DEFAULT_MGRO_CLAIM_INTERVAL
    return Number.isNaN(n) || n <= 0 ? DEFAULT_MGRO_CLAIM_INTERVAL : n
  }

  /**
   * Number of reward tranches/checkpoints in the schedule.
   * Total schedule duration is derived as intervalSeconds * claimCount.
   */
  get MGRO_CLAIM_COUNT() {
    const raw = process.env.MGRO_CLAIM_COUNT
    const n =
      raw !== undefined && raw !== ''
        ? parseInt(raw, 10)
        : DEFAULT_MGRO_CLAIM_COUNT
    return Number.isNaN(n) || n <= 0 ? DEFAULT_MGRO_CLAIM_COUNT : n
  }

  get TGN_DECIMALS() {
    const d = parseInt(process.env.TGN_DECIMALS || '18')
    return Number.isNaN(d) ? 18 : d
  }

  get VALIDATORS_MINIMUM_TGN_TOKENS() {
    return process.env.VALIDATORS_MINIMUM_TGN_TOKENS || 2000n
  }

  get MINIMUM_ACTIVE_VERIFIERS() {
    const raw = process.env.MINIMUM_ACTIVE_VERIFIERS
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 5
    return Number.isNaN(n) ? 5 : Math.max(1, n)
  }

  get TGN_STAKE_VERIFIER_CRON_TIME() {
    return process.env.TGN_STAKE_VERIFIER_CRON_TIME || '13 2 * * *'
  }

  get ENABLE_CRONJOBS() {
    return process.env.ENABLE_CRONJOBS || 'false'
  }

  get ENABLE_REWARD_CLAIM_WORKER() {
    return process.env.ENABLE_REWARD_CLAIM_WORKER || 'false'
  }

  get ENABLE_SLASH_WORKER() {
    return process.env.ENABLE_SLASH_WORKER || 'false'
  }

  get ENABLE_BURN_INDEXER() {
    return process.env.ENABLE_BURN_INDEXER || 'false'
  }

  get BURN_INDEXER_POLL_MS() {
    const raw = process.env.BURN_INDEXER_POLL_MS
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 30000
    return Number.isNaN(n) || n < 1000 ? 30000 : n
  }

  get BURN_INDEXER_CONFIRMATIONS() {
    const raw = process.env.BURN_INDEXER_CONFIRMATIONS
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 12
    return Number.isNaN(n) || n < 0 ? 12 : n
  }

  get BURN_INDEXER_CHUNK_SIZE() {
    const raw = process.env.BURN_INDEXER_CHUNK_SIZE
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 2000
    return Number.isNaN(n) || n <= 0 ? 2000 : n
  }

  get MGRO_BURN_START_BLOCK() {
    const raw = process.env.MGRO_BURN_START_BLOCK
    const n =
      raw !== undefined && raw !== ''
        ? parseInt(raw, 10)
        : DEFAULT_MGRO_BURN_START_BLOCK
    return Number.isNaN(n) || n < 0 ? DEFAULT_MGRO_BURN_START_BLOCK : n
  }

  get REDIS_URL() {
    return process.env.REDIS_URL || ''
  }

  get REDIS_HOST() {
    return process.env.REDIS_HOST || '127.0.0.1'
  }

  get REDIS_PORT() {
    const v = parseInt(process.env.REDIS_PORT || '6379', 10)
    return Number.isNaN(v) ? 6379 : v
  }

  get REDIS_PASSWORD() {
    return process.env.REDIS_PASSWORD || ''
  }

  get REDIS_DB() {
    const v = parseInt(process.env.REDIS_DB || '0', 10)
    return Number.isNaN(v) ? 0 : v
  }

  get REDIS_TLS() {
    return process.env.REDIS_TLS === 'true'
  }

  /** Max distance (m) between health-check GPS and submission plant GPS for eligibility. */
  get HEALTH_CHECK_MAX_DISTANCE_METERS() {
    const raw = process.env.HEALTH_CHECK_MAX_DISTANCE_METERS
    const n = raw !== undefined && raw !== '' ? parseFloat(raw) : 5
    return Number.isNaN(n) || n <= 0 ? 5 : n
  }

  /**
   * `treegens_ml` — self-hosted FastAPI YOLO verifier (`PLANTING_VERIFICATION_*`, no Roboflow).
   * `ultralytics` — multipart Bearer call to `AI_API_PREDICT_URL` or base + path.
   * `roboflow_workflow` — Roboflow Serverless (`ROBOFLOW_*` settings).
   */
  get AI_PROVIDER():
    | 'treegens_ml'
    | 'ultralytics'
    | 'roboflow_workflow' {
    const v = (process.env.AI_PROVIDER || 'treegens_ml').trim().toLowerCase()
    if (v === 'roboflow_workflow' || v === 'roboflow')
      return 'roboflow_workflow'
    if (
      v === 'treegens_ml' ||
      v === 'planting_api' ||
      v === 'local_ml' ||
      v === 'yolo'
    ) {
      return 'treegens_ml'
    }
    return 'ultralytics'
  }

  /** Base URL for self-hosted planting verifier, e.g. `http://127.0.0.1:8000`. */
  get PLANTING_VERIFICATION_API_URL() {
    return (process.env.PLANTING_VERIFICATION_API_URL || '').trim()
  }

  /**
   * Shared secret for `POST /internal/verify-video` (`X-Internal-Key`).
   * Must match FastAPI `INTERNAL_API_KEY` on the planting service.
   */
  get PLANTING_VERIFICATION_INTERNAL_KEY() {
    return process.env.PLANTING_VERIFICATION_INTERNAL_KEY || ''
  }

  /**
   * When true and `AI_PROVIDER=treegens_ml`, retry with Ultralytics `/predict` if the
   * planting API times out or returns 5xx.
   */
  get AI_FAILOVER_TO_ULTRALYTICS() {
    const v = (process.env.AI_FAILOVER_TO_ULTRALYTICS || '').trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes'
  }

  /** Mangrove AI verification API (Building Culture). All optional — if unset, plant uploads skip AI. */
  get AI_API_BASE_URL() {
    const raw =
      process.env.AI_API_BASE_URL || 'https://app.buildingculture.capital'
    return String(raw).replace(/\/+$/, '')
  }

  get AI_API_BEARER_TOKEN() {
    return process.env.AI_API_BEARER_TOKEN || ''
  }

  /** Path appended to AI_API_BASE_URL, e.g. `/mangrove/verify` (must include leading `/`). */
  get AI_API_VERIFY_PATH() {
    return (process.env.AI_API_VERIFY_PATH || '').trim()
  }

  /**
   * Full POST URL for Ultralytics-style `/predict` (e.g. Cloud Run). When set, overrides
   * `AI_API_BASE_URL` + `AI_API_VERIFY_PATH` (no path join).
   */
  get AI_API_PREDICT_URL() {
    return (process.env.AI_API_PREDICT_URL || '').trim()
  }

  /** Multipart field name for the video file sent to the AI API. */
  get AI_VIDEO_FORM_FIELD_NAME() {
    const v = (process.env.AI_VIDEO_FORM_FIELD_NAME || 'video').trim()
    return v || 'video'
  }

  /**
   * When true (default), appends submissionId, wallet, GPS, declared count to multipart.
   * Set false for minimal `/predict` endpoints that only accept `file` + inference params.
   */
  get AI_API_SEND_SUBMISSION_METADATA() {
    return process.env.AI_API_SEND_SUBMISSION_METADATA !== 'false'
  }

  /**
   * Ultralytics `/predict` on Cloud Run is typically image-based (multipart `file` + conf/iou/imgsz).
   * `middle_frame_jpeg` decodes the planter clip (MP4, WebM from MediaRecorder, etc.), grabs the
   * midpoint frame, and sends `image/jpeg` — same contract as `curl -F file=@image.jpg`.
   * `multipart_video` sends the raw upload bytes (only if your endpoint accepts video).
   */
  get AI_ULTRALYTICS_INPUT_MODE(): 'multipart_video' | 'middle_frame_jpeg' {
    const v = (process.env.AI_ULTRALYTICS_INPUT_MODE || 'middle_frame_jpeg')
      .trim()
      .toLowerCase()
    if (
      v === 'multipart_video' ||
      v === 'video' ||
      v === 'raw' ||
      v === 'raw_video'
    ) {
      return 'multipart_video'
    }
    return 'middle_frame_jpeg'
  }

  /** Optional multipart fields for Ultralytics-style predict (omit when unset). */
  get AI_PREDICT_CONF() {
    return (process.env.AI_PREDICT_CONF || '').trim()
  }

  get AI_PREDICT_IOU() {
    return (process.env.AI_PREDICT_IOU || '').trim()
  }

  get AI_PREDICT_IMGSZ() {
    return (process.env.AI_PREDICT_IMGSZ || '').trim()
  }

  get AI_REQUEST_TIMEOUT_MS() {
    const raw = process.env.AI_REQUEST_TIMEOUT_MS
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 120_000
    return Number.isNaN(n) || n < 5000 ? 120_000 : Math.min(n, 600_000)
  }

  get AI_AUTO_APPROVE_MIN_CONFIDENCE() {
    const raw = process.env.AI_AUTO_APPROVE_MIN_CONFIDENCE
    const n = raw !== undefined && raw !== '' ? parseFloat(raw) : 0.9
    return Number.isNaN(n) || n < 0 || n > 1 ? 0.9 : n
  }

  get AI_MAX_COUNT_DELTA() {
    const raw = process.env.AI_MAX_COUNT_DELTA
    const n = raw !== undefined && raw !== '' ? parseInt(String(raw), 10) : 2
    return Number.isNaN(n) || n < 0 ? 2 : n
  }

  /** Comma-separated paths to try for integer count (e.g. `count,data.count`). */
  get AI_RESPONSE_COUNT_PATHS() {
    const def =
      'mangrove_count,seedling_count,count,outputs.mangrove_count,outputs.0.mangrove_count,verification_json.mangrove_count,verification_json.seedling_count,verification_json.count,outputs.verification_json.mangrove_count,outputs.verification_json.count,data.count,data.mangrove_count,result.mangrove_count,data.detected,data.detected_count,result.count,treesCount,mangroveCount,mangrovesCounted,detected,totalDetections'
    return (process.env.AI_RESPONSE_COUNT_PATHS || def)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  /**
   * Path names (single segment, matching end of dot-paths in AI_RESPONSE_COUNT_PATHS) that usually
   * mean “sum of all frame detections” for video — skipped on the **root** object when the
   * response also has a multi-item `outputs` / `results` array and per-frame rows had no parseable
   * count, so we do not return an inflated total.
   */
  get AI_RESPONSE_CUMULATIVE_COUNT_PATHS() {
    const def = 'totalDetections,detected'
    return (process.env.AI_RESPONSE_CUMULATIVE_COUNT_PATHS || def)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  /**
   * When the model returns a per-frame `outputs` or `results` array, combine those counts with
   * this reducer. Default `max` matches “most seedlings visible in any one frame” and avoids
   * summing the same plants across frames. Set to `sum` if your API encodes disjoint regions per row.
   */
  get AI_RESPONSE_OUTPUTS_AGGREGATION():
    | 'max'
    | 'min'
    | 'sum'
    | 'median'
    | 'mean'
    | 'first'
    | 'last' {
    const v = (process.env.AI_RESPONSE_OUTPUTS_AGGREGATION || 'max')
      .trim()
      .toLowerCase()
    if (
      v === 'max' ||
      v === 'min' ||
      v === 'sum' ||
      v === 'median' ||
      v === 'mean' ||
      v === 'first' ||
      v === 'last'
    ) {
      return v
    }
    return 'max'
  }

  /** Comma-separated paths to try for confidence in 0–1 or 0–100. */
  get AI_RESPONSE_CONFIDENCE_PATHS() {
    const def =
      'confidence,average_confidence,verification_json.confidence,data.confidence,verification_json.average_confidence,data.average_confidence,score,data.score,data.confidence_score,overallConfidence'
    return (process.env.AI_RESPONSE_CONFIDENCE_PATHS || def)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }

  /** Cap stored JSON string size for auditing (characters). */
  get AI_RAW_RESPONSE_MAX_CHARS() {
    const raw = process.env.AI_RAW_RESPONSE_MAX_CHARS
    const n = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 16_384
    return Number.isNaN(n) || n < 1024 ? 16_384 : Math.min(n, 256_000)
  }

  /**
   * When `detections[]` includes boxes, merge overlaps with this IoU threshold (0–1).
   * Lower values merge more aggressively (fewer double-counts, risk of under-counting).
   */
  get AI_DETECTION_NMS_IOU() {
    const raw = process.env.AI_DETECTION_NMS_IOU
    const n = raw !== undefined && raw !== '' ? parseFloat(String(raw)) : 0.32
    if (Number.isNaN(n) || n <= 0 || n > 1) return 0.32
    return n
  }

  /**
   * Drop boxes whose area exceeds this fraction of inferred frame area (strips full-frame FPs).
   * Typical frame inferred from max x2/y2 across detections.
   */
  get AI_DETECTION_MAX_BOX_AREA_FRACTION() {
    const raw = process.env.AI_DETECTION_MAX_BOX_AREA_FRACTION
    const n = raw !== undefined && raw !== '' ? parseFloat(String(raw)) : 0.22
    if (Number.isNaN(n) || n <= 0 || n > 1) return 0.22
    return n
  }

  /**
   * Minimum per-detection confidence before NMS (when the field exists). Set to 0 to disable.
   */
  get AI_DETECTION_MIN_CONFIDENCE() {
    const raw = process.env.AI_DETECTION_MIN_CONFIDENCE
    const n = raw !== undefined && raw !== '' ? parseFloat(String(raw)) : 0.88
    if (Number.isNaN(n) || n < 0 || n > 1) return 0.88
    return n
  }

  // --- Roboflow Serverless workflows (when AI_PROVIDER=roboflow_workflow) ---

  /** Base URL for Serverless workflows (matches inference-sdk InferenceHTTPClient). */
  get ROBOFLOW_API_URL() {
    const raw =
      process.env.ROBOFLOW_API_URL ||
      process.env.ROBOFLOW_SERVERLESS_URL ||
      'https://serverless.roboflow.com'
    return String(raw).replace(/\/+$/, '')
  }

  /**
   * Prefer `ROBOFLOW_API_KEY`.
   * If unset, `AI_API_BEARER_TOKEN` is used so a single secret can supply both providers (optional).
   */
  get ROBOFLOW_API_KEY() {
    const k =
      process.env.ROBOFLOW_API_KEY ||
      process.env.ROBOFLOW_PRIVATE_API_KEY ||
      process.env.AI_API_BEARER_TOKEN ||
      ''
    return String(k).trim()
  }

  /** Deployed workspace name (named workflow URL segment). */
  get ROBOFLOW_WORKSPACE_NAME() {
    return (
      process.env.ROBOFLOW_WORKSPACE_NAME ||
      process.env.ROBOFLOW_WORKSPACE ||
      ''
    ).trim()
  }

  get ROBOFLOW_WORKFLOW_ID() {
    return (process.env.ROBOFLOW_WORKFLOW_ID || '').trim()
  }

  /**
   * Optional full POST URL override (snippet from Roboflow UI).
   * If unset, workspace + workflow id or spec file derives the URL.
   */
  get ROBOFLOW_WORKFLOW_URL() {
    return (process.env.ROBOFLOW_WORKFLOW_URL || '').trim()
  }

  /**
   * Path to JSON workflow specification file (mutually exclusive with named workflow).
   * When set, requests go to `{ROBOFLOW_API_URL}/workflows/run` with `specification` in the body.
   */
  get ROBOFLOW_WORKFLOW_SPEC_PATH() {
    return (process.env.ROBOFLOW_WORKFLOW_SPEC_PATH || '').trim()
  }

  /** Workflow parameter `confidence` (0–1). */
  get AI_ROBOFLOW_CONFIDENCE() {
    const raw = process.env.AI_ROBOFLOW_CONFIDENCE
    const n = raw !== undefined && raw !== '' ? parseFloat(raw) : 0.96
    return Number.isNaN(n) || n < 0 || n > 1 ? 0.96 : n
  }

  /** Workflow `InferenceImage` input name from your deployed graph (default matches plan). */
  get AI_ROBOFLOW_IMAGE_FIELD() {
    const v = (process.env.AI_ROBOFLOW_IMAGE_FIELD || 'image').trim()
    return v || 'image'
  }

  /**
   * Optional JSON object merged into workflow `inputs` as `videometa` (e.g. fps / duration hints).
   * Example: {"fps":30}
   */
  get AI_ROBOFLOW_VIDEOMETA_JSON(): string {
    return (process.env.AI_ROBOFLOW_VIDEOMETA_JSON || '').trim()
  }

  /**
   * When true (default), sends a minimal `videometa` derived from ffprobe (+ optional JSON overlay).
   * Set `false` if your deployed workflow omits WorkflowVideoMetadata.
   */
  get AI_ROBOFLOW_SEND_VIDEOMETA() {
    return process.env.AI_ROBOFLOW_SEND_VIDEOMETA !== 'false'
  }

  /**
   * When false, omits `confidence` from workflow `inputs` (matches minimal browser snippets).
   */
  get AI_ROBOFLOW_SEND_CONFIDENCE() {
    return process.env.AI_ROBOFLOW_SEND_CONFIDENCE !== 'false'
  }

  /**
   * When true, JSON body is only `{ api_key, inputs }` (no use_cache / enable_profiling).
   */
  get AI_ROBOFLOW_MINIMAL_REQUEST() {
    return process.env.AI_ROBOFLOW_MINIMAL_REQUEST === 'true'
  }

  /** Used by Swagger `/docs` server entry. */
  get API_BASE_URL() {
    return (process.env.API_BASE_URL || 'http://localhost:3000').trim()
  }

  get JWT_SECRET() {
    return (process.env.JWT_SECRET || '').trim()
  }

  get JWT_EXPIRES_IN() {
    return (process.env.JWT_EXPIRES_IN || '7d').trim()
  }

  /** Publishable Infer / Roboflow key (browser); backend inference uses `ROBOFLOW_API_KEY`. */
  get ROBOFLOW_PUBLIC_API_KEY() {
    return String(process.env.ROBOFLOW_PUBLIC_API_KEY || '').trim()
  }

  get THIRDWEB_SECRET_KEY() {
    return String(process.env.THIRDWEB_SECRET_KEY || '').trim()
  }

  get THIRDWEB_PROJECT_ID() {
    return String(process.env.THIRDWEB_PROJECT_ID || '').trim()
  }

  get TELEGRAM_BOT_TOKEN() {
    return String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
  }

  get X_CLIENT_ID() {
    return String(process.env.X_CLIENT_ID || '').trim()
  }

  get X_CLIENT_SECRET() {
    return String(process.env.X_CLIENT_SECRET || '').trim()
  }

  get NEYNAR_API_KEY() {
    return String(process.env.NEYNAR_API_KEY || '').trim()
  }

  get LANGBASE_API_KEY() {
    return String(process.env.LANGBASE_API_KEY || '').trim()
  }

  get LLM_API_KEY() {
    return String(process.env.LLM_API_KEY || '').trim()
  }

  /** Ops / deploy hints (not routed). */
  get VPS_IP() {
    return String(process.env.VPS_IP || '').trim()
  }

  get VPS_USERNAME() {
    return String(process.env.VPS_USERNAME || '').trim()
  }

  get BACKEND_URL() {
    return String(process.env.BACKEND_URL || '')
      .trim()
      .replace(/\/+$/, '')
  }

  get DOCKER_IMAGE() {
    return String(process.env.DOCKER_IMAGE || '').trim()
  }

  get VAPID_PUBLIC_KEY() {
    return String(process.env.VAPID_PUBLIC_KEY || '').trim()
  }

  get VAPID_PRIVATE_KEY() {
    return String(process.env.VAPID_PRIVATE_KEY || '').trim()
  }

  get VAPID_CONTACT_EMAIL() {
    return (
      String(process.env.VAPID_CONTACT_EMAIL || '').trim() ||
      'mailto:team@treegens.app'
    )
  }

  /**
   * When true, POST /api/users/me/delegate requires min on-chain staked TGN (same bar as verifiers).
   * Default false so off-chain delegation works without RPC/vault reads (common in dev / wallets without stake).
   */
  get DELEGATION_REQUIRE_MIN_STAKED_TGN() {
    return process.env.DELEGATION_REQUIRE_MIN_STAKED_TGN === 'true'
  }

  /** Dev/demo: return seeded leaderboard rows when DB has no entries (never in production). */
  get LEADERBOARD_DEMO_FALLBACK() {
    return process.env.LEADERBOARD_DEMO_FALLBACK === 'true'
  }

  validateRequired() {
    // Storage (GCS) is intentionally NOT hard-required: it is validated at
    // upload time and surfaced in /health, so a missing bucket never blocks
    // boot or the workers (which never upload). Only MongoDB is fatal.
    const required = ['MONGODB_URI']
    const missing = required.filter(key => !process.env[key])

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(', ')}`,
      )
    }
  }
}

export default new EnvironmentConfig()
