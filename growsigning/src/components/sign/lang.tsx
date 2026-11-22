'use client';
// The language of the signing page on screen: which one, the words in it, and the menu in the header that changes it.
// The rules are src/lib/signlang.ts. The page decides the language once (useSignLang) and the Shell
// (src/components/sign/parts.tsx) puts it on its root as lang and dir and hands it to every component under it, so a
// component asks useT() for its words and never needs a prop for the language.
import { createContext, useContext, useSyncExternalStore, useId, useEffect, Fragment, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { api, toast } from '@/components/ui';
import { signT, shownError, isPseudo, menuLanguages, signDir, signLangAttr } from '@/lib/signlang';
import type { Vars } from '@/lib/i18n';

const DEV = process.env.NODE_ENV !== 'production';

// The language chosen in the header menu in this tab, for that one signing link: it wins over the one the server
// decided, so the page changes at once and stays changed while the link is open, also when the server could not save
// it (a locked link). Another link opened in the same tab (the next person signing in person) starts from its own.
let chosen: { token: string; tag: string } | null = null;
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
const choose = (token: string, tag: string) => {
  chosen = { token, tag };
  listeners.forEach((f) => f());
};
/** The language chosen in this tab for `token`, if any. */
export const chosenFor = (token: string | undefined): string | null => (token && chosen?.token === token ? chosen.tag : null);

/** A test language asked for in the address (?lang=en-XA), on a development server only. */
const pseudoAsked = (): string | null => {
  if (!DEV || typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('lang');
  return isPseudo(v) ? v : null;
};

/** The language this page is in now: the one chosen in this tab, else a test language on a development server, else the server's choice, else English. */
export function useSignLang(data?: any): string {
  const params = useParams() as { token?: string } | null;
  const mine = useSyncExternalStore(subscribe, () => chosenFor(params?.token), () => null);
  // Read after the page is in the browser (the server never sees the address's ?lang), so the first paint matches.
  const asked = useSyncExternalStore(subscribe, pseudoAsked, () => null);
  return mine || asked || data?.language?.locale || 'en';
}

const LangContext = createContext<string>('en');
export const SignLangProvider = LangContext.Provider;
/** The page's language, inside the Shell. */
export const useLang = () => useContext(LangContext);

/** The words of the signing page in its language: T(key, vars), and T.error(e) for a refusal from the server. */
export function useT() {
  const lang = useContext(LangContext);
  const T = (key: string, vars?: Vars) => signT(lang, key, vars);
  T.error = (e: any, fallbackKey?: string) => shownError(lang, e, fallbackKey);
  T.lang = lang;
  return T;
}

/**
 * A text with parts that are not plain words, such as a name in bold: richText(lang, key, { name: <b>{n}</b> }).
 * The text is translated with a marker in each place and the parts are put there, so a language may put the name
 * wherever its sentence needs it.
 */
export function richText(lang: string, key: string, parts: Record<string, ReactNode>, vars: Vars = {}): ReactNode[] {
  const names = Object.keys(parts);
  const marked: Vars = { ...vars };
  names.forEach((n, i) => (marked[n] = `\uE000${i}\uE001`));
  return signT(lang, key, marked).split(/\uE000(\d+)\uE001/).map((piece, i) => (i % 2 ? <Fragment key={i}>{parts[names[Number(piece)]]}</Fragment> : piece));
}

/** The root attributes of a page in `lang`. */
export const langAttrs = (lang: string) => ({ lang: signLangAttr(lang), dir: signDir(lang) });

/**
 * The whole document in the page's language while the signing page is open: dialogs and toasts are drawn outside the
 * Shell, so without this an Arabic signer's dialogs would not mirror and a screen reader would read them as English.
 * Put back as it was when the page goes. With the page in the language the document already has, nothing changes.
 */
export function useDocumentLang(lang: string) {
  useEffect(() => {
    const el = document.documentElement;
    const want = langAttrs(lang);
    const was = { lang: el.getAttribute('lang'), dir: el.getAttribute('dir') };
    if (was.lang === want.lang && (was.dir || 'ltr') === want.dir) return;
    el.setAttribute('lang', want.lang);
    el.setAttribute('dir', want.dir);
    return () => {
      for (const [k, v] of Object.entries(was)) (v == null ? el.removeAttribute(k) : el.setAttribute(k, v));
    };
  }, [lang]);
}

/**
 * The header's language menu. Not there at all while one language is switched on (research/ux-notes.json
 * ds-lang-signing). The choice is saved on this person (POST /sign/:token/locale) so their emails and their next visit
 * follow it; a test language changes only this tab.
 */
export function LanguageMenu({ lang }: { lang: string }) {
  const params = useParams() as { token?: string } | null;
  const id = useId();
  const options = menuLanguages({ dev: DEV, current: lang });
  if (options.length < 2 || !params?.token) return null;
  const T = (key: string, vars?: Vars) => signT(lang, key, vars);
  const pick = async (tag: string) => {
    if (tag === lang) return;
    choose(params.token!, tag);
    if (isPseudo(tag)) return;
    // The page is in the new language in this tab either way. When the choice is not kept, the person is told why, on
    // screen (a toast, read out too), so a reload in the earlier language is no surprise.
    let why = '';
    try {
      const r: any = await api(`/sign/${encodeURIComponent(params.token!)}/locale`, { body: { locale: tag } });
      if (r?.saved === false) why = r.why === 'finished' ? 'sign.language.not_saved_done' : r.why === 'closed' ? 'sign.language.not_saved_closed' : r.why === 'group' ? 'sign.language.not_saved_group' : 'sign.language.not_saved';
    } catch {
      why = 'sign.language.not_saved';
    }
    if (why) toast(signT(tag, why));
  };
  return (
    <span className="sg-lang">
      <label htmlFor={id} className="sg-vh">{T('sign.language.label')}</label>
      <select id={id} className="sg-lang-pick" value={lang} onChange={(e) => pick(e.target.value)}>
        {options.map((o) => (
          <option key={o.tag} value={o.tag} lang={signLangAttr(o.tag)} dir="auto">{o.own}</option>
        ))}
      </select>
    </span>
  );
}
