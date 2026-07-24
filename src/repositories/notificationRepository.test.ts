import { NotificationRepository } from './notificationRepository';
import { getDb, closeDb } from '../db/database';
import type BetterSqlite3 from 'better-sqlite3';

describe('NotificationRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: NotificationRepository;

  beforeEach(() => {
    // Isolated in-memory database instance with migrations applied
    db = getDb(':memory:');
    repo = new NotificationRepository(db);
  });

  afterEach(() => {
    closeDb();
  });

  describe('saveWebNotification', () => {
    it('should insert a notification record into the database and return a UUID string', () => {
      const userId = 'usr-12345';
      const title = 'Escrow Created';
      const message = 'Your escrow contract #890 has been initialized.';

      const notificationId = repo.saveWebNotification(userId, title, message);

      expect(typeof notificationId).toBe('string');
      expect(notificationId.length).toBeGreaterThan(0);

      // Direct DB query verification
      const rawRow = db
        .prepare<[string], { id: string; user_id: string; title: string; message: string; created_at: string }>(
          'SELECT * FROM notifications WHERE id = ?'
        )
        .get(notificationId);

      expect(rawRow).toBeDefined();
      expect(rawRow?.id).toBe(notificationId);
      expect(rawRow?.user_id).toBe(userId);
      expect(rawRow?.title).toBe(title);
      expect(rawRow?.message).toBe(message);
      expect(rawRow?.created_at).toBeDefined();
      expect(new Date(rawRow!.created_at).getTime()).not.toBeNaN();
    });

    it('should save notifications with special characters and complex payloads', () => {
      const userId = 'usr-special';
      const title = 'Alert: <Script> test & "quotes"';
      const message = JSON.stringify({ event: 'FUNDS_DEPOSITED', amount: 1000, currency: 'USDC' });

      const notificationId = repo.saveWebNotification(userId, title, message);

      const notifications = repo.findByUser(userId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].id).toBe(notificationId);
      expect(notifications[0].title).toBe(title);
      expect(notifications[0].message).toBe(message);
    });
  });

  describe('findByUser', () => {
    it('should return an empty array when no notifications exist for the given user', () => {
      const notifications = repo.findByUser('non-existent-user');
      expect(notifications).toEqual([]);
    });

    it('should return all notifications for a specific user ordered by created_at DESC', async () => {
      const userId = 'usr-multi-notifications';

      // Insert multiple notifications with artificial slight delays to ensure timestamps ordering
      const id1 = repo.saveWebNotification(userId, 'First Alert', 'Initial message');
      // Force small timestamp separation if needed
      await new Promise((r) => setTimeout(r, 10));
      const id2 = repo.saveWebNotification(userId, 'Second Alert', 'Follow-up message');
      await new Promise((r) => setTimeout(r, 10));
      const id3 = repo.saveWebNotification(userId, 'Third Alert', 'Final message');

      const notifications = repo.findByUser(userId);

      expect(notifications).toHaveLength(3);
      // Most recent first (id3 -> id2 -> id1)
      expect(notifications[0].id).toBe(id3);
      expect(notifications[0].title).toBe('Third Alert');
      expect(notifications[1].id).toBe(id2);
      expect(notifications[1].title).toBe('Second Alert');
      expect(notifications[2].id).toBe(id1);
      expect(notifications[2].title).toBe('First Alert');
    });

    it('should isolate notifications between different user IDs', () => {
      const userA = 'user-alpha';
      const userB = 'user-beta';

      repo.saveWebNotification(userA, 'Alpha Notice', 'For Alpha only');
      repo.saveWebNotification(userB, 'Beta Notice', 'For Beta only');

      const notificationsA = repo.findByUser(userA);
      const notificationsB = repo.findByUser(userB);

      expect(notificationsA).toHaveLength(1);
      expect(notificationsA[0].title).toBe('Alpha Notice');

      expect(notificationsB).toHaveLength(1);
      expect(notificationsB[0].title).toBe('Beta Notice');
    });
  });
});
