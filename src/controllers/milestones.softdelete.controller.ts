import type { NextFunction, Request, Response } from 'express';
import {
  MilestoneConflictError,
  MilestoneNotFoundError,
  milestonesService,
} from '../services/milestones.service';
import { SoftDeleteRetentionError } from '../utils/softDelete';
import { fail, ok } from '../utils/apiResponse';
import {
  toCreateMilestoneInput,
  toListMilestonesOptions,
  toListMilestonesResponseDto,
  toSingleMilestoneResponseDto,
  type CreateMilestoneRequestDto,
  type ListMilestonesQueryDto,
} from '../modules/milestones/dto/milestone.dto';

/**
 * Maps well-known domain errors to structured HTTP responses.
 * Returns `true` when an error was handled so the caller can skip `next(error)`.
 */
function mapMilestoneError(res: Response, error: unknown): boolean {
  if (error instanceof MilestoneNotFoundError) {
    fail(res, error.code, error.message, error.statusCode);
    return true;
  }
  if (error instanceof MilestoneConflictError) {
    fail(res, error.code, error.message, error.statusCode);
    return true;
  }
  if (error instanceof SoftDeleteRetentionError) {
    fail(res, error.code, error.message, error.statusCode);
    return true;
  }
  return false;
}

/**
 * Handlers for milestone soft-delete / restore / list / create.
 * Mounted under `/api/v1/contracts/:id/milestones…`.
 *
 * All request bodies are mapped through typed DTOs before reaching the
 * service layer, and all domain records are mapped through typed DTOs before
 * being handed to `ok()`. No loose `any`-typed objects cross the HTTP boundary.
 */
export class MilestonesSoftDeleteController {
  public list(req: Request, res: Response, next: NextFunction): void {
    try {
      const contractId = req.params.id!;
      const queryDto = req.query as unknown as ListMilestonesQueryDto;
      const options = toListMilestonesOptions(queryDto);
      const milestones = milestonesService.listByContract(contractId, options);
      ok(res, toListMilestonesResponseDto(milestones));
    } catch (error) {
      if (mapMilestoneError(res, error)) return;
      next(error);
    }
  }

  public create(req: Request, res: Response, next: NextFunction): void {
    try {
      const contractId = req.params.id!;
      const body = (req.body ?? {}) as CreateMilestoneRequestDto;
      if (!body.title || typeof body.amount !== 'number') {
        fail(res, 'validation_error', 'title and amount are required', 400);
        return;
      }
      const input = toCreateMilestoneInput(body);
      const created = milestonesService.create(contractId, input);
      ok(res, toSingleMilestoneResponseDto(created), undefined, 201);
    } catch (error) {
      if (mapMilestoneError(res, error)) return;
      next(error);
    }
  }

  public softDelete(req: Request, res: Response, next: NextFunction): void {
    try {
      const contractId = req.params.id!;
      const milestoneId = req.params.milestoneId!;
      const deleted = milestonesService.softDelete(contractId, milestoneId);
      ok(res, toSingleMilestoneResponseDto(deleted, `Milestone ${milestoneId} soft-deleted`));
    } catch (error) {
      if (mapMilestoneError(res, error)) return;
      next(error);
    }
  }

  public restore(req: Request, res: Response, next: NextFunction): void {
    try {
      const contractId = req.params.id!;
      const milestoneId = req.params.milestoneId!;
      const restored = milestonesService.restore(contractId, milestoneId);
      ok(res, toSingleMilestoneResponseDto(restored, `Milestone ${milestoneId} restored`));
    } catch (error) {
      if (mapMilestoneError(res, error)) return;
      next(error);
    }
  }
}

export function createMilestonesSoftDeleteController(): MilestonesSoftDeleteController {
  return new MilestonesSoftDeleteController();
}

/**
 * Maintenance entrypoint: purge soft-deleted milestones past the retention window.
 * Intended for cron / scheduled jobs.
 */
export function runMilestonesSoftDeletePurge(now: Date = new Date()): number {
  return milestonesService.purgeExpired(now);
}
