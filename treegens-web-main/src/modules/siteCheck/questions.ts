/**
 * Site Check questionnaire copy: every question, help text, answer label and
 * photo slot a planter reads. Keep all of it here so a language branch can
 * translate this one file. Answer values must match siteVerdict.ts (the
 * `satisfies` checks below fail the build if they drift).
 *
 * Help texts follow the IUCN "Pause before you Plant" guidance and the SPREP
 * mangrove monitoring manual (impact codes, tide marks on trunks).
 */
import type { SitePhotoKind } from '@/types'
import type { SiteAnswers } from './siteVerdict'

type AnswerValue<K extends keyof SiteAnswers> =
  NonNullable<SiteAnswers[K]> extends (infer E)[]
    ? E
    : NonNullable<SiteAnswers[K]>

type QuestionFor<K extends keyof SiteAnswers> = {
  key: K
  section: keyof typeof QUESTION_SECTIONS
  kind: 'choice' | 'multi' | 'yesno' | 'scale' | 'number' | 'text'
  title: string
  help: string
  options?: readonly { value: AnswerValue<K>; label: string }[]
  min?: number
  max?: number
  unit?: string
  placeholder?: string
}

type AnyQuestion = {
  [K in keyof SiteAnswers]-?: QuestionFor<K>
}[keyof SiteAnswers]

export const QUESTION_SECTIONS = {
  history: 'Before and now',
  water: 'Tide and water',
  ground: 'Ground and shore',
  nearby: 'Nearby mangroves',
  notes: 'Anything else',
} as const

export const SITE_QUESTIONS = [
  {
    key: 'previousUse',
    section: 'history',
    kind: 'choice',
    title: 'What was here before?',
    help: 'Ask older people in the village if you are not sure. Places that had mangroves before are the best places to plant.',
    options: [
      { value: 'mangrove_cut', label: 'Mangroves, now cut' },
      { value: 'pond_or_salt_pan', label: 'Fish pond or salt pan' },
      { value: 'farm_or_built', label: 'Farm, road or houses' },
      { value: 'never_mangrove', label: 'Never mangroves' },
      { value: 'unknown', label: 'I do not know' },
    ],
  },
  {
    key: 'currentCover',
    section: 'history',
    kind: 'choice',
    title: 'What covers the ground now?',
    help: 'Look at the whole site at low tide.',
    options: [
      { value: 'bare_mud', label: 'Bare mud' },
      { value: 'sand', label: 'Sand' },
      { value: 'seagrass', label: 'Seagrass' },
      { value: 'grass_or_shrub', label: 'Grass or bushes' },
      { value: 'degraded_mangrove', label: 'Damaged mangroves' },
      { value: 'healthy_mangrove', label: 'Healthy mangrove forest' },
      { value: 'rock_or_coral', label: 'Rock or coral' },
    ],
  },
  {
    key: 'lossCauses',
    section: 'history',
    kind: 'multi',
    title: 'Why were mangroves lost here?',
    help: 'Choose all that apply. Skip this if mangroves never grew here.',
    options: [
      { value: 'cutting', label: 'Cutting trees' },
      { value: 'bark_stripping', label: 'Bark stripping' },
      { value: 'infrastructure', label: 'Building or dumping' },
      { value: 'blocked_flow', label: 'Tide flow blocked' },
      { value: 'erosion', label: 'Erosion' },
      { value: 'mining', label: 'Sand or mud mining' },
      { value: 'pollution', label: 'Pollution or rubbish' },
      { value: 'grazing', label: 'Animals grazing or digging' },
      { value: 'storm', label: 'Storm damage' },
      { value: 'unknown', label: 'Not known' },
    ],
  },
  {
    key: 'causeStillActive',
    section: 'history',
    kind: 'choice',
    title: 'Is this still happening?',
    help: 'New trees die the same way if the cause has not stopped.',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'partly', label: 'Partly' },
      { value: 'no', label: 'No, it stopped' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    key: 'tideReach',
    section: 'water',
    kind: 'choice',
    title: 'How often does the tide cover this spot?',
    help: 'Mangroves grow between the middle and the top of the tide. They need to dry out between tides.',
    options: [
      { value: 'daily', label: 'Every day' },
      { value: 'spring_tides_only', label: 'Only the biggest tides' },
      { value: 'never', label: 'Never' },
      { value: 'always_underwater', label: 'Always under water' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    key: 'depthVsReference',
    section: 'water',
    kind: 'choice',
    title: 'At high tide, how deep is the water here?',
    help: 'Compare with the nearest wild mangroves. Stand in them at high tide and see where the water reaches on your legs. Then do the same here.',
    options: [
      { value: 'similar', label: 'About the same' },
      { value: 'shallower', label: 'Less deep here' },
      { value: 'much_deeper', label: 'Much deeper here' },
      { value: 'no_reference', label: 'No mangroves nearby' },
      { value: 'not_measured', label: 'Not checked' },
    ],
  },
  {
    key: 'tideMarkCm',
    section: 'water',
    kind: 'number',
    title: 'How high is the tide mark? (cm)',
    help: 'Look at nearby mangrove trunks: the mud line where the bark changes colour shows high water. Measure its height above the mud.',
    min: 0,
    max: 500,
    unit: 'cm',
    placeholder: 'e.g. 40',
  },
  {
    key: 'flowBlocked',
    section: 'water',
    kind: 'choice',
    title: 'Does anything stop the tide flowing in and out?',
    help: 'Walk the creeks and edges. Look for pond walls, dykes, roads or blocked channels.',
    options: [
      { value: 'no', label: 'No' },
      { value: 'yes_fixed', label: 'Yes, but it is open now' },
      { value: 'yes_not_fixed', label: 'Yes, still blocked' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    key: 'substrate',
    section: 'ground',
    kind: 'choice',
    title: 'What is the ground like?',
    help: 'Push a stick or your finger into the ground.',
    options: [
      { value: 'soft_mud', label: 'Soft mud' },
      { value: 'sandy_mud', label: 'Sandy mud' },
      { value: 'sand', label: 'Sand' },
      { value: 'rock_or_rubble', label: 'Rock or stones' },
      { value: 'salt_crust', label: 'White salt crust' },
    ],
  },
  {
    key: 'shoreExposure',
    section: 'ground',
    kind: 'choice',
    title: 'Is the water calm or rough?',
    help: 'Mangroves need calm water. Strong waves wash seedlings away.',
    options: [
      { value: 'sheltered', label: 'Calm, sheltered' },
      { value: 'exposed', label: 'Strong waves' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    key: 'erosionScarps',
    section: 'ground',
    kind: 'yesno',
    title: 'Do you see small mud cliffs at the edge?',
    help: 'Little steps or cliffs in the mud mean the ground is being washed away.',
    options: [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ],
  },
  {
    key: 'naturalRecruitment',
    section: 'nearby',
    kind: 'choice',
    title: 'Are young wild mangroves growing here?',
    help: 'Look for small seedlings that nobody planted. If many are coming, nature is already replanting.',
    options: [
      { value: 'many', label: 'Many' },
      { value: 'few', label: 'A few' },
      { value: 'none', label: 'None' },
      { value: 'unsure', label: 'Not sure' },
    ],
  },
  {
    key: 'nearestMangroves',
    section: 'nearby',
    kind: 'choice',
    title: 'How far are the nearest wild mangroves?',
    help: 'Wild mangroves nearby bring seeds and show what grows here.',
    options: [
      { value: 'within_100m', label: 'Less than 100 m' },
      { value: 'within_1km', label: 'Less than 1 km' },
      { value: 'over_1km', label: 'More than 1 km' },
      { value: 'none_known', label: 'None that I know' },
    ],
  },
  {
    key: 'nearbyCanopyImpact',
    section: 'nearby',
    kind: 'scale',
    title: 'How damaged are the nearest mangroves?',
    help: 'Stand in the nearest mangroves and look up at the trees. 0 means an even canopy with no gaps. 5 means cleared to bare mud.',
    options: [
      { value: 0, label: '0: Even canopy, no gaps' },
      { value: 1, label: '1: Some gaps' },
      { value: 2, label: '2: Broken canopy, some trees cut' },
      { value: 3, label: '3: Uneven, bare mud showing' },
      { value: 4, label: '4: Only a few trees left' },
      { value: 5, label: '5: Cleared to bare mud' },
    ],
  },
  {
    key: 'notes',
    section: 'notes',
    kind: 'text',
    title: 'Anything else verifiers should know?',
    help: 'For example: who owns the land, or what changed since the trees were lost.',
    max: 1000,
    placeholder: 'Write a short note (optional)',
  },
] as const satisfies readonly AnyQuestion[]

export type SiteQuestion = AnyQuestion

export const QUESTIONNAIRE_TEXT = {
  required: 'Required',
  optional: 'Optional',
  chooseAll: 'Choose all that apply',
  progress: (done: number, total: number) =>
    `${done} of ${total} required answers done`,
  previewTitle: 'What your answers say so far',
  previewNote:
    'This is only a preview. The satellite check runs after you send the site.',
} as const

export const PHOTO_SLOTS = [
  {
    kind: 'low_tide_360',
    required: true,
    title: 'Slow 360 at low tide',
    help: 'At low tide, stand in the middle of the site. Turn slowly and take a wide photo (panorama) all the way around.',
  },
  {
    kind: 'ground',
    required: true,
    title: 'Close-up of the ground',
    help: 'Point the camera down at the ground by your feet. Show the mud or sand, roots and any seedlings.',
  },
  {
    kind: 'tide_mark',
    required: false,
    title: 'Tide line on a nearby trunk, with a stick for scale',
    help: 'Find the mud line on a mangrove trunk. Hold a stick with marks next to it.',
  },
  {
    kind: 'high_tide',
    required: false,
    title: 'Same spot at high tide',
    help: 'Come back at high tide and take a photo from the same place. It shows how deep the water gets.',
  },
] as const satisfies readonly {
  kind: SitePhotoKind
  required: boolean
  title: string
  help: string
}[]

export const PHOTO_TEXT = {
  notSavedOffline:
    'Photos stay in this screen only. They are not saved on the phone if you close the app, so take them when you are ready to send.',
  add: 'Take photo',
  replace: 'Replace',
  remove: 'Remove photo',
  none: 'No photo',
} as const
