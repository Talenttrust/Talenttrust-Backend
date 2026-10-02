/**
 * @module milestones/divergence/dependencies
 * @description Production wiring for the milestone divergence scanner.
 *
 * Centralizes the default dependency graph so the processor, scheduler and
 * routes share one consistent construction. Tests inject their own fakes
 * instead of importing this module (constructing the default graph opens the
 * SQLite database and instantiates the Soroban RPC client).
 */

import { getDb } from '../../db/database';
import { milestonesService } from '../../services/milestones.service';
import { SorobanMilestoneChainReader } from './chain-reader';
import { MilestonesServiceIndexedStore, SqliteMilestoneContractProvider } from './indexed-reader';
import { SqliteMilestoneDivergenceRepository } from './repository';
import { MilestoneDivergenceScanner } from './scanner';

export interface DivergenceDependencies {
  scanner: MilestoneDivergenceScanner;
  repository: SqliteMilestoneDivergenceRepository;
}

/** Builds the default scanner over the shared SQLite database. */
export function createDefaultDivergenceDependencies(): DivergenceDependencies {
  const db = getDb();
  const repository = new SqliteMilestoneDivergenceRepository(db);
  const scanner = new MilestoneDivergenceScanner({
    chainReader: new SorobanMilestoneChainReader(),
    indexedStore: new MilestonesServiceIndexedStore(milestonesService),
    contractProvider: new SqliteMilestoneContractProvider(db),
    repository,
  });
  return { scanner, repository };
}

/** Lazily-created default dependencies shared by the processor and routes. */
let defaultDependencies: DivergenceDependencies | null = null;

export function getDefaultDivergenceDependencies(): DivergenceDependencies {
  if (defaultDependencies === null) {
    defaultDependencies = createDefaultDivergenceDependencies();
  }
  return defaultDependencies;
}
