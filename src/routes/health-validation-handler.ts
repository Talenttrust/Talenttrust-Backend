import { Response } from "express";

export interface HealthResponsePayload {
  status: "ok";
  service: string;
}

const DEFAULT_SERVICE_NAME = "talenttrust-backend";

/**
 * Build the static health response payload returned by legacy health endpoints.
 */
export function buildHealthResponse(): HealthResponsePayload {
  return {
    status: "ok",
    service: process.env.SERVICE_NAME ?? DEFAULT_SERVICE_NAME,
  };
}

/**
 * Send a consistent health check response for the legacy /health route.
 */
export function sendHealthResponse(res: Response): Response {
  return res.status(200).json(buildHealthResponse());
}
