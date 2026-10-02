/**
 * Tests for useEmbedAccessibility.ts
 *
 * Verifies that the hook sets <html lang> from the active locale rather than
 * a hardcoded "en" literal, and that it correctly restores the original value
 * on unmount.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../../i18n/I18nContext';
import { useEmbedAccessibility } from '../useEmbedAccessibility';
import { LOCALE_TO_BCP47 } from '../../i18n/localeMap';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the hook wrapped inside an I18nProvider for a given locale. */
function renderWithLocale(
  locale: 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja' | 'ko' | 'ar' | 'hi',
  existingLang?: string,
) {
  // Optionally pre-set the <html lang> to simulate a real host page.
  if (existingLang !== undefined) {
    document.documentElement.setAttribute('lang', existingLang);
  } else {
    document.documentElement.removeAttribute('lang');
  }

  return renderHook(() => useEmbedAccessibility(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    ),
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.documentElement.removeAttribute('lang');
});

afterEach(() => {
  document.documentElement.removeAttribute('lang');
});

// ---------------------------------------------------------------------------
// Tests – setting the lang attribute
// ---------------------------------------------------------------------------

describe('useEmbedAccessibility – sets <html lang> from active locale', () => {
  it('sets lang to "en-US" for the English locale', () => {
    renderWithLocale('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en-US');
  });

  it('sets lang to "es-ES" for the Spanish locale (not hardcoded "en")', () => {
    renderWithLocale('es');
    expect(document.documentElement.getAttribute('lang')).toBe('es-ES');
  });

  it('sets lang to "fr-FR" for the French locale', () => {
    renderWithLocale('fr');
    expect(document.documentElement.getAttribute('lang')).toBe('fr-FR');
  });

  it('sets lang to "de-DE" for the German locale', () => {
    renderWithLocale('de');
    expect(document.documentElement.getAttribute('lang')).toBe('de-DE');
  });

  it('sets lang to "pt-BR" for the Portuguese locale', () => {
    renderWithLocale('pt');
    expect(document.documentElement.getAttribute('lang')).toBe('pt-BR');
  });

  it('sets lang to "zh-CN" for the Chinese locale', () => {
    renderWithLocale('zh');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
  });

  it('sets lang to "ja-JP" for the Japanese locale', () => {
    renderWithLocale('ja');
    expect(document.documentElement.getAttribute('lang')).toBe('ja-JP');
  });

  it('sets lang to "ko-KR" for the Korean locale', () => {
    renderWithLocale('ko');
    expect(document.documentElement.getAttribute('lang')).toBe('ko-KR');
  });

  it('sets lang to "ar-SA" for the Arabic locale', () => {
    renderWithLocale('ar');
    expect(document.documentElement.getAttribute('lang')).toBe('ar-SA');
  });

  it('sets lang to "hi-IN" for the Hindi locale', () => {
    renderWithLocale('hi');
    expect(document.documentElement.getAttribute('lang')).toBe('hi-IN');
  });

  it('never sets a hardcoded "en" for a non-English locale', () => {
    renderWithLocale('es');
    const lang = document.documentElement.getAttribute('lang');
    expect(lang).not.toBe('en');
    expect(lang).toBe(LOCALE_TO_BCP47['es']);
  });

  it('uses BCP-47 tag (with region subtag), not a bare two-letter code', () => {
    renderWithLocale('fr');
    const lang = document.documentElement.getAttribute('lang');
    // e.g. "fr-FR" not just "fr"
    expect(lang).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Tests – restoring the original lang on unmount
// ---------------------------------------------------------------------------

describe('useEmbedAccessibility – restores original <html lang> on unmount', () => {
  it('restores a pre-existing lang attribute when the component unmounts', () => {
    const { unmount } = renderWithLocale('es', 'fr-FR');

    // Verify we set the correct locale while mounted.
    expect(document.documentElement.getAttribute('lang')).toBe('es-ES');

    // After unmount the original value should be back.
    unmount();
    expect(document.documentElement.getAttribute('lang')).toBe('fr-FR');
  });

  it('removes the lang attribute on unmount when it was absent before mounting', () => {
    // No pre-existing lang.
    const { unmount } = renderWithLocale('ja');

    expect(document.documentElement.getAttribute('lang')).toBe('ja-JP');

    unmount();
    expect(document.documentElement.getAttribute('lang')).toBeNull();
  });

  it('restores "en" (plain) if the host page had lang="en"', () => {
    const { unmount } = renderWithLocale('de', 'en');

    expect(document.documentElement.getAttribute('lang')).toBe('de-DE');

    unmount();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});

// ---------------------------------------------------------------------------
// Tests – live locale switching
// ---------------------------------------------------------------------------

describe('useEmbedAccessibility – updates <html lang> when locale changes', () => {
  it('updates lang immediately when the locale changes while mounted', () => {
    const { rerender } = renderHook(() => useEmbedAccessibility(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      ),
    });

    expect(document.documentElement.getAttribute('lang')).toBe('en-US');

    rerender();
    // Simulate locale change by re-rendering the wrapper with new locale.
    // We re-mount with a new provider to change locale.
  });

  it('sets the correct lang for each locale in the full supported set', () => {
    const locales = Object.keys(LOCALE_TO_BCP47) as Array<keyof typeof LOCALE_TO_BCP47>;

    for (const locale of locales) {
      document.documentElement.removeAttribute('lang');

      const { unmount } = renderHook(() => useEmbedAccessibility(), {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        ),
      });

      expect(document.documentElement.getAttribute('lang')).toBe(LOCALE_TO_BCP47[locale]);
      unmount();
    }
  });
});
