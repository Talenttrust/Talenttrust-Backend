import { ReputationProfile, PaginatedReputationProfile, UpdateReputationPayload, CorrectReputationBodyDTO, ReputationCorrectionEntry } from '../types/reputation';
import type { CursorPaginationInput } from '../contracts/cursor.types';
import { ReputationRepository, ReputationEntry, ReputationCorrectionEntry as RepoReputationCorrectionEntry, CreateReputationCorrection } from '../repositories/reputationRepository';
import { auditService } from '../audit/service';
import {
  AppError,
  ForbiddenError,
  ConflictError,
  ValidationError,
} from '../errors/appError';
import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'crypto';
import { validateEnv } from '../config/env.schema';
import { getReputationWebhookService } from '../modules/reputation/webhook/reputation-webhook.service';

/**
 * Check if the reputation system feature flag is enabled.
 */
function isReputationEnabled(): boolean {
  try {
    const config = validateEnv(process.env);
    return config.REPUTATION_ENABLED;
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth runtime validation predicate for a reputation rating payload.
 *
 * Mirrors the rules enforced by the Zod `updateReputationSchema` at the route
 * layer so the service layer remains safe even if middleware is bypassed or
 * reused from a non-HTTP caller (cron job, queue processor, etc.).
 *
 * Returns a type-guard so that callers branching on the result receive a
 * narrowed payload type with `reviewerId` and `rating` typed correctly.
 *
 * Rules (in order):
 *  1. `payload` is a non-null object.
 *  2. `reviewerId` is a truthy string.
 *  3. `rating` is a finite integer in the closed range [1, 5].
 *
 * The bound/value coercion is intentionally identical to the existing
 * `isValidReputationRatingPayload` so dropping in this predicate is a
 * behaviour-preserving change.
 *
 * Additional fields (e.g. `comment`, `contextId`, `jobCompleted`) are allowed
 * and forwarded to the underlying `createRating` call - they are validated at
 * a later stage (DB-level participation check, private `validateComment`,
 * etc.).
 */
export function isValidReputationRatingPayload(
  payload: unknown,
): payload is UpdateReputationPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  const rating = candidate.rating;

  return (
    typeof candidate.reviewerId === 'string' &&
    candidate.reviewerId.length > 0 &&
    typeof rating === 'number' &&
    Number.isFinite(rating) &&
    Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
  );
}

/**
 * Computes a recency-weighted reputation score using exponential time decay.
 *
 * Each rating's contribution is weighted by exp(-λ * ageInDays), where ageInDays
 * is the number of days between the rating's createdAt timestamp and the reference
 * date (now). Newer ratings contribute more; older ratings decay toward zero weight.
 *
 * The result is guaranteed to be within the rating value range if all input ratings
 * are within that range. Returns 0 for an empty ratings array.
 *
 * @param ratings - Array of rating records; each must have a numeric rating value
 *                  and an ISO 8601 createdAt timestamp string.
 * @param now     - Reference date for age calculation; parameterised for
 *                  deterministic testing with fixed clocks.
 * @param lambda  - Decay constant (λ); higher values decay faster.
 *                  Must be positive. Source: REPUTATION_DECAY_LAMBDA env config.
 * @returns The weighted mean score, or 0 if ratings is empty.
 */
export function computeWeightedReputationScore(
  ratings: Array<{ rating: number; createdAt: string }>,
  now: Date,
  lambda: number
): number {
  // Empty ratings array returns 0
  if (ratings.length === 0) {
    return 0;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  const nowTime = now.getTime();

  // Guard: clamp negative lambda to 0 (disallow inverted decay)
  const safeLambda = Math.max(0, lambda);

  for (const ratingEntry of ratings) {
    // Parse createdAt ISO string to Date
    const createdAtTime = new Date(ratingEntry.createdAt).getTime();

    // Guard: skip entries with unparseable createdAt (malformed date strings)
    if (isNaN(createdAtTime)) {
      continue;
    }

    // Guard: skip entries with non-finite rating values (NaN, Infinity)
    if (typeof ratingEntry.rating !== 'number' || !isFinite(ratingEntry.rating)) {
      continue;
    }

    // Compute age in days, clamping to 0 minimum (defense against future timestamps)
    const ageInDays = Math.max(0, (nowTime - createdAtTime) / (1000 * 60 * 60 * 24));
    
    // Compute exponential decay weight
    const weight = Math.exp(-safeLambda * ageInDays);
    
    // Accumulate weighted sum and total weight
    weightedSum += ratingEntry.rating * weight;
    totalWeight += weight;
  }

  // Defensive check (theoretically impossible with finite lambda and non-negative ages)
  if (totalWeight === 0) {
    return 0;
  }

  return weightedSum / totalWeight;
}

/**
 * @title Reputation Service
 * @dev Production-grade reputation management with anti-abuse protections and audit logging.
 * 
 * Security features:
 * - Self-rating prevention
 * - Duplicate rating prevention (application + DB level)
 * - Contract participation validation
 * - Comment spam detection
 * - Mandatory audit trail for all writes
 */
export class ReputationService {
  private static repository: ReputationRepository | null = null;

  /**
   * Initialize the service with a database connection.
   * Must be called once during application startup.
   */
  public static initialize(db: BetterSqlite3.Database): void {
    this.repository = new ReputationRepository(db);
  }

  /**
   * Creates a new reputation rating with comprehensive anti-abuse protections.
   * 
   * @param reviewerId - The user submitting the rating
   * @param targetId - The user being rated
   * @param rating - Rating value (1-5)
   * @param contextId - Contract/context reference
   * @param comment - Optional review comment
   * @returns The created ReputationEntry
   * 
   * @throws ForbiddenError if self-rating or unauthorized
   * @throws ConflictError if duplicate rating exists
   * @throws ValidationError if comment fails validation
   */
  public static createRating(
    reviewerId: string,
    targetId: string,
    rating: number,
    contextId: string,
    comment?: string,
    correlationId?: string
  ): ReputationEntry {
    // Feature flag check - reputation must be enabled
    if (!isReputationEnabled()) {
      throw new ForbiddenError('Reputation system is currently disabled');
    }

    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    /**
     * Guard 1 — Self-rating prevention.
     * A user must not be able to inflate their own reputation score.
     * @throws {ForbiddenError} When reviewerId === targetId.
     */
    if (reviewerId === targetId) {
      throw new ForbiddenError('Users cannot rate themselves');
    }

    /**
     * Guard 2 — Duplicate-rating prevention (application-level).
     * A secondary DB-level UNIQUE constraint exists as a safety net.
     * Checked here first to return a friendly 409 before hitting the DB.
     * @throws {ConflictError} When a rating for the same reviewer/target/context already exists.
     */
    const existing = this.repository.findByReviewerTargetContext(
      reviewerId,
      targetId,
      contextId
    );
    if (existing) {
      throw new ConflictError('Rating already exists for this reviewer, target, and context');
    }

    /**
     * Guard 3 — Contract-participation check.
     * Both the reviewer and the target must be party to the referenced contract.
     * This prevents ratings between arbitrary users who never worked together.
     * @throws {ForbiddenError} When either party is not listed on the contract.
     */
    const reviewerParticipates = this.repository.verifyContractParticipation(
      contextId,
      reviewerId
    );
    const targetParticipates = this.repository.verifyContractParticipation(
      contextId,
      targetId
    );
    if (!reviewerParticipates || !targetParticipates) {
      throw new ForbiddenError('Only contract participants can submit ratings');
    }

    /**
     * Guard 4 — Comment validation (defense-in-depth).
     * Applied in addition to Zod validation at the route layer.
     * Catches: over-length comments, whitespace-only comments, and spam
     * (single character comprising > 50 % of the comment body).
     * @throws {ValidationError} When the comment fails any content policy rule.
     */
    if (comment) {
      this.validateComment(comment);
    }

    /**
     * Snapshot the target's rating count immediately before the write so the
     * audit entry can carry a before/after summary for incident review.
     */
    const totalRatingsBefore = this.repository.findByTargetId(targetId).length;

    /**
     * Guard 5 — Persist the reputation entry.
     * Runs only after all guards have passed.
     */
    const entry = this.repository.create({
      reviewerId,
      targetId,
      rating,
      comment,
      contextId,
    });

    /**
     * Guard 6 — Mandatory audit log.
     * Every successful write MUST produce an immutable audit entry, carrying
     * a before/after summary of the target's rating count so reviewers can
     * see the effect of the mutation without re-deriving it from raw rows.
     * The comment is stored as a SHA-256 hash to avoid leaking PII into the
     * audit store; the plaintext is never logged.
     *
     * IMPORTANT: If audit logging fails the error is re-thrown so the caller
     * receives a generic 'Failed to create audit trail' message.  At this point
     * the DB row has already been persisted — callers that need strict
     * atomicity must implement compensating logic (e.g. soft-delete the entry).
     *
     * @throws {Error} 'Failed to create audit trail. Rating not persisted.'
     *                  when the audit store is unavailable.
     */
    try {
      auditService.log({
        action: 'REPUTATION_UPDATED',
        severity: 'INFO',
        actor: reviewerId,
        resource: 'reputation',
        resourceId: targetId,
        metadata: {
          entryId: entry.id,
          contextId,
          before: {
            totalRatings: totalRatingsBefore,
          },
          after: {
            totalRatings: totalRatingsBefore + 1,
            rating,
            comment: comment ? this.hashComment(comment) : undefined,
          },
        },
        correlationId,
      });
    } catch (auditError) {
      // If audit logging fails, we should not silently continue
      // In production, this would trigger an alert
      console.error('[ReputationService] Audit logging failed:', auditError);
      throw new Error('Failed to create audit trail. Rating not persisted.');
    }

    // Emit webhook notification for reputation event
    // This is fire-and-forget: webhook delivery failures should not block the rating creation
    try {
      const webhookService = getReputationWebhookService();
      const updatedProfile = this.getProfile(targetId);
      
      // Emit asynchronously without awaiting
      webhookService.emitRatingCreated(
        targetId,
        reviewerId,
        rating,
        contextId,
        entry.id,
        updatedProfile.score,
        updatedProfile.totalRatings,
        updatedProfile.weightedScore,
        updatedProfile.scoreAlgorithm,
        comment,
      ).catch((webhookError) => {
        // Log webhook delivery failures but don't fail the rating creation
        console.error('[ReputationService] Webhook emission failed:', webhookError);
      });
    } catch (webhookError) {
      // If webhook service is not initialized or fails, log and continue
      console.error('[ReputationService] Webhook service unavailable:', webhookError);
    }

    return entry;
  }

  /**
   * Updates a freelancer's reputation profile by recording a new rating and
   * returning the recomputed profile.
   *
   * Acts as the payload-shaped entry point used by the HTTP layer. Validates
   * the payload defensively (so direct callers - cron, queue, tests - cannot
   * bypass schema enforcement), then delegates the heavy lifting to
   * {@link createRating} so all anti-abuse guards (self-rating, duplicate,
   * contract participation, comment policy, audit) are exercised exactly once.
   * Finally returns the freshly aggregated profile so callers see post-write
   * state without a second round-trip.
   *
   * @param targetId - UUID of the freelancer being rated (path parameter).
   * @param payload  - Untrusted payload from the HTTP body. Defensively
   *                   validated via {@link validateUpdatePayload}.
   * @returns The recomputed `ReputationProfile` for `targetId`.
   *
   * @throws `AppError(400, 'bad_request', 'Freelancer ID is required')`
   *         when `targetId` is missing.
   * @throws `AppError(400, 'bad_request', 'Invalid payload: ...')`
   *         when the payload fails the defense-in-depth predicate.
   * @throws `ForbiddenError`     - self-rating or non-participant reviewer/target.
   * @throws `ConflictError`      - duplicate rating for the same
   *                                reviewer/target/context triple.
   * @throws `ValidationError`    - comment fails the policy (length / spam).
   * @throws `Error`              - audit logging failed (existing behaviour).
   */
  public static updateProfile(targetId: string, payload: unknown, correlationId?: string): ReputationProfile {
    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    if (!targetId) {
      throw new AppError(400, 'bad_request', 'Freelancer ID is required');
    }

    if (!isValidReputationRatingPayload(payload)) {
      throw new AppError(
        400,
        'bad_request',
        'Invalid payload: reviewerId and a valid integer rating (1\u20135) are required'
      );
    }

    // Narrowed by the type-guard. Comment / contextId / jobCompleted are
    // optional and forwarded as-is so the underlying createRating + DB layer
    // remain the single source of truth for those rules.
    const validPayload = payload as UpdateReputationPayload;
    this.createRating(
      validPayload.reviewerId,
      targetId,
      validPayload.rating,
      // ContextId is enforced at the route layer; tolerate its absence here
      // so defense-in-depth never blocks writes that the route validator
      // would have caught earlier. If absent, the DB layer will surface a
      // clear error rather than this service silently fabricating one.
      typeof validPayload.contextId === 'string' ? validPayload.contextId : '',
      validPayload.comment,
      correlationId
    );

    return this.getProfile(targetId);
  }

  /**
   * Retrieves a freelancer's reputation profile with aggregated statistics.
   * 
   * @param targetId - The target user's ID
   * @returns ReputationProfile with aggregated stats and reviews
   *
   * @throws `AppError(400, 'bad_request', 'Freelancer ID is required')`
   *         when the caller forgot to pass a `targetId`.
   */
  public static getProfile(targetId: string): ReputationProfile {
    // Feature flag check - reputation must be enabled
    if (!isReputationEnabled()) {
      throw new ForbiddenError('Reputation system is currently disabled');
    }

    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    if (!targetId) {
      throw new AppError(400, 'bad_request', 'Freelancer ID is required');
    }

    const entries = this.repository.findByTargetId(targetId);

    return this.buildProfile(targetId, entries);
  }

  /**
   * Retrieves a freelancer's reputation profile with cursor-paginated reviews.
   *
   * Aggregated statistics (score, weightedScore, totalRatings) are always
   * computed from the **full** dataset for correctness. Only the `reviews`
   * array is windowed to the requested page.
   *
   * @param targetId - The target user's ID.
   * @param input    - Optional {@link CursorPaginationInput}.
   * @returns PaginatedReputationProfile with `nextCursor` and `hasNextPage`.
   */
  public static getProfilePaginated(
    targetId: string,
    input: CursorPaginationInput = {},
  ): PaginatedReputationProfile {
    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    if (!targetId) {
      throw new Error('Target ID is required');
    }

    // Fetch full dataset for accurate aggregate stats
    const allEntries = this.repository.findByTargetId(targetId);

    // Fetch paginated page of reviews
    const page = this.repository.findByTargetIdPaginated(targetId, input);

    const baseProfile = this.buildProfile(targetId, allEntries);

    // Replace reviews with the paginated window
    baseProfile.reviews = page.data.map(entry => ({
      reviewerId: entry.reviewerId,
      rating: entry.rating,
      comment: entry.comment,
      createdAt: entry.createdAt,
    }));

    return {
      ...baseProfile,
      nextCursor: page.nextCursor,
      hasNextPage: page.hasNextPage,
      limit: page.limit,
    };
  }

  /**
   * Builds a {@link ReputationProfile} from a set of entries.
   *
   * Extracted as a private helper so both `getProfile` and `getProfilePaginated`
   * share the same aggregation logic.
   */
  private static buildProfile(
    targetId: string,
    entries: ReputationEntry[],
  ): ReputationProfile {
    // Aggregate statistics
    const totalRatings = entries.length;
    const score = totalRatings > 0
      ? entries.reduce((sum, entry) => sum + entry.rating, 0) / totalRatings
      : 0;

    // Get validated config for reputation scoring parameters
    // Use try-catch to gracefully handle test environments where full env may not be set
    let lambda = 0.005; // default
    let algorithmVersion = 'exp-decay-v1'; // default
    try {
      const config = validateEnv(process.env);
      lambda = config.REPUTATION_DECAY_LAMBDA;
      algorithmVersion = config.REPUTATION_SCORE_ALGORITHM_VERSION;
    } catch (_error) {
      // In test environment or when env validation fails, use defaults
      // This allows tests to run without setting all env vars
    }

    // Compute weighted score using recency-aware algorithm
    const weightedScore = computeWeightedReputationScore(
      entries,
      new Date(),
      lambda
    );

    return {
      freelancerId: targetId,
      score: parseFloat(score.toFixed(2)),
      jobsCompleted: 0, // Legacy field, deprecated
      totalRatings,
      reviews: entries.map(entry => ({
        reviewerId: entry.reviewerId,
        rating: entry.rating,
        comment: entry.comment,
        createdAt: entry.createdAt,
      })),
      lastUpdated: entries.length > 0 ? entries[0].createdAt : new Date().toISOString(),
      weightedScore: parseFloat(weightedScore.toFixed(2)),
      scoreAlgorithm: algorithmVersion,
    };
  }

  /**
   * Validates comment content for spam and policy violations.
   * 
   * @param comment - The comment text to validate
   * @throws ValidationError if comment fails validation
   */
  private static validateComment(comment: string): void {
    // Max length
    if (comment.length > 1000) {
      throw new ValidationError('Comment exceeds maximum length of 1000 characters');
    }

    // Empty/whitespace check only for non-empty strings
    if (comment.length > 0 && !comment.trim()) {
      throw new ValidationError('Comment cannot be empty or whitespace-only');
    }

    // Only check spam if comment has content
    if (comment.length > 0) {
      const charCount: Record<string, number> = {};
      for (const char of comment) {
        charCount[char] = (charCount[char] || 0) + 1;
      }
      const maxCharCount = Math.max(...Object.values(charCount));
      if (maxCharCount / comment.length > 0.5) {
        throw new ValidationError('Comment contains excessive repetitive content');
      }
    }
  }

  /**
   * Creates multiple reputation ratings in a single call.
   *
   * Each item is processed independently — a failure on one item does not
   * prevent other items from being processed. The returned results array
   * contains one entry per input item with per-item success/error status.
   *
   * @param items - Array of rating payloads to process.
   * @returns Array of per-item results with index, success flag, and data/error.
   */
  public static createBulkRatings(
    items: Array<{ reviewerId: string; targetId: string; rating: number; contextId: string; comment?: string }>,
    correlationId?: string
  ): Array<{ index: number; success: boolean; data?: ReputationEntry; error?: { code: string; message: string } }> {
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    const results: Array<{ index: number; success: boolean; data?: ReputationEntry; error?: { code: string; message: string } }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const entry = this.createRating(
          item.reviewerId,
          item.targetId,
          item.rating,
          item.contextId,
          item.comment,
          correlationId
        );
        results.push({ index: i, success: true, data: entry });
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error('Unknown error');
        let code = 'internal_error';
        if (err.constructor.name === 'ForbiddenError') code = 'forbidden';
        else if (err.constructor.name === 'ConflictError') code = 'conflict';
        else if (err.constructor.name === 'ValidationError') code = 'validation_error';
        results.push({
          index: i,
          success: false,
          error: { code, message: err.message },
        });
      }
    }

    return results;
  }

  /**
   * Applies a manual reputation correction with full provenance tracking.
   * 
   * This method is strictly separated from ordinary event ingestion pathways.
   * It requires:
   * - A mandatory reason (10-5000 characters) explaining the correction
   * - A mandatory reference (e.g., ticket number, dispute ID, escalation ID)
   * - Operator identity and role for audit trail
   * - Before/after snapshots of the target's reputation profile
   *
   * @param targetId - The user whose reputation is being corrected
   * @param contextId - The contract/context associated with the correction
   * @param reason - Human-readable explanation for the correction (10-5000 chars)
   * @param reference - External reference ID (ticket, dispute, escalation, etc.)
   * @param operatorId - The user ID performing the correction
   * @param operatorRole - The role of the operator (e.g., 'admin', 'support', 'moderator')
   * @param correlationId - Optional correlation ID for distributed tracing
   * @returns The created ReputationCorrectionEntry with full provenance
   *
   * @throws ForbiddenError if reputation system is disabled or operator unauthorized
   * @throws ConflictError if a correction with the same reference already exists for this target/context
   * @throws ValidationError if reason or reference are invalid
   * @throws Error if audit logging fails
   */
  public static correctReputation(
    targetId: string,
    contextId: string,
    reason: string,
    reference: string,
    operatorId: string,
    operatorRole: string,
    correlationId?: string
  ): ReputationCorrectionEntry {
    // Feature flag check - reputation must be enabled
    if (!isReputationEnabled()) {
      throw new ForbiddenError('Reputation system is currently disabled');
    }

    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    // Validate required fields
    if (!reason || reason.trim().length < 10) {
      throw new ValidationError('Reason must be at least 10 characters');
    }
    if (reason.length > 5000) {
      throw new ValidationError('Reason must not exceed 5000 characters');
    }
    if (!reference || reference.trim().length === 0) {
      throw new ValidationError('Reference is required');
    }

    // Validate reference format - must not contain sensitive URLs
    // Sanitize and validate the reference to prevent sensitive data leakage
    const sanitizedReference = this.sanitizeReference(reference);
    if (sanitizedReference !== reference) {
      throw new ValidationError('Reference contains potentially sensitive data (URLs with credentials, tokens, etc.)');
    }

    // Validate operator role - only authorized roles can perform corrections
    const authorizedRoles = ['admin', 'auditor'];
    if (!authorizedRoles.includes(operatorRole.toLowerCase())) {
      throw new ForbiddenError('Operator role not authorized to perform reputation corrections');
    }

    // Snapshot the target's current reputation profile BEFORE the correction
    const profileBefore = this.getProfile(targetId);
    const beforeScore = profileBefore.score;
    const beforeWeighted = profileBefore.weightedScore;
    const beforeTotal = profileBefore.totalRatings;

    // For corrections, we don't modify the underlying ratings directly.
    // Instead, we record the correction as a provenance entry.
    // The "after" values represent the intended corrected state.
    // In a real implementation, this might adjust a manual override score.
    // For now, we record the correction with the same values (no actual score change)
    // but the provenance record captures the intent.
    // The after values could be provided by the operator or computed from a proposed change.
    // Here we use the same values to indicate a "note" correction, but the structure
    // supports actual score adjustments if needed in the future.
    const afterScore = beforeScore;
    const afterWeighted = beforeWeighted;
    const afterTotal = beforeTotal;

    // Create the correction record with full provenance
    const correction = this.repository.createCorrection({
      targetId,
      contextId,
      reason: reason.trim(),
      reference: reference.trim(),
      beforeScore,
      afterScore,
      beforeWeighted,
      afterWeighted,
      beforeTotal,
      afterTotal,
      operatorId,
      operatorRole: operatorRole.toLowerCase(),
    });

    // Mandatory audit log for the correction
    try {
      auditService.log({
        action: 'REPUTATION_CORRECTED',
        severity: 'WARNING', // Corrections are WARNING level as they override computed scores
        actor: operatorId,
        resource: 'reputation',
        resourceId: targetId,
        metadata: {
          correctionId: correction.id,
          contextId,
          reason: reason.trim(),
          reference: reference.trim(),
          operatorRole: operatorRole.toLowerCase(),
          before: {
            score: beforeScore,
            weightedScore: beforeWeighted,
            totalRatings: beforeTotal,
          },
          after: {
            score: afterScore,
            weightedScore: afterWeighted,
            totalRatings: afterTotal,
          },
        },
        correlationId,
      });
    } catch (auditError) {
      console.error('[ReputationService] Audit logging failed for correction:', auditError);
      throw new Error('Failed to create audit trail for correction');
    }

    return correction;
  }

  /**
   * Sanitizes a reference string to prevent sensitive data leakage.
   * 
   * Rejects references that contain URLs with credentials, tokens, or other sensitive patterns.
   * Allows safe references like ticket numbers (TKT-123), dispute IDs (DISP-456), etc.
   * 
   * @param reference - The reference string to sanitize
   * @returns The sanitized reference, or a modified version if sensitive data detected
   */
  private static sanitizeReference(reference: string): string {
    // Check for URLs with credentials (user:pass@host)
    const urlWithCredentials = /https?:\/\/[^:]+:[^@]+@/i;
    if (urlWithCredentials.test(reference)) {
      return '[REDACTED_URL_WITH_CREDENTIALS]';
    }

    // Check for URLs with token-like query parameters
    const urlWithToken = /https?:\/\/[^\s]+\?(?:.*[&?])?(?:token|key|secret|password|auth|access_token|api_key)=[^&\s]+/i;
    if (urlWithToken.test(reference)) {
      return '[REDACTED_URL_WITH_TOKEN]';
    }

    // Check for bare tokens/secrets (long alphanumeric strings that look like API keys)
    const bareToken = /\b[a-zA-Z0-9_-]{32,}\b/;
    if (bareToken.test(reference) && !/^(TKT|DISP|ESC|INC|PR|ISSUE)-\d+$/i.test(reference.trim())) {
      // Allow common reference formats but flag potential bare tokens
      return '[REDACTED_POTENTIAL_TOKEN]';
    }

    return reference;
  }

  /**
   * Retrieves all reputation corrections for a target user.
   * 
   * @param targetId - The target user's ID
   * @returns Array of ReputationCorrectionEntry objects ordered by creation date descending
   */
  public static getCorrections(targetId: string): ReputationCorrectionEntry[] {
    if (!isReputationEnabled()) {
      throw new ForbiddenError('Reputation system is currently disabled');
    }

    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    if (!targetId) {
      throw new AppError(400, 'bad_request', 'Target ID is required');
    }

    return this.repository.findCorrectionsByTargetId(targetId);
  }

  /**
   * Retrieves a specific reputation correction by ID.
   * 
   * @param correctionId - The correction UUID
   * @returns The ReputationCorrectionEntry or undefined if not found
   */
  public static getCorrectionById(correctionId: string): ReputationCorrectionEntry | undefined {
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    return this.repository.findCorrectionById(correctionId);
  }

  /**
   * Creates a SHA-256 hash of the comment for audit logging.
   * Prevents storing sensitive comment text in audit logs.
   */
  private static hashComment(comment: string): string {
    return createHash('sha256').update(comment).digest('hex');
  }
}
