/**
 * @file health.test.ts
 * @description Smoke test — verifies the test runner itself is operational.
 *
 * Detailed health-route tests live in src/routes/health.test.ts.
 */

describe('test runner smoke test', () => {
  it('Jest is configured and running', () => {
    expect(true).toBe(true);
  });

  it('TypeScript types are available', () => {
    const val: string = 'talenttrust';
    expect(typeof val).toBe('string');
  });
});
