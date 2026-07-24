process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
process.env.NODE_ENV = 'test';

// Mock the notification service module before any imports resolve so that
// the module-level `notificationService` singleton (which calls validateEnv()
// and opens a SQLite connection) is never constructed during tests.
jest.mock('../services/notification.service', () => ({
  notificationService: {
    sendEmail: jest.fn().mockResolvedValue({ success: true }),
    sendWebNotification: jest.fn().mockResolvedValue({ success: true }),
  },
}));

import { KeyEscrowEvent } from '../types/notification.types';
import type { EscrowChannelResult, EscrowDispatchResult } from './escrow.hooks';

let EscrowHooks: any;
let notificationService: any;
let logger: any;

beforeAll(async () => {
  const hooksMod = await import('./escrow.hooks');
  EscrowHooks = hooksMod.EscrowHooks;
  const serviceMod = await import('../services/notification.service');
  notificationService = serviceMod.notificationService;
  const loggerMod = await import('../logger');
  logger = loggerMod.logger;
});

/**
 * Baseline payload used across tests.  All PII-sensitive fields are
 * synthetic test values; none are real addresses.
 */
const BASE_PAYLOAD = {
  contractId: 'C123',
  userEmail: 'client@example.com',
  userId: 'user-abc',
  amount: '1500 USDC',
};

describe('EscrowHooks.onEscrowEvent — channel isolation', () => {
  let sendEmailSpy: jest.SpyInstance;
  let sendWebSpy: jest.SpyInstance;
  let logInfoSpy: jest.SpyInstance;
  let logWarnSpy: jest.SpyInstance;
  let logErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    sendEmailSpy = jest
      .spyOn(notificationService, 'sendEmail')
      .mockResolvedValue({ success: true });
    sendWebSpy = jest
      .spyOn(notificationService, 'sendWebNotification')
      .mockResolvedValue({ success: true });

    logInfoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    logWarnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    logErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  describe('when both channels succeed', () => {
    it('calls sendEmail with the correct arguments', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.ESCROW_INITIALIZED, BASE_PAYLOAD);

      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        BASE_PAYLOAD.userEmail,
        KeyEscrowEvent.ESCROW_INITIALIZED,
        expect.objectContaining({ contractId: 'C123', amount: '1500 USDC' }),
      );
    });

    it('calls sendWebNotification with the correct arguments', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.ESCROW_INITIALIZED, BASE_PAYLOAD);

      expect(sendWebSpy).toHaveBeenCalledTimes(1);
      expect(sendWebSpy).toHaveBeenCalledWith(
        BASE_PAYLOAD.userId,
        KeyEscrowEvent.ESCROW_INITIALIZED,
        expect.objectContaining({ contractId: 'C123', amount: '1500 USDC' }),
      );
    });

    it('returns allSucceeded:true and both channel successes', async () => {
      const result: EscrowDispatchResult = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.ESCROW_INITIALIZED,
        BASE_PAYLOAD,
      );

      expect(result.allSucceeded).toBe(true);
      expect(result.anySucceeded).toBe(true);
      expect(result.channels).toHaveLength(2);
      expect(result.channels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channel: 'email', success: true }),
          expect.objectContaining({ channel: 'web', success: true }),
        ]),
      );
    });

    it('logs a single info-level summary when all channels succeed', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.FUNDS_DEPOSITED, BASE_PAYLOAD);

      const infoMessages = logInfoSpy.mock.calls.map(([msg]) => msg);
      expect(infoMessages).toContain(
        '[EscrowHooks] All notification channels dispatched successfully',
      );
      expect(logWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EscrowHooks] All notification'),
        expect.anything(),
      );
    });
  });

  // ─── Email fails, web succeeds ──────────────────────────────────────────────

  describe('when the email channel rejects', () => {
    beforeEach(() => {
      sendEmailSpy.mockRejectedValue(new Error('SMTP connection refused'));
    });

    it('still attempts the web channel', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.FUNDS_DEPOSITED, BASE_PAYLOAD);

      expect(sendWebSpy).toHaveBeenCalledTimes(1);
    });

    it('returns email:failed and web:succeeded', async () => {
      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.FUNDS_DEPOSITED,
        BASE_PAYLOAD,
      );

      expect(result.allSucceeded).toBe(false);
      expect(result.anySucceeded).toBe(true);

      const emailResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'email');
      const webResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'web');

      expect(emailResult).toEqual({
        channel: 'email',
        success: false,
        message: 'SMTP connection refused',
      });
      expect(webResult).toEqual({ channel: 'web', success: true });
    });

    it('logs an error for the email channel and a warn for the aggregate', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.FUNDS_DEPOSITED, BASE_PAYLOAD);

      const errorMessages = logErrorSpy.mock.calls.map(([msg]) => msg);
      expect(errorMessages).toContain('[EscrowHooks] email channel threw an exception');

      const warnMessages = logWarnSpy.mock.calls.map(([msg]) => msg);
      expect(warnMessages).toContain(
        '[EscrowHooks] One or more notification channels failed',
      );
    });

    it('does not leak PII (email address) in any log call', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.FUNDS_DEPOSITED, BASE_PAYLOAD);

      const allLogArgs = [
        ...logInfoSpy.mock.calls,
        ...logWarnSpy.mock.calls,
        ...logErrorSpy.mock.calls,
      ]
        .map(args => JSON.stringify(args))
        .join(' ');

      expect(allLogArgs).not.toContain('client@example.com');
    });
  });

  // ─── Web fails, email succeeds ──────────────────────────────────────────────

  describe('when the web channel rejects', () => {
    beforeEach(() => {
      sendWebSpy.mockRejectedValue(new Error('WebSocket timeout'));
    });

    it('still attempts the email channel', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.MILESTONE_APPROVED, BASE_PAYLOAD);

      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    });

    it('returns email:succeeded and web:failed', async () => {
      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.MILESTONE_APPROVED,
        BASE_PAYLOAD,
      );

      expect(result.allSucceeded).toBe(false);
      expect(result.anySucceeded).toBe(true);

      const emailResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'email');
      const webResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'web');

      expect(emailResult).toEqual({ channel: 'email', success: true });
      expect(webResult).toEqual({
        channel: 'web',
        success: false,
        message: 'WebSocket timeout',
      });
    });

    it('logs an error for the web channel', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.MILESTONE_APPROVED, BASE_PAYLOAD);

      const errorMessages = logErrorSpy.mock.calls.map(([msg]) => msg);
      expect(errorMessages).toContain('[EscrowHooks] web channel threw an exception');
    });
  });

  // ─── Both channels fail ─────────────────────────────────────────────────────

  describe('when both channels reject', () => {
    beforeEach(() => {
      sendEmailSpy.mockRejectedValue(new Error('Email service down'));
      sendWebSpy.mockRejectedValue(new Error('Web service down'));
    });

    it('does not throw — resolves with both failures', async () => {
      await expect(
        EscrowHooks.onEscrowEvent(KeyEscrowEvent.DISPUTE_RAISED, BASE_PAYLOAD),
      ).resolves.toBeDefined();
    });

    it('returns allSucceeded:false, anySucceeded:false', async () => {
      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.DISPUTE_RAISED,
        BASE_PAYLOAD,
      );

      expect(result.allSucceeded).toBe(false);
      expect(result.anySucceeded).toBe(false);
    });

    it('returns failure entries for both channels', async () => {
      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.DISPUTE_RAISED,
        BASE_PAYLOAD,
      );

      const emailResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'email');
      const webResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'web');

      expect(emailResult).toEqual({
        channel: 'email',
        success: false,
        message: 'Email service down',
      });
      expect(webResult).toEqual({
        channel: 'web',
        success: false,
        message: 'Web service down',
      });
    });

    it('logs an error-level aggregate message', async () => {
      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.DISPUTE_RAISED, BASE_PAYLOAD);

      const errorMessages = logErrorSpy.mock.calls.map(([msg]) => msg);
      expect(errorMessages).toContain('[EscrowHooks] All notification channels failed');
    });
  });

  // ─── Service returns success:false without throwing ─────────────────────────

  describe('when a channel fulfils but reports success:false', () => {
    it('treats email success:false as a failed channel', async () => {
      sendEmailSpy.mockResolvedValue({ success: false, message: 'Recipient rejected' });

      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.ESCROW_RESOLVED,
        BASE_PAYLOAD,
      );

      const emailResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'email');
      expect(emailResult).toEqual({
        channel: 'email',
        success: false,
        message: 'Recipient rejected',
      });
      expect(result.allSucceeded).toBe(false);
      expect(result.anySucceeded).toBe(true); // web still succeeded
    });

    it('treats web success:false as a failed channel', async () => {
      sendWebSpy.mockResolvedValue({ success: false, message: 'User not found' });

      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.ESCROW_CANCELLED,
        BASE_PAYLOAD,
      );

      const webResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'web');
      expect(webResult).toEqual({
        channel: 'web',
        success: false,
        message: 'User not found',
      });
    });

    it('logs a warn for a success:false fulfilment', async () => {
      sendEmailSpy.mockResolvedValue({ success: false, message: 'Recipient rejected' });

      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.ESCROW_RESOLVED, BASE_PAYLOAD);

      const warnMessages = logWarnSpy.mock.calls.map(([msg]) => msg);
      expect(warnMessages).toContain('[EscrowHooks] email channel reported failure');
    });
  });

  // ─── Non-Error rejection values ─────────────────────────────────────────────

  describe('when a channel rejects with a non-Error value', () => {
    it('handles a string rejection gracefully', async () => {
      sendEmailSpy.mockRejectedValue('plain string error');

      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.FUNDS_DEPOSITED,
        BASE_PAYLOAD,
      );

      const emailResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'email');
      expect(emailResult?.success).toBe(false);
      expect(emailResult?.message).toBe('plain string error');
    });

    it('handles a numeric rejection gracefully', async () => {
      sendWebSpy.mockRejectedValue(503);

      const result = await EscrowHooks.onEscrowEvent(
        KeyEscrowEvent.FUNDS_DEPOSITED,
        BASE_PAYLOAD,
      );

      const webResult = result.channels.find((c: EscrowChannelResult) => c.channel === 'web');
      expect(webResult?.success).toBe(false);
      expect(webResult?.message).toBe('503');
    });
  });

  // ─── Correlation fields in logs ─────────────────────────────────────────────

  describe('log correlation fields', () => {
    it('always includes contractId and userId in aggregate log', async () => {
      sendEmailSpy.mockRejectedValue(new Error('fail'));

      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.DISPUTE_RAISED, BASE_PAYLOAD);

      const warnCall = logWarnSpy.mock.calls.find(([msg]) =>
        msg.includes('[EscrowHooks]'),
      );
      expect(warnCall).toBeDefined();
      expect(warnCall![1]).toMatchObject({
        contractId: 'C123',
        userId: 'user-abc',
      });
    });

    it('includes contractId and userId in per-channel error log', async () => {
      sendEmailSpy.mockRejectedValue(new Error('SMTP down'));

      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.FUNDS_DEPOSITED, BASE_PAYLOAD);

      const channelErrorCall = logErrorSpy.mock.calls.find(([msg]) =>
        msg.includes('email channel threw an exception'),
      );
      expect(channelErrorCall).toBeDefined();
      expect(channelErrorCall![1]).toMatchObject({
        contractId: 'C123',
        userId: 'user-abc',
      });
    });
  });

  // ─── All KeyEscrowEvent variants ────────────────────────────────────────────

  describe('handles every KeyEscrowEvent variant', () => {
    const events = Object.values(KeyEscrowEvent);

    it.each(events)('dispatches %s without throwing', async event => {
      const result = await EscrowHooks.onEscrowEvent(event, BASE_PAYLOAD);

      expect(result.channels).toHaveLength(2);
      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendWebSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── State Transitions (Lifecycle Hooks) ────────────────────────────────────

  describe('onStateTransition — contract lifecycle transitions', () => {
    it('dispatches FUNDS_DEPOSITED for draft -> active transition (funded)', async () => {
      const result = await EscrowHooks.onStateTransition('draft', 'active', BASE_PAYLOAD);
      expect(result).not.toBeNull();
      expect(result!.allSucceeded).toBe(true);
      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        BASE_PAYLOAD.userEmail,
        KeyEscrowEvent.FUNDS_DEPOSITED,
        expect.objectContaining({
          contractId: BASE_PAYLOAD.contractId,
          userId: BASE_PAYLOAD.userId,
          userEmail: BASE_PAYLOAD.userEmail,
          amount: BASE_PAYLOAD.amount,
        }),
      );
      expect(sendWebSpy).toHaveBeenCalledTimes(1);
      expect(sendWebSpy).toHaveBeenCalledWith(
        BASE_PAYLOAD.userId,
        KeyEscrowEvent.FUNDS_DEPOSITED,
        expect.objectContaining({
          contractId: BASE_PAYLOAD.contractId,
          userId: BASE_PAYLOAD.userId,
          userEmail: BASE_PAYLOAD.userEmail,
          amount: BASE_PAYLOAD.amount,
        }),
      );
    });

    it('dispatches ESCROW_RESOLVED for active -> completed transition (released)', async () => {
      const result = await EscrowHooks.onStateTransition('active', 'completed', BASE_PAYLOAD);
      expect(result).not.toBeNull();
      expect(result!.allSucceeded).toBe(true);
      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        BASE_PAYLOAD.userEmail,
        KeyEscrowEvent.ESCROW_RESOLVED,
        expect.objectContaining({
          contractId: BASE_PAYLOAD.contractId,
          userId: BASE_PAYLOAD.userId,
          userEmail: BASE_PAYLOAD.userEmail,
        }),
      );
      expect(sendWebSpy).toHaveBeenCalledTimes(1);
    });

    it('dispatches DISPUTE_RAISED for active -> disputed transition (disputed)', async () => {
      const result = await EscrowHooks.onStateTransition('active', 'disputed', BASE_PAYLOAD);
      expect(result).not.toBeNull();
      expect(result!.allSucceeded).toBe(true);
      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        BASE_PAYLOAD.userEmail,
        KeyEscrowEvent.DISPUTE_RAISED,
        expect.objectContaining({
          contractId: BASE_PAYLOAD.contractId,
          userId: BASE_PAYLOAD.userId,
          userEmail: BASE_PAYLOAD.userEmail,
        }),
      );
      expect(sendWebSpy).toHaveBeenCalledTimes(1);
    });

    it('emits no notifications for unchanged states', async () => {
      const statuses = ['draft', 'active', 'completed', 'disputed', 'cancelled'];
      for (const status of statuses) {
        const result = await EscrowHooks.onStateTransition(status, status, BASE_PAYLOAD);
        expect(result).toBeNull();
      }
      expect(sendEmailSpy).not.toHaveBeenCalled();
      expect(sendWebSpy).not.toHaveBeenCalled();
    });

    it('emits no notifications for unknown or ignored transitions', async () => {
      const ignoredTransitions = [
        { old: 'draft', new: 'completed' },
        { old: 'completed', new: 'active' },
        { old: 'unknown_state', new: 'active' },
        { old: 'active', new: 'unknown_state' },
      ];
      for (const transition of ignoredTransitions) {
        const result = await EscrowHooks.onStateTransition(transition.old, transition.new, BASE_PAYLOAD);
        expect(result).toBeNull();
      }
      expect(sendEmailSpy).not.toHaveBeenCalled();
      expect(sendWebSpy).not.toHaveBeenCalled();
    });
  });
});
