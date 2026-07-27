import type { NextFunction, Request, Response } from 'express';
import {
  MilestoneConflictError,
  MilestoneNotFoundError,
  milestonesService,
} from '../services/milestones.service';
import { SoftDeleteRetentionError } from '../utils/softDelete';
import { fail, ok } from '../utils/apiResponse';
import { createMilestoneSchema, type CreateMilestoneInput } from '../modules/contracts/dto/milestones.dto';

function serializeMilestone(m: {
  id: string;
  contractId: string;
  title: string;
  description: string;
  amount: number;
  deadline?: string;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}) {
  return {
    id: m.id,
    contractId: m.contractId,
    title: m.title,
    description: m.description,
    amount: m.amount,
    deadline: m.deadline,
    completed: m.completed,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
  };
}

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
 */
export class MilestonesSoftDeleteController {
  public list(req: Request, res: Response, next: NextFunction): void {
    try {
      const contractId = req.params.id!;
      const includeDeleted = req.query.includeDeleted === 'true';
      const milestones = milestonesService.listByContract(contractId, { includeDeleted });
      ok(res, {
        milestones: milestones.map(serializeMilestone),
        total: milestones.length,
      });
    } catch (error) {
      if (mapMilestoneError(res, error)) return;
      next(error);
    }
  }

  public create(req: Request, res: Response, next: NextFunction): void {
    try {
      const contractId = req.params.id!;
      const body = req.body as CreateMilestoneInput;
      const created = milestonesService.create(contractId, body);
      ok(res, { milestone: serializeMilestone(created) }, undefined, 201);
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
      ok(res, {
        milestone: serializeMilestone(deleted),
        message: `Milestone ${milestoneId} soft-deleted`,
      });
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
      ok(res, {
        milestone: serializeMilestone(restored),
        message: `Milestone ${milestoneId} restored`,
      });
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
