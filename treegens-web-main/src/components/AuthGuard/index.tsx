'use client'
import { usePathname, useRouter } from 'next/navigation'
import React, { useEffect } from 'react'
import { isPublicPath, routes } from '@/config/appConfig'
import { useAuth } from '@/contexts/AuthProvider'

export const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const { replace } = useRouter()
  const pathname = usePathname()
  const isLoginPage = pathname === routes.Login
  const isPublicPage = isPublicPath(pathname)
  const { isLoading: authLoading, isAuthenticated } = useAuth()

  useEffect(() => {
    const handleAuth = async () => {
      if (authLoading) return

      if (isLoginPage) {
        if (isAuthenticated) {
          replace(routes.Home)
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
