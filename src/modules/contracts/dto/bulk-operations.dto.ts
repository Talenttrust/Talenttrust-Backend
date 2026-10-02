/**
 * @module bulk-operations.dto
 * @description DTOs for bulk contract operations endpoints.
 *
 * Design:
 * - Bulk request wraps an array of single-item operations (each using exact same schema as single endpoint)
 * - Batch size is capped to prevent resource exhaustion
 * - Response includes per-item success/error results, allowing client to retry failures
 */

import { z } from "zod";
import { createContractSchema, QUERY_LIMIT_MAX } from "./contract.dto";

/**
 * Maximum number of items in a single bulk operation batch.
 * Set to match MAX_PAGE_LIMIT convention (100) for consistency with other list endpoints.
 * Can be made config-driven later if needed.
 */
export const BULK_OPERATION_MAX_BATCH_SIZE = 100;

/**
 * Schema for bulk create contracts request.
 *
 * Array of items, each shaped exactly like a single POST /contracts request body.
 * Must have between 1 and BULK_OPERATION_MAX_BATCH_SIZE items.
 * Empty array is rejected (almost certainly a client bug).
 */
export const bulkCreateContractsSchema = z.object({
  body: z.union([
    z
      .array(z.record(z.unknown()))
      .min(1, "items array must not be empty (at least 1 item required)")
      .max(
        BULK_OPERATION_MAX_BATCH_SIZE,
        `items array must not exceed ${BULK_OPERATION_MAX_BATCH_SIZE} items`,
      ),
    z.object({
      operations: z
        .array(z.record(z.unknown()))
        .min(1, "operations array must not be empty")
        .max(BULK_OPERATION_MAX_BATCH_SIZE),
    }),
    z.object({
      items: z
        .array(z.record(z.unknown()))
        .min(1, "items array must not be empty")
        .max(BULK_OPERATION_MAX_BATCH_SIZE),
    }),
  ]),
});

/**
 * Per-item result in a bulk response: either a success (with the created contract) or an error.
 */
export interface BulkItemSuccessResult<T> {
  status: "success";
  code: number; // HTTP status code (e.g., 201 for created)
  data: T;
}

export interface BulkItemErrorResult {
  status: "error";
  code: number; // HTTP status code (e.g., 400, 422, 403)
  error: {
    code: string; // Error code (e.g., 'validation_error', 'unauthorized')
    message: string;
  };
}

export type BulkItemResult<T> = BulkItemSuccessResult<T> | BulkItemErrorResult;

/**
 * Response for bulk create contracts endpoint.
 * Includes per-item results and overall summary.
 */
export interface BulkCreateContractsResponse<T = any> {
  /**
   * Array of per-item results, positionally matched to the request items.
   * A failed item's result includes an error; a successful item includes the created contract.
   */
  items: BulkItemResult<T>[];

  /**
   * Summary statistics.
   */
  summary: {
    total: number; // Total items in the batch
    succeeded: number; // Number of successfully created items
    failed: number; // Number of failed items
  };
}
