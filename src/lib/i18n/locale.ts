import type { Locale } from "date-fns";
import { ar, enUS, es, ko, ptBR } from "date-fns/locale";

/**
 * The UI language is fixed per build (NEXT_PUBLIC_APP_LOCALE, see
 * src/i18n/request.ts). These helpers let date and number formatting
 * follow it instead of the browser's language or a hard-coded en-US.
 */
export const APP_LOCALES = ["en", "pt", "es", "ko", "ar"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

const env = process.env.NEXT_PUBLIC_APP_LOCALE ?? "";
export const APP_LOCALE: AppLocale = (APP_LOCALES as readonly string[]).includes(env)
  ? (env as AppLocale)
  : "en";

/**
 * Locale tag for `Intl` / `toLocale*String`. English stays `undefined`
 * (the viewer's browser format), matching what the app always did.
 * Arabic keeps Western digits (`nu-latn`) so dates and amounts read the
 * same as the phone numbers and IDs next to them.
 */
const INTL_LOCALES: Record<AppLocale, string | undefined> = {
  en: undefined,
  pt: "pt-BR",
  es: "es",
  ko: "ko",
  ar: "ar-u-nu-latn",
};
export const INTL_LOCALE = INTL_LOCALES[APP_LOCALE];

/** date-fns locale for `format` / `formatDistanceToNow`. */
const DATE_FNS_LOCALES: Record<AppLocale, Locale> = {
  en: enUS,
  pt: ptBR,
  es,
  ko,
  ar,
};
export const DATE_FNS_LOCALE = DATE_FNS_LOCALES[APP_LOCALE];
