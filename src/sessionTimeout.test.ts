import {
  createSessionTimeoutController,
  type SessionTimeoutWarning,
  showSessionTimeoutModal,
} from './sessionTimeout';

describe('session timeout controller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows a stay logged in warning at T-60s and does not redirect early', () => {
    let currentTime = 1_000;
    const now = jest.fn(() => currentTime);
    const onWarning = jest.fn();
    const redirect = jest.fn();

    const controller = createSessionTimeoutController({
      expiresAtEpochMs: 121_000,
      stayLoggedIn: jest.fn(),
      onWarning,
      now,
      redirect,
    });

    controller.start();
    jest.advanceTimersByTime(59_999);

    expect(onWarning).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();

    currentTime = 61_000;
    jest.advanceTimersByTime(1);

    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toMatchObject({
      kind: 'session-timeout-warning',
      secondsRemaining: 60,
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('auto-logs out and redirects to /signin at T=0', () => {
    const now = jest.fn(() => 1_000);
    const onLogout = jest.fn();
    const redirect = jest.fn();

    const controller = createSessionTimeoutController({
      expiresAtEpochMs: 61_000,
      stayLoggedIn: jest.fn(),
      onWarning: jest.fn(),
      onLogout,
      now,
      redirect,
    });

    controller.start();
    jest.advanceTimersByTime(59_999);

    expect(redirect).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    expect(onLogout).toHaveBeenCalledWith({
      kind: 'session-timeout-logout',
      reason: 'expired',
      redirectTo: '/signin',
    });
    expect(redirect).toHaveBeenCalledWith('/signin');
  });

  it('negative: rejects an already-expired session with a typed error before redirecting', () => {
    const onError = jest.fn();
    const redirect = jest.fn();

    const controller = createSessionTimeoutController({
      expiresAtEpochMs: 999,
      stayLoggedIn: jest.fn(),
      onWarning: jest.fn(),
      onError,
      now: () => 1_000,
      redirect,
    });

    controller.start();

    expect(onError).toHaveBeenCalledWith({
      kind: 'invalid-expiry',
      message: 'Session expiry must be a future epoch millisecond timestamp. Received 999.',
    });
    expect(redirect).toHaveBeenCalledWith('/signin');
  });

  it('stay logged in refreshes the expiry and prevents the original logout', async () => {
    let currentTime = 1_000;
    let warning: SessionTimeoutWarning | undefined;
    const redirect = jest.fn();

    const controller = createSessionTimeoutController({
      expiresAtEpochMs: 61_000,
      stayLoggedIn: jest.fn().mockResolvedValue({ expiresAtEpochMs: 181_000 }),
      onWarning: (nextWarning) => {
        warning = nextWarning;
      },
      now: () => currentTime,
      redirect,
    });

    controller.start();
    jest.advanceTimersByTime(1);

    expect(warning).toBeDefined();

    currentTime = 1_000;
    await expect(warning!.stayLoggedIn()).resolves.toEqual({
      ok: true,
      expiresAtEpochMs: 181_000,
    });

    currentTime = 61_000;
    jest.advanceTimersByTime(60_000);

    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('session timeout modal', () => {
  it('renders a dialog with a stay logged in CTA and cleans up after refresh', async () => {
    const remove = jest.fn();
    const buttonListeners: Array<() => void> = [];
    const created: any[] = [];
    const documentRef = {
      body: {
        append: jest.fn(),
      },
      createElement: jest.fn((tagName: string) => {
        const element = {
          tagName,
          append: jest.fn(),
          remove,
          setAttribute: jest.fn(),
          addEventListener: jest.fn((_event: string, handler: () => void) => {
            buttonListeners.push(handler);
          }),
          className: '',
          id: '',
          textContent: '',
          type: '',
        };
        created.push(element);
        return element;
      }),
    } as unknown as Document;

    const warning: SessionTimeoutWarning = {
      kind: 'session-timeout-warning',
      secondsRemaining: 60,
      stayLoggedIn: jest.fn().mockResolvedValue({ ok: true, expiresAtEpochMs: 120_000 }),
    };

    const cleanup = showSessionTimeoutModal(warning, { documentRef });

    expect(documentRef.body.append).toHaveBeenCalled();
    expect(created.some((element) => element.textContent === 'Stay logged in')).toBe(true);

    buttonListeners[0]();
    await Promise.resolve();
    await Promise.resolve();

    expect(warning.stayLoggedIn).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();

    cleanup();
  });
});
