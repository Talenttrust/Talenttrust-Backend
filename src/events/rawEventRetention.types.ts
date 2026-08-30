/**
 * @module events/rawEventRetention.types
 * @description Queue payload type for the raw event retention job.
 *
 * Lives in its own module (with no imports) so `src/queue/types.ts` can
 * reference it without a circular dependency.
 */

import type { RawEventNetwork } from './rawEventRetention';

/** Payload accepted by the `RAW_EVENT_RETENTION` queue job. */
export interface RawEventRetentionJobPayload {
  /** Scope the run to one network's retention class. */
  network?: RawEventNetwork;
  /** Bounded override for this run (still capped by the hard limit). */
  maxEvents?: number;
  /** Count candidates without archiving/purging anything. */
  dryRun?: boolean;
  correlationId?: string;
  requestId?: string;
}
