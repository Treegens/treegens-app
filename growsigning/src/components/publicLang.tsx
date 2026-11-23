'use client';
// The language of the public pages and the sign-in forms (research/docusign-gaps.json, batch "lang-sender-rest"):
// nobody is signed in there, so it is the first sender language the browser asks for, else English (the rules of
// src/lib/senderlang.ts with no choice saved). On a development server ?lang=en-XA or ?lang=ar-XB shows a test
// language, as in the app. While English is the only language switched on, every word reads as it always did.
import { useSenderLang } from '@/components/senderLang';
import { useDocumentLang } from '@/components/sign/lang';
import { senderT, senderError } from '@/lib/senderlang';
import type { Vars } from '@/lib/i18n';

/** T(key, vars) in the visitor's language, with T.lang and T.error(e). The page carries its lang and dir too. */
export function usePublicT() {
  const lang = useSenderLang(null);
  useDocumentLang(lang);
  const T = (key: string, vars?: Vars) => senderT(lang, key, vars);
  T.lang = lang;
  T.error = (e: any) => senderError(lang, e);
  return T;
}
