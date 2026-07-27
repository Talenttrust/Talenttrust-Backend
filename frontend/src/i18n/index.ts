/**
 * src/i18n/index.ts
 *
 * Barrel export for the i18n system.
 */
export { I18nProvider, useI18n } from './I18nContext';
export type { Locale, I18nContextValue } from './I18nContext';
export { LOCALE_TO_BCP47, getBcp47Tag } from './localeMap';
