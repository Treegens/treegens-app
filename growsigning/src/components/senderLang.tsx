'use client';
// The language of the sender's own screens (research/docusign-gaps.json, batch "lang-sender"). The rules are
// src/lib/senderlang.ts: the language chosen under Settings, Profile, else the browser's among the sender languages,
// else English. AppShell decides it once from /api/me and hands it down, so a component asks useST() for its words.
//
// On a development server, opening any page of the app with ?lang=en-XA (accented, 40 percent longer) or ?lang=ar-XB
// (right to left) keeps that test language in this tab until ?lang= with nothing after it. A production build never
// offers them and the server never saves them.
import { createContext, useContext, useSyncExternalStore, Fragment, type ReactNode } from 'react';
import { senderLocale, senderT, senderDir, senderLangAttr, senderError, senderRichPieces } from '@/lib/senderlang';
import { isPseudo } from '@/lib/signlang';
import type { Vars } from '@/lib/i18n';

const DEV = process.env.NODE_ENV !== 'production';
const KEY = 'sg-sender-test-lang';

const noop = () => () => {};
/** The test language of this tab, on a development server only. Read after the page is in the browser. */
function pseudoInTab(): string | null {
  if (!DEV || typeof window === 'undefined') return null;
  try {
    const asked = new URLSearchParams(window.location.search).get('lang');
    if (asked !== null) {
      if (isPseudo(asked)) sessionStorage.setItem(KEY, asked);
      else sessionStorage.removeItem(KEY);
    }
    const kept = sessionStorage.getItem(KEY);
    return isPseudo(kept) ? kept : null;
  } catch {
    return null;
  }
}
const browserList = (): string => (typeof navigator === 'undefined' ? '' : (navigator.languages?.length ? navigator.languages : [navigator.language]).filter(Boolean).join(','));

/** The language of the sender's screens for the person `me` (the answer of /api/me). */
export function useSenderLang(me: any): string {
  const pseudo = useSyncExternalStore(noop, pseudoInTab, () => null);
  const browser = useSyncExternalStore(noop, browserList, () => '');
  return senderLocale({ chosen: me?.user?.locale, browser, pseudo });
}

const Ctx = createContext<string>('en');
export const SenderLangProvider = Ctx.Provider;
/** The sender's language, inside AppShell (English outside it). */
export const useSenderLangHere = () => useContext(Ctx);

/** The words of the sender's screens in their language: T(key, vars), with T.lang. */
export function useST() {
  const lang = useContext(Ctx);
  const T = (key: string, vars?: Vars) => senderT(lang, key, vars);
  T.lang = lang;
  T.error = (e: any) => senderError(lang, e);
  return T;
}

/** A text with parts that are not plain words (a name in bold): see richText in components/sign/lang.tsx. */
export function senderRich(lang: string, key: string, parts: Record<string, ReactNode>, vars: Vars = {}): ReactNode[] {
  return senderRichPieces(lang, key, Object.keys(parts), vars).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[piece]}</Fragment> : piece));
}

/** The attributes of the app's root in `lang`. */
export const senderAttrs = (lang: string) => ({ lang: senderLangAttr(lang), dir: senderDir(lang) });
