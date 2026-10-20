import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { openapi } from '../src/openapi';

describe('OpenAPI validation', () => {
  it('openapi document passes structural validation', async () => {
    expect((openapi as any).openapi).toBe('3.0.3');
    // Basic structural checks
    expect((openapi as any).paths).toBeDefined();
    expect((openapi as any).components.schemas).toBeDefined();
  });

  it('openapi has required schemas', () => {
    const schemas = (openapi as any).components.schemas;
    expect(schemas.EscrowContract).toBeDefined();
    expect(schemas.Error).toBeDefined();
    expect(schemas.Milestone).toBeDefined();
    expect(schemas.Dispute).toBeDefined();
    expect(schemas.Reputation).toBeDefined();
    expect(schemas.Stats).toBeDefined();
    expect(schemas.ChainInfo).toBeDefined();
    expect(schemas.Health).toBeDefined();
    expect(schemas.ServiceInfo).toBeDefined();
    expect(schemas.ContractList).toBeDefined();
    expect(schemas.EscrowContract.required).toContain('reputationIssued');
    expect(schemas.EscrowContract.required).toContain('createdAt');
    expect(schemas.EscrowContract.required).toContain('updatedAt');
  });

  it('proves harness catches a mismatch', async () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemas = (openapi as any).components.schemas;
    for (const [name, schema] of Object.entries(schemas)) {
      ajv.addSchema(schema as any, `#/components/schemas/${name}`);
    }
    const schema = schemas.EscrowContract;
    const validate = ajv.compile(schema);
    expect(validate({ id: 1 })).toBe(false);
  });
});
