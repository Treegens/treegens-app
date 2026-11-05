'use client'

import { client } from '@/config/thirdwebConfig'
import { defaultChain } from '@/config/thirdwebChain'
import { getTreegensInAppWallet } from '@/config/treegensInAppWallet'
import { useAuth } from '@/contexts/AuthProvider'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { useConnect } from 'thirdweb/react'
import type { Account, Wallet } from 'thirdweb/wallets'
import { preAuthenticate } from 'thirdweb/wallets/in-app'
import { peekPostAuthRedirect } from '@/utils/postAuthRedirect'

type Step = 'email' | 'code'

type Props = {
  /** Called after the JWT sign-in succeeds (before any navigation). */
  onSignedIn?: (email: string) => void
}

export function EmailSignInForm({ onSignedIn }: Props = {}) {
  const router = useRouter()
  const pathname = usePathname()
  const { authenticate } = useAuth()
  const { connect } = useConnect()

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)

  const normalizedEmail = email.trim().toLowerCase()

  const handleSendCode = async () => {
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      toast.error('Enter a valid email address')
      return
    }
    setIsSending(true)
    try {
      await preAuthenticate({
        client,
        strategy: 'email',
        email: normalizedEmail,
      })
      setStep('code')
      toast.success('Check your email for a sign-in code or link')
    } catch (error) {
      console.error('[EmailSignIn] preAuthenticate failed', error)
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not send sign-in email. Try again.',
      )
    } finally {
      setIsSending(false)
    }
  }

  const handleVerifyCode = async () => {
    const trimmedCode = code.trim()
    if (!trimmedCode) {
      toast.error('Enter the code from your email')
      return
    }
    setIsSigningIn(true)
    try {
      let connectedWallet: Wallet | undefined
      let connectedAccount: Account | undefined

      await connect(async () => {
        const wallet = getTreegensInAppWallet(['email'])
        connectedAccount = await wallet.connect({
          client,
          chain: defaultChain,
          strategy: 'email',
          email: normalizedEmail,
          verificationCode: trimmedCode,
        })
        connectedWallet = wallet
        return wallet
      })

      if (!connectedAccount?.address) {
        toast.error('Wallet connected but account is not ready. Try again.')
        return
      }

      const ok = await authenticate(true, {
        account: connectedAccount,
        wallet: connectedWallet ?? null,
      })
      if (ok) {
        onSignedIn?.(normalizedEmail)
        // Stored in localStorage with a TTL: survives a magic link opening a
        // new tab. No-op when we are already on the destination page.
        const target = peekPostAuthRedirect() ?? '/'
        if (target !== pathname) router.replace(target)
      } else {
        toast.error('Wallet connected but sign-in failed. Try again.')
      }
    } catch (error) {
      console.error('[EmailSignIn] verify failed', error)
      toast.error(
        error instanceof Error
          ? error.message
          : 'Invalid or expired code. Request a new one.',
      )
    } finally {
      setIsSigningIn(false)
    }
  }

  return (
    <div className="w-full rounded-2xl border border-white/20 bg-black/35 px-4 py-4 backdrop-blur-sm">
      <p className="text-center text-sm font-semibold text-white">
        Sign in with email
      </p>
      <p className="mt-1 text-center text-xs text-white/75">
        We&apos;ll email you a one-time code (magic link opens the same flow).
      </p>

      {step === 'email' ? (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full rounded-xl border border-white/25 bg-white/95 px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-400"
          />
          <button
            type="button"
            onClick={() => void handleSendCode()}
            disabled={isSending}
            className="w-full rounded-xl bg-[#d3e165] px-4 py-2.5 text-sm font-semibold text-[#1a3012] disabled:opacity-60"
          >
            {isSending ? 'Sending…' : 'Send sign-in code'}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-center text-xs text-white/80">
            Code sent to <span className="font-medium">{normalizedEmail}</span>
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={e => setCode(e.target.value)}
            className="w-full rounded-xl border border-white/25 bg-white/95 px-3 py-2.5 text-center text-lg tracking-widest text-gray-900 placeholder:text-gray-400"
          />
          <button
            type="button"
            onClick={() => void handleVerifyCode()}
            disabled={isSigningIn}
            className="w-full rounded-xl bg-[#d3e165] px-4 py-2.5 text-sm font-semibold text-[#1a3012] disabled:opacity-60"
          >
            {isSigningIn ? 'Signing in…' : 'Verify & sign in'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email')
              setCode('')
            }}
            className="text-xs font-medium text-white/80 underline"
          >
            Use a different email
          </button>
        </div>
      )}
    </div>
  )
}
