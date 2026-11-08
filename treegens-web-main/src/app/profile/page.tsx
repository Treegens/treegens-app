'use client'

import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import {
  IoCallOutline,
  IoCheckmarkCircle,
  IoFlagOutline,
  IoPersonOutline,
} from 'react-icons/io5'
import Link from 'next/link'
import {
  HiArrowLeft,
  HiClipboardDocumentCheck,
  HiSparkles,
} from 'react-icons/hi2'
import { defaultChain } from '@/config/thirdwebChain'
import { client } from '@/config/thirdwebConfig'
import { getTreegensConnectModalProps } from '@/config/thirdwebConnect'
import { routes } from '@/config/appConfig'
import { POINTS_PER_TGN_HINT } from '@/config/socialAndDefi'
import { HubPageHeader } from '@/components/Layout/HubPageHeader'
import { ProfileWalletInfo } from '@/components/profile/ProfileWalletInfo'
import { useAuth } from '@/contexts/AuthProvider'
import { useUser } from '@/contexts/UserProvider'
import { patchCurrentUserProfile } from '@/services/app'
import {
  validateProfileForm,
  type ProfileFormData,
} from '@/utils/profileValidation'
import { notifyError } from '@/utils/apiErrorMessage'
import { formatMgroCollectedDisplay } from '@/utils/formatMgro'
import { clearPlantingTutorialSkip } from '@/utils/plantingTutorialPreference'
import {
  useActiveAccount,
  useActiveWallet,
  useConnectModal,
  getLastAuthProvider,
  useDisconnect,
  useWalletDetailsModal,
} from 'thirdweb/react'
import { getTreegensInAppWallet } from '@/config/treegensInAppWallet'
import {
  createWallet,
  type InAppWalletAuth,
  type WalletId,
} from 'thirdweb/wallets'

const LAST_WALLET_ID_KEY = 'treegens_last_wallet_id'
const LAST_WALLET_ADDRESS_KEY = 'treegens_last_wallet_address'
const LAST_AUTH_PROVIDER_KEY = 'treegens_last_auth_provider'

/** `Colors.secondary` from mobile — icon tint */
const ICON = '#4d341e'

export default function Profile() {
  const router = useRouter()
  const { user, isLoading: userLoading, fetchUser } = useUser()
  const { signOut, token } = useAuth()
  const [formData, setFormData] = useState<ProfileFormData>({})
  const [isSaving, setIsSaving] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  const activeAccount = useActiveAccount()
  const activeWallet = useActiveWallet()
  const walletDetailsModal = useWalletDetailsModal()
  const { connect: openConnectModal, isConnecting: isWalletConnecting } =
    useConnectModal()
  const { disconnect } = useDisconnect()
  const [isProfileConnectFlow, setIsProfileConnectFlow] = useState(false)

  const openWalletDetailsModal = useCallback(() => {
    walletDetailsModal.open({
      client,
      chains: [defaultChain],
      onDisconnect: () => {
        void signOut()
      },
    })
  }, [walletDetailsModal, signOut])

  useEffect(() => {
    if (user) {
      setFormData({
        name: user.name,
        phone: user.phone != null ? String(user.phone) : undefined,
        experience: user.experience,
      })
    }
  }, [user])

  const handleInputChange = (field: keyof ProfileFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleSave = async () => {
    if (isSaving) return
    if (!token) {
      notifyError('Sign in to save your profile')
      return
    }

    const validation = validateProfileForm(formData)
    if (!validation.valid) {
      notifyError(validation.error ?? 'Invalid input')
      return
    }

    try {
      setIsSaving(true)
      await patchCurrentUserProfile(validation.normalized)
      await fetchUser()
      toast.success('Profile saved successfully')
    } catch (error) {
      console.error('Error saving user:', error)
      notifyError('Could not save. Try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleOpenWalletProfile = async () => {
    if (!activeAccount) {
      const lastWalletId =
        typeof window !== 'undefined'
          ? localStorage.getItem(LAST_WALLET_ID_KEY)
          : null
      if (!lastWalletId) {
        notifyError('Log in again to reconnect')
        return
      }
      const isInApp =
        lastWalletId === 'inApp' ||
        lastWalletId === 'inAppWallet' ||
        lastWalletId.startsWith('ecosystem.')
      let wallets
      if (isInApp) {
        const lastAuthProvider =
          (typeof window !== 'undefined'
            ? localStorage.getItem(LAST_AUTH_PROVIDER_KEY)
            : null) || (await getLastAuthProvider())
        if (!lastAuthProvider) {
          notifyError('Log in again to reconnect')
          return
        }
        wallets = [
          getTreegensInAppWallet([lastAuthProvider as InAppWalletAuth]),
        ]
      } else {
        wallets = [createWallet(lastWalletId as WalletId)]
      }
      setIsProfileConnectFlow(true)
      void openConnectModal(
        getTreegensConnectModalProps({ wallets, showAllWallets: false }),
      )
      return
    }
    openWalletDetailsModal()
  }

  useEffect(() => {
    if (!isProfileConnectFlow || !activeAccount) return
    const lastWalletAddress =
      typeof window !== 'undefined'
        ? localStorage.getItem(LAST_WALLET_ADDRESS_KEY)
        : null
    if (
      lastWalletAddress &&
      activeAccount.address.toLowerCase() !== lastWalletAddress.toLowerCase()
    ) {
      if (activeWallet) {
        void disconnect(activeWallet)
      }
      notifyError('Use the wallet you signed in with')
      setIsProfileConnectFlow(false)
      return
    }
    openWalletDetailsModal()
    setIsProfileConnectFlow(false)
  }, [
    activeAccount,
    activeWallet,
    disconnect,
    isProfileConnectFlow,
    openWalletDetailsModal,
  ])

  const confirmSignOut = useCallback(() => {
    const ok = window.confirm(
      "Sign out? This will remove your wallet and sign you out. You'll need to sign in again to access your account.",
    )
    if (!ok) return
    void (async () => {
      if (isSigningOut) return
      setIsSigningOut(true)
      try {
        await signOut()
        router.push(routes.Login)
      } catch (error) {
        console.error('Failed to sign out:', error)
        notifyError('Could not sign out')
      } finally {
        setIsSigningOut(false)
      }
    })()
  }, [isSigningOut, signOut, router])

  if (userLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-[#435F24]/25 border-t-[#dfea8a]"
          aria-label="Loading"
        />
      </div>
    )
  }

  return (
    <div className="relative min-h-screen flex-1 text-[#1a2610]">
      <div className="relative z-10 px-4 pb-28 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-lg p-1 text-[#435F24] hover:bg-black/5"
            aria-label="Back"
          >
            <HiArrowLeft className="h-6 w-6" />
          </button>
        </div>

        <HubPageHeader
          title={user?.name ? 'My Profile' : 'Create Profile'}
          subtitle="Identity"
        />

        <section className="tg-glass-panel mb-6 p-5">
          <div className="mb-4 flex flex-row items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#6b6560]">
              Your planting impact
            </p>
            <Link
              href={routes.Leaderboard}
              className="text-[11px] font-semibold text-[#435F24] underline decoration-[#435F24]/35 underline-offset-2"
            >
              Leaderboard →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="tg-impact-card px-3 py-3.5">
              <div className="mb-1 flex flex-row items-center gap-1.5 text-[#435F24]">
                <HiSparkles className="h-4 w-4" aria-hidden />
                <span className="text-[10px] font-bold uppercase tracking-wide">
                  Verified trees
                </span>
              </div>
              <p className="text-[26px] font-black tabular-nums leading-none text-[#1a2610]">
                {(user?.treesPlanted ?? 0).toLocaleString()}
              </p>
              <p className="mt-2 text-[10px] leading-snug text-[#5c534a]">
                Count from approved submissions stored in your TreeGens account.
              </p>
            </div>
            <div className="tg-impact-card px-3 py-3.5">
              <div className="mb-1 flex flex-row items-center gap-1.5 text-[#435F24]">
                <HiClipboardDocumentCheck className="h-4 w-4" aria-hidden />
                <span className="text-[10px] font-bold uppercase tracking-wide">
                  Loyalty pts
                </span>
              </div>
              <p className="text-[26px] font-black tabular-nums leading-none text-[#1a2610]">
                {(user?.socialPointsTotal ?? 0).toLocaleString()}
              </p>
              <p className="mt-2 text-[10px] leading-snug text-[#5c534a]">
                ~{POINTS_PER_TGN_HINT} pts ≈ 1 TGN (guide rate). Earn more on
                Tasks.
              </p>
              <Link
                href={routes.Earn}
                className="mt-2 inline-flex items-center gap-1 rounded-full bg-[#435F24]/10 px-2 py-1 text-[11px] font-bold text-[#435F24] ring-1 ring-[#435F24]/15"
              >
                Open tasks
              </Link>
            </div>
          </div>
          <div className="tg-impact-card-mgro mt-3 px-4 py-3.5">
            <p className="text-[10px] font-bold uppercase tracking-wide text-[#303E1A]/85">
              MGRO on-chain (claimed)
            </p>
            <p className="mt-1 text-lg font-black tabular-nums text-[#1a2610]">
              {formatMgroCollectedDisplay(user?.tokensClaimed)}{' '}
              <span className="text-xs font-semibold text-[#5c534a]">MGRO</span>
            </p>
            <p className="mt-1 text-[10px] text-[#4d534a]">
              Mirrors claim jobs from verifier + planter allocations.
            </p>
          </div>
        </section>

        <p className="mb-6 text-center">
          <button
            type="button"
            onClick={() => {
              clearPlantingTutorialSkip()
              router.push(routes.Tutorial)
            }}
            className="text-[11px] font-semibold text-[#6b6560] underline decoration-[#6b6560]/40 underline-offset-2 hover:text-[#435F24]"
          >
            Watch the planting tutorial
          </button>
        </p>

        <div className="tg-glass-panel px-5 py-8 shadow-lg">
          <div className="mb-8 flex justify-center">
            <div className="relative flex h-[5.25rem] w-[5.25rem] items-center justify-center rounded-full bg-gradient-to-br from-[#dfea8a] to-[#6B8C3B] p-[3px] shadow-lg ring-2 ring-white">
              <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-[#ececec]">
                <Image
                  src="/img/treegens-logo.svg"
                  alt=""
                  width={64}
                  height={64}
                  className="object-cover"
                  priority
                />
              </div>
            </div>
          </div>

          <div className="mb-6 flex flex-col gap-4">
            <div className="tg-field flex flex-row items-center px-4">
              <IoPersonOutline
                className="mr-3 shrink-0"
                size={20}
                color={ICON}
                aria-hidden
              />
              <input
                type="text"
                className="min-w-0 flex-1 border-0 bg-transparent py-3 text-base text-[#111] placeholder:text-[#9ca3af] focus:ring-0"
                placeholder="Name"
                value={formData.name ?? ''}
                onChange={e => handleInputChange('name', e.target.value)}
                autoComplete="name"
              />
            </div>
            <div className="tg-field flex flex-row items-center px-4">
              <IoCallOutline
                className="mr-3 shrink-0"
                size={20}
                color={ICON}
                aria-hidden
              />
              <input
                type="tel"
                className="min-w-0 flex-1 border-0 bg-transparent py-3 text-base text-[#111] placeholder:text-[#9ca3af] focus:ring-0"
                placeholder="Phone no."
                value={formData.phone ?? ''}
                onChange={e => handleInputChange('phone', e.target.value)}
                autoComplete="tel"
              />
            </div>
            <div className="tg-field flex flex-row items-center px-4">
              <IoFlagOutline
                className="mr-3 shrink-0"
                size={20}
                color={ICON}
                aria-hidden
              />
              <input
                type="text"
                className="min-w-0 flex-1 border-0 bg-transparent py-3 text-base text-[#111] placeholder:text-[#9ca3af] focus:ring-0"
                placeholder="Experience (Optional)"
                value={formData.experience ?? ''}
                onChange={e => handleInputChange('experience', e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-row items-center justify-between gap-2">
            <ProfileWalletInfo
              onOpenWallet={handleOpenWalletProfile}
              isWalletConnecting={isWalletConnecting}
            />
            {user?.isVerifier ? (
              <div className="flex shrink-0 flex-row items-center gap-1 rounded-full border border-[#86efac] bg-[#dcfce7] px-2 py-1">
                <IoCheckmarkCircle className="text-[#15803d]" size={16} />
                <span className="text-xs font-semibold text-[#166534]">
                  Verifier
                </span>
              </div>
            ) : null}
          </div>

          <div className="mb-4 mt-2 flex w-full flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => router.push(routes.OtcMe)}
              className="min-h-10 rounded-full bg-[#ececec] px-4 py-2 text-[14px] text-[#374151] transition-opacity hover:opacity-90 active:opacity-90"
            >
              M-Pesa payouts
            </button>
            {user?.isOtcBuyer ? (
              <button
                type="button"
                onClick={() => router.push(routes.OtcDesk)}
                className="min-h-10 rounded-full bg-[#435F24] px-4 py-2 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 active:opacity-90"
              >
                OTC desk
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => router.push(routes.Stake)}
              className="min-h-10 rounded-full bg-[#ececec] px-4 py-2 text-[14px] text-[#374151] transition-opacity hover:opacity-90 active:opacity-90"
            >
              {user?.isVerifier ? 'Stake / Unstake TGN' : 'Become a verifier'}
            </button>
          </div>

          <div className="w-full pb-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="tg-cta mb-3 flex w-full flex-row items-center justify-center gap-2 py-3.5 text-base disabled:opacity-70"
            >
              {isSaving ? (
                <span
                  className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[#16210c]/40 border-t-[#16210c]"
                  aria-hidden
                />
              ) : null}
              <span>{isSaving ? 'Saving…' : 'Save'}</span>
            </button>
            <button
              type="button"
              onClick={confirmSignOut}
              disabled={isSigningOut}
              className="flex w-full flex-row items-center justify-center gap-2 rounded-full border border-[rgba(241,52,14,0.35)] bg-[#ffdbd3] py-3 text-base font-medium text-[#f1340e] transition-opacity active:opacity-90 disabled:opacity-70"
            >
              {isSigningOut ? (
                <span
                  className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-[#f1340e]/40 border-t-[#f1340e]"
                  aria-hidden
                />
              ) : null}
              <span>{isSigningOut ? 'Signing out…' : 'Sign out'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
