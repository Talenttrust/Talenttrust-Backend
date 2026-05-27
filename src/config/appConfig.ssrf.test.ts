import { loadConfig } from '../appConfiguration';

describe('loadConfig SSRF Protection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should throw if UPSTREAM_CONTRACTS_URL is private', () => {
    process.env.UPSTREAM_CONTRACTS_URL = 'http://localhost:3001/contracts';
    expect(() => loadConfig(process.env)).toThrow(/SSRF protection/);
  });

  it('should allow public UPSTREAM_CONTRACTS_URL', () => {
    process.env.UPSTREAM_CONTRACTS_URL = 'https://api.github.com/contracts';
    const config = loadConfig(process.env);
    expect(config.upstreamContractsUrl).toBe('https://api.github.com/contracts');
  });
});
