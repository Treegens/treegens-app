/**
 * The four planting rules, and the wild-seedling check, in the four tutorial
 * languages.
 *
 * Jimi 2026-10-14: make it super clear to mangrove planters that they
 *   1. must plant within 2 metres MAXIMUM of a living mangrove tree of the
 *      same species;
 *   2. can only plant beside the same tree species. Each propagule goes beside
 *      a living tree of its own species. One planting MAY include several
 *      species, as long as each one goes beside its own kind;
 *   3. should be able to learn the mangrove tree species (tell them apart in
 *      the field);
 *   4. must look for signs of natural regeneration (wild mangrove seedlings
 *      coming up by themselves) before planting.
 * For "lots of seedlings" Jimi chose NO blocking and NO flagging: only clear
 * advice (protect them, plant only in bare gaps, never plant on top of them,
 * never pull them up), and the planter must answer that they looked.
 *
 * Where each one is shown: the tutorial (read once, has a Skip button), the
 * create screen's land step (before the trip, with the seedling question the
 * planter must answer) and its plant step (above the record area, with the
 * confirm that Submit needs), and create/[id]. Keep the rules in this order:
 * the 2 m rule is first because it is the one verifiers check on every
 * planting (ApproveSubmissionModal "Planted within 2m of the same tree
 * species"). If that number ever changes, change it here and there together.
 *
 * Sources. The 2 m figure is Treegens' own rule; it is NOT in the CBEMR
 * source pack, so the copy never says a study set it. What the pack does
 * support is the reason: each species grows best at its own height in the
 * tide (Ellison et al. 2012, Manual for Mangrove Monitoring in the Pacific
 * Islands Region, p. 5), and the IUCN line quoted below (IUCN Mangrove
 * Specialist Group, Pause before you Plant, Oct 2020).
 *
 * The IUCN quote stays in English in every language, word for word. It is a
 * quotation with a name on it: a translation nobody on the team can check
 * would put words in the IUCN's mouth. Each language instead carries its own
 * plain line saying what the quote means (`quoteMeaning`), and the line that
 * introduces it is translated.
 *
 * The Aug 16 2026 natural-vegetation rule (siteCheck in plantTutorialCopy.tsx,
 * src/config/plantingRules.ts, the amber land-step block on the create
 * screen) is untouched and comes first: "if no mangroves grow naturally at
 * that spot, you cannot plant there". These four apply at a site that passed.
 *
 * Copy rules (a planter reads this on a cheap phone, in the mud, often in a
 * second language): short sentences, one idea each; no em or en dashes; no
 * reward, approval or token words; no ASCII apostrophes (prettier would turn
 * the quotes around them, and Oromo's hudhaa is U+2019 anyway); distances as
 * "2 m".
 *
 * ⚠️ The Swahili, Amharic and Oromo lines below were written for this change
 * and have not been read by a native speaker yet.
 *
 * Import-free at run time (type-only imports) so a `node --test
 * --experimental-strip-types` script can load it.
 */
import type { TutorialLang } from './plantTutorialCopy'

/** The planter's answer to "did you look for wild seedlings here?". */
export type SeedlingAnswer = 'none' | 'few' | 'many'

/** Display order of the answers. */
export const seedlingAnswers: readonly SeedlingAnswer[] = [
  'none',
  'few',
  'many',
] as const

export interface PlantingRule {
  title: string
  body: string
  /**
   * The rule in its fewest words, for the create screens: they are for doing,
   * not reading, and a planter films several plantings a day. Made only of
   * sentences that are already in `body` (so no new wording to check), and
   * `body` is one tap away under `fullRulesLabel`. The tutorial shows `body`.
   */
  short: string
}

export interface PlantingRulesText {
  /** Small label above the card title. */
  label: string
  title: string
  intro: string
  /** Jimi's four rules, in his order. The 2 m rule is first. */
  rules: [PlantingRule, PlantingRule, PlantingRule, PlantingRule]
  /** The label on the drawing's arrow. */
  diagramMax: string
  /** Says what the drawing shows, under it (and for screen readers). */
  diagramCaption: string
  /** Create screens: opens the rules in full (each rule's `body`). */
  fullRulesLabel: string
  whyLabel: string
  why: string
  quoteIntro: string
  /** English in every language: see the file comment. */
  quote: string
  quoteSource: string
  /** What the quote means, in this language. */
  quoteMeaning: string
  /** Name of the language picker on the create screen. */
  languageLabel: string
  /** Land step: the rules are confirmed later, after planting. */
  landNote: string
  /** Plant step: the one tap Submit needs. */
  confirmButton: string
  confirmed: string
  /**
   * Under the confirm until it is tapped. It names mangrove plantings: the
   * card shows before the mangrove question is answered, and Submit waits
   * for the confirm on mangroves only.
   */
  confirmNeeded: string
  /** Shown when Submit is tapped (or is waiting) without the confirm. */
  confirmMissing: string
  /** Plant step, when the land answer was "A few" or "Many". */
  seedlingReminder: string
  /** The species guide while its species list is still empty. */
  guideEmpty: string
}

export interface SeedlingCheckText {
  label: string
  question: string
  /** What a wild seedling is. */
  help: string
  /** What they look like. */
  signs: [string, string]
  /**
   * Each starts with "Yes": the question asks whether they looked, and Jimi
   * asked that the planter answer that they did. The rest says what they saw.
   */
  answers: Record<SeedlingAnswer, string>
  adviceLabel: string
  /** For "A few" and "Many". The same advice: Jimi asked for no flagging. */
  advice: [string, string, string, string]
  /** For "None here". */
  none: string
  film: string
  /** Shown when the land Submit is tapped (or is waiting) without an answer. */
  required: string
}

/** IUCN Mangrove Specialist Group, Pause before you Plant (Oct 2020), verbatim. */
const IUCN_QUOTE =
  'planting mangroves is not bad per se, but planting the wrong species in the wrong place is.'
const IUCN_SOURCE =
  'IUCN Mangrove Specialist Group, Pause before you Plant, 2020'

export const plantingRules: Record<TutorialLang, PlantingRulesText> = {
  English: {
    label: 'Planting rules',
    title: 'Plant beside the same species',
    intro: 'Follow these four rules every time you plant mangroves.',
    rules: [
      {
        title: 'Within 2 m of the same species',
        body: 'Plant every propagule within 2 m of a living mangrove tree of the same species. 2 m is the maximum. Never plant more than 2 m away.',
        short:
          'Plant every propagule within 2 m of a living mangrove tree of the same species. Never plant more than 2 m away.',
      },
      {
        title: 'Only beside its own kind',
        body: 'Plant each species only beside living trees of that species. A Rhizophora propagule goes beside a Rhizophora tree, never beside an Avicennia. One planting may have more than one species. Each one goes beside its own kind.',
        short:
          'Plant each species only beside living trees of that species. One planting may have more than one species.',
      },
      {
        title: 'Know the species',
        body: 'Learn to tell the species apart by their roots, leaves and propagules. If you are not sure which tree it is, do not plant beside it. Use the species guide below.',
        short:
          'If you are not sure which tree it is, do not plant beside it. Use the species guide below.',
      },
      {
        title: 'Look for wild seedlings first',
        body: 'Look under and around the trees for young mangroves that came up by themselves. If you see them, protect them. Plant only in the bare gaps. Never plant on top of them. Never pull them up.',
        short:
          'Look under and around the trees for young mangroves that came up by themselves. If you see them, protect them. Plant only in the bare gaps.',
      },
    ],
    diagramMax: 'Max 2 m',
    diagramCaption:
      'A new propagule beside a living tree of the same species. 2 m away at most.',
    fullRulesLabel: 'Read the rules in full',
    whyLabel: 'Why these rules?',
    why: 'Each species grows best at its own height in the tide. A living tree of the same species is a good sign that the spot suits it.',
    quoteIntro: 'Mangrove experts warn:',
    quote: IUCN_QUOTE,
    quoteSource: IUCN_SOURCE,
    quoteMeaning: 'So plant the right species in the right place.',
    languageLabel: 'Language',
    landNote: 'After you plant, you will confirm these rules on the next step.',
    confirmButton: 'I planted by these rules',
    confirmed: 'Rules confirmed',
    confirmNeeded:
      'Tap this after you plant. Mangrove plantings need it to submit.',
    confirmMissing: 'Confirm the planting rules above before you submit.',
    seedlingReminder:
      'You saw wild seedlings here. Plant only in the bare gaps between them.',
    guideEmpty:
      'The species list is not ready yet. If you are not sure which tree it is, do not plant beside it.',
  },
  Swahili: {
    label: 'Kanuni za kupanda',
    title: 'Panda kando ya aina ile ile',
    intro: 'Fuata kanuni hizi nne kila unapopanda mikoko.',
    rules: [
      {
        title: 'Ndani ya 2 m ya aina ile ile',
        body: 'Panda kila mbegu ndani ya 2 m kutoka kwa mti hai wa aina ile ile. 2 m ndio umbali mkubwa zaidi. Usipande kamwe mbali zaidi ya 2 m.',
        short:
          'Panda kila mbegu ndani ya 2 m kutoka kwa mti hai wa aina ile ile. Usipande kamwe mbali zaidi ya 2 m.',
      },
      {
        title: 'Kando ya aina yake tu',
        body: 'Panda kila aina kando ya miti hai ya aina hiyo tu. Mbegu ya Rhizophora huenda kando ya mti wa Rhizophora. Haiendi kamwe kando ya Avicennia. Katika upandaji mmoja unaweza kupanda zaidi ya aina moja. Kila moja huenda kando ya aina yake.',
        short:
          'Panda kila aina kando ya miti hai ya aina hiyo tu. Katika upandaji mmoja unaweza kupanda zaidi ya aina moja.',
      },
      {
        title: 'Zijue aina za mikoko',
        body: 'Jifunze kutofautisha aina kwa mizizi, majani na mbegu zake. Ikiwa huna uhakika ni mti gani, usipande kando yake. Tumia mwongozo wa aina hapa chini.',
        short:
          'Ikiwa huna uhakika ni mti gani, usipande kando yake. Tumia mwongozo wa aina hapa chini.',
      },
      {
        title: 'Tafuta miche ya asili kwanza',
        body: 'Angalia chini na karibu na miti. Tafuta mikoko michanga iliyoota yenyewe. Ukiiona, ilinde. Panda tu kwenye nafasi tupu. Usipande juu yake kamwe. Usiing’oe kamwe.',
        short:
          'Tafuta mikoko michanga iliyoota yenyewe. Ukiiona, ilinde. Panda tu kwenye nafasi tupu.',
      },
    ],
    diagramMax: 'Hadi 2 m',
    diagramCaption:
      'Mbegu mpya kando ya mti hai wa aina ile ile. Umbali usiozidi 2 m.',
    fullRulesLabel: 'Soma kanuni kamili',
    whyLabel: 'Kwa nini kanuni hizi?',
    why: 'Kila aina hukua vizuri zaidi kwenye kimo chake kati ya maji kupwa na maji kujaa. Mti hai wa aina ile ile ni ishara nzuri kwamba mahali hapo panaifaa.',
    quoteIntro: 'Wataalamu wa mikoko wanaonya:',
    quote: IUCN_QUOTE,
    quoteSource: IUCN_SOURCE,
    quoteMeaning:
      'Maana yake: kupanda mikoko si vibaya. Kosa ni kupanda aina isiyofaa mahali pasipofaa.',
    languageLabel: 'Lugha',
    landNote:
      'Baada ya kupanda, utathibitisha kanuni hizi kwenye hatua inayofuata.',
    confirmButton: 'Nimepanda kwa kanuni hizi',
    confirmed: 'Kanuni zimethibitishwa',
    confirmNeeded:
      'Bonyeza hapa baada ya kupanda. Upandaji wa mikoko unahitaji hii ili kutuma.',
    confirmMissing: 'Thibitisha kanuni za kupanda hapo juu kabla ya kutuma.',
    seedlingReminder:
      'Uliona miche ya asili hapa. Panda tu kwenye nafasi tupu kati yake.',
    guideEmpty:
      'Orodha ya aina bado haijawa tayari. Ikiwa huna uhakika ni mti gani, usipande kando yake.',
  },
  Amharic: {
    label: 'የመትከል ደንቦች',
    title: 'ከተመሳሳይ ዝርያ አጠገብ ይትከሉ',
    intro: 'ማንግሩቭ በተከሉ ቁጥር እነዚህን አራት ደንቦች ይከተሉ።',
    rules: [
      {
        title: 'ከተመሳሳይ ዝርያ በ 2 m ውስጥ',
        body: 'እያንዳንዱን ፕሮፓጉል ከተመሳሳይ ዝርያ ሕያው የማንግሩቭ ዛፍ በ 2 m ውስጥ ይትከሉ። 2 m ከፍተኛው ርቀት ነው። ከ 2 m በላይ ርቀው በፍጹም አይትከሉ።',
        short:
          'እያንዳንዱን ፕሮፓጉል ከተመሳሳይ ዝርያ ሕያው የማንግሩቭ ዛፍ በ 2 m ውስጥ ይትከሉ። ከ 2 m በላይ ርቀው በፍጹም አይትከሉ።',
      },
      {
        title: 'ከራሱ ዝርያ አጠገብ ብቻ',
        body: 'እያንዳንዱን ዝርያ ከዚያው ዝርያ ሕያው ዛፎች አጠገብ ብቻ ይትከሉ። የ Rhizophora ፕሮፓጉል ከ Rhizophora ዛፍ አጠገብ ይተከላል። ከ Avicennia አጠገብ በፍጹም አይተከልም። በአንድ ተከላ ውስጥ ከአንድ በላይ ዝርያ መትከል ይችላሉ። እያንዳንዱ ከራሱ ዝርያ አጠገብ ይተከላል።',
        short:
          'እያንዳንዱን ዝርያ ከዚያው ዝርያ ሕያው ዛፎች አጠገብ ብቻ ይትከሉ። በአንድ ተከላ ውስጥ ከአንድ በላይ ዝርያ መትከል ይችላሉ።',
      },
      {
        title: 'ዝርያዎቹን ይወቁ',
        body: 'ዝርያዎቹን በሥሮቻቸው፣ በቅጠሎቻቸው እና በፕሮፓጉሎቻቸው መለየት ይማሩ። የትኛው ዛፍ እንደሆነ እርግጠኛ ካልሆኑ አጠገቡ አይትከሉ። ከታች ያለውን የዝርያዎች መመሪያ ይጠቀሙ።',
        short:
          'የትኛው ዛፍ እንደሆነ እርግጠኛ ካልሆኑ አጠገቡ አይትከሉ። ከታች ያለውን የዝርያዎች መመሪያ ይጠቀሙ።',
      },
      {
        title: 'መጀመሪያ የዱር ችግኞችን ይፈልጉ',
        body: 'በዛፎቹ ሥር እና ዙሪያ ይመልከቱ። በራሳቸው የበቀሉ ወጣት ማንግሩቮችን ይፈልጉ። ካዩዋቸው ይጠብቋቸው። ባዶ ክፍተቶች ላይ ብቻ ይትከሉ። በላያቸው ላይ በፍጹም አይትከሉ። በፍጹም አይንቀሏቸው።',
        short:
          'በራሳቸው የበቀሉ ወጣት ማንግሩቮችን ይፈልጉ። ካዩዋቸው ይጠብቋቸው። ባዶ ክፍተቶች ላይ ብቻ ይትከሉ።',
      },
    ],
    diagramMax: 'ቢበዛ 2 m',
    diagramCaption: 'አዲስ ፕሮፓጉል ከተመሳሳይ ዝርያ ሕያው ዛፍ አጠገብ። ርቀቱ ቢበዛ 2 m ነው።',
    fullRulesLabel: 'ደንቦቹን ሙሉ በሙሉ ያንብቡ',
    whyLabel: 'እነዚህ ደንቦች ለምን?',
    why: 'እያንዳንዱ ዝርያ ለራሱ በሚስማማ የባሕር ውሃ ከፍታ ላይ በደንብ ያድጋል። ተመሳሳይ ዝርያ ያለው ሕያው ዛፍ ቦታው እንደሚስማማው ጥሩ ምልክት ነው።',
    quoteIntro: 'የማንግሩቭ ባለሙያዎች ያስጠነቅቃሉ፦',
    quote: IUCN_QUOTE,
    quoteSource: IUCN_SOURCE,
    quoteMeaning:
      'ትርጉሙ፦ ማንግሩቭ መትከል መጥፎ አይደለም። ስህተቱ የተሳሳተ ዝርያን በተሳሳተ ቦታ መትከል ነው።',
    languageLabel: 'ቋንቋ',
    landNote: 'ከተከሉ በኋላ በሚቀጥለው ደረጃ እነዚህን ደንቦች ያረጋግጣሉ።',
    confirmButton: 'በእነዚህ ደንቦች ተክያለሁ',
    confirmed: 'ደንቦቹ ተረጋግጠዋል',
    confirmNeeded: 'ከተከሉ በኋላ ይህን ይንኩ። የማንግሩቭ ተከላ ለማስገባት ይህ ያስፈልገዋል።',
    confirmMissing: 'ከማስገባትዎ በፊት ከላይ ያሉትን የመትከል ደንቦች ያረጋግጡ።',
    seedlingReminder: 'እዚህ የዱር ችግኞችን አይተዋል። በመካከላቸው ባሉ ባዶ ክፍተቶች ላይ ብቻ ይትከሉ።',
    guideEmpty: 'የዝርያዎቹ ዝርዝር ገና አልተዘጋጀም። የትኛው ዛፍ እንደሆነ እርግጠኛ ካልሆኑ አጠገቡ አይትከሉ።',
  },
  Oromo: {
    label: 'Seerota dhaabbii',
    title: 'Gosa isaa cina dhaabi',
    intro: 'Yeroo mangroovii dhaabdu hunda seerota afran kana hordofi.',
    rules: [
      {
        title: 'Gosa isaa irraa 2 m keessatti',
        body: 'Biqiltuu hunda muka mangroovii gosa isaa kan lubbuun jiru irraa 2 m keessatti dhaabi. 2 m fageenya olaanaa dha. Kana caalaa fagaattee gonkumaa hin dhaabin.',
        short:
          'Biqiltuu hunda muka mangroovii gosa isaa kan lubbuun jiru irraa 2 m keessatti dhaabi. 2 m fageenya olaanaa dha.',
      },
      {
        title: 'Gosa ofii isaa cina qofa',
        body: 'Gosa hunda mukoota lubbuun jiran kan gosa sanaa cina qofa dhaabi. Biqiltuun Rhizophora muka Rhizophora cina dhaabama. Gonkumaa Avicennia cina hin dhaabamu. Dhaabbii tokko keessatti gosa tokkoo ol dhaabuu dandeessa. Tokkoon tokkoon isaanii gosa ofii isaanii cina dhaabamu.',
        short:
          'Gosa hunda mukoota lubbuun jiran kan gosa sanaa cina qofa dhaabi. Dhaabbii tokko keessatti gosa tokkoo ol dhaabuu dandeessa.',
      },
      {
        title: 'Gosoota beeki',
        body: 'Gosoota hidda, baala fi biqiltuu isaaniitiin addaan baasuu baradhu. Yoo muka kam akka ta’e mirkanaa’uu baatte, cina isaa hin dhaabin. Qajeelfama gosootaa armaan gadii fayyadami.',
        short:
          'Yoo muka kam akka ta’e mirkanaa’uu baatte, cina isaa hin dhaabin. Qajeelfama gosootaa armaan gadii fayyadami.',
      },
      {
        title: 'Dura biqiltuu ofumaan biqile barbaadi',
        body: 'Mukoota jalaa fi naannoo isaanii ilaali. Mangroovii xixiqqoo ofumaan biqilan barbaadi. Yoo argite, eegi. Bakka duwwaa qofatti dhaabi. Gonkumaa isaan irratti hin dhaabin. Gonkumaa hin buqqisin.',
        short:
          'Mangroovii xixiqqoo ofumaan biqilan barbaadi. Yoo argite, eegi. Bakka duwwaa qofatti dhaabi.',
      },
    ],
    diagramMax: 'Hanga 2 m',
    diagramCaption:
      'Biqiltuu haaraa muka gosa isaa kan lubbuun jiru cina. Fageenyi isaa hanga 2 m qofa.',
    fullRulesLabel: 'Seerota guutuu dubbisi',
    whyLabel: 'Seerota kana maaliif?',
    why: 'Gosti hundi olka’iinsa bishaan galaanaa ofii isaa irratti caalaatti guddata. Mukni gosa isaa kan lubbuun jiru, iddoon sun isaaf akka mijatu mallattoo gaarii dha.',
    quoteIntro: 'Ogeeyyiin mangroovii akkas jedhanii akeekkachiisu:',
    quote: IUCN_QUOTE,
    quoteSource: IUCN_SOURCE,
    quoteMeaning:
      'Hiikni isaa: mangroovii dhaabuun hamaa miti. Dogoggorri gosa hin taane iddoo hin taanetti dhaabuu dha.',
    languageLabel: 'Afaan',
    landNote:
      'Erga dhaabdee booda, tarkaanfii itti aanu irratti seerota kana ni mirkaneessita.',
    confirmButton: 'Seerota kanaan dhaabeera',
    confirmed: 'Seeronni mirkanaa’aniiru',
    confirmNeeded:
      'Erga dhaabdee booda kana tuqi. Dhaabbiin mangroovii erguuf kana barbaada.',
    confirmMissing:
      'Utuu hin ergin dura seerota dhaabbii armaan olii mirkaneessi.',
    seedlingReminder:
      'Asitti biqiltuu ofumaan biqile argiteetta. Bakka duwwaa gidduu isaanii qofatti dhaabi.',
    guideEmpty:
      'Tarreen gosootaa ammallee hin qophoofne. Yoo muka kam akka ta’e mirkanaa’uu baatte, cina isaa hin dhaabin.',
  },
}

/**
 * Asked on the land step, before the trip goes ahead: the land video is the
 * "before" footage, so it is where wild seedlings are filmed. The planter must
 * answer; no answer blocks or flags anything (Jimi 2026-10-14). "A few" and
 * "Many" get the same advice.
 *
 * ⚠️ The Swahili, Amharic and Oromo lines below were written for this change
 * and have not been read by a native speaker yet.
 */
export const seedlingCheck: Record<TutorialLang, SeedlingCheckText> = {
  English: {
    label: 'Before you plant',
    question: 'Did you look for wild mangrove seedlings here?',
    help: 'Wild seedlings are young mangroves that came up by themselves.',
    signs: [
      'They are small mangroves with leaves, under or near the trees.',
      'Some are propagules standing up and rooted in the mud.',
    ],
    answers: { none: 'Yes, none', few: 'Yes, a few', many: 'Yes, many' },
    adviceLabel: 'What to do',
    advice: [
      'Protect them.',
      'Plant only in the bare gaps between them.',
      'Never plant on top of them.',
      'Never pull them up.',
    ],
    none: 'Good. Plant only beside living trees of the same species, within 2 m.',
    film: 'Film the wild seedlings and the trees you will plant beside in this land video.',
    required: 'Answer the wild seedling question above before you submit.',
  },
  Swahili: {
    label: 'Kabla ya kupanda',
    question: 'Je, umetafuta miche ya asili ya mikoko hapa?',
    help: 'Miche ya asili ni mikoko michanga iliyoota yenyewe.',
    signs: [
      'Ni mikoko midogo yenye majani, chini au karibu na miti.',
      'Mingine ni mbegu zilizosimama na zenye mizizi kwenye matope.',
    ],
    answers: {
      none: 'Ndiyo, hakuna',
      few: 'Ndiyo, michache',
      many: 'Ndiyo, mingi',
    },
    adviceLabel: 'Cha kufanya',
    advice: [
      'Ilinde.',
      'Panda tu kwenye nafasi tupu kati yake.',
      'Usipande juu yake kamwe.',
      'Usiing’oe kamwe.',
    ],
    none: 'Vizuri. Panda tu kando ya miti hai ya aina ile ile, ndani ya 2 m.',
    film: 'Rekodi miche ya asili na miti utakayopanda kando yake kwenye video hii ya eneo.',
    required: 'Jibu swali la miche ya asili hapo juu kabla ya kutuma.',
  },
  Amharic: {
    label: 'ከመትከልዎ በፊት',
    question: 'እዚህ የዱር ማንግሩቭ ችግኞችን ፈልገዋል?',
    help: 'የዱር ችግኞች በራሳቸው የበቀሉ ወጣት ማንግሩቮች ናቸው።',
    signs: [
      'ቅጠል ያላቸው ትናንሽ ማንግሩቮች ናቸው። በዛፎቹ ሥር ወይም አጠገብ ይበቅላሉ።',
      'አንዳንዶቹ ቀጥ ብለው የቆሙ እና በጭቃው ውስጥ ሥር የሰደዱ ፕሮፓጉሎች ናቸው።',
    ],
    answers: { none: 'አዎ፣ የለም', few: 'አዎ፣ ጥቂት', many: 'አዎ፣ ብዙ' },
    adviceLabel: 'ምን ማድረግ አለብዎት',
    advice: [
      'ይጠብቋቸው።',
      'በመካከላቸው ባሉ ባዶ ክፍተቶች ላይ ብቻ ይትከሉ።',
      'በላያቸው ላይ በፍጹም አይትከሉ።',
      'በፍጹም አይንቀሏቸው።',
    ],
    none: 'ጥሩ። ከተመሳሳይ ዝርያ ሕያው ዛፎች አጠገብ ብቻ፣ በ 2 m ውስጥ ይትከሉ።',
    film: 'የዱር ችግኞቹን እና አጠገባቸው የሚተክሉባቸውን ዛፎች በዚህ የመሬት ቪዲዮ ውስጥ ይቅረጹ።',
    required: 'ከማስገባትዎ በፊት ከላይ ያለውን የዱር ችግኝ ጥያቄ ይመልሱ።',
  },
  Oromo: {
    label: 'Utuu hin dhaabin',
    question: 'Asitti biqiltuu mangroovii ofumaan biqile barbaaddeettaa?',
    help: 'Biqiltuun ofumaan biqile mangroovii xixiqqoo ofumaan biqilan dha.',
    signs: [
      'Mangroovii xixiqqoo baala qaban dha. Mukoota jala ykn cina biqilu.',
      'Gariin isaanii biqiltuu ol dhaabatanii dhoqqee keessatti hidda godhatan dha.',
    ],
    answers: {
      none: 'Eeyyee, hin jiru',
      few: 'Eeyyee, muraasa',
      many: 'Eeyyee, baay’ee',
    },
    adviceLabel: 'Maal gochuu qabda',
    advice: [
      'Eegi.',
      'Bakka duwwaa gidduu isaanii qofatti dhaabi.',
      'Gonkumaa isaan irratti hin dhaabin.',
      'Gonkumaa hin buqqisin.',
    ],
    none: 'Gaarii. Mukoota gosa isaa kan lubbuun jiran cina qofa, 2 m keessatti dhaabi.',
    film: 'Biqiltuu ofumaan biqile fi mukoota cina isaanii dhaabdu viidiyoo lafaa kana keessatti waraabi.',
    required:
      'Utuu hin ergin dura gaaffii biqiltuu ofumaan biqilee armaan olii deebisi.',
  },
}
