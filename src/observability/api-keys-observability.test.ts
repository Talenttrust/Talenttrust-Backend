import { EventEmitter } from "events";
import { NextFunction, Request, Response } from "express";
import { Registry } from "prom-client";

import { MetricsService } from "./metrics-service";

function record(
  service: MetricsService,
  method: string,
  routePath: string,
  statusCode: number,
) {
  const response = new EventEmitter() as Response & EventEmitter;
  response.statusCode = statusCode;
  response.locals = {
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  const request = {
    method,
    route: { path: routePath },
  } as unknown as Request;
  const next = jest.fn() as NextFunction;

  service.trackApiKeysRequest(request, response, next);
  expect(next).toHaveBeenCalledTimes(1);
  response.emit("finish");

  return response.locals["log"] as {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
}

describe("API keys observability", () => {
  it("records success duration and status and emits a structured info log", async () => {
    const registry = new Registry();
    const service = new MetricsService("test", registry);
    const log = record(service, "POST", "/api-keys", 201);
    const metrics = await registry.getMetricsAsJSON();

    expect(
      metrics.find((metric) => metric.name === "api_keys_requests_total")
        ?.values,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: { operation: "create", status_code: "201" },
          value: 1,
        }),
      ]),
    );
    expect(
      metrics.find(
        (metric) => metric.name === "api_keys_request_duration_seconds",
      )?.values,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: expect.objectContaining({
            operation: "create",
            status_code: "201",
          }),
        }),
      ]),
    );
    expect(
      metrics.find((metric) => metric.name === "api_keys_errors_total")?.values,
    ).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(
      "api_keys_request",
      expect.objectContaining({
        method: "POST",
        route: "/api/v1/api-keys",
        operation: "create",
        statusCode: 201,
        outcome: "success",
        durationMs: expect.any(Number),
      }),
    );
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([
    [400, "validation_error"],
    [401, "authentication_error"],
    [403, "authorization_error"],
    [404, "not_found"],
    [429, "client_error"],
  ])(
    "records client status %i with bounded cause %s",
    async (statusCode, cause) => {
      const registry = new Registry();
      const service = new MetricsService("test", registry);
      const log = record(service, "GET", "/api-keys/:id", statusCode);
      const metrics = await registry.getMetricsAsJSON();

      expect(
        metrics.find((metric) => metric.name === "api_keys_errors_total")
          ?.values,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            labels: { operation: "get", cause },
            value: 1,
          }),
        ]),
      );
      expect(log.warn).toHaveBeenCalledWith(
        "api_keys_request",
        expect.objectContaining({
          route: "/api/v1/api-keys/:id",
          statusCode,
          errorCause: cause,
          outcome: "error",
        }),
      );
    },
  );

  it("records server errors on the existing registry and logs at error level", async () => {
    const registry = new Registry();
    const service = new MetricsService("test", registry);
    const log = record(service, "POST", "/api-keys/:id/rotate", 500);

    expect(await service.getMetrics()).toContain(
      'api_keys_errors_total{operation="rotate",cause="server_error"} 1',
    );
    expect(log.error).toHaveBeenCalledWith(
      "api_keys_request",
      expect.objectContaining({
        operation: "rotate",
        statusCode: 500,
        errorCause: "server_error",
      }),
    );
  });

  it.each([
    ["GET", "/api-keys", "list"],
    ["DELETE", "/api-keys/:id", "deactivate"],
    ["PATCH", "/api-keys/:id", "unknown"],
  ])(
    "uses a static operation label for %s %s",
    async (method, routePath, operation) => {
      const registry = new Registry();
      const service = new MetricsService("test", registry);
      record(service, method, routePath, 200);
      const metrics = await registry.getMetricsAsJSON();

      expect(
        metrics.find((metric) => metric.name === "api_keys_requests_total")
          ?.values,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            labels: { operation, status_code: "200" },
          }),
        ]),
      );
    },
  );
});
