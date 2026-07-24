/**
 * NotificationRepository — SQLite-backed data access for web notifications.
 *
 * Provides typed operations for persisting and retrieving user web notifications
 * from the `notifications` table using prepared statements to prevent SQL injection.
 *
 * Security & Data Integrity Notes:
 *  - Parameterized binding is used for all SQL queries.
 *  - `userId` field isolates notifications across distinct user accounts.
 *  - Results are ordered by `created_at` descending to return the most recent alerts first.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';

/** Raw database row shape returned from SQLite queries (snake_case). */
interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  message: string;
  created_at: string;
}

/** Domain representation of a web notification. */
export interface WebNotification {
  id: string;
  title: string;
  message: string;
  createdAt: string;
}

/**
 * Repository providing typed database access for the `notifications` table.
 *
 * Instantiate with an open `BetterSqlite3.Database` connection instance.
 */
export class NotificationRepository {
  private db: BetterSqlite3.Database;

  /**
   * Initializes the NotificationRepository with an open SQLite database connection.
   *
   * @param db Open `BetterSqlite3.Database` handle.
   */
  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Persists a new web notification for a specific user.
   *
   * @param userId UUID or unique identifier of the target user.
   * @param title Title or event headline for the notification.
   * @param message Detailed body message or JSON payload summary.
   * @returns The generated UUID string primary key for the new notification.
   */
  saveWebNotification(userId: string, title: string, message: string): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare<[string, string, string, string, string]>(
        `INSERT INTO notifications (id, user_id, title, message, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, userId, title, message, createdAt);

    return id;
  }

  /**
   * Retrieves all web notifications for a target user, ordered by creation date descending.
   *
   * @param userId Unique identifier of the user whose notifications should be fetched.
   * @returns Array of `WebNotification` records (empty array if no notifications exist).
   */
  findByUser(userId: string): WebNotification[] {
    const rows = this.db
      .prepare<[string], NotificationRow>(
        `SELECT id, title, message, created_at
         FROM notifications
         WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .all(userId);

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      message: r.message,
      createdAt: r.created_at,
    }));
  }
}
