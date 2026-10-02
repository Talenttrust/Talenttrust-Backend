import { Request, Response } from "express";
import { z } from "zod";
import { validateMetricsInput } from "../observability/metrics-validation";

/**
 * Validate a metrics route request body and send a consistent 400 response
 * when validation fails.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param schema - Zod schema to validate the request body against
 * @returns The parsed payload when validation succeeds, otherwise undefined
 */
export function validateMetricsRequestBody<T>(
  req: Request,
  res: Response,
  schema: z.ZodSchema<T>,
): { ok: true; data: T } | undefined {
  const validation = validateMetricsInput(schema, req.body);
  if (!validation.ok) {
    res.status(400).json({
      error: {
        code: validation.code,
        message: "Request validation failed",
        requestId: res.locals.requestId ?? "unknown",
        details: validation.issues,
      },
    });
    return undefined;
  }

  return validation;
}
