import { publicEnv } from '@/config/publicEnv'
import { inAppWallet, type InAppWalletAuth } from 'thirdweb/wallets'

/**
 * Auth methods shown in Connect modal, email sign-in and phone (SMS) sign-in.
 * `phone` must also be enabled for this client in the thirdweb dashboard
 * (In-App Wallets > Authentication) or `preAuthenticate` rejects the request.
 */
export const TREEGENS_IN_APP_AUTH_OPTIONS: InAppWalletAuth[] = [
  'email',
  'phone',
  'google',
  'apple',
  'facebook',
  'passkey',
]

function resolveAuthRedirectUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/auth`
  }
  const base = publicEnv.appUrl || 'https://treegens.app'
  return `${base.replace(/\/$/, '')}/auth`
}

/**
 * Shared in-app wallet config — email OTP, social OAuth, passkey.
 * `redirectUrl` is required for OAuth / magic-link style returns on mobile PWA.
 */
export function getTreegensInAppWallet(
  authOptions: InAppWalletAuth[] = TREEGENS_IN_APP_AUTH_OPTIONS,
) {
  const origin =
    (typeof window !== 'undefined' && window.location?.origin) ||
    publicEnv.appUrl ||
    'https://treegens.app'

  return inAppWallet({
    auth: {
      options: authOptions,
      mode: 'redirect',
      redirectUrl: resolveAuthRedirectUrl(),
    },
    metadata: {
      name: 'TreeGens',
      icon: `${origin}/img/treegens-logo.svg`,
      image: {
        src: `${origin}/img/treegens-logo.svg`,
        width: 80,
        height: 80,
        alt: 'TreeGens',
      },
    },
  })
}
