import { Router, Request, Response } from "express";

/**
 * Health checks for blue-green deployments.
 * /health/live: Liveness probe
 * /health/ready: Readiness probe (checks if ready for traffic)
 */
export const healthRouter = Router();

healthRouter.get("/health/live", (req: Request, res: Response) => {
  res.json({ status: "ok", service: "talenttrust-backend", probe: "live" });
});

healthRouter.get("/health/ready", async (req: Request, res: Response) => {
  try {
    const activeColor = process.env.ACTIVE_COLOR || "blue";
    res.json({
      status: "ready",
      service: "talenttrust-backend",
      probe: "ready",
      activeColor,
    });
  } catch (error) {
    res
      .status(503)
      .json({ status: "not-ready", error: (error as Error).message });
  }
});
