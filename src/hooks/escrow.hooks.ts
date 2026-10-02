import { KeyEscrowEvent } from '../types/notification.types';
import { notificationService } from '../services/notification.service';
import { logger } from '../logger';

/**
 * @notice Payload representing context surrounding an escrow event.
 */
export interface EscrowEventPayload {
  contractId: string;
  userEmail: string;
  userId: string;
  amount?: string;
  reason?: string;
}

/**
 * Result for a single notification channel dispatch attempt.
 *
 * @property channel  - The notification channel that was attempted.
 * @property success  - Whether the channel completed without throwing.
 * @property message  - Optional description of failure when `success` is false.
 */
export interface EscrowChannelResult {
  channel: 'email' | 'web';
  success: boolean;
  message?: string;
}

/**
 * Aggregated result returned by `EscrowHooks.onEscrowEvent`.
 *
 * Callers can inspect `channels` to determine which channels succeeded and
 * which failed, and apply per-channel retry or alerting strategies without
 * re-running the entire dispatch.
 *
 * @property allSucceeded  - `true` only when every channel succeeded.
 * @property anySucceeded  - `true` when at least one channel succeeded.
 * @property channels      - Per-channel outcome array (one entry per channel).
 */
export interface EscrowDispatchResult {
  allSucceeded: boolean;
  anySucceeded: boolean;
  channels: EscrowChannelResult[];
}

/**
 * @title EscrowHooks
 * @notice Centralized handler for dispatching multi-channel notifications.
 * @dev Hooks into the main protocol lifecycle to notify involved parties.
 */
export class EscrowHooks {
  /**
   * @notice Trigger notifications for a generic key escrow event across all
   *         supported channels (email and web/in-app).
   *
   * @dev
   * Uses `Promise.allSettled` so that a failure in one channel **never**
   * prevents the other channel from being attempted. Each channel outcome is
   * logged individually at the appropriate level (info / warn / error).  No
   * PII (e.g. the raw email address or message body) is written to logs —
   * only `contractId` and `userId` from the payload are included as
   * correlation identifiers.
   *
   * @param event   The triggered {@link KeyEscrowEvent}.
   * @param payload The context details of the escrow event.
   * @returns       An {@link EscrowDispatchResult} summarising per-channel outcomes.
   */
  public static async onEscrowEvent(
    event: KeyEscrowEvent,
    payload: EscrowEventPayload,
  ): Promise<EscrowDispatchResult> {
    const { userEmail, userId, contractId } = payload;

    // Fan-out to all channels concurrently.  allSettled guarantees every
    // promise is awaited regardless of individual rejections.
    const [emailOutcome, webOutcome] = await Promise.allSettled([
      notificationService.sendEmail(userEmail, event, payload),
      notificationService.sendWebNotification(userId, event, payload),
    ]);

    const channels: EscrowChannelResult[] = [
      EscrowHooks.resolveChannelResult('email', emailOutcome, { contractId, userId }),
      EscrowHooks.resolveChannelResult('web', webOutcome, { contractId, userId }),
    ];

    const allSucceeded = channels.every(c => c.success);
    const anySucceeded = channels.some(c => c.success);

    if (allSucceeded) {
      logger.info('[EscrowHooks] All notification channels dispatched successfully', {
        event,
        contractId,
        userId,
      });
    } else if (anySucceeded) {
      logger.warn('[EscrowHooks] One or more notification channels failed', {
        event,
        contractId,
        userId,
        channels,
      });
    } else {
      logger.error('[EscrowHooks] All notification channels failed', {
        event,
        contractId,
        userId,
        channels,
      });
    }

    return { allSucceeded, anySucceeded, channels };
  }

  /**
   * @internal
   * Maps a single `Promise.allSettled` outcome to a typed {@link EscrowChannelResult}.
   * Logs channel-level success or failure with safe correlation fields only —
   * no PII is included.
   *
   * @param channel  - The channel name for logging/reporting.
   * @param outcome  - The settled promise result for this channel.
   * @param ctx      - Safe correlation identifiers (`contractId`, `userId`).
   */
  private static resolveChannelResult(
    channel: 'email' | 'web',
    outcome: PromiseSettledResult<{ success: boolean; message?: string }>,
    ctx: { contractId: string; userId: string },
  ): EscrowChannelResult {
    if (outcome.status === 'fulfilled') {
      const { success, message } = outcome.value;
      if (success) {
        logger.info(`[EscrowHooks] ${channel} channel succeeded`, {
          channel,
          contractId: ctx.contractId,
          userId: ctx.userId,
        });
        return { channel, success: true };
      }
      // The service returned success:false without throwing — treat as failure.
      logger.warn(`[EscrowHooks] ${channel} channel reported failure`, {
        channel,
        contractId: ctx.contractId,
        userId: ctx.userId,
        message,
      });
      return { channel, success: false, message };
    }

    // status === 'rejected' — the promise itself threw
    const err = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
    logger.error(`[EscrowHooks] ${channel} channel threw an exception`, {
      channel,
      contractId: ctx.contractId,
      userId: ctx.userId,
      err,
    });
    return { channel, success: false, message: err.message };
  }

  /**
   * @notice Maps state transitions of contracts to KeyEscrowEvents and dispatches notifications.
   *         Filters out unchanged and unknown/ignored states.
   *
   * @param oldStatus Starting contract status.
   * @param newStatus Destination contract status.
   * @param payload Context payload containing required identifiers.
   * @returns Aggregated dispatch result, or null if no notification is triggered.
   */
  public static async onStateTransition(
    oldStatus: string,
    newStatus: string,
    payload: EscrowEventPayload,
  ): Promise<EscrowDispatchResult | null> {
    if (!oldStatus || !newStatus || oldStatus === newStatus) {
      return null;
    }

    let event: KeyEscrowEvent | null = null;

    if (oldStatus === 'draft' && newStatus === 'active') {
      event = KeyEscrowEvent.FUNDS_DEPOSITED; // funded
    } else if (oldStatus === 'active' && newStatus === 'completed') {
      event = KeyEscrowEvent.ESCROW_RESOLVED; // released
    } else if (oldStatus === 'active' && newStatus === 'disputed') {
      event = KeyEscrowEvent.DISPUTE_RAISED; // disputed
    }

    if (!event) {
      return null;
    }

    return EscrowHooks.onEscrowEvent(event, payload);
  }
}
