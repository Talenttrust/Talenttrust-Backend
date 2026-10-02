/**
 * src/components/voice/VoiceContext.tsx
 *
 * Provides a React context that wraps the Web Speech API for opt-in voice
 * command recognition.  The recognition language is derived from the app's
 * active i18n locale so that non-English speakers — the primary audience for
 * this motor-accessibility feature — have their spoken language recognised
 * correctly.
 *
 * If the Web Speech API is unavailable in the current browser, the context
 * degrades gracefully: `isSupported` is false and all control functions are
 * no-ops.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useI18n } from '../../i18n/I18nContext';
import { getBcp47Tag } from '../../i18n/localeMap';

// ---------------------------------------------------------------------------
// Web Speech API type augmentation
// (TypeScript's lib.dom.d.ts does not always include SpeechRecognition)
// ---------------------------------------------------------------------------

interface SpeechRecognitionEvent extends Event {
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionClass(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w['SpeechRecognition'] as SpeechRecognitionConstructor | undefined) ??
    (w['webkitSpeechRecognition'] as SpeechRecognitionConstructor | undefined) ??
    null;
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export interface VoiceContextValue {
  /** Whether the Web Speech API is available in this browser. */
  isSupported: boolean;
  /** Whether voice recognition is currently active. */
  isListening: boolean;
  /** The transcript of the most recent recognised phrase. */
  transcript: string;
  /** The last error message from the Speech API, if any. */
  error: string | null;
  /** Start voice recognition. The BCP-47 lang tag is derived from the active locale. */
  startListening: () => void;
  /** Stop voice recognition. */
  stopListening: () => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const VoiceContext = createContext<VoiceContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface VoiceProviderProps {
  children: React.ReactNode;
}

/**
 * Wrap the portion of your component tree that needs voice input with this
 * provider.  It must be placed inside an `<I18nProvider>` so that the active
 * locale is available.
 *
 * @example
 * ```tsx
 * <I18nProvider initialLocale="es">
 *   <VoiceProvider>
 *     <App />
 *   </VoiceProvider>
 * </I18nProvider>
 * ```
 */
export function VoiceProvider({ children }: VoiceProviderProps) {
  const { locale } = useI18n();

  const SpeechRecognitionClass = getSpeechRecognitionClass();
  const isSupported = SpeechRecognitionClass !== null;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Stop and tear down any active recognition session when the locale changes
  // so the next startListening() call picks up the new language.
  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
      setIsListening(false);
    }
  }, [locale]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const startListening = useCallback(() => {
    if (!isSupported || !SpeechRecognitionClass) return;

    // Abort any existing session before creating a new one.
    recognitionRef.current?.abort();

    const recognition = new SpeechRecognitionClass();

    // Derive the BCP-47 tag from the active locale; falls back to "en-US".
    const bcp47 = getBcp47Tag(locale);

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = bcp47;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result[0]) {
          if (result.isFinal) {
            final += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }
      }
      setTranscript(final || interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setError(event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    setError(null);
    recognition.start();
    setIsListening(true);
  }, [isSupported, SpeechRecognitionClass, locale]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  const value: VoiceContextValue = {
    isSupported,
    isListening,
    transcript,
    error,
    startListening,
    stopListening,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the active voice recognition context.
 * Must be used inside a `<VoiceProvider>`.
 */
export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (ctx === null) {
    throw new Error(
      'useVoice() must be called inside a <VoiceProvider>. ' +
        'Wrap the relevant component tree with <VoiceProvider>.',
    );
  }
  return ctx;
}
