/**
 * The mangrove species guide: how a planter tells the trees apart, so the
 * propagule they plant matches the living tree it goes beside.
 *
 * Jimi 2026-10-14 (product decision, the four planter rules in his order):
 *   1. Plant within 2 m MAXIMUM of a living mangrove tree of the same species.
 *   2. Plant only beside the same species. Each propagule goes beside a living
 *      tree of its own species. One planting may hold several species, as long
 *      as each one goes beside its own kind.
 *   3. Learn the mangrove species, so you can tell them apart in the field.
 *   4. Look for wild mangrove seedlings before planting (advice only, never a
 *      block or a flag).
 * This file is rule 3, and it is how a planter keeps rule 2. The rules
 * themselves, and their copy, live in plantingRulesCopy.ts.
 *
 * WHY THE SPECIES MATTERS. The 2 m figure is Treegens' own rule; it is NOT in
 * the CBEMR source pack, so nothing here says the pack gives it. The pack
 * gives the reason: each species prefers "a particular elevation between mean
 * tide and high tide" (Ellison et al. 2012, Manual for Mangrove Monitoring in
 * the Pacific Islands Region, p. 5), and "planting mangroves is not bad per
 * se, but planting the wrong species in the wrong place is." (IUCN Mangrove
 * Specialist Group, Pause before you Plant, 2020).
 *
 * WHICH SPECIES. The nine true mangroves of East Africa (Kenya and Tanzania,
 * where most Treegens planters work), in this order. Ids use the mainnet
 * catalog spelling (treegens-app/treegens-web-main/src/modules/siteCheck/
 * mangroveSpecies.ts), which writes Bruguiera as 'bruguiera_gymnorhiza'. The
 * catalog has no Xylocarpus moluccensis, so its id follows the same pattern.
 *
 * WHERE EACH FACT COMES FROM. Never add a fact and say the pack gave it.
 *   - Leaves, propagules, fruit, flowers and bark: Jean Yong's "Comparative
 *     Guide to Mangroves" chart in the pack, read from its photos (the chart
 *     has no written descriptions). It shows no leaves for Bruguiera
 *     gymnorhiza and no fruit for Lumnitzera racemosa; those two lines, the
 *     Ceriops ridges and the "same green on both sides" of Sonneratia leaves
 *     are general botanical knowledge.
 *   - Roots: the chart shows no roots. All root lines are well-established
 *     general knowledge, not from the pack: Rhizophora stilt roots; Avicennia
 *     thin pencil roots; Sonneratia thicker, taller cone roots; Bruguiera knee
 *     roots; Ceriops small buttresses with knee roots only sometimes;
 *     Xylocarpus granatum and Heritiera snaking plank roots; X. moluccensis
 *     short, stout breathing roots and no plank roots; Lumnitzera racemosa no
 *     roots above the mud.
 *   - Sizes against a hand, a thumb, a fist, an arm or a pencil: general
 *     knowledge. The chart only shows a 15 cm ruler beside some photos.
 *   - Where it grows: typical East African zonation, from the sea to the land.
 *     Zonation varies from place to place, and zones are often mixed (Ellison
 *     et al. record Rhizophora, not Avicennia, as the seaward zone in Tonga,
 *     and many mixed zones in Suva). That is exactly why the rule is "beside a
 *     living tree of the same species" and never "in the right zone": the
 *     nearest living tree is the only proof that this species grows at this
 *     level of the tide.
 *   - "Rare in Kenya" for X. moluccensis: a Kenyan mangrove field guide (only
 *     two trees known in Gazi Bay) and The Star, 2024-06-13 (a rare species).
 *   - Lumnitzera against Ceriops: general botanical knowledge, not the
 *     chart. The chart uses flower colour only to tell Lumnitzera racemosa
 *     (white) from L. littorea (red). Ceriops petals can be white too, so
 *     flower colour is not used against Ceriops. The cues are the leaves
 *     (Ceriops leaves grow in opposite pairs, Lumnitzera leaves one by one)
 *     and the propagule (Ceriops has a long slim one, Lumnitzera none).
 *   - "No long plank roots" in the X. moluccensis tell-apart is its roots
 *     line (general knowledge, above). Its leaflet tips and its rough,
 *     cracked bark are from the chart.
 *
 * LOCAL NAMES (Swahili, shown as written). Checked on 2026-10-14 by web
 * search; the source pages themselves could not be opened from the build
 * machine, so every name below still needs a check by a planter or forester
 * on the Kenyan and Tanzanian coast before it is trusted.
 *   The rule: one species, its own names. A name that sounds like another
 *   species' name is kept only when it is a main name planters use, and that
 *   species' tell-apart then says the two are different trees (Kikandaa
 *   against Mkandaa, Mkomafi dume against Mkomafi). A second, rarer name of
 *   that kind brings the same confusion and no name planters need, so it is
 *   left out.
 *   Kept:
 *   - Mkoko (Rhizophora mucronata), Mkandaa (Ceriops tagal), Mchu (Avicennia
 *     marina), Mlilana (Sonneratia alba), Mkomafi (Xylocarpus granatum),
 *     Muia (Bruguiera gymnorhiza): ICRAF "Useful Trees" Kenya fact sheets.
 *   - Mshinzi (Bruguiera gymnorhiza): PROTA, and the mainnet catalog.
 *   - Kikandaa (Lumnitzera racemosa): ICRAF "Useful Trees" Kenya.
 *   - Msikundazi (Heritiera littoralis): PROTA.
 *   - Mkomafi dume (Xylocarpus moluccensis): The Star, 2024-06-13, on
 *     Wetlands International nurseries in Lamu. One news source only, so this
 *     is the name most in need of a local check.
 *   Left out on purpose:
 *   - Mtonga: ICRAF gives it for Xylocarpus granatum too. Left out until a
 *     local check shows it does not also name X. moluccensis; one name for
 *     two species breaks the match.
 *   - Mkandaa mwitu (Lumnitzera racemosa, ICRAF): a second name for a tree
 *     that already has Kikandaa, and it is Mkandaa, the Ceriops name, with a
 *     word added. A planter could plant Ceriops beside Lumnitzera.
 *   - Mkoko wimbi (Bruguiera, PROTA), and Giriama "Mkoko" for Bruguiera:
 *     Bruguiera already has Muia and Mshinzi, and these are Mkoko, the
 *     Rhizophora name.
 *   - Msindi (Bruguiera, ICRAF), Mtsu (Avicennia, ICRAF), mkokoshi and
 *     mgongongo (Heritiera, PROTA): found in one source each and not
 *     commonly published. Add them back once a local check confirms them.
 *
 * COPY RULES (enforced by tests in this repo): short, plain sentences, one
 * idea each, for a second-language reader on a cheap phone in the mud. No em
 * or en dash. No carbon, CO2, token, wallet or reward words. No contraction
 * with an ASCII apostrophe. Distances as "2 m". Scientific names stay in
 * Latin in every language, and Amharic puts a space between a prefix and a
 * Latin name or a number ("ከ Bruguiera", "በ 2 m"). Oromo writes the hudhaa
 * as U+2019.
 *
 * ⚠️ The Swahili, Amharic and Oromo lines below were written for this change
 * and have not been read by a native speaker yet.
 *
 * CONTRACT (other files code against these exports; keep the names):
 *   - `mangroveSpecies`: the species, in the order the guide shows them.
 *   - `speciesGuideUi`: every other word on the guide, per language.
 *   - `RootKind`: drives the small root drawing next to each species.
 *
 * Import-free at runtime (type-only imports) so a `node --test
 * --experimental-strip-types` script can load it.
 */
import type { TutorialLang } from './plantTutorialCopy'

/** The root shape a planter can see from the mud, the first thing to look at. */
export type RootKind = 'stilt' | 'pencil' | 'knee' | 'plank'

export interface MangroveSpeciesText {
  /** What the roots look like. */
  roots: string
  /** What the leaves look like. */
  leaves: string
  /** What the propagule, fruit or seed looks like. */
  propagule: string
  /** Where in the tide it usually grows. */
  whereItGrows: string
  /** The one cue that tells it from its look-alikes. */
  tellApart: string
}

export interface MangroveSpeciesEntry {
  /** Stable id, same spelling as the mainnet catalog (genus_species). */
  id: string
  scientificName: string
  /** Names planters use locally (e.g. Swahili). Shown as written. */
  localNames: string[]
  roots: RootKind
  /**
   * True when the tree shows no roots above the mud (Lumnitzera racemosa).
   * `roots` is then only the nearest drawing, and the roots text says what
   * the planter really sees. A screen may dim or skip the drawing.
   */
  rootsNotVisible?: boolean
  text: Record<TutorialLang, MangroveSpeciesText>
}

export interface SpeciesGuideUi {
  /** Button that opens the guide. */
  open: string
  title: string
  intro: string
  /** How to use the guide with the 2 m rule: match the tree, then plant. */
  matchTip: string
  rootsLabel: string
  leavesLabel: string
  propaguleLabel: string
  whereLabel: string
  tellApartLabel: string
  /** Label before the local names, e.g. "Local name". */
  localNameLabel: string
  /** Name of each root drawing, read by screen readers. */
  rootKindName: Record<RootKind, string>
  /** Shown at the bottom: what to do when the tree is not in the guide. */
  notListed: string
  close: string
}

export const mangroveSpecies: MangroveSpeciesEntry[] = [
  {
    id: 'rhizophora_mucronata',
    scientificName: 'Rhizophora mucronata',
    localNames: ['Mkoko'],
    roots: 'stilt',
    text: {
      English: {
        roots:
          'Many curved stilt roots arch out from the trunk into the mud. The tree looks like it stands on legs.',
        leaves:
          'Big, broad, oval leaves with a small sharp point at the tip. Look for tiny dark dots underneath.',
        propagule:
          'A very long, thick, green propagule with small bumps. It can grow almost as long as your arm.',
        whereItGrows:
          'Near the open water and along creek banks, in soft mud. The tide covers its roots often.',
        tellApart:
          'It can look like Bruguiera. Only Rhizophora stands on tall arching stilt roots, and its propagule is much longer.',
      },
      Swahili: {
        roots:
          'Mizizi mingi iliyopinda hutoka kwenye shina na kushuka kwenye matope. Mti huonekana kama umesimama kwa miguu.',
        leaves:
          'Majani makubwa, mapana na ya mviringo, yenye ncha ndogo kali. Tafuta vidoti vidogo vyeusi upande wa chini.',
        propagule:
          'Mbegu ndefu sana, nene na ya kijani, yenye vivimbe vidogo. Inaweza kuwa karibu ndefu kama mkono wako.',
        whereItGrows:
          'Karibu na maji ya wazi na kando ya mikondo, kwenye matope laini. Maji ya kujaa hufunika mizizi yake mara kwa mara.',
        tellApart:
          'Unaweza kuuchanganya na Bruguiera. Rhizophora pekee husimama juu ya mizizi mirefu iliyopinda kama nguzo, na mbegu yake ni ndefu zaidi.',
      },
      Amharic: {
        roots:
          'ብዙ የተጣመሙ የምሰሶ ሥሮች ከግንዱ ወጥተው ወደ ጭቃው ይወርዳሉ። ዛፉ በእግሮች ላይ የቆመ ይመስላል።',
        leaves:
          'ትልልቅ፣ ሰፊ እና ሞላላ ቅጠሎች ሲሆኑ ጫፋቸው ትንሽ ሹል ነው። በቅጠሉ ጀርባ ላይ ትናንሽ ጥቁር ነጥቦችን ይፈልጉ።',
        propagule:
          'በጣም ረጅም፣ ወፍራም እና አረንጓዴ ፕሮፓጉል ሲሆን ትናንሽ እብጠቶች አሉት። ርዝመቱ ወደ ክንድዎ ርዝመት ሊጠጋ ይችላል።',
        whereItGrows:
          'ክፍት ውሃ አጠገብ እና በጅረቶች ዳር፣ በለስላሳ ጭቃ ውስጥ ያድጋል። ማዕበሉ ሥሮቹን በተደጋጋሚ ይሸፍናል።',
        tellApart:
          'ከ Bruguiera ጋር ሊምታታ ይችላል። ረጅም በተጣመሙ የምሰሶ ሥሮች ላይ የሚቆመው Rhizophora ብቻ ነው፤ ፕሮፓጉሉም ከ Bruguiera በጣም ይረዝማል።',
      },
      Oromo: {
        roots:
          'Hiddi jallatan baay’een jirma irraa ba’anii gara dhoqqee seenu. Mukni miilla irra kan dhaabate fakkaata.',
        leaves:
          'Baala guddaa, bal’aa fi geengoo kan fiixee isaatti qara xiqqaa qabu. Gama jalaa irratti tuqaalee gurraacha xixiqqaa barbaadi.',
        propagule:
          'Biqiltuu baay’ee dheeraa, furdaa fi magariisa kan dhiita xixiqqaa qabu. Dheerinni isaa gara dheerina irree keetii ga’uu danda’a.',
        whereItGrows:
          'Bishaan banaa bira fi qarqara lagaa irratti, dhoqqee laafaa keessatti. Bishaan galaanaa yeroo baay’ee hidda isaa haguuga.',
        tellApart:
          'Bruguiera waliin wal fakkaachuu danda’a. Rhizophora qofatu hidda utubaa dheeraa jallatu irra dhaabata, biqiltuun isaas kan Bruguiera caalaa baay’ee dheeraa dha.',
      },
    },
  },
  {
    id: 'ceriops_tagal',
    scientificName: 'Ceriops tagal',
    localNames: ['Mkandaa'],
    roots: 'knee',
    text: {
      English: {
        roots:
          'The base of the trunk spreads out in small flat ridges. Small knee roots may stick up from the mud.',
        leaves:
          'Shiny leaves with a round end, widest near the tip. They grow in bunches at the ends of the twigs.',
        propagule:
          'A slim green propagule with fine ridges, a little thicker than a pencil. A pale yellow ring sits just below the small brown fruit.',
        whereItGrows:
          'In the middle of the forest and towards the land, in firmer mud. The tide reaches it less often than Rhizophora.',
        tellApart:
          'It can look like a small Bruguiera. Check the propagule: slim and ridged with a pale ring means Ceriops.',
      },
      Swahili: {
        roots:
          'Chini ya shina kuna mbavu ndogo bapa zinazotanuka. Mizizi midogo ya goti inaweza kujitokeza kutoka kwenye matope.',
        leaves:
          'Majani yenye ncha ya mviringo, mapana zaidi karibu na ncha. Hukua kwa mafungu kwenye ncha za vijiti.',
        propagule:
          'Mbegu nyembamba ya kijani yenye mistari midogo, nene kidogo kuliko penseli. Pete ya njano hafifu iko chini kidogo ya tunda dogo la kahawia.',
        whereItGrows:
          'Katikati ya msitu na kuelekea nchi kavu, kwenye matope magumu zaidi. Maji ya kujaa huifikia mara chache kuliko Rhizophora.',
        tellApart:
          'Inaweza kufanana na Bruguiera ndogo. Angalia mbegu: nyembamba, yenye mistari na pete hafifu ni Ceriops.',
      },
      Amharic: {
        roots:
          'የግንዱ ታች ወደ ትናንሽ ጠፍጣፋ ሸንተረሮች ይዘረጋል። ትናንሽ የጉልበት ሥሮች ከጭቃው ሊወጡ ይችላሉ።',
        leaves:
          'የሚያብረቀርቁ ቅጠሎች ሲሆኑ ጫፋቸው ክብ ነው፤ ከጫፉ አጠገብ ሰፊ ናቸው። በቅርንጫፎቹ ጫፍ ላይ በቡድን ያድጋሉ።',
        propagule:
          'ቀጭን አረንጓዴ ፕሮፓጉል ሲሆን ቀጭን ሸንተረሮች አሉት፤ ከእርሳስ ትንሽ ይወፍራል። ከትንሹ ቡናማ ፍሬ ስር ፈዛዛ ቢጫ ቀለበት አለ።',
        whereItGrows:
          'በደኑ መሃል እና ወደ የብስ አቅጣጫ፣ በጠንካራ ጭቃ ውስጥ ያድጋል። ማዕበሉ ከ Rhizophora ያነሰ ጊዜ ይደርስበታል።',
        tellApart:
          'ትንሽ Bruguiera ሊመስል ይችላል። ፕሮፓጉሉን ይመልከቱ፤ ቀጭን፣ ሸንተረር ያለው እና ፈዛዛ ቀለበት ያለው ከሆነ Ceriops ነው።',
      },
      Oromo: {
        roots:
          'Jalli jirma isaa sarara diriiraa xixiqqaan babal’ata. Hiddi jilbaa xixiqqaan dhoqqee keessaa ba’uu danda’u.',
        leaves:
          'Baala calaqqisu kan fiixee geengoo qabu, fiixee isaa bira bal’aa ta’e. Fiixee damee irratti walitti qabamanii biqilu.',
        propagule:
          'Biqiltuu qal’aa magariisa kan sarara xixiqqaa qabu, irsaasii irra xiqqoo furdaa. Firii bunaa’aa xiqqaa jalatti geengoon keelloo ifaa jira.',
        whereItGrows:
          'Gidduu bosonaa fi gara lafaatti, dhoqqee jabaa keessatti. Bishaan galaanaa Rhizophora caalaa yeroo muraasa isa ga’a.',
        tellApart:
          'Bruguiera xiqqaa fakkaachuu danda’a. Biqiltuu ilaali: qal’aa, sarara qabu fi geengoo keelloo ifaa qabu yoo ta’e Ceriops dha.',
      },
    },
  },
  {
    id: 'bruguiera_gymnorhiza',
    scientificName: 'Bruguiera gymnorhiza',
    localNames: ['Muia', 'Mshinzi'],
    roots: 'knee',
    text: {
      English: {
        roots:
          'Roots come up out of the mud and bend back down, like bent knees. The base of the trunk is wide.',
        leaves: 'Big, shiny, dark green leaves with a pointed tip.',
        propagule:
          'A fat, smooth propagule shaped like a cigar, about as long as your hand. On top sits a red crown with many pointed lobes.',
        whereItGrows:
          'In the middle of the forest and towards the land. It often grows mixed with Rhizophora and Ceriops.',
        tellApart:
          'It can look like Ceriops. Bruguiera has a fat, smooth propagule under a red crown, and bright red flowers.',
      },
      Swahili: {
        roots:
          'Mizizi hutoka juu ya matope na kurudi chini, kama magoti yaliyopinda. Chini ya shina ni pana.',
        leaves:
          'Majani makubwa ya kijani kilichokolea, yenye ncha iliyochongoka.',
        propagule:
          'Mbegu nene na laini yenye umbo la sigara, karibu urefu wa kiganja chako. Juu yake kuna taji jekundu lenye vipande vingi vilivyochongoka.',
        whereItGrows:
          'Katikati ya msitu na kuelekea nchi kavu. Mara nyingi huota pamoja na Rhizophora na Ceriops.',
        tellApart:
          'Inaweza kufanana na Ceriops. Bruguiera ina mbegu nene na laini chini ya taji jekundu, na maua mekundu angavu.',
      },
      Amharic: {
        roots: 'ሥሮቹ ከጭቃው ወጥተው ተመልሰው ይገባሉ፤ እንደ ተጣጠፈ ጉልበት ይመስላሉ። የግንዱ ታች ሰፊ ነው።',
        leaves: 'ትልልቅ፣ የሚያብረቀርቁ እና ጥቁር አረንጓዴ ቅጠሎች ሲሆኑ ጫፋቸው ሹል ነው።',
        propagule:
          'ወፍራም እና ልሙጥ፣ የሲጋራ ቅርጽ ያለው ፕሮፓጉል ሲሆን ርዝመቱ የእጅዎን ያህል ነው። ላዩ ላይ ብዙ ሹል ክፍሎች ያሉት ቀይ ዘውድ አለ።',
        whereItGrows:
          'በደኑ መሃል እና ወደ የብስ አቅጣጫ ያድጋል። ብዙ ጊዜ ከ Rhizophora እና ከ Ceriops ጋር ተቀላቅሎ ያድጋል።',
        tellApart:
          'ከ Ceriops ጋር ሊምታታ ይችላል። Bruguiera ከቀይ ዘውድ ስር ወፍራም ልሙጥ ፕሮፓጉል እና ደማቅ ቀይ አበቦች አሉት።',
      },
      Oromo: {
        roots:
          'Hiddi dhoqqee keessaa ol ba’ee deebi’ee gadi seena, akka jilba dachaafame. Jalli jirma isaa bal’aa dha.',
        leaves:
          'Baala guddaa, calaqqisu fi magariisa dukkana’aa kan fiixee qara qabu.',
        propagule:
          'Biqiltuu furdaa fi sukkuumaa kan sigaaraa fakkaatu, dheerinni isaa gara harka keetii. Gubbaa isaa irra gonfoo diimaa kutaalee qaraa baay’ee qabutu jira.',
        whereItGrows:
          'Gidduu bosonaa fi gara lafaatti. Yeroo baay’ee Rhizophora fi Ceriops waliin walmakee biqila.',
        tellApart:
          'Ceriops waliin wal fakkaachuu danda’a. Bruguiera biqiltuu furdaa sukkuumaa gonfoo diimaa jala jiru, fi daraaraa diimaa ifaa qaba.',
      },
    },
  },
  {
    id: 'avicennia_marina',
    scientificName: 'Avicennia marina',
    localNames: ['Mchu'],
    roots: 'pencil',
    text: {
      English: {
        roots:
          'Many thin roots poke straight up from the mud all around the tree. They look like pencils stuck in the ground.',
        leaves:
          'Small pointed leaves, green on top. Turn a leaf over: the underside is pale grey-white.',
        propagule:
          'A small grey-green fruit with a short point, about the size of your thumb tip. It does not grow a long propagule.',
        whereItGrows:
          'On the open edge near the sea. Short, small trees of it also grow on the dry salty flats near the land.',
        tellApart:
          'Its roots look like Sonneratia roots. Turn a leaf over: Avicennia is pale grey-white underneath, Sonneratia is green.',
      },
      Swahili: {
        roots:
          'Mizizi mingi myembamba hujitokeza wima kutoka kwenye matope kuzunguka mti. Inaonekana kama penseli zilizochomekwa ardhini.',
        leaves:
          'Majani madogo yenye ncha, ya kijani upande wa juu. Geuza jani: upande wa chini ni mweupe wa kijivu.',
        propagule:
          'Tunda dogo la kijani kijivu lenye ncha fupi, karibu ukubwa wa ncha ya kidole gumba chako. Mti huu hauna mbegu ndefu.',
        whereItGrows:
          'Kwenye ukingo wa wazi karibu na bahari. Miti mifupi midogo ya aina hii pia huota kwenye maeneo makavu yenye chumvi karibu na nchi kavu.',
        tellApart:
          'Mizizi yake hufanana na ya Sonneratia. Geuza jani: Avicennia ni nyeupe ya kijivu chini, Sonneratia ni ya kijani.',
      },
      Amharic: {
        roots: 'ብዙ ቀጭን ሥሮች በዛፉ ዙሪያ ከጭቃው ቀጥ ብለው ይወጣሉ። መሬት ውስጥ የተሰኩ እርሳሶች ይመስላሉ።',
        leaves:
          'ትናንሽ ሹል ቅጠሎች ሲሆኑ ላያቸው አረንጓዴ ነው። ቅጠሉን ይገልብጡ፤ ጀርባው ፈዛዛ ግራጫማ ነጭ ነው።',
        propagule:
          'ትንሽ ግራጫማ አረንጓዴ ፍሬ ሲሆን አጭር ሹል ጫፍ አለው፤ የአውራ ጣትዎ ጫፍ ያህላል። ረጅም ፕሮፓጉል የለውም።',
        whereItGrows:
          'ወደ ባሕሩ ባለው ክፍት ዳርቻ ያድጋል። አጫጭር ትናንሽ ዛፎቹ ደግሞ ከየብሱ አጠገብ ባሉ ደረቅ የጨው ሜዳዎች ላይ ያድጋሉ።',
        tellApart:
          'ሥሮቹ የ Sonneratia ሥሮችን ይመስላሉ። ቅጠሉን ይገልብጡ፤ Avicennia ከስር ግራጫማ ነጭ ነው፣ Sonneratia ግን አረንጓዴ ነው።',
      },
      Oromo: {
        roots:
          'Hiddi qal’aan baay’een naannoo muka sanaa dhoqqee keessaa qajeelanii ol ba’u. Irsaasii lafatti dhaabame fakkaatu.',
        leaves:
          'Baala xixiqqaa fiixee qara qabu, gama olii magariisa. Baala garagalchi: gamni jalaa daalacha adii dha.',
        propagule:
          'Firii xiqqaa magariisa daalachaa kan fiixee gabaabaa qabu, guddinni isaa fiixee quba abbaa keetii hamma. Biqiltuu dheeraa hin qabu.',
        whereItGrows:
          'Qarqara banaa galaana bira. Mukoonni isaa gabaabaa fi xixiqqaan lafa gogaa soogidda qabu kan gara lafaa jiru irrattis biqilu.',
        tellApart:
          'Hiddi isaa hidda Sonneratia fakkaata. Baala garagalchi: Avicennia gama jalaa daalacha adii, Sonneratia garuu magariisa.',
      },
    },
  },
  {
    id: 'sonneratia_alba',
    scientificName: 'Sonneratia alba',
    localNames: ['Mlilana'],
    roots: 'pencil',
    text: {
      English: {
        roots:
          'Breathing roots poke up from the mud, like Avicennia roots. They are thicker and taller, shaped like cones, often taller than your hand.',
        leaves:
          'Short, broad, round leaves with a blunt tip. They are thick and the same green on both sides.',
        propagule:
          'A round green fruit that sits on a flat, spread-out star. The flower looks like a ball of many white threads.',
        whereItGrows:
          'On the open edge near the sea, often the first tree you meet from the water. The tide covers its roots every day.',
        tellApart:
          'Its roots look like Avicennia roots, but thicker. Turn a leaf over: Sonneratia is green underneath, Avicennia is pale grey-white.',
      },
      Swahili: {
        roots:
          'Mizizi ya kupumua hujitokeza kutoka kwenye matope, kama ya Avicennia. Ni minene na mirefu zaidi, yenye umbo la koni, mara nyingi mirefu kuliko kiganja chako.',
        leaves:
          'Majani mafupi, mapana na ya mviringo, yenye ncha butu. Ni manene na ya kijani pande zote mbili.',
        propagule:
          'Tunda la mviringo la kijani linalokaa juu ya nyota bapa iliyotanuka. Ua lake ni kama mpira wa nyuzi nyingi nyeupe.',
        whereItGrows:
          'Kwenye ukingo wa wazi karibu na bahari, mara nyingi ni mti wa kwanza kutoka majini. Maji ya kujaa hufunika mizizi yake kila siku.',
        tellApart:
          'Mizizi yake hufanana na ya Avicennia, lakini ni minene zaidi. Geuza jani: Sonneratia ni ya kijani chini, Avicennia ni nyeupe ya kijivu.',
      },
      Amharic: {
        roots:
          'የመተንፈሻ ሥሮች ከጭቃው ይወጣሉ፤ እንደ Avicennia ሥሮች። እነሱ ግን ወፍራም፣ ረጅም እና ሾጣጣ ናቸው፤ ብዙ ጊዜ ከእጅዎ ይረዝማሉ።',
        leaves:
          'አጫጭር፣ ሰፊ እና ክብ ቅጠሎች ሲሆኑ ጫፋቸው ዱልዱም ነው። ወፍራም ናቸው፤ በሁለቱም በኩል አንድ አይነት አረንጓዴ ናቸው።',
        propagule:
          'ፍሬው ክብ እና አረንጓዴ ሲሆን በተዘረጋ ጠፍጣፋ ኮከብ ላይ ይቀመጣል። አበባው የብዙ ነጭ ክሮች ኳስ ይመስላል።',
        whereItGrows:
          'ወደ ባሕሩ ባለው ክፍት ዳርቻ ያድጋል፤ ብዙ ጊዜ ከውሃው በኩል የሚያገኙት የመጀመሪያው ዛፍ ነው። ማዕበሉ ሥሮቹን በየቀኑ ይሸፍናል።',
        tellApart:
          'ሥሮቹ የ Avicennia ሥሮችን ይመስላሉ፣ ግን ወፍራም ናቸው። ቅጠሉን ይገልብጡ፤ Sonneratia ከስር አረንጓዴ ነው፣ Avicennia ግን ግራጫማ ነጭ ነው።',
      },
      Oromo: {
        roots:
          'Hiddi hafuura baafatu dhoqqee keessaa ol ba’u, akka hidda Avicennia. Isaan garuu furdaa fi dheeraa, fiixeen isaanii qara’aa, yeroo baay’ee harka kee caalu.',
        leaves:
          'Baala gabaabaa, bal’aa fi geengoo kan fiixee qara hin qabne qabu. Furdaa dha, gama lamaanuu magariisa tokko.',
        propagule:
          'Firii geengoo magariisa kan urjii diriiraa babal’ate irra taa’u. Daraaraan isaa kubbaa rifeensa adii baay’ee fakkaata.',
        whereItGrows:
          'Qarqara banaa galaana bira, yeroo baay’ee muka bishaan irraa jalqaba argattu. Bishaan galaanaa guyyaa guyyaan hidda isaa haguuga.',
        tellApart:
          'Hiddi isaa hidda Avicennia fakkaata, garuu furdaa dha. Baala garagalchi: Sonneratia gama jalaa magariisa, Avicennia garuu daalacha adii.',
      },
    },
  },
  {
    id: 'xylocarpus_granatum',
    scientificName: 'Xylocarpus granatum',
    localNames: ['Mkomafi'],
    roots: 'plank',
    text: {
      English: {
        roots:
          'Flat roots snake over the mud like wavy boards standing on their edge. They run far from the trunk.',
        leaves:
          'Each leaf is made of a few small leaflets in pairs. The leaflet tips are round.',
        propagule:
          'A big, heavy, round brown fruit, as big as two fists. Inside are corky seeds with sharp corners.',
        whereItGrows: 'On the land side of the forest and along creek banks.',
        tellApart:
          'It looks like Xylocarpus moluccensis. Its leaflet tips are round, and its smooth bark flakes off in patches.',
      },
      Swahili: {
        roots:
          'Mizizi bapa hutambaa juu ya matope kama mbao zilizopinda zilizosimama wima. Huenda mbali na shina.',
        leaves:
          'Kila jani lina vijani vichache vilivyopangwa kwa jozi. Ncha za vijani ni za mviringo.',
        propagule:
          'Tunda kubwa, zito, la mviringo na la kahawia, ukubwa wa ngumi mbili. Ndani kuna mbegu kama kizibo zenye pembe kali.',
        whereItGrows: 'Upande wa nchi kavu wa msitu na kando ya mikondo.',
        tellApart:
          'Inafanana na Xylocarpus moluccensis. Ncha za vijani vyake ni za mviringo, na gome lake laini hubanduka kwa mabaka.',
      },
      Amharic: {
        roots:
          'ጠፍጣፋ ሥሮች በጭቃው ላይ እንደ እባብ ይሄዳሉ፤ በጎናቸው የቆሙ ጠማማ ሳንቃዎች ይመስላሉ። ከግንዱ ርቀው ይዘረጋሉ።',
        leaves:
          'እያንዳንዱ ቅጠል በጥንድ የተደረደሩ ጥቂት ትናንሽ ቅጠሎች አሉት። የትናንሾቹ ቅጠሎች ጫፍ ክብ ነው።',
        propagule:
          'ትልቅ፣ ከባድ እና ክብ ቡናማ ፍሬ ሲሆን የሁለት ቡጢ ያህል ነው። ውስጡ ሹል ማዕዘን ያላቸው እንደ ቡሽ ያሉ ዘሮች አሉ።',
        whereItGrows: 'በደኑ የየብስ በኩል እና በጅረቶች ዳር ያድጋል።',
        tellApart:
          'ከ Xylocarpus moluccensis ጋር ይመሳሰላል። የትናንሽ ቅጠሎቹ ጫፍ ክብ ነው፤ ልሙጡ ቅርፊቱም በቁርጥራጭ ይላጣል።',
      },
      Oromo: {
        roots:
          'Hiddi diriiraan dhoqqee irra akka bofaa deemu, akka gabatee jallataa qarqaraan dhaabatee. Jirma irraa fagaatanii deemu.',
        leaves:
          'Baalli tokkoon tokkoon isaa baala xixiqqaa muraasa lamaan lamaan qindaa’e qaba. Fiixeen baala xixiqqaa sanaa geengoo dha.',
        propagule:
          'Firii guddaa, ulfaataa, geengoo fi bunaa’aa, guddinni isaa harka cufame lama hamma. Keessa isaa sanyiiwwan golee qaraa qaban jiru.',
        whereItGrows: 'Bosona gama lafaatiin fi qarqara lagaa irratti.',
        tellApart:
          'Xylocarpus moluccensis fakkaata. Fiixeen baala xixiqqaa isaa geengoo dha, qolli isaa sukkuumaan immoo bakka bakkaan ni ka’a.',
      },
    },
  },
  {
    id: 'xylocarpus_moluccensis',
    scientificName: 'Xylocarpus moluccensis',
    localNames: ['Mkomafi dume'],
    roots: 'pencil',
    text: {
      English: {
        roots:
          'Short, thick breathing roots stick up from the mud, like short fat pencils. It has no long, flat plank roots.',
        leaves:
          'Each leaf is made of small leaflets in pairs, like Xylocarpus granatum. The leaflet tips are pointed.',
        propagule:
          'A round green fruit, smaller than the Xylocarpus granatum fruit, about the size of one fist. Inside are seeds with sharp corners.',
        whereItGrows:
          'On the land side of the forest and along creek banks. It is rare in Kenya.',
        tellApart:
          'It looks like Xylocarpus granatum, but it has no long plank roots. Its leaflet tips are pointed, and its bark is rough with long cracks. Its name Mkomafi dume sounds like Mkomafi, the name of Xylocarpus granatum. They are different trees.',
      },
      Swahili: {
        roots:
          'Mizizi mifupi minene ya kupumua hujitokeza kutoka kwenye matope, kama penseli fupi nene. Haina mizizi mirefu bapa ya ubao.',
        leaves:
          'Kila jani lina vijani vilivyopangwa kwa jozi, kama Xylocarpus granatum. Ncha za vijani zimechongoka.',
        propagule:
          'Tunda la mviringo la kijani, dogo kuliko la Xylocarpus granatum, karibu ukubwa wa ngumi moja. Ndani kuna mbegu zenye pembe kali.',
        whereItGrows:
          'Upande wa nchi kavu wa msitu na kando ya mikondo. Ni nadra nchini Kenya.',
        tellApart:
          'Inafanana na Xylocarpus granatum, lakini haina mizizi mirefu ya ubao. Ncha za vijani vyake zimechongoka. Gome lake si laini, na lina nyufa ndefu. Jina lake Mkomafi dume linafanana na Mkomafi, jina la Xylocarpus granatum. Ni miti tofauti.',
      },
      Amharic: {
        roots:
          'አጫጭር ወፍራም የመተንፈሻ ሥሮች ከጭቃው ይወጣሉ፤ አጫጭር ወፍራም እርሳሶች ይመስላሉ። ረጅም ጠፍጣፋ የሳንቃ ሥሮች የሉትም።',
        leaves:
          'እንደ Xylocarpus granatum እያንዳንዱ ቅጠል በጥንድ የተደረደሩ ትናንሽ ቅጠሎች አሉት። የትናንሾቹ ቅጠሎች ጫፍ ሹል ነው።',
        propagule:
          'ክብ አረንጓዴ ፍሬ ሲሆን ከ Xylocarpus granatum ፍሬ ያንሳል፤ የአንድ ቡጢ ያህል ነው። ውስጡ ሹል ማዕዘን ያላቸው ዘሮች አሉ።',
        whereItGrows: 'በደኑ የየብስ በኩል እና በጅረቶች ዳር ያድጋል። በኬንያ ብርቅ ነው።',
        tellApart:
          'ከ Xylocarpus granatum ጋር ይመሳሰላል፣ ግን ረጅም የሳንቃ ሥሮች የሉትም። የትናንሽ ቅጠሎቹ ጫፍ ሹል ነው፤ ቅርፊቱም ሻካራ ሲሆን ረጅም ስንጥቆች አሉት። Mkomafi dume የሚለው ስሙ Mkomafi ይመስላል፤ Mkomafi የ Xylocarpus granatum ስም ነው። የተለያዩ ዛፎች ናቸው።',
      },
      Oromo: {
        roots:
          'Hiddi hafuura baafatu gabaabaa fi furdaan dhoqqee keessaa ol ba’u, akka irsaasii gabaabaa furdaa. Hidda gabatee diriiraa dheeraa hin qabu.',
        leaves:
          'Baalli tokkoon tokkoon isaa baala xixiqqaa lamaan lamaan qindaa’e qaba, akka Xylocarpus granatum. Fiixeen baala xixiqqaa sanaa qara’aa dha.',
        propagule:
          'Firii geengoo magariisa, kan Xylocarpus granatum irra xiqqaa, guddinni isaa harka cufame tokko hamma. Keessa isaa sanyiiwwan golee qaraa qaban jiru.',
        whereItGrows:
          'Bosona gama lafaatiin fi qarqara lagaa irratti. Keeniyaa keessatti baay’ee hin argamu.',
        tellApart:
          'Xylocarpus granatum fakkaata, garuu hidda gabatee dheeraa hin qabu. Fiixeen baala xixiqqaa isaa qara’aa dha. Qolli isaa sukkuumaa miti, baqaqaa dheeraa qaba. Maqaan isaa Mkomafi dume Mkomafi fakkaata, Mkomafi maqaa Xylocarpus granatum ti. Mukoota adda addaa ti.',
      },
    },
  },
  {
    id: 'lumnitzera_racemosa',
    scientificName: 'Lumnitzera racemosa',
    localNames: ['Kikandaa'],
    // No roots show above the mud. 'knee' is only the nearest drawing; the
    // text says plainly that there is nothing to match (rootsNotVisible).
    roots: 'knee',
    rootsNotVisible: true,
    text: {
      English: {
        roots:
          'Its roots stay under the mud. You will not see stilt, pencil, knee or plank roots.',
        leaves:
          'Small, thick, bright green leaves with a round tip. They grow close together near the ends of the twigs.',
        propagule:
          'The fruit is small and hard. It has no long propagule. Look for small white flowers with 5 petals along the twigs.',
        whereItGrows:
          'At the land edge of the forest, often as a bush. Only the highest tides reach it.',
        tellApart:
          'It can look like a small Ceriops bush. Ceriops leaves grow in pairs, facing each other, and it has long, slim propagules. Lumnitzera leaves grow one by one, and it has no long propagule. Its name Kikandaa sounds like Mkandaa, the name of Ceriops. They are different trees.',
      },
      Swahili: {
        roots:
          'Mizizi yake hubaki chini ya matope. Hutaona mizizi ya nguzo, penseli, goti wala ubao.',
        leaves:
          'Majani madogo, manene, ya kijani angavu, yenye ncha ya mviringo. Hukua karibu karibu kwenye ncha za vijiti.',
        propagule:
          'Tunda ni dogo na gumu, bila mbegu ndefu. Tafuta maua madogo meupe yenye petali 5 kando ya vijiti.',
        whereItGrows:
          'Kwenye ukingo wa msitu upande wa nchi kavu, mara nyingi kama kichaka. Maji makubwa ya kujaa tu ndiyo huifikia.',
        tellApart:
          'Inaweza kufanana na kichaka kidogo cha Ceriops. Majani ya Ceriops huota kwa jozi, yakielekeana, na ina mbegu ndefu nyembamba. Majani ya Lumnitzera huota moja moja, na haina mbegu ndefu. Jina lake Kikandaa linafanana na Mkandaa, jina la Ceriops. Ni miti tofauti.',
      },
      Amharic: {
        roots: 'ሥሮቹ ከጭቃው ስር ይቀራሉ። የምሰሶ፣ የእርሳስ፣ የጉልበት ወይም የሳንቃ ሥሮች አያዩም።',
        leaves:
          'ትናንሽ፣ ወፍራም እና ደማቅ አረንጓዴ ቅጠሎች ሲሆኑ ጫፋቸው ክብ ነው። በቅርንጫፎቹ ጫፍ አጠገብ ተጠጋግተው ያድጋሉ።',
        propagule:
          'ፍሬው ትንሽ እና ጠንካራ ነው፤ ረጅም ፕሮፓጉል የለውም። በቅርንጫፎቹ ላይ ባለ 5 የአበባ ቅጠል ትናንሽ ነጭ አበቦችን ይፈልጉ።',
        whereItGrows:
          'በደኑ የየብስ ዳርቻ ያድጋል፤ ብዙ ጊዜ እንደ ቁጥቋጦ ነው። የሚደርስበት ከፍተኛው ማዕበል ብቻ ነው።',
        tellApart:
          'ትንሽ የ Ceriops ቁጥቋጦ ሊመስል ይችላል። የ Ceriops ቅጠሎች ጥንድ ጥንድ ሆነው ፊት ለፊት ያድጋሉ፤ ረጅም ቀጭን ፕሮፓጉሎችም አሉት። የ Lumnitzera ቅጠሎች አንድ በአንድ ያድጋሉ፤ ረጅም ፕሮፓጉል የለውም። Kikandaa የሚለው ስሙ Mkandaa ይመስላል፤ Mkandaa የ Ceriops ስም ነው። የተለያዩ ዛፎች ናቸው።',
      },
      Oromo: {
        roots:
          'Hiddi isaa dhoqqee jala hafa. Hidda utubaa, irsaasii, jilbaa ykn gabatee hin argitu.',
        leaves:
          'Baala xixiqqaa, furdaa fi magariisa ifaa kan fiixee geengoo qabu. Fiixee damee bira walitti dhihaatanii biqilu.',
        propagule:
          'Firiin isaa xiqqaa fi jabaa dha, biqiltuu dheeraa hin qabu. Daraaraa adii xixiqqaa baala daraaraa 5 qaban damee irratti barbaadi.',
        whereItGrows:
          'Qarqara bosonaa gama lafaatiin, yeroo baay’ee akka daggalaatti. Bishaan galaanaa ol aanaan qofatu isa ga’a.',
        tellApart:
          'Daggala Ceriops xiqqaa fakkaachuu danda’a. Baalli Ceriops lamaan lamaan wal fuuldura biqila, biqiltuu dheeraa qal’aa ni qaba. Baalli Lumnitzera tokko tokkoon biqila, biqiltuu dheeraa hin qabu. Maqaan isaa Kikandaa Mkandaa fakkaata, Mkandaan maqaa Ceriops ti. Mukoota adda addaa ti.',
      },
    },
  },
  {
    id: 'heritiera_littoralis',
    scientificName: 'Heritiera littoralis',
    localNames: ['Msikundazi'],
    roots: 'plank',
    text: {
      English: {
        roots:
          'Tall, flat roots stand out from the trunk like boards. They snake along the mud away from the tree.',
        leaves:
          'Big leaves, dark green on top. The underside shines silver-white.',
        propagule:
          'Shiny brown fruits shaped like little boats, with a sharp ridge along the back. They hang in bunches.',
        whereItGrows:
          'At the land edge of the forest, often near fresh water. It grows as single trees, not in big groups.',
        tellApart:
          'Avicennia leaves are also pale underneath, but small. Heritiera leaves are big and silver, and its fruits look like boats.',
      },
      Swahili: {
        roots:
          'Mizizi mirefu bapa husimama kutoka kwenye shina kama mbao. Hutambaa juu ya matope mbali na mti.',
        leaves:
          'Majani makubwa, ya kijani kilichokolea upande wa juu. Upande wa chini ni mweupe kama fedha.',
        propagule:
          'Matunda ya kahawia yenye umbo la mashua ndogo, yenye mgongo mkali. Hukaa kwa mafungu.',
        whereItGrows:
          'Kwenye ukingo wa msitu upande wa nchi kavu, mara nyingi karibu na maji yasiyo na chumvi. Huota kama mti mmoja mmoja, si kwa makundi makubwa.',
        tellApart:
          'Majani ya Avicennia pia ni meupe chini, lakini ni madogo. Majani ya Heritiera ni makubwa na kama fedha, na matunda yake ni kama mashua.',
      },
      Amharic: {
        roots:
          'ረጃጅም ጠፍጣፋ ሥሮች እንደ ሳንቃ ከግንዱ ወጥተው ይቆማሉ። ከዛፉ ርቀው በጭቃው ላይ እንደ እባብ ይሄዳሉ።',
        leaves: 'ትልልቅ ቅጠሎች ሲሆኑ ላያቸው ጥቁር አረንጓዴ ነው። ጀርባቸው እንደ ብር ነጭ ሆኖ ያበራል።',
        propagule:
          'ፍሬዎቹ የሚያብረቀርቁ ቡናማ ሲሆኑ ትናንሽ ጀልባዎች ይመስላሉ፤ ጀርባቸው ላይ ሹል ሸንተረር አለ። በዘለላ ተንጠልጥለው ያድጋሉ።',
        whereItGrows:
          'በደኑ የየብስ ዳርቻ ያድጋል፤ ብዙ ጊዜ ጨው የሌለው ውሃ አጠገብ ነው። በትልቅ ቡድን ሳይሆን ለብቻው ያድጋል።',
        tellApart:
          'የ Avicennia ቅጠሎችም ጀርባቸው ፈዛዛ ነው፣ ግን ትናንሽ ናቸው። የ Heritiera ቅጠሎች ትልልቅ እና እንደ ብር ናቸው፤ ፍሬዎቹም ጀልባ ይመስላሉ።',
      },
      Oromo: {
        roots:
          'Hiddi dhedheeraa diriiraan akka gabateetti jirma irraa ba’anii dhaabatu. Muka irraa fagaatanii dhoqqee irra akka bofaa deemu.',
        leaves:
          'Baala guddaa, gama olii magariisa dukkana’aa. Gamni jalaa akka meetiitti adii calaqqisa.',
        propagule:
          'Firii bunaa’aa calaqqisu kan bidiruu xixiqqaa fakkaatu, dugda isaa irratti sarara qaraa qabu. Gurmuun rarra’u.',
        whereItGrows:
          'Qarqara bosonaa gama lafaatiin, yeroo baay’ee bishaan soogidda hin qabne bira. Muka tokko tokkoon biqila, garee guddaan miti.',
        tellApart:
          'Baalli Avicennia gama jalaa adii dha, garuu xiqqaa dha. Baalli Heritiera guddaa fi akka meetii, firiin isaas bidiruu fakkaata.',
      },
    },
  },
]

export const speciesGuideUi: Record<TutorialLang, SpeciesGuideUi> = {
  English: {
    open: 'Learn the mangrove species',
    title: 'Mangrove species',
    intro:
      'Each mangrove species grows best at its own level in the tide. That is why each propagule goes beside a living tree of its own species, no more than 2 m away.',
    matchTip:
      'First find the living tree. Match its roots, leaves and propagules with this guide. Then plant only that species, within 2 m of that tree.',
    rootsLabel: 'Roots',
    leavesLabel: 'Leaves',
    propaguleLabel: 'Propagule or fruit',
    whereLabel: 'Where it grows',
    tellApartLabel: 'How to tell it apart',
    localNameLabel: 'Local name',
    rootKindName: {
      stilt: 'Stilt roots',
      pencil: 'Pencil roots',
      knee: 'Knee roots',
      plank: 'Plank roots',
    },
    notListed:
      'If the tree is not in this guide, or you are not sure, do not plant beside it. Plant only beside a tree you know.',
    close: 'Close',
  },
  Swahili: {
    open: 'Jifunze aina za mikoko',
    title: 'Aina za mikoko',
    intro:
      'Kila aina ya mikoko hustawi vizuri kwenye kina chake cha maji ya kujaa na kupwa. Ndiyo maana kila mbegu hupandwa kando ya mti hai wa aina yake, umbali usiozidi 2 m.',
    matchTip:
      'Kwanza tafuta mti hai. Linganisha mizizi, majani na mbegu zake na mwongozo huu. Kisha panda aina hiyo tu, ndani ya 2 m kutoka mti huo.',
    rootsLabel: 'Mizizi',
    leavesLabel: 'Majani',
    propaguleLabel: 'Mbegu au tunda',
    whereLabel: 'Mahali inapoota',
    tellApartLabel: 'Jinsi ya kuitofautisha',
    localNameLabel: 'Jina la kienyeji',
    rootKindName: {
      stilt: 'Mizizi ya nguzo',
      pencil: 'Mizizi ya penseli',
      knee: 'Mizizi ya goti',
      plank: 'Mizizi ya ubao',
    },
    notListed:
      'Ikiwa mti haupo kwenye mwongozo huu, au huna uhakika, usipande kando yake. Panda tu kando ya mti unaoujua.',
    close: 'Funga',
  },
  Amharic: {
    open: 'የማንግሩቭ ዝርያዎችን ይወቁ',
    title: 'የማንግሩቭ ዝርያዎች',
    intro:
      'እያንዳንዱ የማንግሩቭ ዝርያ በማዕበሉ ውስጥ በራሱ ከፍታ ላይ በደንብ ያድጋል። ስለዚህ እያንዳንዱ ፕሮፓጉል ከራሱ ዝርያ ሕያው ዛፍ አጠገብ፣ ከ 2 m ባልበለጠ ርቀት ይተከላል።',
    matchTip:
      'መጀመሪያ ሕያው ዛፉን ያግኙ። ሥሮቹን፣ ቅጠሎቹን እና ፕሮፓጉሎቹን ከዚህ መመሪያ ጋር ያመሳስሉ። ከዚያ ያንን ዝርያ ብቻ ከዛፉ በ 2 m ርቀት ውስጥ ይትከሉ።',
    rootsLabel: 'ሥሮች',
    leavesLabel: 'ቅጠሎች',
    propaguleLabel: 'ፕሮፓጉል ወይም ፍሬ',
    whereLabel: 'የሚያድግበት ቦታ',
    tellApartLabel: 'እንዴት እንደሚለይ',
    localNameLabel: 'የአካባቢ ስም',
    rootKindName: {
      stilt: 'የምሰሶ ሥሮች',
      pencil: 'የእርሳስ ሥሮች',
      knee: 'የጉልበት ሥሮች',
      plank: 'የሳንቃ ሥሮች',
    },
    notListed:
      'ዛፉ በዚህ መመሪያ ውስጥ ከሌለ ወይም እርግጠኛ ካልሆኑ፣ አጠገቡ አይትከሉ። የሚያውቁት ዛፍ አጠገብ ብቻ ይትከሉ።',
    close: 'ዝጋ',
  },
  Oromo: {
    open: 'Gosoota mangroovii baradhu',
    title: 'Gosoota mangroovii',
    intro:
      'Gosti mangroovii hundi sadarkaa bishaan galaanaa ofii isaa irratti akka gaariitti guddata. Kanaafuu biqiltuun hundi muka gosa isaa kan lubbuun jiru bira, 2 m hin caalletti dhaabama.',
    matchTip:
      'Jalqaba muka lubbuun jiru barbaadi. Hidda, baala fi biqiltuu isaa qajeelfama kana waliin wal bira qabi. Achiis gosa sana qofa, muka sanaa irraa 2 m keessatti dhaabi.',
    rootsLabel: 'Hidda',
    leavesLabel: 'Baala',
    propaguleLabel: 'Biqiltuu ykn firii',
    whereLabel: 'Iddoo itti biqilu',
    tellApartLabel: 'Akkamitti adda baafatta',
    localNameLabel: 'Maqaa naannoo',
    rootKindName: {
      stilt: 'Hidda utubaa',
      pencil: 'Hidda irsaasii',
      knee: 'Hidda jilbaa',
      plank: 'Hidda gabatee',
    },
    notListed:
      'Yoo mukni qajeelfama kana keessa hin jirre, ykn yoo mirkanaa’uu baatte, isa bira hin dhaabin. Muka beektu qofa cina dhaabi.',
    close: 'Cufi',
  },
}
