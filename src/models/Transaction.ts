/**
 * Transaction statuses.
 */
export enum TransactionStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
}

/**
 * Interface representing a blockchain transaction in the system.
 */
export interface Transaction {
  hash: string;
  status: TransactionStatus;
  receipt?: any;
  lastCheckedAt?: Date;
  retryCount: number;
}

/**
 * Simple in-memory storage for transactions (mocking a database).
 */
export const transactionsDb: Map<string, Transaction> = new Map();
