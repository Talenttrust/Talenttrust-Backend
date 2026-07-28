export type SessionTimeoutError =
  | {
      kind: 'invalid-expiry';
      message: string;
    }
  | {
      kind: 'stay-logged-in-failed';
      message: string;
      cause?: unknown;
    };

export type SessionRefreshResult =
  | {
      ok: true;
      expiresAtEpochMs: number;
    }
  | {
      ok: false;
      error: SessionTimeoutError;
    };

export type SessionTimeoutWarning = {
  kind: 'session-timeout-warning';
  secondsRemaining: number;
  stayLoggedIn: () => Promise<SessionRefreshResult>;
};

export type SessionLogoutEvent = {
  kind: 'session-timeout-logout';
  reason: 'expired';
  redirectTo: string;
};

export type SessionTimerApi = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;

export interface SessionTimeoutControllerOptions {
  expiresAtEpochMs: number;
  stayLoggedIn: () => Promise<{ expiresAtEpochMs: number }>;
  onWarning: (warning: SessionTimeoutWarning) => void;
  onLogout?: (event: SessionLogoutEvent) => void;
  onError?: (error: SessionTimeoutError) => void;
  now?: () => number;
  timerApi?: SessionTimerApi;
  redirect?: (path: string) => void;
  signinPath?: string;
  warningBeforeMs?: number;
}

export interface SessionTimeoutController {
  start: () => void;
  stop: () => void;
  updateExpiry: (expiresAtEpochMs: number) => SessionRefreshResult;
}

type TimerHandle = ReturnType<typeof setTimeout>;

const DEFAULT_WARNING_BEFORE_MS = 60_000;
const DEFAULT_SIGNIN_PATH = '/signin';

function typedInvalidExpiry(expiresAtEpochMs: number): SessionRefreshResult {
  return {
    ok: false,
    error: {
      kind: 'invalid-expiry',
      message: `Session expiry must be a future epoch millisecond timestamp. Received ${expiresAtEpochMs}.`,
    },
  };
}

function secondsUntil(expiresAtEpochMs: number, now: () => number): number {
  return Math.max(0, Math.ceil((expiresAtEpochMs - now()) / 1000));
}

export function createSessionTimeoutController(
  options: SessionTimeoutControllerOptions
): SessionTimeoutController {
  const now = options.now ?? Date.now;
  const timerApi = options.timerApi ?? globalThis;
  const signinPath = options.signinPath ?? DEFAULT_SIGNIN_PATH;
  const warningBeforeMs = options.warningBeforeMs ?? DEFAULT_WARNING_BEFORE_MS;
  const redirect =
    options.redirect ??
    ((path: string) => {
      if (typeof window !== 'undefined') {
        window.location.assign(path);
      }
    });

  let expiresAtEpochMs = options.expiresAtEpochMs;
  let warningTimer: TimerHandle | undefined;
  let logoutTimer: TimerHandle | undefined;
  let hasLoggedOut = false;

  function clearTimers(): void {
    if (warningTimer) {
      timerApi.clearTimeout(warningTimer);
      warningTimer = undefined;
    }
    if (logoutTimer) {
      timerApi.clearTimeout(logoutTimer);
      logoutTimer = undefined;
    }
  }

  function logout(): void {
    if (hasLoggedOut) return;
    hasLoggedOut = true;
    clearTimers();

    const event: SessionLogoutEvent = {
      kind: 'session-timeout-logout',
      reason: 'expired',
      redirectTo: signinPath,
    };
    options.onLogout?.(event);
    redirect(signinPath);
  }

  function validateExpiry(nextExpiry: number): SessionRefreshResult {
    if (!Number.isFinite(nextExpiry) || nextExpiry <= now()) {
      return typedInvalidExpiry(nextExpiry);
    }

    return { ok: true, expiresAtEpochMs: nextExpiry };
  }

  function schedule(): void {
    clearTimers();

    const valid = validateExpiry(expiresAtEpochMs);
    if (!valid.ok) {
      options.onError?.(valid.error);
      logout();
      return;
    }

    const warnInMs = Math.max(0, expiresAtEpochMs - now() - warningBeforeMs);
    const logoutInMs = Math.max(0, expiresAtEpochMs - now());

    warningTimer = timerApi.setTimeout(() => {
      options.onWarning({
        kind: 'session-timeout-warning',
        secondsRemaining: secondsUntil(expiresAtEpochMs, now),
        stayLoggedIn: async () => {
          try {
            const refreshed = await options.stayLoggedIn();
            return updateExpiry(refreshed.expiresAtEpochMs);
          } catch (cause) {
            const error: SessionTimeoutError = {
              kind: 'stay-logged-in-failed',
              message: 'Unable to refresh the session.',
              cause,
            };
            options.onError?.(error);
            return { ok: false, error };
          }
        },
      });
    }, warnInMs);

    logoutTimer = timerApi.setTimeout(logout, logoutInMs);
  }

  function updateExpiry(nextExpiry: number): SessionRefreshResult {
    const result = validateExpiry(nextExpiry);
    if (!result.ok) {
      options.onError?.(result.error);
      return result;
    }

    expiresAtEpochMs = nextExpiry;
    hasLoggedOut = false;
    schedule();
    return result;
  }

  return {
    start: schedule,
    stop: clearTimers,
    updateExpiry,
  };
}

export interface SessionTimeoutModalOptions {
  title?: string;
  message?: string;
  stayLoggedInLabel?: string;
  documentRef?: Document;
}

export function showSessionTimeoutModal(
  warning: SessionTimeoutWarning,
  options: SessionTimeoutModalOptions = {}
): () => void {
  const documentRef = options.documentRef ?? (typeof document !== 'undefined' ? document : undefined);
  if (!documentRef) return () => undefined;

  const overlay = documentRef.createElement('div');
  overlay.setAttribute('role', 'presentation');
  overlay.className = 'session-timeout-modal__overlay';

  const dialog = documentRef.createElement('section');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'session-timeout-title');
  dialog.className = 'session-timeout-modal';

  const title = documentRef.createElement('h2');
  title.id = 'session-timeout-title';
  title.textContent = options.title ?? 'Your session is about to expire';

  const message = documentRef.createElement('p');
  message.textContent =
    options.message ?? `You will be signed out in ${warning.secondsRemaining} seconds.`;

  const cta = documentRef.createElement('button');
  cta.type = 'button';
  cta.textContent = options.stayLoggedInLabel ?? 'Stay logged in';
  cta.addEventListener('click', () => {
    void warning.stayLoggedIn().then((result) => {
      if (result.ok) cleanup();
    });
  });

  dialog.append(title, message, cta);
  overlay.append(dialog);
  documentRef.body.append(overlay);

  function cleanup(): void {
    overlay.remove();
  }

  return cleanup;
}
