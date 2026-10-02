/**
 * src/hooks/useEmbedAccessibility.ts
 *
 * Sets accessibility attributes on the host page's <html> element while an
 * embed widget is mounted, then restores all original values on unmount.
 *
 * The `lang` attribute is derived from the app's active i18n locale so that
 * assistive technologies pronounce content in the correct language, rather
 * than always falling back to a hardcoded "en" literal.
 *
 * Usage
 * -----
 * Call this hook at the top level of the embed widget component.  The hook
 * reads the active locale from `useI18n()`, so the component must be
 * rendered inside an `<I18nProvider>`.
 *
 * @example
 * ```tsx
 * function EmbedWidget() {
 *   useEmbedAccessibility();
 *   return <div>…</div>;
 * }
 * ```
 */
import { useEffect } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { getBcp47Tag } from '../i18n/localeMap';

/**
 * Applies and restores `<html lang>` (and `dir` when appropriate) based on
 * the active i18n locale while the calling component is mounted.
 *
 * - Sets `html[lang]` to the BCP-47 tag for the active locale (e.g. "es-ES").
 * - Restores the original `lang` value (or removes the attribute entirely if
 *   it was absent) when the component unmounts.
 * - Re-runs whenever the active locale changes so live locale switching is
 *   reflected immediately.
 */
export function useEmbedAccessibility(): void {
  const { locale } = useI18n();

  useEffect(() => {
    const html = document.documentElement;

    // Capture original value before we mutate anything.
    const originalLang = html.getAttribute('lang');

    // Derive the correct BCP-47 tag from the active locale.
    const activeBcp47 = getBcp47Tag(locale);
    html.setAttribute('lang', activeBcp47);

    return () => {
      // Restore the original state precisely:
      // • If the attribute existed before, put it back.
      // • If it was absent, remove it entirely (don't leave a stale value).
      if (originalLang !== null) {
        html.setAttribute('lang', originalLang);
      } else {
        html.removeAttribute('lang');
      }
    };
  }, [locale]);
}
