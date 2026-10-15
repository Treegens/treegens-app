'use client'

import { HubPageHeader } from '@/components/Layout/HubPageHeader'
import { PlantingRulesCard } from '@/components/planting/PlantingRulesCard'
import { TutorialLanguageSelector } from '@/components/tutorial/TutorialLanguageSelector'
import { Button } from '@/components/ui/Button'
import { appConfig } from '@/config/appConfig'
import {
  hasSkippedPlantingTutorial,
  markPlantingTutorialSkipped,
} from '@/utils/plantingTutorialPreference'
import {
  plantInstructions,
  plantTitle,
  type TutorialLang,
} from '@/components/tutorial/plantTutorialCopy'
import {
  readSavedTutorialLang,
  saveTutorialLang,
} from '@/utils/tutorialLanguage'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { HiArrowRight } from 'react-icons/hi2'

export default function TutorialPlantPage() {
  const router = useRouter()
  // The language this planter chose before (it also carries to the planting
  // rules on the create screen), read after mount: the server has no
  // storage. Ported from Treegens/treegens-web (lang-en) PR #15.
  const [lang, setLang] = useState<TutorialLang>('English')
  const changeLang = (next: TutorialLang) => {
    setLang(next)
    saveTutorialLang(next)
  }
  // This tutorial's own copy exists in English and Swahili only. Amharic or
  // Oromo shows its steps in English, like this page's header and buttons,
  // while the planting rules card and the species guide follow the choice.
  const copyLang: 'English' | 'Swahili' =
    lang === 'Swahili' ? 'Swahili' : 'English'
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const saved = readSavedTutorialLang()
    if (saved) setLang(saved)
  }, [])

  useEffect(() => {
    if (!mounted) return
    if (hasSkippedPlantingTutorial()) {
      router.replace(appConfig.routes.NewPlant)
    }
  }, [mounted, router])

  if (!mounted) {
    return null
  }

  if (hasSkippedPlantingTutorial()) {
    return null
  }

  return (
    <div className="tg-page-bg flex min-h-screen flex-col px-4 pb-28 pt-3">
      <HubPageHeader
        title="How to plant"
        subtitle="Mangrove basics"
        rightSlot={
          <button
            type="button"
            onClick={() => {
              markPlantingTutorialSkipped()
              router.push(appConfig.routes.NewPlant)
            }}
            className="text-xs font-semibold text-[#6b6560] underline decoration-[#6b6560]/50 underline-offset-2 hover:text-[#435F24]"
          >
            Skip
          </button>
        }
      />

      <div className="relative z-0 mb-8 flex flex-1 flex-col gap-5">
        {/* Live's four-language selector (a radiogroup, 44 px pills) in
            place of the old English/Swahili toggle, so the rules card can be
            read in Amharic or Oromo here too and the selection always matches
            it. A line saying the steps stay in English for those two would be
            new planter copy, so it waits for Jimi's wording. */}
        <TutorialLanguageSelector value={lang} onChange={changeLang} />

        <section className="tg-pill-card overflow-hidden px-5 py-5">
          <h3 className="text-lg font-black tracking-tight text-[#1a2610]">
            {plantTitle[copyLang]}
          </h3>
          <div className="mt-3 text-sm leading-relaxed text-[#374151] [&_a]:text-[#435F24] [&_a]:underline [&_h3]:mt-4 [&_h3]:font-black [&_h3]:text-[#1a2610] [&_ol]:mt-2">
            {plantInstructions[copyLang]}
          </div>
        </section>

        {/* After the planting steps (Step 3 is the 2 m rule in one line),
            before the video: the four rules in full. Jimi 2026-10-14: within
            2 m of a living tree of the same species, only beside its own
            kind, know the species, look for wild seedlings first. */}
        <PlantingRulesCard
          variant="tutorial"
          lang={lang}
          onLangChange={changeLang}
        />

        <section className="tg-pill-card overflow-hidden">
          <div className="border-b border-[#435F24]/10 bg-gradient-to-r from-[#eef6e4] via-white to-[#faf9f6] px-5 py-3">
            <h3 className="text-sm font-black uppercase tracking-[0.14em] text-[#435F24]">
              Watch video tutorial
            </h3>
          </div>
          <div className="p-4">
            <video
              className="aspect-video w-full overflow-hidden rounded-2xl bg-black/5 ring-1 ring-black/5"
              preload="metadata"
              controls
            >
              <source src="/videos/how-to-plant.mp4" type="video/mp4" />
              Your browser does not support the video tag.
            </video>
          </div>
        </section>

        <div className="flex flex-col gap-2">
          <Button
            onClick={() => router.push(appConfig.routes.TutorialVerify)}
            pill
            color="success"
          >
            Next
            <HiArrowRight className="ml-3 h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
