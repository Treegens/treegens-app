'use client'

import { client } from '@/config/thirdwebConfig'
import { defaultChain } from '@/config/thirdwebChain'
import { getTreegensInAppWallet } from '@/config/treegensInAppWallet'
import { useAuth } from '@/contexts/AuthProvider'
import { formatPhoneForDisplay, normalizeKenyanPhone } from '@/utils/mpesaPhone'
import { peekPostAuthRedirect } from '@/utils/postAuthRedirect'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { useConnect } from 'thirdweb/react'
import type { Account, Wallet } from 'thirdweb/wallets'
import { preAuthenticate } from 'thirdweb/wallets/in-app'

type Step = 'phone' | 'code'

type Props = {
  /** Called when the planter submits the SMS code (sign-in is now in flight). */
  onSignInStart?: () => void
  /** Called after the JWT sign-in succeeds, with the verified E.164 number. */
  onSignedIn?: (phoneE164: string) => void
  /** Shown when SMS sign-in fails, e.g. a "Use email instead" button. */
  fallback?: React.ReactNode
  title?: string
  /** Light variant for white pages (the invite page); default matches /auth. */
  tone?: 'dark' | 'light'
}

/**
 * SMS one-time-code sign-in through the thirdweb in-app wallet `phone`
 * strategy. Modelled on `EmailSignInForm`. Default country is Kenya (+254):
 * `07XX XXX XXX` is accepted as typed on an M-Pesa receipt.
 *
 * Requires phone auth to be enabled for this client in the thirdweb dashboard.
 */
export function PhoneSignInForm({
  onSignInStart,
  onSignedIn,
  fallback,
  title = 'Sign in with your M-Pesa phone number',
  tone = 'dark',
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const { authenticate } = useAuth()
  const { connect } = useConnect()

  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const phoneE164 = normalizeKenyanPhone(phone)
  const light = tone === 'light'

  const inputClass = light
    ? 'w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base text-gray-900 placeholder:text-gray-400 focus:border-[#435F24] focus:outline-none'
    : 'w-full rounded-xl border border-white/25 bg-white/95 px-3 py-3 text-base text-gray-900 placeholder:text-gray-400'
  const primaryClass = light
    ? 'tg-cta w-full py-3 text-sm disabled:opacity-60'
    : 'w-full rounded-xl bg-[#d3e165] px-4 py-3 text-sm font-semibold text-[#1a3012] disabled:opacity-60'
  const mutedText = light ? 'text-gray-600' : 'text-white/75'
  const strongText = light ? 'text-gray-900' : 'text-white'
  const linkText = light ? 'text-[#435F24]' : 'text-white/80'

  const handleSendCode = async () => {
    setError(null)
    if (!phoneE164) {
      toast.error('Enter a valid phone number, e.g. 0712 345 678')
      return
    }
    setIsSending(true)
    try {
      await preAuthenticate({
        client,
        strategy: 'phone',
        phoneNumber: phoneE164,
      })
      setStep('code')
      toast.success(`Code sent by SMS to ${formatPhoneForDisplay(phoneE164)}`)
    } catch (err) {
      console.error('[PhoneSignIn] preAuthenticate failed', err)
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'Could not send the SMS code. Try again or use email.'
      setError(msg)
      toast.error(msg)
    } finally {
      setIsSending(false)
    }
  }

  const handleVerifyCode = async () => {
    setError(null)
    const trimmedCode = code.trim()
    if (!trimmedCode || !phoneE164) {
      toast.error('Enter the code from the SMS')
      return
    }
    setIsSigningIn(true)
    onSignInStart?.()
    try {
      let connectedWallet: Wallet | undefined
      let connectedAccount: Account | undefined

      await connect(async () => {
        const wallet = getTreegensInAppWallet(['phone'])
        connectedAccount = await wallet.connect({
          client,
          chain: defaultChain,
          strategy: 'phone',
          phoneNumber: phoneE164,
          verificationCode: trimmedCode,
        })
        connectedWallet = wallet
        return wallet
      })

      if (!connectedAccount?.address) {
        const msg = 'Wallet connected but account is not ready. Try again.'
        setError(msg)
        toast.error(msg)
        return
      }

      const ok = await authenticate(true, {
        account: connectedAccount,
        wallet: connectedWallet ?? null,
      })
      if (!ok) {
        const msg = 'Phone verified but sign-in failed. Try again.'
        setError(msg)
        toast.error(msg)
        return
      }

      onSignedIn?.(phoneE164)
      const target = peekPostAuthRedirect() ?? '/'
      if (target !== pathname) router.replace(target)
    } catch (err) {
      console.error('[PhoneSignIn] verify failed', err)
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'Invalid or expired code. Request a new one.'
      setError(msg)
      toast.error(msg)
    } finally {
      setIsSigningIn(false)
    }
  }

  return (
    <div
      className={
        light
          ? 'w-full rounded-2xl border border-gray-200 bg-white px-4 py-4 shadow-sm'
          : 'w-full rounded-2xl border border-white/20 bg-black/35 px-4 py-4 backdrop-blur-sm'
      }
    >
      <p className={`text-center text-sm font-semibold ${strongText}`}>
        {title}
      </p>
      <p className={`mt-1 text-center text-xs ${mutedText}`}>
        We&apos;ll text you a one-time code. No password needed.
      </p>

      {step === 'phone' ? (
        <div className="mt-3 flex flex-col gap-2">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="07XX XXX XXX"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            className={inputClass}
            aria-label="Phone number"
          />
          {phone.trim() && !phoneE164 ? (
            <p className="text-xs text-red-600">
              That does not look like a phone number. Use 07XX XXX XXX or
              +2547XX XXX XXX.
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void handleSendCode()}
            disabled={isSending}
            className={primaryClass}
          >
            {isSending ? 'Sending…' : 'Send SMS code'}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <p className={`text-center text-xs ${mutedText}`}>
            Code sent to{' '}
            <span className="font-medium">
              {formatPhoneForDisplay(phoneE164)}
            </span>
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={e => setCode(e.target.value)}
            className={`${inputClass} text-center text-lg tracking-widest`}
            aria-label="SMS code"
          />
          <button
            type="button"
            onClick={() => void handleVerifyCode()}
            disabled={isSigningIn}
            className={primaryClass}
          >
            {isSigningIn ? 'Signing in…' : 'Verify & sign in'}
          </button>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setStep('phone')
                setCode('')
                setError(null)
              }}
              className={`py-2 text-xs font-medium underline ${linkText}`}
            >
              Use a different number
            </button>
            <button
              type="button"
              onClick={() => void handleSendCode()}
              disabled={isSending}
              className={`py-2 text-xs font-medium underline ${linkText} disabled:opacity-60`}
            >
              {isSending ? 'Sending…' : 'Resend code'}
            </button>
          </div>
        </div>
      )}

      {error ? (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-xs text-red-800">{error}</p>
          {fallback ? <div className="mt-2">{fallback}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
