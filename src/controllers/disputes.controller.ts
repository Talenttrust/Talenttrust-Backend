import type { NextFunction, Request, Response } from 'express';
import { disputesService, DisputeError } from '../services/disputes.service';
import {
  DisputeResponseDto,
  mapToDisputeResponse,
  CreateDisputeDto,
  UpdateDisputePayload,
  BatchDisputeOperation,
} from '../modules/disputes/dto/dispute.dto';
import { ok, fail } from '../utils/apiResponse';
import type { Logger } from '../logger';

type DisputeRequest<TBody = unknown> = Request<
  Record<string, string>,
  unknown,
  TBody
> & { user?: { id: string } };

function resolveLogger(res: Response): Logger {
  const log = res.locals['log'] as Logger | undefined;
  if (log) return log;
  return require('../logger').logger as Logger;
}

function traceContext(res: Response): Record<string, string> {
  const requestId =
    typeof res.locals['requestId'] === 'string'
      ? (res.locals['requestId'] as string)
      : 'unknown';
  return { requestId };
}

export class DisputesController {
  public async getDisputes(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info('disputes.getDisputes: start', ctx);

    try {
      ok(res, { disputes: [], total: 0 });
    } catch (error) {
      log.error('disputes.getDisputes: error', { ...ctx, err: error as Error });
      next(error);
    }
  }

  public async getDisputeById(
    req: DisputeRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const id = req.params.id!;
    log.info('disputes.getDisputeById: start', { ...ctx, disputeId: id });

    try {
      const dispute = disputesService.getDisputeById(id);
      log.info('disputes.getDisputeById: success', { ...ctx, disputeId: id });
      ok(res, mapToDisputeResponse(dispute));
    } catch (error) {
      if (error instanceof DisputeError && error.statusCode === 404) {
        log.warn('disputes.getDisputeById: not found', { ...ctx, disputeId: id });
        fail(res, 'dispute_not_found', error.message, 404);
        return;
      }
      log.error('disputes.getDisputeById: error', { ...ctx, disputeId: id, err: error as Error });
      next(error);
    }
  }

  public async createDispute(
    req: DisputeRequest<CreateDisputeDto>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info('disputes.createDispute: start', ctx);

    try {
      const body = req.body ?? {};
      const dispute = {
        id: `dispute-${Date.now()}`,
        contractId: body.contractId ?? '',
        status: 'open' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      log.info('disputes.createDispute: success', { ...ctx, disputeId: dispute.id });
      ok(res, mapToDisputeResponse(dispute), undefined, 201);
    } catch (error) {
      log.error('disputes.createDispute: error', { ...ctx, err: error as Error });
      next(error);
    }
  }

  public async updateDispute(
    req: DisputeRequest<UpdateDisputePayload>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const id = req.params.id!;
    log.info('disputes.updateDispute: start', { ...ctx, disputeId: id });

    try {
      const body = req.body ?? {};
      const dispute = await disputesService.updateDispute(id, body);
      log.info('disputes.updateDispute: success', { ...ctx, disputeId: id });
      ok(res, mapToDisputeResponse(dispute));
    } catch (error) {
      if (error instanceof DisputeError) {
        log.warn('disputes.updateDispute: failed', { ...ctx, disputeId: id, error: error.code });
        fail(res, error.code, error.message, error.statusCode);
        return;
      }
      log.error('disputes.updateDispute: error', { ...ctx, disputeId: id, err: error as Error });
      next(error);
    }
  }

  public async deleteDispute(
    req: DisputeRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    const id = req.params.id!;
    log.info('disputes.deleteDispute: start', { ...ctx, disputeId: id });

    try {
      ok(res, { message: `Dispute ${id} deleted successfully` });
    } catch (error) {
      log.error('disputes.deleteDispute: error', { ...ctx, disputeId: id, err: error as Error });
      next(error);
    }
  }

  public async processBatch(
    req: DisputeRequest<BatchDisputeOperation[]>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const log = resolveLogger(res);
    const ctx = traceContext(res);
    log.info('disputes.processBatch: start', { ...ctx, batchSize: req.body?.length });

    try {
      const operations = req.body ?? [];
      const results = await disputesService.processBatch(operations);
      log.info('disputes.processBatch: success', { ...ctx, resultsCount: results.length });
      ok(res, { results });
    } catch (error) {
      log.error('disputes.processBatch: error', { ...ctx, err: error as Error });
      next(error);
    }
  }
}

export function createDisputesController() {
  const controller = new DisputesController();
  return {
    getDisputes: controller.getDisputes.bind(controller),
    getDisputeById: controller.getDisputeById.bind(controller),
    createDispute: controller.createDispute.bind(controller),
    updateDispute: controller.updateDispute.bind(controller),
    deleteDispute: controller.deleteDispute.bind(controller),
    processBatch: controller.processBatch.bind(controller),
  };
}
