/**
 * Test Setup
 * 
 * Mocks BullMQ and Redis connections for testing environment.
 * This allows tests to run without requiring a running Redis instance.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
extendZodWithOpenApi(z);

// Mock BullMQ classes
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({ id: 'test-job-id' }),
    getJob: jest.fn().mockResolvedValue({
      id: 'test-job-id',
      name: 'test-job',
      data: {},
      progress: 0,
      returnvalue: null,
      failedReason: null,
      getState: jest.fn().mockResolvedValue('completed'),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
  QueueEvents: jest.fn().mockImplementation(() => ({
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
  Job: jest.fn(),
}));

// Mock ioredis
jest.mock('ioredis', () => ({
  default: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

process.env.NODE_ENV = 'test';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.COMPLIANCE_AUDIT_SECRET = 'a'.repeat(32);
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
process.env.STELLAR_RPC_URL = 'https://rpc-testnet.stellar.org';
process.env.SSRF_ALLOW_PRIVATE_HOSTS = 'true';
process.env.REPUTATION_ENABLED = 'true';

// Mock uuid using native crypto.randomUUID to bypass Jest ESM parser issues
import { randomUUID } from 'crypto';
jest.mock('uuid', () => ({
  v4: jest.fn().mockImplementation(() => randomUUID()),
}));

