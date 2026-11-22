// The language of a public page drawn on the server (research/docusign-gaps.json, batch "lang-sender-rest"): the first
// sender language the browser asks for, else English, by the same rules as the app (src/lib/senderlang.ts). While
// English is the only sender language the request is not read, as in src/app/layout.tsx, so nothing changes with
// zero setup. For server components only; a client component asks usePublicT (src/components/publicLang.tsx).
import { Fragment, type ReactNode } from 'react';
import { headers } from 'next/headers';
import { senderChoiceShown, senderBrowserLocale, senderT, senderRichPieces } from '@/lib/senderlang';
import { SOURCE_LOCALE, type Vars } from '@/lib/i18n';

export async function requestLang(): Promise<string> {
  if (!senderChoiceShown()) return SOURCE_LOCALE;
  return senderBrowserLocale((await headers()).get('accept-language')) || SOURCE_LOCALE;
}

/** T(key, vars) in the language of this request, for a server component. */
export async function requestT() {
  const lang = await requestLang();
  const T = (key: string, vars?: Vars) => senderT(lang, key, vars);
  T.lang = lang;
  /** A text with parts that are not plain words (a link, a name in bold), as senderRich does on the client. */
  T.rich = (key: string, parts: Record<string, ReactNode>, vars: Vars = {}): ReactNode[] =>
    senderRichPieces(lang, key, Object.keys(parts), vars).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[piece]}</Fragment> : piece));
  return T;
}
