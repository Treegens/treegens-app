import { ethers } from 'ethers'
import jwt from 'jsonwebtoken'
import env from '../config/environment'
import AuthChallenge from '../models/AuthChallenge'
import User from '../models/User'

type TokenPayload = {
  userId: string
  walletAddress: string
  authProvider: string
}

class AuthService {
  private jwtSecret: string
  private jwtExpiresIn: string
  private challengeExpiry: number
  constructor() {
    // Never fall back to a public constant — a known JWT secret lets anyone
    // mint tokens for any wallet. validateRequired() also makes this fatal at
    // boot; this is the second line of defence in case that is ever relaxed.
    this.jwtSecret = env.JWT_SECRET
    if (!this.jwtSecret || this.jwtSecret.length < 16) {
      throw new Error('JWT_SECRET is required and must be at least 16 chars')
    }
    this.jwtExpiresIn = env.JWT_EXPIRES_IN || '7d'
    this.challengeExpiry = 10 * 60 * 1000 // 10 minutes
  }

  // Generate JWT token
  generateToken(payload: TokenPayload) {
    return jwt.sign(
      payload as any,
      this.jwtSecret as any,
      {
        expiresIn: this.jwtExpiresIn as any,
        issuer: 'treegens-backend',
      } as any,
    ) as unknown as string
  }

  // Verify JWT token
  verifyToken(token: string): TokenPayload {
    try {
      return jwt.verify(token, this.jwtSecret as any) as TokenPayload
    } catch {
      console.warn('JWT verification failed', {
        tokenPrefix: token?.slice(0, 12),
      })
      throw new Error('Invalid or expired token')
    }
  }

  // Get token expiration date
  getTokenExpiration() {
    const expiresIn = this.jwtExpiresIn
    let expirationMs

    if (expiresIn.endsWith('d')) {
      expirationMs = parseInt(expiresIn) * 24 * 60 * 60 * 1000
    } else if (expiresIn.endsWith('h')) {
      expirationMs = parseInt(expiresIn) * 60 * 60 * 1000
    } else if (expiresIn.endsWith('m')) {
      expirationMs = parseInt(expiresIn) * 60 * 1000
    } else {
      expirationMs = parseInt(expiresIn) * 1000 // seconds
    }

    return new Date(Date.now() + expirationMs)
  }

  // Verify wallet signature
  async verifyWalletSignature(
    walletAddress: string,
    signature: string,
    message: string,
  ) {
    try {
      // Recover the address from the signature
      const recoveredAddress = ethers.verifyMessage(message, signature)

      // Compare addresses (case-insensitive)
      return recoveredAddress.toLowerCase() === walletAddress.toLowerCase()
    } catch (error) {
      console.error('Wallet signature verification failed:', {
        walletAddress,
        error,
      })
      return false
    }
  }

  // Sign in with wallet - now requires challenge validation
  async signInWithWallet(
    walletAddress: string,
    signature: string,
    message: string,
  ) {
    // First validate the challenge message
    const challengeValidation = await this.validateChallengeMessage(
      walletAddress,
      message,
    )
    if (!challengeValidation.valid) {
      console.warn('Challenge validation failed', {
        walletAddress,
        reason: challengeValidation.error,
      })
      throw new Error(challengeValidation.error)
    }

    // Verify the signature
    const isValidSignature = await this.verifyWalletSignature(
      walletAddress,
      signature,
      message,
    )
    if (!isValidSignature) {
      console.warn('Invalid wallet signature', { walletAddress })
      throw new Error('Invalid wallet signature')
    }

    if (challengeValidation.challengeId) {
      await AuthChallenge.deleteOne({ _id: challengeValidation.challengeId })
    }

    // Find or create user by wallet address
    const normalizedWalletAddress = walletAddress.toLowerCase()
    let user = await User.findOne({
      walletAddress: normalizedWalletAddress,
    })

    if (!user) {
      // Create new user
      user = new User({
        walletAddress: normalizedWalletAddress,
        authProvider: 'wallet',
      })
    }

    // Generate JWT token
    const tokenPayload: TokenPayload = {
      userId: user._id.toString(),
      walletAddress: user.walletAddress,
      authProvider: 'wallet',
    }

    const token = this.generateToken(tokenPayload)
    const tokenExpiration = this.getTokenExpiration()

    // Update user with token info
    user.currentToken = token
    user.tokenExpiration = tokenExpiration
    user.lastLoginAt = new Date()
    user.authProvider = 'wallet'

    await user.save()

    return {
      token,
      tokenExpiration,
      user: {
        id: user._id,
        walletAddress: user.walletAddress,
        name: user.name,
        ensName: user.ensName,
        authProvider: user.authProvider,
        lastLoginAt: user.lastLoginAt,
      },
    }
  }

  // Validate user token and get user info
  async validateUserToken(token: string) {
    try {
      // Verify JWT token
      const decoded = this.verifyToken(token)

      // Find user in database
      const user = await User.findById(decoded.userId)
      if (!user) {
        console.warn('Token validation failed: user not found', {
          userId: decoded.userId,
          walletAddress: decoded.walletAddress,
        })
        throw new Error('User not found')
      }

      // Check if token matches current token in database
      if (user.currentToken !== token) {
        console.warn('Token validation failed: token mismatch', {
          userId: decoded.userId,
          walletAddress: decoded.walletAddress,
        })
        throw new Error('Token revoked or invalid')
      }

      // Check if token is expired
      if (user.tokenExpiration && new Date() > user.tokenExpiration) {
        console.warn('Token validation failed: token expired', {
          userId: decoded.userId,
          walletAddress: decoded.walletAddress,
          tokenExpiration: user.tokenExpiration,
        })
        throw new Error('Token expired')
      }

      return {
        userId: user._id.toString(),
        walletAddress: user.walletAddress,
        email: user.email,
        name: user.name,
        authProvider: user.authProvider,
      }
    } catch (error) {
      console.warn('Token validation failed', {
        error: (error as Error).message,
      })
      throw new Error(`Token validation failed: ${error.message}`)
    }
  }

  // Sign out user (revoke token)
  async signOut(userId: string) {
    try {
      await User.findByIdAndUpdate(userId, {
        $unset: {
          currentToken: '',
          tokenExpiration: '',
        },
      })
      return true
    } catch {
      throw new Error('Sign out failed')
    }
  }

  // Generate and store challenge message for wallet signing
  async generateChallengeMessage(
    walletAddress: string,
    nonce: string | null = null,
  ) {
    const timestamp = new Date().toISOString()
    const challengeNonce = nonce || Math.random().toString(36).substring(7)
    const normalizedWalletAddress = walletAddress.toLowerCase()

    const challengeData = {
      message: `Sign this message to authenticate with Treegens:\n\nWallet: ${walletAddress}\nTimestamp: ${timestamp}\nNonce: ${challengeNonce}`,
      nonce: challengeNonce,
      timestamp,
      walletAddress: normalizedWalletAddress,
      expiresAt: Date.now() + this.challengeExpiry,
    }

    await AuthChallenge.create({
      walletAddress: normalizedWalletAddress,
      nonce: challengeNonce,
      message: challengeData.message,
      expiresAt: new Date(challengeData.expiresAt),
    })

    return {
      message: challengeData.message,
      nonce: challengeNonce,
      timestamp,
    }
  }

  // Validate challenge message
  async validateChallengeMessage(walletAddress: string, message: string) {
    // Extract nonce from message
    const nonceMatch = message.match(/Nonce:\s*([a-z0-9]+)/i)
    if (!nonceMatch) {
      console.warn('Challenge validation failed: missing nonce', {
        walletAddress,
        messagePrefix: message?.slice(0, 40),
      })
      return { valid: false, error: 'Invalid message format - no nonce found' }
    }

    const nonce = nonceMatch[1]
    const normalizedWalletAddress = walletAddress.toLowerCase()
    const storedChallenge = await AuthChallenge.findOne({
      walletAddress: normalizedWalletAddress,
      nonce,
    })

    if (!storedChallenge) {
      console.warn('Challenge validation failed: not found', {
        walletAddress,
        nonce,
      })
      return {
        valid: false,
        error:
          'Challenge not found or expired. Please generate a new challenge.',
      }
    }

    if (storedChallenge.expiresAt && storedChallenge.expiresAt < new Date()) {
      await AuthChallenge.deleteOne({ _id: storedChallenge._id })
      console.warn('Challenge validation failed: expired', {
        walletAddress,
        nonce,
      })
      return {
        valid: false,
        error: 'Challenge expired. Please generate a new challenge.',
      }
    }

    if (storedChallenge.message !== message) {
      console.warn('Challenge validation failed: message mismatch', {
        walletAddress,
        nonce,
      })
      return {
        valid: false,
        error: 'Message does not match generated challenge',
      }
    }

    if (storedChallenge.walletAddress !== normalizedWalletAddress) {
      console.warn('Challenge validation failed: wallet mismatch', {
        walletAddress,
        nonce,
        storedWalletAddress: storedChallenge.walletAddress,
      })
      return { valid: false, error: 'Wallet address mismatch' }
    }

    return { valid: true, challengeId: storedChallenge._id }
  }
}

export default AuthService
