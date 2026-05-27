/**
 * Test Setup
 * 
 * Mocks BullMQ and Redis connections for testing environment.
 * This allows tests to run without requiring a running Redis instance.
 */

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

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
