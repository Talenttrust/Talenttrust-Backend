/**
 * @module milestones/divergence
 * @description Detects divergence between indexed and on-chain milestone state.
 *
 * Entry points:
 *  - `processMilestoneDivergenceScan` — BullMQ processor for the bounded scan
 *    job (registered under {@link JobType.MILESTONE_DIVERGENCE_SCAN}).
 *  - `MilestoneDivergenceScanner` — the bounded comparison service.
 *  - `createMilestoneDivergenceRouter` — admin API to list reports / trigger
 *    a scan.
 *  - `milestoneDivergenceSchedulerService` — optional periodic scheduler.
 */

export * from './types';
export {
  compareMilestone,
  compareContract,
} from './compare';
export {
  DEFAULT_DIVERGENCE_REPORT_LIMIT,
  MAX_DIVERGENCE_REPORT_LIMIT,
  SqliteMilestoneDivergenceRepository,
  InMemoryMilestoneDivergenceRepository,
  toDivergenceReportRecord,
  type MilestoneDivergenceRepository,
} from './repository';
export {
  SorobanMilestoneChainReader,
  decodeMilestoneEntry,
  normalizeMilestoneState,
  MILESTONES_CONTRACT_DATA_KEY,
  type MilestoneChainReader,
  type OnChainMilestoneRead,
} from './chain-reader';
export {
  MilestonesServiceIndexedStore,
  SqliteMilestoneContractProvider,
  toMilestoneState,
  type MilestoneIndexedStore,
  type MilestoneContractProvider,
} from './indexed-reader';
export {
  MilestoneDivergenceScanner,
  DEFAULT_MAX_CONTRACTS_PER_RUN,
  MAX_CONTRACTS_PER_RUN,
  clampMaxContracts,
  sanitizeRpcError,
  type MilestoneDivergenceScannerOptions,
} from './scanner';
export {
  processMilestoneDivergenceScan,
  milestoneDivergenceScanPayloadSchema,
} from './processor';
export {
  MilestoneDivergenceSchedulerService,
  milestoneDivergenceSchedulerService,
} from './scheduler';
export {
  createMilestoneDivergenceRouter,
  type DivergenceRouterOptions,
} from './routes';
