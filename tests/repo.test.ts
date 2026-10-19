import { MemoryRepository } from '../src/repo/memory';
import { SqliteRepository } from '../src/repo/sqlite';
import { repositoryContract } from './repo.contract';

describe('memory repository', () => repositoryContract(() => new MemoryRepository()));
describe('SQLite repository', () => repositoryContract(() => new SqliteRepository(':memory:')));
