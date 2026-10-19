import { MemoryRepository } from './memory';
import { SqliteRepository } from './sqlite';
import { EscrowRepository } from './types';
import { storageConfig } from '../config';

export function createRepository(options: ReturnType<typeof storageConfig>): EscrowRepository {
  return options.driver === 'sqlite' ? new SqliteRepository(options.path) : new MemoryRepository();
}
