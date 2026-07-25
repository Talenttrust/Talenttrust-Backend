import { Response } from "express";
import {
  buildHealthResponse,
  sendHealthResponse,
} from "./health-validation-handler";

describe("health-validation-handler", () => {
  const makeResponse = (): Partial<Response> => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  it("buildHealthResponse returns the expected payload with default service name", () => {
    const originalEnv = process.env.SERVICE_NAME;
    delete process.env.SERVICE_NAME;

    const payload = buildHealthResponse();
    expect(payload).toEqual({ status: "ok", service: "talenttrust-backend" });

    process.env.SERVICE_NAME = originalEnv;
  });

  it("buildHealthResponse uses SERVICE_NAME when provided", () => {
    const originalEnv = process.env.SERVICE_NAME;
    process.env.SERVICE_NAME = "custom-service";

    const payload = buildHealthResponse();
    expect(payload).toEqual({ status: "ok", service: "custom-service" });

    process.env.SERVICE_NAME = originalEnv;
  });

  it("sendHealthResponse writes a 200 response with JSON body", () => {
    const res = makeResponse() as Response;
    sendHealthResponse(res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "ok",
      service: process.env.SERVICE_NAME ?? "talenttrust-backend",
    });
  });
});
