import { generateOpenApiSpec } from './generate-openapi';

describe('generateOpenApiSpec', () => {
  it('should generate a valid OpenAPI spec', () => {
    const spec = generateOpenApiSpec();
    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info).toBeDefined();
    expect(spec.servers).toBeDefined();
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths)).not.toHaveLength(0);
  });

  it('should include contracts, reputation, and health routes', () => {
    const spec = generateOpenApiSpec();
    expect(spec.paths['/contracts']).toBeDefined();
    expect(spec.paths['/reputation']).toBeDefined();
    expect(spec.paths['/health']).toBeDefined();
  });
});