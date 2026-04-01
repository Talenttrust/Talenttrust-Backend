/**
 * Email Processor Tests
 * 
 * Unit tests for email notification processing.
 */

import { processEmailNotification } from './email-processor';
import { EmailNotificationPayload } from '../types';

describe('Email Processor', () => {
  describe('processEmailNotification', () => {
    it('should process valid email notification', async () => {
      const payload: EmailNotificationPayload = {
        to: 'user@example.com',
        subject: 'Welcome',
        body: 'Welcome to TalentTrust',
      };

      const result = await processEmailNotification(payload);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Email sent');
      expect(result.data).toHaveProperty('emailId');
    });

    it('should process email with template ID', async () => {
      const payload: EmailNotificationPayload = {
        to: 'user@example.com',
        subject: 'Template Email',
        body: 'Body content',
        templateId: 'welcome-template',
      };

      const result = await processEmailNotification(payload);
      expect(result.success).toBe(true);
    });

    it('should reject invalid email address', async () => {
      const payload: EmailNotificationPayload = {
        to: 'invalid-email',
        subject: 'Test',
        body: 'Test body',
      };

      await expect(processEmailNotification(payload)).rejects.toThrow(
        'Invalid email address'
      );
    });

    it('should reject missing subject', async () => {
      const payload: EmailNotificationPayload = {
        to: 'user@example.com',
        subject: '',
        body: 'Test body',
      };

      await expect(processEmailNotification(payload)).rejects.toThrow(
        'Email subject and body are required'
      );
    });

    it('should reject missing body', async () => {
      const payload: EmailNotificationPayload = {
        to: 'user@example.com',
        subject: 'Test',
        body: '',
      };

      await expect(processEmailNotification(payload)).rejects.toThrow(
        'Email subject and body are required'
      );
    });

    it('should handle multiple email formats', async () => {
      const validEmails = [
        'simple@example.com',
        'user.name@example.com',
        'user+tag@example.co.uk',
      ];

      for (const email of validEmails) {
        const payload: EmailNotificationPayload = {
          to: email,
          subject: 'Test',
          body: 'Test body',
        };

        const result = await processEmailNotification(payload);
        expect(result.success).toBe(true);
      }
    });
  });
});
