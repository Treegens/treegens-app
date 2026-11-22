'use client';
// The words of the stamp screens (research/docusign-gaps.json, batch "lang-sender-rest"). StampMaker is shown on the
// signing page (in the signer's language) and in Settings (in the sender's): whichever of the two is around it says
// which language. Both read the same catalogue (src/locales/en.json, keys stamps.*).
import { useLang } from '@/components/sign/lang';
import { useSenderLangHere } from '@/components/senderLang';
import { senderT } from '@/lib/senderlang';
import { INK_WORD, type Ink } from '@/lib/stampink';
import type { Vars } from '@/lib/i18n';

/** T(key, vars) in the language of the page around: the signer's on the signing page, else the sender's. */
export function useStampT() {
  const signer = useLang();
  const sender = useSenderLangHere();
  const lang = signer !== 'en' ? signer : sender;
  const T = (key: string, vars?: Vars) => senderT(lang, key, vars);
  T.lang = lang;
  /** An ink's name ("Blue"), and in a sentence ("blue"). */
  T.ink = (ink: unknown) => (typeof ink === 'string' && Object.hasOwn(INK_WORD, ink) ? senderT(lang, `stamps.ink.${ink as Ink}`) : '');
  T.inkLower = (ink: unknown) => (typeof ink === 'string' && Object.hasOwn(INK_WORD, ink) ? senderT(lang, `stamps.ink_lower.${ink as Ink}`) : '');
  return T;
}
