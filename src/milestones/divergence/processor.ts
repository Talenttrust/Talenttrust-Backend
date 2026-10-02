/**
 * @module milestones/divergence/processor
 * @description BullMQ processor for the milestone divergence scan job.
 *
 * Wraps {@link MilestoneDivergenceScanner} with queue-level concerns:
 * payload validation (terminal on invalid input, so the job is not retried
 * pointlessly), correlation-id propagation, and a structured job result.
 *
 * Retry semantics:
 *  - Invalid payload → throws `InvalidJobPayloadError` (terminal, quarantined).
 *  - Head-ledger RPC failure → the scanner throws; the error propagates so the
 *    queue retries with the job type's backoff policy.
 *  - Per-contract RPC failures → recorded as `unavailable` reports inside the
 *    scan; the job itself succeeds and reports the counts.
 */

import { z } from 'zod';
import { createLogger } from '../../logger';
import { InvalidJobPayloadError } from '../../queue/queue-errors';
import type { JobResult } from '../../queue/types';
import type { MilestoneDivergenceScanPayload } from './types';
import {
  MilestoneDivergenceScanner,
  MAX_CONTRACTS_PER_RUN,
  DEFAULT_MAX_CONTRACTS_PER_RUN,
} from './scanner';
import { getDefaultDivergenceDependencies } from './dependencies';

/** Zod schema for the scan job payload (mirrors the queue payload type). */
export const milestoneDivergenceScanPayloadSchema = z
  .object({
    tenantId: z.string().min(1).max(128).optional(),
    maxContracts: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONTRACTS_PER_RUN)
      .optional(),
    cursor: z.string().max(256).optional(),
    runId: z.string().min(1).max(128).optional(),
    correlationId: z.string().max(256).optional(),
    requestId: z.string().max(256).optional(),
  })
  .strict();

export type MilestoneDivergenceDependencies = {
  scanner?: MilestoneDivergenceScanner;
};

/**
 * Processes one milestone divergence scan job.
 *
 * @param payload - Scan configuration from the queue.
 * @param deps    - Optional injected dependencies (tests); defaults to the
 *                  production wiring.
 */
export async function processMilestoneDivergenceScan(
  payload: MilestoneDivergenceScanPayload,
  deps: MilestoneDivergenceDependencies = {},
): Promise<JobResult> {
  const log = createLogger({
    processor: 'milestone-divergence-scan',
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId && { requestId: payload.requestId }),
  });

  const parsed = milestoneDivergenceScanPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn('Milestone divergence scan rejected: invalid payload', {
      issues: parsed.error.issues.map((i) => i.message),
    });
    throw new InvalidJobPayloadError(
      `Invalid milestone divergence scan payload: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }

  const scanner = deps.scanner ?? getDefaultDivergenceDependencies().scanner;
  const summary = await scanner.run(parsed.data);

  log.info('Milestone divergence scan job completed', {
    runId: summary.runId,
    contractsScanned: summary.contractsScanned,
    inSync: summary.inSync,
    divergent: summary.divergent,
    unavailable: summary.unavailable,
  });

  return {
    success: true,
    message: `Milestone divergence scan completed: ${summary.contractsScanned} contract(s) compared`,
    data: summary,
  };
}
