import { KeyEscrowEvent, EmailPayload, WebPayload } from '../types/notification.types';

/**
 * @title NotificationService
 * @notice Service responsible for dispatching email and web push notifications.
 * @dev All transport layers (SMTP, WebPush) are currently mocked with console logs.
 * Care must be taken to sanitize user inputs and prevent info leakage on errors.
 */
export class NotificationService {
  /**
   * @notice Sends an email notification to the specified recipient.
   * @dev In production, this would integrate with an SMTP service (e.g. SendGrid, AWS SES).
   * Note on security: `to` address must be validated/sanitized before passing to the real transport
   * to prevent header injection or SSRF using email providers.
   * Rate limiting should also be implemented per recipient email to prevent email bombing.
   * 
   * @param to The recipient's email address.
   * @param event The Key Escrow event triggering this notification.
   * @param data Optional context data for the email template.
   * @return A boolean indicating whether the email was queued/sent successfully.
   */
  public async sendEmail(to: string, event: KeyEscrowEvent, data?: any): Promise<boolean> {
    try {
      if (!to || !to.includes('@')) {
        throw new Error('Invalid email address');
      }

      const payload: EmailPayload = {
        to,
        subject: `Notification: ${event}`,
        body: `Event ${event} has occurred with data: ${JSON.stringify(data || {})}`
      };

      // Ensure no sensitive data leakage by catching and standardizing errors
      // Mocking transport Layer
      console.log(`[NotificationService:Email] Sending mail to ${payload.to}`, payload);
      
      return true;
    } catch (error) {
      console.error(`[NotificationService:Email] Failed to send email for event ${event}`, (error as Error).message);
      return false; // Fail safe
    }
  }

  /**
   * @notice Sends a web push/in-app notification to the specified user.
   * @dev In production, this would persist to a database or use WebSockets/Firebase Push.
   * Security constraints: The `userId` must be authorized against the active session
   * to prevent IDOR vulnerabilities (one user pushing notifications to another).
   * 
   * @param userId The unique identifier of the target user.
   * @param event The Key Escrow event triggering this notification.
   * @param data Optional context data for the UI payload.
   * @return A boolean indicating whether the notification was dispatched successfully.
   */
  public async sendWebNotification(userId: string, event: KeyEscrowEvent, data?: any): Promise<boolean> {
    try {
      if (!userId) {
        throw new Error('Invalid user ID');
      }

      const payload: WebPayload = {
        userId,
        title: `Alert: ${event}`,
        message: `Details: ${JSON.stringify(data || {})}`
      };

      // Mocking transport Layer
      console.log(`[NotificationService:Web] Sending web alert to ${payload.userId}`, payload);

      return true;
    } catch (error) {
      console.error(`[NotificationService:Web] Failed to send web alert for event ${event}`, (error as Error).message);
      return false; // Fail safe
    }
  }
}

export const notificationService = new NotificationService();
