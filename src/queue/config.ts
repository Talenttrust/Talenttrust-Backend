/**
 * Queue Configuration
 * 
 * Centralized configuration for Redis connection and queue settings.
 * Supports environment-based configuration for different deployment environments.
 */

import { ConnectionOptions } from 'bullmq';

export interface QueueConfig {
  redis: ConnectionOptions;
  defaultJobOptions: {
    attempts: number;
    backoff: {
      type: 'exponential';
      delay: number;
    };
    removeOnComplete: number | boolean;
    removeOnFail: number | boolean;
  };
}

/**
 * Get Redis connection configuration from environment variables
 * Falls back to localhost defaults for development
 */
export function getRedisConfig(): ConnectionOptions {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

/**
 * Default queue configuration
 * Provides sensible defaults for job retry logic and cleanup
 */
export const queueConfig: QueueConfig = {
  redis: getRedisConfig(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 1000,
  },
};
