/**
 * Data Purge Module with Dry-Run Support
 *
 * Provides safe data purging capabilities with a dry-run mode that reports
 * candidate row counts per table without deleting anything.
 *
 * @module retention/purge
 */

import { StorageManager, InMemoryStorageProvider, ArchivalStorageType, RetainedData } from './index';
import { maskEmail, REDACTED } from '../audit/redact';

/** Result of counting candidates for purge */
export interface PurgeCandidateCount {
  table: string;
  count: number;
}

/** Options for purge operation */
export interface PurgeOptions {
  /** If true, only count candidates without deleting */
  dryRun?: boolean;
}

/** Result of purge operation */
export interface PurgeResult {
  dryRun: boolean;
  candidates: PurgeCandidateCount[];
  deleted: number;
  failed: number;
}

/** Storage type to table name mapping for reporting */
const STORAGE_TABLE_MAP: Record<ArchivalStorageType, string> = {
  [ArchivalStorageType.LOCAL]: 'local_data',
  [ArchivalStorageType.CLOUD]: 'cloud_data',
  [ArchivalStorageType.COLD_STORAGE]: 'cold_storage',
  [ArchivalStorageType.ENCRYPTED_ARCHIVE]: 'encrypted_archive',
};

/**
 * Redacts sensitive data for safe logging.
 * Uses the same redaction logic as audit logs.
 *
 * @param data - Data to redact
 * @returns Redacted representation safe for logs
 */
function redactForLog(data: RetainedData): Record<string, unknown> {
  return {
    id: data.id,
    entityType: data.entityType,
    classification: data.classification,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    isArchived: data.isArchived,
    // Redact the actual data payload - never log raw PII
    data: REDACTED,
    metadata: data.metadata ? REDACTED : undefined,
  };
}

/**
 * Redacts a string value, masking emails if present.
 *
 * @param value - String value to potentially redact
 * @returns Redacted string safe for logs
 */
function redactString(value: string): string {
  return maskEmail(value);
}

/**
 * Formats candidate counts for output, ensuring no raw PII.
 *
 * @param candidates - Candidate counts per table
 * @returns Formatted output safe for logging
 */
function formatCandidateOutput(candidates: PurgeCandidateCount[]): string {
  const lines = candidates.map(c => {
    const countStr = c.count.toString();
    return `  ${c.table}: ${countStr} rows`;
  });
  return `Purge candidates:\n${lines.join('\n')}`;
}

/**
 * Check if dry-run mode is enabled via environment variable.
 * RETENTION_DRY_RUN=true enables dry-run mode.
 *
 * @returns True if dry-run mode is enabled via env
 */
export function isDryRunFromEnv(): boolean {
  return process.env.RETENTION_DRY_RUN === 'true';
}

/**
 * Parse command-line arguments for dry-run flag.
 * Supports both --dry-run and --dry-run=true formats.
 *
 * @param args - Command-line arguments (defaults to process.argv)
 * @returns True if --dry-run flag is present
 */
export function isDryRunFromArgs(args: string[] = process.argv): boolean {
  return args.some(arg => arg === '--dry-run' || arg === '--dry-run=true');
}

/**
 * Count purge candidates across all storage types.
 * Reuses the exact same query logic as the real purge.
 *
 * @param storageManager - Storage manager instance
 * @param postArchivalRetentionDays - Days to retain after archival
 * @returns Array of candidate counts per table
 */
async function countPurgeCandidates(
  storageManager: StorageManager,
  postArchivalRetentionDays: number,
): Promise<PurgeCandidateCount[]> {
  const candidates: PurgeCandidateCount[] = [];
  const now = Date.now();
  const postArchivalMs = postArchivalRetentionDays * 24 * 60 * 60 * 1000;

  // Check local storage for expired non-archived data
  const localProvider = storageManager.getProvider(ArchivalStorageType.LOCAL);
  const localData = await localProvider.list();
  let localCount = 0;
  for (const data of localData) {
    if (!data.isArchived && data.expiresAt.getTime() < now) {
      localCount++;
    }
  }
  candidates.push({ table: STORAGE_TABLE_MAP[ArchivalStorageType.LOCAL], count: localCount });

  // Check archive storage for post-archival expired data
  // Track unique items across all archive types to avoid double-counting
  // since COLD_STORAGE and ENCRYPTED_ARCHIVE share the same provider
  const archiveTypes = [ArchivalStorageType.COLD_STORAGE, ArchivalStorageType.ENCRYPTED_ARCHIVE];
  const seenArchiveIds = new Set<string>();
  
  for (const storageType of archiveTypes) {
    const provider = storageManager.getProvider(storageType);
    const archivedData = await provider.list();
    let archiveCount = 0;
    for (const data of archivedData) {
      // Skip items already counted from another archive type (same provider)
      if (seenArchiveIds.has(data.id)) {
        continue;
      }
      if (data.isArchived && data.archivedAt) {
        const archivalAge = now - data.archivedAt.getTime();
        if (archivalAge > postArchivalMs) {
          archiveCount++;
          seenArchiveIds.add(data.id);
        }
      }
    }
    candidates.push({ table: STORAGE_TABLE_MAP[storageType], count: archiveCount });
  }

  return candidates;
}

/**
 * Execute the purge operation.
 *
 * When dryRun is true:
 * - Reports candidate row counts per table
 * - Does NOT delete any data
 * - Uses the exact same query logic as real purge
 *
 * When dryRun is false:
 * - Actually deletes expired/archived data
 * - Returns counts of deleted rows
 *
 * All output is redacted - no raw PII in logs.
 *
 * @param storageManager - Storage manager instance
 * @param postArchivalRetentionDays - Days to retain after archival (default: 30)
 * @param options - Purge options including dryRun flag
 * @returns Purge result with candidate counts and deletion stats
 */
export async function executePurge(
  storageManager: StorageManager,
  postArchivalRetentionDays: number = 30,
  options: PurgeOptions = {},
): Promise<PurgeResult> {
  const dryRun = options.dryRun ?? (isDryRunFromEnv() || isDryRunFromArgs());

  // Count candidates using the exact same query logic
  const candidates = await countPurgeCandidates(storageManager, postArchivalRetentionDays);

  // In dry-run mode, just report counts without deleting
  if (dryRun) {
    const output = formatCandidateOutput(candidates);
    console.log(`[DRY-RUN] ${output}`);
    return {
      dryRun: true,
      candidates,
      deleted: 0,
      failed: 0,
    };
  }

  // Real purge: delete the data
  const now = Date.now();
  const postArchivalMs = postArchivalRetentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let failed = 0;

  try {
    // Delete expired non-archived data from local storage
    const localProvider = storageManager.getProvider(ArchivalStorageType.LOCAL);
    const localData = await localProvider.list();
    for (const data of localData) {
      if (!data.isArchived && data.expiresAt.getTime() < now) {
        try {
          const success = await storageManager.delete(data.id, ArchivalStorageType.LOCAL);
          if (success) {
            deleted++;
          }
        } catch {
          failed++;
        }
      }
    }

    // Delete post-archival expired data from archive storage
    // Track unique items across all archive types to avoid double-deleting
    // since COLD_STORAGE and ENCRYPTED_ARCHIVE share the same provider
    const archiveTypes = [ArchivalStorageType.COLD_STORAGE, ArchivalStorageType.ENCRYPTED_ARCHIVE];
    const seenArchiveIds = new Set<string>();
    
    for (const storageType of archiveTypes) {
      const provider = storageManager.getProvider(storageType);
      const archivedData = await provider.list();
      for (const data of archivedData) {
        // Skip items already processed from another archive type (same provider)
        if (seenArchiveIds.has(data.id)) {
          continue;
        }
        if (data.isArchived && data.archivedAt) {
          const archivalAge = now - data.archivedAt.getTime();
          if (archivalAge > postArchivalMs) {
            seenArchiveIds.add(data.id);
            try {
              const success = await storageManager.delete(data.id, storageType);
              if (success) {
                deleted++;
              }
            } catch {
              failed++;
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error during purge:', error instanceof Error ? error.message : 'Unknown error');
  }

  // Log results with redaction
  const output = formatCandidateOutput(candidates);
  console.log(`[PURGE] ${output}`);
  console.log(`[PURGE] Deleted: ${deleted} rows, Failed: ${failed}`);

  return {
    dryRun: false,
    candidates,
    deleted,
    failed,
  };
}

/**
 * Run purge with explicit dry-run flag.
 * Convenience function that wraps executePurge.
 *
 * @param storageManager - Storage manager instance
 * @param postArchivalRetentionDays - Days to retain after archival
 * @param dryRun - If true, only report counts without deleting
 * @returns Purge result
 */
export async function runPurge(
  storageManager: StorageManager,
  postArchivalRetentionDays: number = 30,
  dryRun: boolean = false,
): Promise<PurgeResult> {
  return executePurge(storageManager, postArchivalRetentionDays, { dryRun });
}

export { redactForLog, redactString, formatCandidateOutput };
