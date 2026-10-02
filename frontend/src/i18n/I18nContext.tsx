/**
 * src/i18n/I18nContext.tsx
 *
 * Provides the active locale to the entire React tree via context.
 * Components that need the current locale call `useI18n()`.
 */
import React, { createContext, useContext, useState, useCallback } from 'react';

/**
 * Supported locale identifiers (BCP-47 language tags without region, used
 * internally as keys). Extend this union as new locales are added.
 */
export type Locale =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'zh'
  | 'ja'
  | 'ko'
  | 'ar'
  | 'hi';

export interface I18nContextValue {
  /** The currently active locale, e.g. "es" or "fr". */
  locale: Locale;
  /** Change the active locale at runtime. */
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  /** Initial locale. Defaults to "en". */
  initialLocale?: Locale;
  children: React.ReactNode;
}

/**
 * Wrap the application root (or embed widget root) with this provider so that
 * all descendant components have access to the active locale.
 *
 * @example
 * ```tsx
 * <I18nProvider initialLocale="es">
 *   <App />
 * </I18nProvider>
 * ```
 */
export function I18nProvider({ initialLocale = 'en', children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

/**
 * Hook that returns the active locale and a setter for changing it.
 *
 * Must be used inside an `<I18nProvider>`. Throws a descriptive error
 * when called outside of one so misconfiguration is caught early.
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error(
      'useI18n() must be called inside an <I18nProvider>. ' +
        'Wrap your component tree with <I18nProvider> in App.tsx.',
    );
  }
  return ctx;
}
