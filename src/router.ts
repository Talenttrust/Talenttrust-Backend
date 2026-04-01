import express, { Request, Response, NextFunction } from "express";
import * as http from "http";
import type { IncomingMessage, ServerResponse } from "http";

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

// Proxy middleware
routerApp.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const target = getActiveBackendUrl();
  console.log(`Routing ${req.method} ${req.url} to ${target}`);

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
        console.error("Proxy response error:", err);
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
    console.error("Client request error:", err);
    proxyReq.destroy();
    next(err);
  });

  proxyReq.on("error", (err: Error) => {
    console.error("Proxy request error:", err);
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