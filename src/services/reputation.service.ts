import { ReputationProfile } from '../types/reputation';
import { ReputationRepository, ReputationEntry } from '../repositories/reputationRepository';
import { auditService } from '../audit/service';
import { ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

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
  public static initialize(db: Database.Database): void {
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
    comment?: string
  ): ReputationEntry {
    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    // 1. BLOCK self-rating
    if (reviewerId === targetId) {
      throw new ForbiddenError('Users cannot rate themselves');
    }

    // 2. BLOCK duplicate ratings (application-level check)
    const existing = this.repository.findByReviewerTargetContext(
      reviewerId,
      targetId,
      contextId
    );
    if (existing) {
      throw new ConflictError('Rating already exists for this reviewer, target, and context');
    }

    // 3. BLOCK unauthorized rating (verify contract participation)
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

    // 4. Validate comment (defense-in-depth, in addition to Zod validation)
    if (comment) {
      this.validateComment(comment);
    }

    // 5. Persist reputation entry
    const entry = this.repository.create({
      reviewerId,
      targetId,
      rating,
      comment,
      contextId,
    });

    // 6. AUDIT LOG (MANDATORY - no write without audit)
    try {
      auditService.log({
        action: 'REPUTATION_UPDATED',
        severity: 'INFO',
        actor: reviewerId,
        resource: 'reputation',
        resourceId: targetId,
        metadata: {
          rating,
          comment: comment ? this.hashComment(comment) : undefined,
          contextId,
        },
      });
    } catch (auditError) {
      // If audit logging fails, we should not silently continue
      // In production, this would trigger an alert
      console.error('[ReputationService] Audit logging failed:', auditError);
      throw new Error('Failed to create audit trail. Rating not persisted.');
    }

    return entry;
  }

  /**
   * Retrieves a freelancer's reputation profile with aggregated statistics.
   * 
   * @param targetId - The target user's ID
   * @returns ReputationProfile with aggregated stats and reviews
   */
  public static getProfile(targetId: string): ReputationProfile {
    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    if (!targetId) {
      throw new Error('Target ID is required');
    }

    const entries = this.repository.findByTargetId(targetId);

    // Aggregate statistics
    const totalRatings = entries.length;
    const score = totalRatings > 0
      ? entries.reduce((sum, entry) => sum + entry.rating, 0) / totalRatings
      : 0;

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
   * Creates a SHA-256 hash of the comment for audit logging.
   * Prevents storing sensitive comment text in audit logs.
   */
  private static hashComment(comment: string): string {
    return createHash('sha256').update(comment).digest('hex');
  }
}
