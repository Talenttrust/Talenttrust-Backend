import { Router, Request, Response } from 'express';

import {
  getIncidentRunbookById,
  isValidRunbookId,
  listIncidentRunbooks,
} from './incidentResponse.service';

export const incidentResponseRouter = Router();

incidentResponseRouter.get('/', (_req: Request, res: Response) => {
  const runbooks = listIncidentRunbooks();

  res.json({
    runbooks,
    count: runbooks.length,
  });
});

incidentResponseRouter.get('/:runbookId', (req: Request, res: Response) => {
  const normalizedRunbookId = req.params.runbookId.trim().toLowerCase();

  if (!isValidRunbookId(normalizedRunbookId)) {
    return res.status(400).json({
      error: 'Invalid runbook id. Use lowercase letters, numbers, and hyphens only.',
    });
  }

  const runbook = getIncidentRunbookById(normalizedRunbookId);

  if (!runbook) {
    return res.status(404).json({
      error: `Runbook '${normalizedRunbookId}' was not found.`,
    });
  }

  return res.json({ runbook });
});
