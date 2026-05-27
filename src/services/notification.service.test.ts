import { notificationService } from './notification.service';
import { KeyEscrowEvent } from '../types/notification.types';

describe('NotificationService', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Mock transport outputs
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('sendEmail', () => {
    it('should successfully send an email for a valid payload', async () => {
      const result = await notificationService.sendEmail('test@example.com', KeyEscrowEvent.ESCROW_INITIALIZED, { id: '123' });
      expect(result).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[NotificationService:Email] Sending mail to test@example.com',
        expect.objectContaining({ to: 'test@example.com', subject: 'Notification: ESCROW_INITIALIZED' })
      );
    });

    it('should fail cleanly and log error on invalid email address', async () => {
      const result = await notificationService.sendEmail('invalid-email-no-at', KeyEscrowEvent.FUNDS_DEPOSITED);
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[NotificationService:Email] Failed to send email for event FUNDS_DEPOSITED',
        'Invalid email address'
      );
    });

    it('should fail cleanly and log error on empty email address', async () => {
      const result = await notificationService.sendEmail('', KeyEscrowEvent.DISPUTE_RAISED);
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[NotificationService:Email] Failed to send email for event DISPUTE_RAISED',
        'Invalid email address'
      );
    });
  });

  describe('sendWebNotification', () => {
    it('should successfully send a web notification for a valid payload', async () => {
      const result = await notificationService.sendWebNotification('user123', KeyEscrowEvent.MILESTONE_APPROVED, { amount: 500 });
      expect(result).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[NotificationService:Web] Sending web alert to user123',
        expect.objectContaining({ userId: 'user123', title: 'Alert: MILESTONE_APPROVED' })
      );
    });

    it('should fail cleanly and log error on empty userId', async () => {
      const result = await notificationService.sendWebNotification('', KeyEscrowEvent.ESCROW_RESOLVED);
      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[NotificationService:Web] Failed to send web alert for event ESCROW_RESOLVED',
        'Invalid user ID'
      );
    });
  });
});
