'use client'

import { routes } from '@/config/appConfig'
import { getTreegensConnectModalProps } from '@/config/thirdwebConnect'
import { EmailSignInForm } from '@/components/auth/EmailSignInForm'
import { useAuth } from '@/contexts/AuthProvider'
import { offlineVideoService } from '@/services/offlineVideoService'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useActiveAccount, useConnectModal } from 'thirdweb/react'
import toast from 'react-hot-toast'
import { peekPostAuthRedirect } from '@/utils/postAuthRedirect'

/** Forest canopy fallback when no env URL and `/public/img/treegens-bg.png` is missing. */
const DEFAULT_AUTH_BG_REMOTE =
  'https://images.unsplash.com/photo-1448375240586-882707dba888?auto=format&fit=crop&w=1920&q=80'

function AuthBackdrop() {
  const envSrc = process.env.NEXT_PUBLIC_AUTH_BG_URL?.trim()
  const [src, setSrc] = useState(() => envSrc || '/img/treegens-bg.png')

  return (
    <div className="absolute inset-0 -z-10">
      <div
        className="absolute inset-0 bg-gradient-to-b from-[#1a3012] via-[#243818] to-[#0d160a]"
        aria-hidden
      />
      <Image
        src={src}
        alt=""
        fill
        className="object-cover"
        sizes="100vw"
        priority
        onError={() => {
          setSrc(prev =>
            prev === DEFAULT_AUTH_BG_REMOTE ? prev : DEFAULT_AUTH_BG_REMOTE,
          )
        }}
      />
      <div className="absolute inset-0 bg-black/40" aria-hidden />
    </div>
  )
}

/**
 * Matches `mobile/app/auth.tsx`: one black “Sign in” opens the wallet flow,
 * then we show a loader while the JWT challenge/sign-in runs, then navigate home.
 */
export default function AuthPage() {
  const router = useRouter()
  const { connect: openConnectModal, isConnecting: isWalletConnecting } =
    useConnectModal()
  const account = useActiveAccount()
  const {
    isAuthenticated,
    isLoading: authContextLoading,
    authenticate,
    token,
  } = useAuth()

  const [pendingSignIn, setPendingSignIn] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const authAttemptRef = useRef(false)
  /** Survives brief gaps between wallet modal close and `account.address` hydration. */
  const signInIntentRef = useRef(false)
  const [serviceWorkerVersion, setServiceWorkerVersion] = useState<
    string | null
  >(offlineVideoService.activeVersion)

  useEffect(() => {
    let isMounted = true
    offlineVideoService
      .getServiceWorkerVersion()
      .then(version => {
        if (!isMounted) return
        if (version) {
          setServiceWorkerVersion(version)
        } else if (offlineVideoService.activeVersion) {
          setServiceWorkerVersion(offlineVideoService.activeVersion)
        }
      })
      .catch(error => {
        console.warn('[Login] Failed to read SW version:', error)
      })
    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (authContextLoading) return
    if (isAuthenticated && token) {
      router.replace(peekPostAuthRedirect() ?? routes.Home)
    }
  }, [authContextLoading, isAuthenticated, token, router])

  /** After OAuth / magic-link redirect, wallet may reconnect before JWT exists. */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const pending =
      sessionStorage.getItem('tg_oauth_pending') === '1' ||
      new URLSearchParams(window.location.search).has('walletId')
    if (!pending) return
    if (!account?.address || isAuthenticated || isAuthenticating) return
    if (authAttemptRef.current) return

    authAttemptRef.current = true
    sessionStorage.removeItem('tg_oauth_pending')
    ;(async () => {
      setIsAuthenticating(true)
      try {
        const ok = await authenticate(true)
        if (ok) {
          router.replace(peekPostAuthRedirect() ?? routes.Home)
        }
      } finally {
        setIsAuthenticating(false)
        authAttemptRef.current = false
      }
    })()
  }, [
    account?.address,
    isAuthenticated,
    isAuthenticating,
    authenticate,
    router,
  ])

  useEffect(() => {
    if (
      !signInIntentRef.current ||
      !account?.address ||
      isAuthenticated ||
      isAuthenticating ||
      authAttemptRef.current
    ) {
      return
    }
    authAttemptRef.current = true
    ;(async () => {
      setIsAuthenticating(true)
      try {
        const ok = await authenticate(true)
        if (ok) {
          router.replace(peekPostAuthRedirect() ?? routes.Home)
        } else {
          toast.error('Sign in failed. Please try again.')
        }
      } finally {
        signInIntentRef.current = false
        setPendingSignIn(false)
        setIsAuthenticating(false)
        authAttemptRef.current = false
      }
    })()
  }, [
    account?.address,
    isAuthenticated,
    isAuthenticating,
    authenticate,
    router,
  ])

  // If the user closes/cancels the wallet modal without connecting, re-enable sign-in.
  useEffect(() => {
    if (!pendingSignIn && !signInIntentRef.current) return
    if (isAuthenticating) return
    if (account?.address) return
    if (isWalletConnecting) return

    const timer = window.setTimeout(() => {
      if (isAuthenticating || account?.address || isWalletConnecting) return
      signInIntentRef.current = false
      setPendingSignIn(false)
    }, 2000)

    return () => window.clearTimeout(timer)
  }, [pendingSignIn, isAuthenticating, account?.address, isWalletConnecting])

  const handleSignInPress = () => {
    if (pendingSignIn || isAuthenticating || isWalletConnecting) return
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('tg_oauth_pending', '1')
    }
    signInIntentRef.current = true
    setPendingSignIn(true)
    openConnectModal(getTreegensConnectModalProps()).catch(() => {
      signInIntentRef.current = false
      setPendingSignIn(false)
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('tg_oauth_pending')
      }
    })
  }

  if (authContextLoading && !isAuthenticated && !token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-lime-green-2" />
      </div>
    )
  }

  if (isAuthenticated && token) {
    return (
      <div className="relative min-h-screen w-full">
        <AuthBackdrop />
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-lime-green-2" />
          <p className="text-center text-white">Taking you home…</p>
        </div>
      </div>
    )
  }

  if (isAuthenticating) {
    return (
      <div className="relative min-h-screen w-full">
        <AuthBackdrop />
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-lime-green-2" />
          <p className="text-center text-white">Signing you in…</p>
        </div>
      </div>
    )
  }

  return (
    <main className="relative h-full w-full min-h-screen">
      <AuthBackdrop />

      <div className="flex min-h-screen flex-col justify-between px-5 pb-20 pt-[200px]">
        <div className="mx-auto flex flex-col items-center gap-2">
          <Image
            src="/img/treegens-logo.svg"
            alt="Logo"
            width={81}
            height={80}
          />
          <Image
            src="/img/treegens-text.svg"
            alt="Treegens"
            width={191}
            height={60}
            priority
          />
          <span className="text-sm font-semibold text-[#d3e165]">
            Plant Trees, Get Rewarded
          </span>
          {serviceWorkerVersion && (
            <span className="text-[8px] text-lime-green-2">
              {serviceWorkerVersion}
            </span>
          )}
        </div>

        <div className="mx-auto flex w-4/5 max-w-md flex-col items-center gap-3">
          <EmailSignInForm />

          <p className="w-full text-center text-xs font-medium uppercase tracking-wide text-white/70">
            or connect a wallet
          </p>

          <div className="w-[60%] max-w-xs">
            <button
              type="button"
              onClick={handleSignInPress}
              className="flex w-full items-center justify-center rounded-[25px] bg-black px-6 py-3.5 font-semibold text-white disabled:opacity-60"
              disabled={pendingSignIn || isWalletConnecting}
            >
              Sign in with wallet
            </button>
          </div>
          <p className="w-full px-1 text-center text-xs leading-5 text-white/85">
            By signing in, you accept our{' '}
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-medium text-[#d3e165] underline"
              onClick={() => {}}
            >
              Privacy Policy
            </button>
          </p>
        </div>
      </div>
    </main>
  )
}
