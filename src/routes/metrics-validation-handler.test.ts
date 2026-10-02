import { Request, Response } from "express";
import { z } from "zod";
import { validateMetricsRequestBody } from "./metrics-validation-handler";

describe("validateMetricsRequestBody", () => {
  const makeRequest = (body: unknown): Partial<Request> => ({ body });

  const makeResponse = () => {
    const res: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: { requestId: "test-request-id" },
    };
    return res as Response;
  };

  const schema = z.object({
    name: z.string(),
    count: z.number().int().min(0),
  });

  it("returns parsed data when validation succeeds", () => {
    const req = makeRequest({ name: "ok", count: 5 }) as Request;
    const res = makeResponse();

    const result = validateMetricsRequestBody(req, res, schema);

    expect(result).toEqual({ ok: true, data: { name: "ok", count: 5 } });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("sends a 400 response when validation fails", () => {
    const req = makeRequest({ name: "ok", count: -1 }) as Request;
    const res = makeResponse();

    const result = validateMetricsRequestBody(req, res, schema);

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        requestId: "test-request-id",
        details: expect.any(Array),
      },
    });
  });

  it("uses unknown requestId when none is available", () => {
    const req = makeRequest({ name: 1, count: 0 }) as Request;
    const res: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {},
    };

    const result = validateMetricsRequestBody(req, res as Response, schema);

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        requestId: "unknown",
        details: expect.any(Array),
      },
    });
  });
});
