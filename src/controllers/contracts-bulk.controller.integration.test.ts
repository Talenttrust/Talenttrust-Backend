import express from "express";
import request from "supertest";
import { createContractsBulkController } from "./contracts-bulk.controller";
import type { ContractsService } from "../services/contracts.service";
import type { Contract } from "../db/types";

function makeContract(id: string): Contract {
  return {
    id,
    title: "Valid contract title",
    clientId: "11111111-1111-4111-8111-111111111111",
    freelancerId: "",
    amount: 10_000,
    status: "draft",
    version: 1,
    createdAt: "2026-09-05T00:00:00.000Z",
  };
}

describe("POST /contracts/bulk integration", () => {
  it("validates at the boundary, strips unknown fields, and preserves item order", async () => {
    const createContractMock = jest
      .fn()
      .mockResolvedValue(makeContract("contract-1"));
    const service = {
      createContract: createContractMock,
    } as unknown as ContractsService;
    const controller = createContractsBulkController(service);
    const app = express();
    app.use(express.json());
    app.post("/contracts/bulk", controller.bulkCreateContracts);

    const response = await request(app)
      .post("/contracts/bulk")
      .send({
        items: [
          {
            ...({
              title: "Valid contract title",
              description: "A valid contract description",
              clientId: "11111111-1111-4111-8111-111111111111",
              budget: 10_000,
            } as const),
            unknownField: "stripped before service",
          },
          {
            title: "x",
            description: "too short",
            clientId: "not-a-uuid",
            budget: "not-a-number",
          },
        ],
      })
      .expect(200);

    const body = response.body.data ?? response.body;
    expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(body.items[0]).toMatchObject({ status: "success", index: 0 });
    expect(body.items[1]).toMatchObject({
      status: "error",
      code: 400,
      index: 1,
    });
    expect(body.items[1].error.code).toBe("validation_error");
    expect(Array.isArray(body.items[1].error.details)).toBe(true);

    expect(createContractMock).toHaveBeenCalledTimes(1);
    expect(createContractMock.mock.calls[0][0]).not.toHaveProperty(
      "unknownField",
    );
  });
});
