# Treegens Backend - Project Memory

## Project Overview

This is a Node.js backend for the Treegens video upload application that uploads videos to IPFS via Filebase and stores metadata in MongoDB.

## Key Features

- Video upload to IPFS via Filebase S3-compatible API
- GPS coordinates tracking for video uploads
- User management system with wallet address authentication
- MongoDB metadata storage with proper IPFS CID extraction
- Content moderation workflow with status tracking
- AWS SDK v3 implementation
- Rate limiting and error handling
- Docker containerization

## Coding Standards

### Code Organization and Structure

1. Follow the Single Responsibility Principle - Each module, class, or function should have one clear purpose
2. Use a consistent directory structure - Group related code together (e.g., features, components, services, etc.)
3. Keep functions small and focused - Aim for functions under 20-30 lines that do one thing well
4. Don't over engineer while development - Try to not make the functions overly complicated
5. Use the KISS coding principle (Keep It Simple, Stupid) while developing the project, to make it easily maintainable.

### Documentation

1. Write self-documenting code - Use meaningful names for variables, functions, and classes
2. Document public APIs - Include clear comments for interfaces and complex logic
3. Maintain an up-to-date README - Include setup instructions, architecture overview, and development workflow

### Code Standards

1. Define and enforce coding standards - Use linters and formatters (ESLint, Prettier, etc.)
2. Avoid duplication - Follow the DRY principle (Don't Repeat Yourself)
3. Handle errors consistently - Implement proper error handling and logging

### Architecture Principles

1. Design for modularity - Create loosely coupled, highly cohesive components
2. Use dependency injection with ENV variables for configuration
3. Follow established patterns - Use design patterns appropriate for your technology stack

## Architecture

### Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **File Storage**: Filebase (IPFS) via S3-compatible API
- **Cloud SDK**: AWS SDK v3
- **File Processing**: Multer
- **Containerization**: Docker

### Key Dependencies

```json
{
  "@aws-sdk/client-s3": "^3.540.0",
  "@aws-sdk/s3-request-presigner": "^3.540.0",
  "express": "^4.18.2",
  "mongoose": "^7.5.0",
  "multer": "^1.4.5-lts.1",
  "cors": "^2.8.5",
  "helmet": "^7.0.0",
  "joi": "^17.9.2",
  "uuid": "^9.0.0"
}
```

## Database Schema

### Video Model (`models/Video.js`)

```javascript
{
  originalFilename: String (required),     // Original video filename
  ipfsHash: String (required, unique),     // S3 ETag/upload hash
  videoCID: String (required, unique),     // Actual IPFS CID for gateways
  uploadTimestamp: Date (default: now),    // Upload timestamp
  type: String (optional, enum: ['before', 'after'], default: 'before'), // Video type for comparison
  userWalletAddress: String (optional, indexed),      // User wallet address
  status: String (optional, enum: ['rejected', 'pending', 'approved'], default: 'pending'), // Content moderation status
  submissionId: String (optional),         // Unique submission identifier
  treesPlanted: Number (optional, min: 0), // Number of trees planted (required when type='after')
  treetype: String (optional),             // Type of tree planted
  gpsCoordinates: {
    latitude: Number (required, -90 to 90),
    longitude: Number (required, -180 to 180)
  }
}
```

### User Model (`models/User.js`)

```javascript
{
  walletAddress: String (required, unique, indexed), // Blockchain wallet address
  name: String (optional),                          // User display name
  ensName: String (optional),                       // ENS domain name
  phone: String (optional),                         // Phone number
  experience: String (optional, max 500 chars),    // User experience description
  treesPlanted: Number (optional, default: 0),     // Number of trees planted
  tokensClaimed: Number (optional, default: 0),    // Tokens claimed by user
  // Automatic timestamps: createdAt, updatedAt
}
```

### Indexes

#### Video Collection Indexes

- `{ uploadTimestamp: -1 }` - For chronological queries
- `{ ipfsHash: 1 }` - For lookup by upload hash
- `{ videoCID: 1 }` - For lookup by IPFS CID
- `{ userWalletAddress: 1 }` - For user-specific video queries

#### User Collection Indexes

- `{ walletAddress: 1 }` - Unique index for wallet lookups
- `{ createdAt: -1 }` - For chronological user queries

## API Endpoints

### Root Endpoint

```
GET /
Response: Basic API information (name, version, status, timestamp)
```

### Health Endpoints

```
GET /health
Response: Comprehensive health status of all services (MongoDB, Filebase)
Status codes: 200 (OK), 503 (DEGRADED), 500 (UNHEALTHY)

GET /health/s3-test
Response: Filebase S3 connection test with status and timestamp
```

### User endpoints (`/api/users`)

Users are **created** when a wallet successfully completes **`POST /api/auth/signin`**.

| Method | Path                                                | Notes                                                                                                                                                |
| ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/users/me`                                     | Current user (Bearer JWT).                                                                                                                           |
| GET    | `/api/users/leaderboard/trees-planted?page=&limit=` | Public; `data` is an array of `{ walletAddress, name, treesPlanted, createdAt }`; sort by `treesPlanted` desc then `createdAt` desc; `limit` max 50. |
| POST   | `/api/users/verifier/check`                         | Body `{ walletAddress }` → `{ isVerifier }`.                                                                                                         |
| POST   | `/api/users/verifier/request`                       | Body `{ walletAddress }` → on-chain stake check; may set verifier flags on the user.                                                                 |

#### Trees planted leaderboard (response shape)

```
GET /api/users/leaderboard/trees-planted?page=1&limit=10

{
  "message": "Trees planted leaderboard retrieved successfully",
  "data": [
    {
      "walletAddress": "0x...",
      "name": "Jane",
      "treesPlanted": 120,
      "createdAt": "2025-07-31T12:00:00.000Z"
    }
  ]
}
```

### Video Management Endpoints

#### Upload Video

```
POST /api/videos/upload
Content-Type: multipart/form-data

Fields:
- video: File (required) - Video file
- userWalletAddress: String (optional) - User wallet address (defaults to null)
- latitude: Number (required) - GPS latitude
- longitude: Number (required) - GPS longitude
- type: String (optional) - 'before' or 'after' (defaults to 'before')
- status: String (optional) - 'rejected', 'pending', or 'approved' (defaults to 'pending')
- submissionId: String (optional) - Unique submission identifier
- treesPlanted: Number (optional, required when type='after') - Number of trees planted (min: 0)
- treetype: String (optional) - Type of tree planted

Response:
{
  "message": "Video uploaded successfully to IPFS",
  "data": {
    "videoId": "ObjectId",
    "ipfsHash": "upload_hash",
    "videoCID": "QmXXXXXX...",
    "filebaseUrl": "https://...",
    "publicUrl": "https://ipfs.io/ipfs/QmXXXXXX...",
    "uploadTimestamp": "2025-07-15T12:05:16.169Z",
    "type": "before",
    "status": "pending"
  }
}
```

#### Get Videos by User

```
GET /api/videos/user/:userWalletAddress?page=1&limit=10

Response:
{
  "message": "User videos retrieved successfully",
  "data": {
    "videos": [
      {
        "videoId": "ObjectId",
        "videoCID": "QmXXXXXX...",
        "type": "before",
        "uploadTimestamp": "2025-07-15T12:05:16.169Z"
      },
      {
        "videoId": "ObjectId",
        "videoCID": "QmYYYYYY...",
        "type": "after",
        "uploadTimestamp": "2025-07-20T15:30:45.123Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 2
    }
  }
}
```

(Rest of the file remains the same...)

## Rejection feedback for planters (October 2026)

- Verifier `no` votes on `POST /api/submissions/:id/vote` **must** carry at least
  one non-empty reason (`validateSubmissionVote`, max 10 reasons of 500 chars).
  The planter is shown these reasons word for word.
- Rejected submissions returned by `GET /api/submissions/:id`,
  `GET /api/submissions/my-submissions` and the default `GET /api/submissions`
  scope carry a `rejection` object: `{ rejectedAt, reasons[], noVotes, yesVotes,
  totalVotes }` (built by `src/utils/rejectionSummary.ts` from the votes; the
  "Another reason (noted below)" checklist label is dropped when the same vote
  has a note).
- `my-submissions` accepts `?status=` and always returns `statusCounts` for the
  whole wallet so the UI can flag rejections without paging.
- The rejection notification (`kind: submission_outcome`) is titled
  "Submission rejected" and its body lists the reasons; the payload carries
  `status: 'rejected'`, `reasons`, `noVotes`, `totalVotes`.
- A planter never learns which verifier cast a vote on their own submission:
  owner reads of `GET /api/submissions/:id`, `my-submissions`, the default
  list scope, and the viewer's own rows in the moderation scope return votes
  as `{ vote, reasons, createdAt }` only (`src/utils/planterSubmissionView.ts`).

## Recent Updates & Fixes (July 22, 2025)

### ✅ Schema Enhancement for Video Types & Content Moderation

- **Added `type` field**: Enum ['before', 'after'] with default 'before'
- **Added `userWalletAddress` field**: Optional indexed field for user identification
- **Added `status` field**: Enum ['rejected', 'pending', 'approved'] with default 'pending'
- **Backward Compatible**: Existing uploads continue to work without requiring new fields
- **Migration v1.1.0**: Non-destructive migration adds userWalletAddress index
- **Migration v1.2.0**: Non-destructive migration adds status field support

### ✅ User Management System Implementation

- **User Model**: Complete user profile management with wallet address as primary key
- **CRUD Operations**: Create, read, update user profiles with extensible schema
- **Stats Tracking**: Built-in fields for trees planted and tokens claimed
- **Wallet Integration**: Designed for blockchain wallet authentication
- **Migration v1.3.0**: Users collection with proper indexes and constraints

### ✅ Fixed Critical Issues

1. **Migration Duplicate Key Error**:
   - Fixed E11000 error when migration runs multiple times
   - Added robust index checking to prevent conflicts
   - Migration now idempotent and safe to run repeatedly

2. **Frontend Upload Compatibility**:
   - Made `type` and `userWalletAddress` optional in validation
   - Added graceful handling of missing fields in service layer
   - Existing frontend code works without modifications

3. **Missing Service Method**:
   - Implemented `getVideosByUser()` method with pagination
   - Added helper flags: `hasBeforeVideo`, `hasAfterVideo`
   - Full user video management support

### 🎯 Current Capabilities

- **Backward Compatible**: Old frontend uploads work seamlessly
- **Future Ready**: Support for land/plant video workflow
- **Content Moderation**: Built-in status field for approval workflow
- **User Management**: Complete user profile system with wallet authentication
- **Stats Tracking**: User progress tracking with trees planted and tokens claimed
- **Production Stable**: No breaking changes to existing data
- **Enhanced UX**: User video tracking with type and status indicators
- **Extensible Schema**: User model designed for future feature additions

### 📋 API Field Requirements

#### Video Upload Endpoint

```javascript
// Upload endpoint - NEW FIELDS OPTIONAL for backward compatibility
POST /api/videos/upload
{
  video: File (required),
  latitude: Number (required),
  longitude: Number (required),
  userWalletAddress: String (optional),           // If not provided, defaults to null
  type: String (optional),             // If not provided, defaults to 'before'
  status: String (optional),           // If not provided, defaults to 'pending'
  submissionId: String (optional),     // Unique submission identifier
  treesPlanted: Number (optional),     // Required when type='after', min: 0
  treetype: String (optional)          // Type of tree planted
}
```

#### User routes (current)

```javascript
// Profile: use GET /api/users/me with Bearer JWT after sign-in.
// Leaderboard: GET /api/users/leaderboard/trees-planted?page=1&limit=10  (public)
// Verifier: POST /api/users/verifier/check | /verifier/request  { walletAddress }
```

## Latest API Changes (July 22, 2025)

### Content Moderation Support

- **Added status field**: `/api/videos/upload` endpoint now accepts optional `status` field
- **Enhanced validation**: Updated input validation to support status field with enum values
- **Database migration v1.2.0**: Added support for content moderation workflow
- **Backward compatibility maintained**: All existing uploads continue to work without changes
- **Default behavior**: New uploads default to 'pending' status for moderation review

### User Management System

- **Wallet-based authentication**: Users identified by unique wallet addresses; user rows created on sign-in
- **Stats tracking**: Trees planted and tokens claimed on the user document (updated by submissions/rewards flows)
- **Database migration v1.3.0**: Users collection with proper indexes and constraints

## Latest API Changes (July 31, 2025) - Session 3

### Trees planted leaderboard (current behavior)

- **Endpoint**: `GET /api/users/leaderboard/trees-planted?page=&limit=` (public).
- **Data**: `data` is a **plain array** of users with `treesPlanted > 0`, fields `walletAddress`, `name`, `treesPlanted`, `createdAt` (no `_id`, rank, or pagination object in the JSON).
- **Sort**: `treesPlanted` descending, then `createdAt` descending.
- **Implementation**: `UserService.getTreesPlantedLeaderboard` queries the **users** collection (not videos/submissions aggregation).

## Latest API Changes (July 31, 2025) - Session 2

### ✅ Backend Compatibility Fixes for Frontend Integration

- **Fixed Video Fetching Route**: `/api/videos/user/:userWalletAddress` now ignores route parameter and always returns authenticated user's videos for security
- **Automatic User Identification**: Video uploads use authenticated user's wallet address automatically, no userWalletAddress parameter needed from frontend
- **Case-Insensitive Wallet Handling**: All user service methods normalize wallet addresses to lowercase for consistency
- **Swagger Documentation Updated**: Clarified that userWalletAddress route parameter is ignored, always returns authenticated user's data
- **Backward Compatibility**: Frontend can continue using existing API calls without modification

### 🔧 Technical Implementation Details

1. **Smart Route Handling**:
   - `/api/videos/user/:userWalletAddress` extracts wallet address from JWT token instead of route parameter
   - Prevents cross-user data access regardless of frontend parameter
   - Maintains API compatibility while enhancing security

2. **Case Normalization**:
   - All UserService methods normalize wallet addresses to lowercase
   - Consistent with AuthService token storage format
   - Prevents case sensitivity mismatches between frontend and backend

3. **Removed Authorization Middleware Conflicts**:
   - Removed `requireWalletOwnership` from video fetching route
   - Uses direct wallet address extraction from JWT token instead
   - Simplified and more reliable authorization approach

### 🚨 Issues Resolved

- **"Access denied" errors**: Fixed wallet address case sensitivity mismatches
- **"Failed to load videos"**: Route now uses correct wallet address from JWT token
- **Empty submission lists**: Videos are now properly associated with lowercase wallet addresses
- **Frontend compatibility**: Existing frontend code works without modification

## Latest API Changes (July 31, 2025) - Session 1

### ✅ Authentication & Authorization System Overhaul

- **Simplified Authentication**: Removed Gmail and Thirdweb authentication methods, keeping only wallet-based authentication
- **Enhanced Security**: Made challenge endpoint mandatory to prevent signature bypass vulnerabilities
- **Challenge Validation**: Implemented nonce-based challenge system with expiration and single-use validation
- **Wallet-Based Authorization**: Added `requireWalletOwnership` middleware to ensure users can only access their own resources
- **User-Specific Endpoints**: Applied authorization to video and user endpoints so users can only access their own data
- **Automatic User Identification**: Video uploads now automatically use authenticated user's wallet address from JWT token
- **Updated Documentation**: Swagger documentation reflects simplified wallet-only authentication flow
- **Backward Compatibility**: Existing JWT tokens continue to work without modification

### 🔒 Security Improvements

1. **Challenge Bypass Prevention**:
   - Challenge messages must be generated via `/api/auth/challenge` endpoint first
   - Each challenge has unique nonce and 10-minute expiration
   - Challenges are single-use and deleted after successful authentication

2. **Resource Access Control**:
   - Users can only fetch videos associated with their wallet address
   - User stats can only be updated by the wallet owner
   - Cross-user data access has been eliminated

3. **Simplified Attack Surface**:
   - Removed multiple authentication providers that could introduce vulnerabilities
   - Single wallet-based authentication flow is easier to audit and secure
   - JWT tokens contain wallet address for consistent authorization

### 📋 Updated Authentication Flow

1. **Generate Challenge**: `GET /api/auth/challenge/:walletAddress` - Get nonce-based challenge message
2. **Sign Challenge**: User signs the exact challenge message with their wallet
3. **Authenticate**: `POST /api/auth/signin` - Submit signature for JWT token
4. **Access Resources**: Use JWT token in Authorization header for authenticated endpoints

## Latest API Changes (July 30, 2025)

### ✅ Enhanced Video Upload with Tree Tracking Fields

- **Added `submissionId` field**: Optional unique submission identifier for tracking video submissions
- **Added `treesPlanted` field**: Number tracking with conditional validation (required when type='after')
- **Added `treetype` field**: Optional tree species/type identification
- **Enhanced validation**: Conditional validation ensures treesPlanted is required for 'after' videos
- **Database migration v1.4.0**: Non-destructive migration adds new optional fields
- **Backward compatibility maintained**: All existing uploads continue to work seamlessly

### 🎯 New Tree Tracking Capabilities

- **Submission Tracking**: Link videos to specific tree planting submissions
- **Tree Count Validation**: Enforce tree count reporting for 'after' videos
- **Species Documentation**: Optional tree type classification
- **Data Integrity**: Robust validation prevents invalid submissions
- **Analytics Ready**: Schema designed for tree planting analytics and reporting

### ✅ JWT Authentication System

- **Complete JWT authentication**: Token-based authentication with wallet and Gmail support
- **Thirdweb integration**: Full compatibility with thirdweb authentication flows
- **Multi-provider support**: Wallet signature verification and Google OAuth
- **Protected endpoints**: All video uploads and user management require authentication
- **Database migration v1.5.0**: Added authentication fields to user model
- **Security features**: Token expiration, signature validation, user session management

### ✅ API Documentation System

- **Swagger/OpenAPI 3.0**: Complete API documentation with interactive interface
- **Available at `/docs`**: Comprehensive documentation accessible via web interface
- **Schema definitions**: Complete request/response models for all endpoints
- **Authentication support**: JWT Bearer token authentication in Swagger UI
- **Interactive testing**: Try-it-out functionality for all endpoints
- **Custom styling**: Branded Swagger UI with Treegens theme

### 🎯 Enhanced Development Experience

- **Interactive API Testing**: Developers can test all endpoints directly from `/docs`
- **Authentication Integration**: JWT tokens can be entered once and used for all protected endpoints
- **Schema Validation**: Complete request/response documentation with examples
- **Endpoint Discovery**: All available endpoints clearly documented with descriptions
- **Error Response Standards**: Consistent error handling documentation across all endpoints

### New Authentication Endpoints

- `POST /api/auth/challenge` - Generate challenge message for wallet signing
- `POST /api/auth/signin` - Sign in with wallet signature
- `POST /api/auth/signin/thirdweb` - Sign in with thirdweb payload
- `POST /api/auth/signin/gmail` - Sign in with Google OAuth
- `GET /api/auth/verify` - Verify JWT token validity
- `POST /api/auth/signout` - Sign out and invalidate token
- `GET /api/auth/me` - Get current user information

### Enhanced Existing Endpoints

- All video upload endpoints now require authentication
- User management endpoints have comprehensive Swagger documentation
- Health check endpoints include detailed status response schemas
- Root endpoint now includes link to API documentation

## Latest API Changes (July 31, 2025)

Leaderboard behavior is documented above under **Trees planted leaderboard (current behavior)** and **User endpoints** (`data` is a plain array; no `userWalletAddress` query param or `currentUser` block).

---

_See `/docs` (Swagger) for the live route list._
