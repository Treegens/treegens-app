/** Shared copy for /tutorial and /tutorial/verify (mirrors mobile tutorial screens). */
import type { ReactNode } from 'react'

/**
 * Languages offered in the tutorial selector, in display order.
 *
 * Ported from Treegens/treegens-web (lang-en) PR #15, with the live values:
 * the planting rules, the wild-seedling check and the species guide
 * (plantingRulesCopy.ts, mangroveSpeciesCopy.ts) are byte-identical copies of
 * the live files and are typed by these. The tutorial copy below still exists
 * in English and Swahili only.
 */
export const tutorialLanguages = [
  'English',
  'Swahili',
  'Amharic',
  'Oromo',
] as const
export type TutorialLang = (typeof tutorialLanguages)[number]

/** Short label shown on the selector for each language (endonym). */
export const tutorialLanguageLabel: Record<TutorialLang, string> = {
  English: 'English',
  Swahili: 'Kiswahili',
  // Endonym. Readable because Noto Sans Ethiopic is self-hosted in globals.css.
  Amharic: 'አማርኛ',
  Oromo: 'Afaan Oromoo',
}

export const plantTitle = {
  English: 'How to Plant Mangroves',
  Swahili: 'Jinsi ya Kupanda Mikoko',
}

export const verifyTitle = {
  English: 'How to Verify Your Mangrove Plantation',
  Swahili: 'Jinsi ya Kuthibitisha Shamba Lako la Mikoko',
}

export const plantInstructions: Record<'English' | 'Swahili', ReactNode> = {
  English: (
    <div className="flex flex-col gap-2 ">
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Step 1{`)`}</span> Find propagules (long
          stick-like seeds){' '}
        </h3>
        <ol className="list-[disc] pl-8">
          <li>
            If{' '}
            <a
              className="text-tree-green-3 font-bold underline"
              href="https://en.m.wikipedia.org/wiki/Ceriops_australis"
              target="_blank"
            >
              Ceriops
            </a>{' '}
            species, there should be 2-3 cms of yellow at the top of them to be
            ripe enough to pluck from the trees
          </li>
          <li>
            Can also find on the ground, as long as they are not dark brown /
            black from sun damage, they are ok to plant{' '}
          </li>
          <li>
            If
            <a
              className="text-tree-green-3 font-bold underline"
              href="https://en.m.wikipedia.org/wiki/Rhizophora"
              target="_blank"
            >
              {' '}
              Rhizophora
            </a>{' '}
            they must be long enough to be ripe, typically around 20-60cm
          </li>
          <li>
            If another species, contact a specialist in our{' '}
            <a
              className="text-tree-green-3 font-bold underline"
              href="http://t.me/TreegenFam"
              target="_blank"
            >
              {' '}
              Telegram
            </a>{' '}
          </li>
        </ol>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Step 2{`)`}</span> Plant each propagule
          about 30cms apart if planting directly. If you are planting mangrove
          seedlings from a nursery, plant them 1 metre apart.
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Step 3{`)`}</span> Only plant the mangrove
          propagules within 2 metres of the same tree species.
        </h3>
      </div>
    </div>
  ),
  Swahili: (
    <div className="flex flex-col gap-2 ">
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Hatua ya 1{')'}</span> Tafuta mbegu za
          mikoko (mbegu zinazofanana na vijiti virefu)
        </h3>
        <ol className="list-[disc] pl-8">
          <li>
            Ikiwa ni spishi ya{' '}
            <a
              className="text-tree-green-3 font-bold underline"
              href="https://en.m.wikipedia.org/wiki/Ceriops_australis"
              target="_blank"
            >
              Ceriops
            </a>{' '}
            , zinapaswa kuwa na sehemu ya juu yenye urefu wa sentimita 2-3 ya
            rangi ya njano ili kuwa tayari kuchunwa kutoka kwenye miti.
          </li>
          <li>
            Pia unaweza kuzipata ardhini, mradi hazijakua na rangi ya
            kahawia/dhahabu nyeusi kutokana na kuharibiwa na jua.
          </li>
          <li>
            Ikiwa ni{' '}
            <a
              className="text-tree-green-3 font-bold underline"
              href="https://en.m.wikipedia.org/wiki/Rhizophora"
              target="_blank"
            >
              {' '}
              Rhizophora
            </a>
            , lazima ziwe na urefu wa kutosha kuonyesha ukomavu, kawaida ya
            urefu wa sentimita 20-60.
          </li>
          <li>
            Ikiwa ni spishi nyingine, wasiliana na mtaalamu kupitia{' '}
            <a
              className="text-tree-green-3 font-bold underline"
              href="http://t.me/TreegenFam"
              target="_blank"
            >
              {' '}
              Telegram
            </a>{' '}
            yetu.
          </li>
        </ol>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Hatua ya 2{')'}</span> Panda kila mbegu
          kwa umbali wa takriban sentimita 30 kutoka kwa mbegu nyingine ikiwa
          unazipanda moja kwa moja. Ikiwa unapanda miche ya mikoko kutoka kwenye
          bustani ya miche, panda kwa umbali wa mita 1 kutoka kwa mbengu
          nyingine.
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Hatua ya 3{')'}</span> Panda mbegu za
          mikoko mita 2 kutoka kwa mti wa spishi hiyo hiyo.
        </h3>
      </div>
    </div>
  ),
}

export const verifyInstructions: Record<'English' | 'Swahili', ReactNode> = {
  English: (
    <div className="flex flex-col gap-2 ">
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Step 1{`)`}</span> Before planting, film
          the land you will be planting. This is your <strong>before</strong>{' '}
          video.
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Step 2{`)`}</span> After planting, film
          your <strong>after</strong> video in{' '}
          <strong>one continual direction only</strong>—either left to right{' '}
          <em>or</em> right to left for the whole clip (not both, and don’t scan
          back and forth). The same idea applies vertically (e.g. only upward or
          only downward). For example, do not pan left‑to‑right and then
          reverse. If a mangrove propagule goes out of the screen & then back
          in, it will be counted twice & you will need to film the trees again.
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Step 3{`)`}</span> Wait for DAO verifiers
          to verify your planting methodology to issue your $MGRO tokens. 1/6th
          of an $MGRO token will be sent to you when you first plant. Another
          1/6th will be sent every 6 months, over the course of 3 years so you
          are incentivised to do health checks on your mangroves.
        </h3>
      </div>
    </div>
  ),
  Swahili: (
    <div className="flex flex-col gap-2 ">
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Hatua ya 1{')'}</span> Kabla ya kupanda,
          chukua video ya eneo utakalopanda. Hii ni video yako ya{' '}
          <strong>kabla</strong>.
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Hatua ya 2{')'}</span> Baada ya kupanda,
          chukua video yako ya <strong>baada</strong> kwa mwelekeo mmoja, mfano
          kutoka kushoto kwenda kulia au kutoka juu kwenda chini. Kwa mfano,
          usirudi kushoto, kisha kulia na kisha kushoto tena. Ikiwa mbegu ya
          mikoko itatoka nje ya skrini na kisha kurudi, itahesabiwa mara mbili
          na utahitaji kupiga video ya miti tena.
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        <h3>
          <span className="font-bold">Hatua ya 3{')'}</span>Subiri wahakiki wa
          DAO kuthibitisha mbinu yako ya upandaji ili upewe tokeni zako za
          $MGRO. Sehemu ya 1/6 ya tokeni ya $MGRO itatumwa kwako unapoanza
          kupanda. Sehemu nyingine ya 1/6 itatumwa kila baada ya miezi 6, kwa
          muda wa miaka 3 ili uwe na motisha ya kufanya ukaguzi wa afya ya
          mikoko yako.
        </h3>
      </div>
    </div>
  ),
}
