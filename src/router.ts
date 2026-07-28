import express, { Request, Response, NextFunction } from "express";
import * as http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { createLogger } from "./logger";
import { redactHeaders, redactUrl } from "./redact";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER, validateExternalId } from "./middleware/requestId";
import { randomUUID } from "crypto";

/**
 * Simple blue-green router using Node http proxy (no extra deps).
 * Proxies /api/* to ACTIVE_COLOR.
 */
export const routerApp = express();
routerApp.use(express.json());

const getActiveBackendUrl = (): string => {
  const color = process.env.ACTIVE_COLOR || "blue";
  const port =
    color === "green"
      ? process.env.GREEN_PORT || "3002"
      : process.env.BLUE_PORT || "3001";

  return `http://localhost:${port}`;
};

/**
 * Build a request-scoped logger with correlation IDs extracted from request headers.
 * Falls back to a fresh UUID for the requestId when no header is present.
 *
 * @param req - Incoming Express request
 */
function buildRouterLogger(req: Request) {
  const requestId =
    validateExternalId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
  const correlationId = validateExternalId(req.headers[CORRELATION_ID_HEADER]);
  return createLogger({
    component: "blue-green-router",
    requestId,
    ...(correlationId !== undefined && { correlationId }),
  });
}

// Proxy middleware
routerApp.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const target = getActiveBackendUrl();
  const log = buildRouterLogger(req);

  log.info("Routing request", {
    method: req.method,
    url: redactUrl(req.url),
    target,
    headers: redactHeaders(req.headers as Record<string, string | string[] | undefined>),
  });

  // Remove host header (important for proxying)
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([key]) => key.toLowerCase() !== "host"
    )
  );

  // 🔥 KEY FIX: Bridge Express → Node types
  const nodeReq = req as unknown as IncomingMessage;
  const nodeRes = res as unknown as ServerResponse;

  const proxyReq = http.request(
    target + req.url,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      // Write headers + status from backend
      nodeRes.writeHead(proxyRes.statusCode || 500, proxyRes.headers);

      // Pipe backend response → client
      proxyRes.pipe(nodeRes);

      proxyRes.on("error", (err: Error) => {
        log.error("Proxy response error", { err });
        if (!res.headersSent) {
          res.status(502).json({ error: "Backend response error" });
        }
      });
    }
  );

  // Pipe client request → backend
  nodeReq.pipe(proxyReq);

  nodeReq.on("end", () => {
    proxyReq.end();
  });

  nodeReq.on("error", (err: Error) => {
    log.error("Client request error", { err });
    proxyReq.destroy();
    next(err);
  });

  proxyReq.on("error", (err: Error) => {
    log.error("Proxy request error", { err });
    if (!res.headersSent) {
      res.status(502).json({ error: "Backend unavailable" });
    }
    next(err);
  });
});

// Health route
routerApp.get("/health/router", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    component: "router",
    active: getActiveBackendUrl(),
  });
});