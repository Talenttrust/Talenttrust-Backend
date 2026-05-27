/**
 * Enum for supported notification transport types.
 */
export enum NotificationType {
  EMAIL = 'EMAIL',
  WEB_PUSH = 'WEB_PUSH',
  APP_UI = 'APP_UI',
}

/**
 * Enum for core Key Escrow protocol events.
 */
export enum KeyEscrowEvent {
  ESCROW_INITIALIZED = 'ESCROW_INITIALIZED',
  FUNDS_DEPOSITED = 'FUNDS_DEPOSITED',
  MILESTONE_APPROVED = 'MILESTONE_APPROVED',
  DISPUTE_RAISED = 'DISPUTE_RAISED',
  ESCROW_RESOLVED = 'ESCROW_RESOLVED',
  ESCROW_CANCELLED = 'ESCROW_CANCELLED',
}

/**
 * Interface representing the payload structure for email notifications.
 */
export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

/**
 * Interface representing the payload structure for web/UI notifications.
 */
export interface WebPayload {
  userId: string;
  title: string;
  message: string;
}
