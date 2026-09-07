import {
  bulkContractItemSchema,
  BULK_OPERATION_MAX_BATCH_SIZE,
} from "./bulk-operations.dto";
import { TITLE_MAX_LENGTH } from "./contract.dto";
import { MAX_CONTRACT_AMOUNT_STROOPS } from "../../../contracts/bounds";

const validCreate = {
  title: "Valid contract title",
  description: "A valid contract description",
  clientId: "11111111-1111-4111-8111-111111111111",
  budget: 1000,
};

describe("bulkContractItemSchema", () => {
  it("accepts a valid create item and strips unknown fields", () => {
    const result = bulkContractItemSchema.safeParse({
      ...validCreate,
      unknownField: "must not reach the service",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        action: "create",
        ...validCreate,
      });
      expect(result.data).not.toHaveProperty("unknownField");
    }
  });

  it("returns all field errors at once", () => {
    const result = bulkContractItemSchema.safeParse({
      title: 42,
      description: "too short".slice(0, 2),
      clientId: "not-a-uuid",
      budget: "not-a-number",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["title", "description", "clientId", "budget"]),
      );
    }
  });
  it("returns errors for missing required fields", () => {
    const result = bulkContractItemSchema.safeParse({});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["title", "description", "clientId", "budget"]),
      );
    }
  });

  it("rejects oversized strings and numbers", () => {
    const result = bulkContractItemSchema.safeParse({
      ...validCreate,
      title: "x".repeat(TITLE_MAX_LENGTH + 1),
      budget: MAX_CONTRACT_AMOUNT_STROOPS + 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
        expect.arrayContaining(["title", "budget"]),
      );
    }
  });

  it("accepts valid update and delete items", () => {
    const update = bulkContractItemSchema.safeParse({
      action: "update",
      contractId: "contract-1",
      version: 1,
      title: "Updated contract title",
      unknownUpdateField: "stripped",
    });
    const deleteResult = bulkContractItemSchema.safeParse({
      action: "delete",
      id: "contract-1",
      version: 2,
      unknownDeleteField: "stripped",
    });

    expect(update.success).toBe(true);
    expect(deleteResult.success).toBe(true);
    if (update.success) {
      expect(update.data).not.toHaveProperty("unknownUpdateField");
    }
    if (deleteResult.success) {
      expect(deleteResult.data).not.toHaveProperty("unknownDeleteField");
    }
  });

  it("requires an identifier for update and delete items", () => {
    for (const action of ["update", "delete"] as const) {
      const result = bulkContractItemSchema.safeParse({
        action,
        version: 1,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["contractId"],
              message: "update and delete items require contractId or id",
            }),
          ]),
        );
      }
    }
  });

  it("documents the bulk batch bound", () => {
    expect(BULK_OPERATION_MAX_BATCH_SIZE).toBeGreaterThan(0);
  });
});
