/**
 * Tests for VoiceContext.tsx
 *
 * Verifies that VoiceProvider initialises SpeechRecognition.lang from the
 * app's active locale rather than hardcoding "en-US".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider, useI18n } from '../../../i18n/I18nContext';
import { VoiceProvider, useVoice } from '../VoiceContext';
import { LOCALE_TO_BCP47 } from '../../../i18n/localeMap';

// ---------------------------------------------------------------------------
// Mock SpeechRecognition
// ---------------------------------------------------------------------------

interface MockRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  onresult: null;
  onerror: null;
  onend: null;
}

/** Tracks every instance created during a test so we can inspect .lang. */
let instances: MockRecognitionInstance[] = [];

function createMockClass() {
  return vi.fn().mockImplementation((): MockRecognitionInstance => {
    const instance: MockRecognitionInstance = {
      continuous: false,
      interimResults: false,
      lang: '',
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
      onresult: null,
      onerror: null,
      onend: null,
    };
    instances.push(instance);
    return instance;
  });
}

beforeEach(() => {
  instances = [];
  const MockClass = createMockClass();
  // Attach to window so VoiceContext's getSpeechRecognitionClass() picks it up.
  Object.defineProperty(window, 'SpeechRecognition', {
    value: MockClass,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // Clean up window property so tests are isolated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).SpeechRecognition;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: a button that triggers startListening so we can inspect the
// recognition instance's `lang` after the call.
// ---------------------------------------------------------------------------

function VoiceTestConsumer() {
  const { startListening, stopListening, isListening, isSupported } = useVoice();
  return (
    <div>
      <span data-testid="supported">{String(isSupported)}</span>
      <span data-testid="listening">{String(isListening)}</span>
      <button onClick={startListening}>Start</button>
      <button onClick={stopListening}>Stop</button>
    </div>
  );
}

function renderWithLocale(locale: 'en' | 'es' | 'fr' | 'de' | 'pt' | 'zh' | 'ja' | 'ko' | 'ar' | 'hi') {
  return render(
    <I18nProvider initialLocale={locale}>
      <VoiceProvider>
        <VoiceTestConsumer />
      </VoiceProvider>
    </I18nProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceProvider – SpeechRecognition.lang reflects active locale', () => {
  it('sets lang to "en-US" for the default English locale', () => {
    renderWithLocale('en');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('en-US');
  });

  it('sets lang to "es-ES" when the active locale is "es"', () => {
    renderWithLocale('es');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('es-ES');
  });

  it('sets lang to "fr-FR" when the active locale is "fr"', () => {
    renderWithLocale('fr');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('fr-FR');
  });

  it('sets lang to "de-DE" when the active locale is "de"', () => {
    renderWithLocale('de');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('de-DE');
  });

  it('sets lang to "zh-CN" when the active locale is "zh"', () => {
    renderWithLocale('zh');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('zh-CN');
  });

  it('sets lang to "ja-JP" when the active locale is "ja"', () => {
    renderWithLocale('ja');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('ja-JP');
  });

  it('sets lang to "ar-SA" when the active locale is "ar"', () => {
    renderWithLocale('ar');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('ar-SA');
  });

  it('never hardcodes "en-US" for a non-English locale', () => {
    renderWithLocale('pt');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances[0].lang).not.toBe('en-US');
    expect(instances[0].lang).toBe(LOCALE_TO_BCP47['pt']);
  });

  it('passes continuous = true and interimResults = true', () => {
    renderWithLocale('en');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances[0].continuous).toBe(true);
    expect(instances[0].interimResults).toBe(true);
  });

  it('reports isSupported = true when SpeechRecognition is available', () => {
    renderWithLocale('en');
    expect(screen.getByTestId('supported').textContent).toBe('true');
  });

  it('reports isSupported = false when SpeechRecognition is unavailable', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).SpeechRecognition;

    renderWithLocale('en');
    expect(screen.getByTestId('supported').textContent).toBe('false');
  });

  it('aborts existing session and creates a new one with updated lang when locale changes', () => {
    // Use a wrapper that exposes setLocale so we can drive a locale change
    // without remounting the entire tree (remounting resets useState).
    function LocaleSwitcher({ children }: { children: React.ReactNode }) {
      const { setLocale } = useI18n();
      return (
        <>
          {children}
          <button onClick={() => setLocale('es')}>Switch to ES</button>
        </>
      );
    }

    render(
      <I18nProvider initialLocale="en">
        <LocaleSwitcher>
          <VoiceProvider>
            <VoiceTestConsumer />
          </VoiceProvider>
        </LocaleSwitcher>
      </I18nProvider>,
    );

    // Start recognition in English.
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('en-US');

    // Switch locale to Spanish — VoiceProvider should abort the old session.
    fireEvent.click(screen.getByRole('button', { name: 'Switch to ES' }));

    // Start a new session; it should now use the Spanish tag.
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(instances).toHaveLength(2);
    expect(instances[1].lang).toBe('es-ES');
  });

  it('does not throw when startListening is called and SpeechRecognition is unavailable', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).SpeechRecognition;

    renderWithLocale('fr');
    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    }).not.toThrow();
  });
});

describe('VoiceProvider – fallback behaviour', () => {
  it('falls back to webkitSpeechRecognition when SpeechRecognition is absent', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).SpeechRecognition;
    const WebkitClass = createMockClass();
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      value: WebkitClass,
      writable: true,
      configurable: true,
    });

    renderWithLocale('ko');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(instances).toHaveLength(1);
    expect(instances[0].lang).toBe('ko-KR');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).webkitSpeechRecognition;
  });
});
