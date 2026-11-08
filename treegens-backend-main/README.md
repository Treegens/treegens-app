# Treegens Backend

A comprehensive Node.js backend application for the Treegens video upload platform that handles video uploads to IPFS via Filebase, user management with wallet authentication, and content moderation workflows. Built with MongoDB for metadata storage and designed for scalable deployment.

## 🌟 Features

### Video Management

- **IPFS Video Upload**: Upload videos to IPFS via Filebase S3-compatible API
- **GPS Tracking**: Store GPS coordinates for each video upload
- **Content Moderation**: Built-in status workflow (pending, approved, rejected)
- **Video Types**: Support for land/plant video comparisons
- **Multiple Access Methods**: Filebase gateway, public IPFS gateways, and direct streaming
- **Comprehensive Validation**: File type, size limits, and GPS coordinate validation

### User Management

- **Wallet Authentication**: User identification via blockchain wallet addresses (users are created on successful wallet sign-in)
- **Statistics Tracking**: Trees planted and tokens claimed on the user record (updated by app flows such as rewards and submissions)
- **Extensible Schema**: Designed for future feature additions

### System Features

- **Database Migrations**: Automated schema evolution with version tracking
- **Health Monitoring**: MongoDB and Filebase connectivity checks
- **Multi-Container Support**: Race condition safe migrations for distributed deployments
- **Content Security**: Helmet.js security headers and CORS configuration
- **Error Handling**: Comprehensive error responses with proper HTTP status codes
- **Docker Ready**: Full containerization support with development and production configurations

## 🛠 Tech Stack

- **Runtime**: Node.js (v16+)
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **File Storage**: Filebase (IPFS) via S3-compatible API
- **Cloud SDK**: AWS SDK v3
- **File Processing**: Multer with validation
- **Validation**: Joi schema validation
- **Security**: Helmet.js, CORS
- **Containerization**: Docker & Docker Compose

## 📋 Prerequisites

- Node.js (v16 or higher)
- MongoDB database (local or cloud)
- Filebase account with S3 bucket configured for IPFS
- Docker (optional, for containerized deployment)

## 🚀 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/GeneralMagicio/treegens-backend.git
cd treegens-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Configuration

```bash
cp .env.example .env
```

Configure your `.env` file:

```env
# Database
MONGODB_URI=mongodb://localhost:27017/treegens

# Filebase S3 Configuration
FILEBASE_ACCESS_KEY=your_filebase_access_key
FILEBASE_SECRET_KEY=your_filebase_secret_key
FILEBASE_BUCKET_NAME=your_ipfs_bucket_name

# Server Configuration
PORT=5000
NODE_ENV=development
```

### 4. Database Setup

The application will automatically run database migrations on startup. To manually run migrations:

```bash
npm run migrate
```

## 🏃‍♂️ Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

### Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

## 🐳 Docker Deployment

### Local Development

```bash
# Copy environment file
cp .env.example .env

# Configure your Filebase credentials in .env
# Start all services (app + MongoDB)
docker-compose -f docker-compose-local.yml up --build
```

### Production

```bash
# Build the image
docker build -t treegens-backend .

# Run with external MongoDB
docker run -p 5000:5000 --env-file .env treegens-backend

# Or use docker-compose for full stack
docker-compose up --build
```

## 📚 API Documentation

### Base URL

```
http://localhost:5000
```

### User Endpoints (`/api/users`)

- **`GET /api/users/me`** — Current user profile (requires `Authorization: Bearer <JWT>`).
- **`GET /api/users/leaderboard/trees-planted?page=1&limit=10`** — Public leaderboard; `data` is an array of `{ walletAddress, name, treesPlanted, createdAt }` (paginated, `limit` capped at 50).
- **`POST /api/users/verifier/check`** — Body: `{ "walletAddress": "0x..." }`; returns whether that wallet is marked as a verifier.
- **`POST /api/users/verifier/request`** — Body: `{ "walletAddress": "0x..." }`; checks on-chain stake and updates verifier status when eligible.

User accounts are created when signing in via **`POST /api/auth/signin`** (see Authentication in `/docs`). There is no public HTTP API to create/update arbitrary profile fields or delete users by wallet.

### OTC $MGRO pre-purchases (`/api/distributions/otc`, `/api/rewards/otc/mine`)

An **OTC (over-the-counter) purchase** is MGRO bought up front for trees that are
not planted yet. MGRO is only ever minted for verified plantings, so the purchase
is fulfilled over time: every time a planting is approved, the planter share of
its MGRO is routed to the buyer instead of the planter, tree by tree, until the
purchased trees are used up. The planter was already paid for those trees from
the OTC proceeds and **never gets a claim on that MGRO**; verifiers keep their 5%.

How it works at approval time:

1. `RewardService.ensureAllocationFromApprovedSubmission` asks
   `OtcPurchaseService.reserveTreesForPlanting` for open purchases. Purchases
   pinned to this planter (`planterWallet`) are drawn first, then unpinned ones,
   oldest first. Each draw is an atomic compare-and-set on `treesAllocated`.
2. The allocation's planter pool (95% of the trees' MGRO) is split per tree:
   covered trees go to `otcPayouts[]` (one row per buyer), the rest stays in
   `planterTotalWei` under the normal survival schedule. When every tree is
   covered the planter gets no schedule at all (`tranches: []`).
3. One `otc` claim job per buyer is queued **automatically** next to the planter
   job. The buyer's MGRO is minted in full (no vesting). With
   `MGRO_MINT_MODE=verifier` the mint is proposed on VerifierMinter and lands
   once verifiers approve; the reward worker re-queues unpaid OTC payouts every
   10 minutes until the mint is on-chain, so nobody has to click anything.

Service-to-service (header `x-distributor-key`, same as the other
`/api/distributions/*` routes; disabled while `DISTRIBUTOR_API_KEY` is unset):

- **`POST /api/distributions/otc`** — Body
  `{ buyerWallet, trees, paymentRef, grossUsd?, planterWallet?, note? }`.
  Records a paid purchase. Idempotent on `paymentRef` (201 on create, 200 on
  replay). `planterWallet` pins the purchase to one planter's plantings.
- **`GET /api/distributions/otc?buyerWallet=&status=&limit=`** — List purchases.
- **`GET /api/distributions/otc/:purchaseId`** — Purchase plus the per-planting
  payouts it funded (`status`, `txHash`, `proposalId`).
- **`POST /api/distributions/otc/:purchaseId/cancel`** — Stop an open purchase
  from funding further plantings; trees already matched stay with the buyer.

Buyer-facing (Bearer JWT):

- **`GET /api/rewards/otc/mine`** — The caller's purchases and every payout
  routed to them, with mint status and tx hash.
- **`GET /api/rewards/status/:submissionId`** — A buyer gets `role: "otc_buyer"`;
  any wallet with an OTC payout also gets an `otcBuyer` slice. Planters see an
  `otc` block (`treesCovered`, `amountWei`, `payouts`) showing which part of their
  planting was pre-sold, and `totalRewardWei` excludes it.
- **`POST /api/rewards/claim`** — Also serves as the manual retry for a buyer's
  payout (claim type `otc`).

### Video Management Endpoints

#### Upload Video

```http
POST /api/videos/upload
Content-Type: multipart/form-data

Fields:
- video: File (required) - Video file
- userWalletAddress: String (optional) - User wallet address
- latitude: Number (required) - GPS latitude (-90 to 90)
- longitude: Number (required) - GPS longitude (-180 to 180)
- type: String (optional) - 'before' or 'after' (default: 'before')
- status: String (optional) - 'pending', 'approved', or 'rejected' (default: 'pending')
```

#### Get Video Metadata

```http
GET /api/videos/:videoId
```

#### Get Video File URLs

```http
GET /api/videos/file/:ipfsHash
```

#### Stream Video

```http
GET /api/videos/stream/:ipfsHash
```

#### Get User Videos

```http
GET /api/videos/user/:userWalletAddress?page=1&limit=10
```

### System Endpoints

#### Health Check

```http
GET /health
```

#### Filebase Connection Test

```http
GET /health/s3-test
```

#### API Information

```http
GET /
```

## 🏗 Project Structure

```
treegens-backend/
├── config/
│   ├── database.js         # MongoDB connection setup
│   ├── environment.js      # Centralized environment configuration
│   ├── filebase.js         # Filebase S3 client configuration
│   ├── ipfs-rpc.js         # Legacy IPFS RPC configuration
│   └── migrations.js       # Database migration system
├── middleware/
│   ├── errorHandler.js     # Global error handling middleware
│   ├── upload.js           # Multer file upload configuration
│   └── validation.js       # Joi request validation schemas
├── models/
│   ├── Video.js            # Mongoose video metadata schema
│   └── User.js             # Mongoose user profile schema
├── routes/
│   ├── videos.js           # Video management API endpoints
│   ├── users.js            # User management API endpoints
│   └── health.js           # System health monitoring endpoints
├── services/
│   ├── videoService.js     # Video business logic and IPFS operations
│   ├── userService.js      # User management business logic
│   └── healthService.js    # Health check and monitoring logic
├── scripts/
│   └── migrate.js          # Manual migration runner
├── utils/
│   └── responseHelpers.js  # Standardized HTTP response utilities
├── .env.example            # Environment variables template
├── .eslintrc.js            # ESLint configuration
├── .prettierrc             # Prettier configuration
├── .gitignore             # Git ignore rules
├── Dockerfile             # Docker container configuration
├── docker-compose.yml     # Production Docker Compose
├── docker-compose-local.yml # Development Docker Compose
├── init-mongo.js          # MongoDB initialization script
├── package.json           # Dependencies and scripts
├── CLAUDE.md              # Detailed technical documentation
├── README.md              # This file
└── server.js              # Application entry point
```

## 🗄 Database Schema

### Video Collection

```javascript
{
  originalFilename: String,
  ipfsHash: String (unique),
  videoCID: String (unique),
  uploadTimestamp: Date,
  type: String ['before', 'after'],
  userWalletAddress: String,
  status: String ['rejected', 'pending', 'approved'],
  gpsCoordinates: {
    latitude: Number,
    longitude: Number
  }
}
```

### User Collection

```javascript
{
  walletAddress: String (unique),
  name: String,
  ensName: String,
  phone: String,
  experience: String,
  treesPlanted: Number,
  tokensClaimed: Number,
  createdAt: Date,
  updatedAt: Date
}
```

## 🔄 Database Migrations

The application uses an automated migration system that runs on startup:

- **v1.0.0**: Initial video schema with IPFS support
- **v1.1.0**: Added user ID and video type fields
- **v1.2.0**: Added content moderation status field
- **v1.3.0**: Created users collection for user management

To manually run migrations:

```bash
npm run migrate
```

## 🛡 Security Features

- **Input Validation**: Comprehensive request validation using Joi schemas
- **File Security**: Strict video file type and size validation
- **GPS Validation**: Coordinate range validation
- **CORS Configuration**: Cross-origin request handling
- **Security Headers**: Helmet.js for security best practices
- **Error Sanitization**: Safe error responses without sensitive data exposure

## 🚨 Error Handling

The API provides consistent error responses:

- **400**: Bad Request (validation errors, missing required fields)
- **404**: Not Found (resource doesn't exist)
- **500**: Internal Server Error (server-side issues)
- **503**: Service Unavailable (external service connectivity issues)

## 🔧 Development

### Code Standards

- ESLint configuration for consistent code quality
- Prettier for code formatting
- Pre-commit hooks (if configured)

### Testing

```bash
# Run tests (when test suite is available)
npm test

# Run tests in watch mode
npm run test:watch
```

### Debugging

Enable debug logging by setting:

```env
NODE_ENV=development
```

## 🌐 Production Deployment

### Environment Variables

Ensure all required environment variables are set:

- `MONGODB_URI`: Full MongoDB connection string
- `FILEBASE_ACCESS_KEY` & `FILEBASE_SECRET_KEY`: Filebase credentials
- `FILEBASE_BUCKET_NAME`: IPFS-enabled bucket name
- `PORT`: Server port (default: 5000)
- `NODE_ENV=production`

### Health Monitoring

The `/health` endpoint provides comprehensive system status:

- MongoDB connectivity
- Filebase S3 connectivity
- System uptime and memory usage

### Scaling

- Stateless design enables horizontal scaling
- Race condition safe migrations for multi-container deployments
- MongoDB connection pooling for concurrent requests

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add some amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Code Style

- Follow existing code conventions
- Run `npm run lint` before committing
- Write descriptive commit messages
- Update documentation for new features

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For support and questions:

- Create an [Issue](https://github.com/GeneralMagicio/treegens-backend/issues)
- Check the [Technical Documentation](CLAUDE.md) for detailed information
- Review the API endpoints and examples in this README
