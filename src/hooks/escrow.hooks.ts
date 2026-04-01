import { KeyEscrowEvent } from '../types/notification.types';
import { notificationService } from '../services/notification.service';

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
 * @title EscrowHooks
 * @notice Centralized handler for dispatching multi-channel notifications.
 * @dev Hooks into the main protocol lifecycle to notify involved parties.
 */
export class EscrowHooks {
  /**
   * @notice Trigger notifications for a generic key escrow event.
   * @dev Ensures that both Email and Web channels are targeted simultaneously.
   * @param event The triggered KeyEscrowEvent.
   * @param payload The context details of the escrow event.
   */
  public static async onEscrowEvent(event: KeyEscrowEvent, payload: EscrowEventPayload): Promise<void> {
    const { userEmail, userId, contractId } = payload;
    
    // In terms of performance, Promise.all runs these asynchronously without blocking each other.
    await Promise.all([
      notificationService.sendEmail(userEmail, event, payload),
      notificationService.sendWebNotification(userId, event, payload)
    ]);
  }
}
