/** Canonical app paths (mirror mobile Expo routes). */

export const routes = {
  Login: '/auth',
  Home: '/',
  /** @deprecated Use routes.Home — kept for refactors */
  Dashboard: '/',
  Profile: '/profile',
  Tutorial: '/tutorial',
  TutorialVerify: '/tutorial/verify',
  Leaderboard: '/leaderboard',
  LeaderboardFunded: '/leaderboard/funded',
  NewPlant: '/submissions/create',
  /** User's submissions list (replaces legacy my-plants as primary list). */
  MySubmissions: '/submissions',
  /** @deprecated Use MySubmissions — same URL */
  MyPlants: '/submissions',
  /** Verifier moderation queue */
  SubmissionsReview: '/submissions/review',
  /** @deprecated Use SubmissionsReview */
  Submissions: '/submissions/review',
  Stake: '/stake',
  Earn: '/earn',
  Inbox: '/inbox',
  HealthChecks: '/health-checks',
  /** Dynamic — use buildReviewSubmissionPath */
  ReviewSubmission: '/submissions/review/[userWalletAddress]/[submissionId]',
  SubmissionDetail: '/submissions/[id]',
  RejectionFeedback: '/submissions/[id]/rejection-feedback',
  /** Dynamic — public planter stats + burns */
  PublicProfile: '/u/[walletAddress]',
  /** Site Check: my registered planting sites */
  Sites: '/sites',
  NewSite: '/sites/create',
  /** Verifier queue of sites to review */
  SitesReview: '/sites/review',
}

export function buildPublicProfilePath(walletAddress: string) {
  const w = walletAddress.trim()
  return `/u/${encodeURIComponent(w)}`
}

/** @deprecated Use routes.Home */
export const legacyDashboardPath = '/dashboard'

export function buildReviewSubmissionPath(
  userWalletAddress: string,
  submissionId: string,
) {
  return `/submissions/review/${encodeURIComponent(userWalletAddress)}/${encodeURIComponent(submissionId)}`
}

export function buildSitePath(siteId: string) {
  return `${routes.Sites}/${encodeURIComponent(siteId)}`
}

/** Opens the Site Check wizard on an existing draft. */
export function buildEditSitePath(siteId: string) {
  return `${routes.NewSite}?siteId=${encodeURIComponent(siteId)}`
}

export function buildSiteReviewPath(siteId: string) {
  return `${routes.SitesReview}/${encodeURIComponent(siteId)}`
}

/**
 * Hub routes used for dynamic title / shell parity (bottom nav shows on all routes except `/auth`).
 */
export const bottomNavVisiblePaths: readonly string[] = [
  routes.Home,
  routes.Profile,
  routes.Earn,
  routes.Inbox,
  routes.Tutorial,
  routes.TutorialVerify,
  routes.Leaderboard,
  routes.LeaderboardFunded,
  routes.Stake,
  routes.MySubmissions,
]

/** @deprecated Use bottomNavVisiblePaths — kept for hooks / naming parity */
export const tabShellPaths: string[] = [...bottomNavVisiblePaths]

/** Bottom dock visible on every authenticated area except the login screen. */
export function shouldShowBottomNav(pathname: string | null): boolean {
  if (!pathname) return false
  return pathname !== routes.Login
}

const dynamicTitleRoutesMap: Record<string, string> = {
  [routes.NewPlant]: 'Plant new trees',
  [routes.Stake]: 'Stake TGN',
  [routes.MySubmissions]: 'My submissions',
  [routes.Profile]: 'Profile',
  [routes.Earn]: 'Earn',
  [routes.Inbox]: 'Inbox',
  [routes.SubmissionsReview]: 'Review submissions',
  [routes.ReviewSubmission]: 'Review submission',
  [routes.SubmissionDetail]: 'Submission',
  [routes.RejectionFeedback]: 'Feedback',
  [routes.HealthChecks]: 'Health checks',
  '/submissions/[id]/health-checks': 'Health checks',
  '/submissions/[id]/health-checks/create': 'New health check',
  '/health-checks/[healthCheckId]': 'Health check',
  '/submissions/review/health-checks/[healthCheckId]': 'Review health check',
  [routes.PublicProfile]: 'Profile',
  [routes.Sites]: 'My sites',
  [routes.NewSite]: 'Check a site',
  [routes.SitesReview]: 'Review sites',
  '/sites/[id]': 'Site Check',
  '/sites/review/[id]': 'Review site',
}

const dynamicTitleRoutes = Object.keys(dynamicTitleRoutesMap)

export const appConfig = {
  routes,
  tabShellPaths,
  dynamicTitleRoutes,
  dynamicTitleRoutesMap,
}
