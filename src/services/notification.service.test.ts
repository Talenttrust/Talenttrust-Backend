import { NotificationService } from './notification.service';
import { NotificationTransport } from './notification.transport';
import { NotificationRepository } from '../repositories/notificationRepository';
import { getDb, closeDb } from '../db/database';
import { KeyEscrowEvent } from '../types/notification.types';

describe('NotificationService', () => {
  let transportMock: NotificationTransport;
  let repo: NotificationRepository;
  let svc: NotificationService;

  beforeEach(() => {
    transportMock = {
      sendEmail: jest.fn().mockResolvedValue({ success: true }),
      sendWebNotification: jest.fn().mockResolvedValue({ success: true }),
    } as unknown as NotificationTransport;

    // Use in-memory DB for isolation
    const db = getDb(':memory:');
    repo = new NotificationRepository(db);
    svc = new NotificationService({ emailTransport: transportMock, webTransport: transportMock, repo });
  });

  afterEach(() => {
    jest.resetAllMocks();
    closeDb();
  });

  describe('sendEmail', () => {
    it('should successfully send an email for a valid payload', async () => {
      const result = await svc.sendEmail('test@example.com', KeyEscrowEvent.ESCROW_INITIALIZED, { id: '123' });
      expect(result.success).toBe(true);
      expect(transportMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'test@example.com' }));
    });

    it('should fail cleanly on invalid email address', async () => {
      const result = await svc.sendEmail('invalid-email-no-at', KeyEscrowEvent.FUNDS_DEPOSITED);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid email address/);
      expect(transportMock.sendEmail).not.toHaveBeenCalled();
    });

    it('should reject header-injection attempts', async () => {
      const result = await svc.sendEmail('victim@example.com\nBCC:attacker@example.com', KeyEscrowEvent.DISPUTE_RAISED);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid email address/);
      expect(transportMock.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('sendWebNotification', () => {
    it('should persist and send a web notification for a valid payload', async () => {
      const res = await svc.sendWebNotification('user123', KeyEscrowEvent.MILESTONE_APPROVED, { amount: 500 });
      expect(res.success).toBe(true);
      expect(transportMock.sendWebNotification).toHaveBeenCalled();

      const entries = repo.findByUser('user123');
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].title).toContain('MILESTONE_APPROVED');
    });

    it('should fail cleanly on empty userId', async () => {
      const result = await svc.sendWebNotification('', KeyEscrowEvent.ESCROW_RESOLVED);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid user ID/);
      expect(transportMock.sendWebNotification).not.toHaveBeenCalled();
    });
  });
});
