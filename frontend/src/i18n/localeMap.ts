/**
 * src/i18n/localeMap.ts
 *
 * Maps the app's internal locale identifiers to the BCP-47 language tags
 * required by the Web Speech API (`SpeechRecognition.lang`) and the HTML
 * `lang` attribute.
 *
 * The Speech API typically expects a full BCP-47 tag with region subtag
 * (e.g. "es-ES") because recognition models are region-specific. Where
 * multiple regional variants exist the most widely used one is chosen as the
 * canonical default; callers that need finer control can map directly.
 *
 * References:
 *  - https://www.w3.org/TR/speech-api/#speechreco-lang
 *  - https://www.iana.org/assignments/language-subtag-registry
 */

import type { Locale } from './I18nContext';

/**
 * Map from internal locale key → BCP-47 tag suitable for
 * `SpeechRecognition.lang` and `<html lang>`.
 */
export const LOCALE_TO_BCP47: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  pt: 'pt-BR',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  ar: 'ar-SA',
  hi: 'hi-IN',
};

/** Fallback tag used when the locale is not in the map. */
export const DEFAULT_BCP47 = 'en-US';

/**
 * Returns the BCP-47 tag for `locale`, or `DEFAULT_BCP47` when the locale is
 * not present in `LOCALE_TO_BCP47` (e.g. after future locale additions that
 * haven't been mapped yet).
 *
 * @param locale - The app's active locale identifier.
 * @returns A BCP-47 language tag string.
 */
export function getBcp47Tag(locale: Locale): string {
  return LOCALE_TO_BCP47[locale] ?? DEFAULT_BCP47;
}
