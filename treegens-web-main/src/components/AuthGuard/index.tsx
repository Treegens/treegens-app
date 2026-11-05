'use client'
import { usePathname, useRouter } from 'next/navigation'
import React, { useEffect } from 'react'
import { routes } from '@/config/appConfig'
import { useAuth } from '@/contexts/AuthProvider'
import {
  clearPostAuthRedirect,
  peekPostAuthRedirect,
} from '@/utils/postAuthRedirect'

/** OTC invite landing is readable before sign-in; it asks to sign in itself. */
function isOtcJoinPage(pathname: string | null): boolean {
  return typeof pathname === 'string' && pathname.startsWith('/otc/join/')
}

export const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const { replace } = useRouter()
  const pathname = usePathname()
  const isLoginPage = pathname === routes.Login
  const isStakePage = pathname === routes.Stake
  const isPublicPage = isLoginPage || isStakePage || isOtcJoinPage(pathname)
  const { isLoading: authLoading, isAuthenticated } = useAuth()

  // Once signed in and off the login page, the stored destination has served
  // its purpose (or was skipped); drop it so it cannot hijack a later sign-in.
  useEffect(() => {
    if (!authLoading && isAuthenticated && !isLoginPage) {
      clearPostAuthRedirect()
    }
  }, [authLoading, isAuthenticated, isLoginPage, pathname])

  useEffect(() => {
    const handleAuth = async () => {
      if (authLoading) return

      if (isLoginPage) {
        if (isAuthenticated) {
          // peek, not consume: the auth page computes the same target in its
          // own effect; whichever runs second must not fall back to Home.
          replace(peekPostAuthRedirect() ?? routes.Home)
        }
        return
      }

      if (!isPublicPage && !isAuthenticated) {
        replace(routes.Login)
        return
      }
    }

    handleAuth()
  }, [authLoading, isAuthenticated, isPublicPage, isLoginPage, replace])

  if (authLoading || (!isAuthenticated && !isPublicPage)) {
    return (
      <div className="flex items-center justify-center min-h-screen tg-page-bg">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-lime-green-1"></div>
      </div>
    )
  }

  if (isLoginPage && isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen tg-page-bg">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-lime-green-1"></div>
      </div>
    )
  }

  return <>{children}</>
}
