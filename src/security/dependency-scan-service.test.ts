import { DependencyScanService, defaultCommandRunner } from './dependency-scan-service';

describe('defaultCommandRunner', () => {
  it('captures stdout/stderr and exit code for a successful command', async () => {
    const result = await defaultCommandRunner('node', [
      '-e',
      "process.stdout.write('scan-ok'); process.stderr.write('scan-warn');",
    ]);

    expect(result.stdout).toContain('scan-ok');
    expect(result.stderr).toContain('scan-warn');
    expect(result.exitCode).toBe(0);
  });

  it('captures spawn errors for invalid commands', async () => {
    const result = await defaultCommandRunner('__definitely_not_a_real_command__', ['--version']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('DependencyScanService', () => {
  it('returns parsed scan results and evaluates policy', async () => {
    const service = new DependencyScanService(
      async () => ({
        stdout: JSON.stringify({
          vulnerabilities: {
            express: {
              severity: 'low',
              isDirect: true,
              dev: false,
              fixAvailable: true,
              range: '<4.21.0',
              via: ['advisory'],
            },
          },
          metadata: {
            vulnerabilities: {
              info: 0,
              low: 1,
              moderate: 0,
              high: 0,
              critical: 0,
            },
          },
        }),
        stderr: '',
        exitCode: 1,
      }),
      {
        failOn: 'high',
        includeDevDependencies: false,
      },
      10_000,
      () => Date.UTC(2026, 0, 1),
    );

    const result = await service.getLatestScan(true);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.evaluation.passed).toBe(true);
      expect(result.summary.total).toBe(1);
      expect(result.remediation[0]).toContain('npm audit fix');
    }
  });

  it('does not pass --omit=dev when includeDevDependencies is enabled', async () => {
    const observedArgs: string[] = [];

    const service = new DependencyScanService(
      async (_command, args) => {
        observedArgs.push(...args);
        return {
          stdout: JSON.stringify({ vulnerabilities: {} }),
          stderr: '',
          exitCode: 0,
        };
      },
      {
        failOn: 'high',
        includeDevDependencies: true,
      },
      60_000,
      () => 1,
    );

    await service.getLatestScan(true);

    expect(observedArgs).toEqual(['audit', '--json']);
  });

  it('returns cached result before ttl expires', async () => {
    let now = 1_000;
    let calls = 0;

    const service = new DependencyScanService(
      async () => {
        calls += 1;
        return {
          stdout: JSON.stringify({
            vulnerabilities: {},
            metadata: {
              vulnerabilities: {
                info: 0,
                low: 0,
                moderate: 0,
                high: 0,
                critical: 0,
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      },
      {
        failOn: 'high',
        includeDevDependencies: false,
      },
      1_000,
      () => now,
    );

    await service.getLatestScan();
    now = 1_100;
    await service.getLatestScan();

    expect(calls).toBe(1);
  });

  it('forces refresh when requested', async () => {
    let calls = 0;

    const service = new DependencyScanService(
      async () => {
        calls += 1;
        return {
          stdout: JSON.stringify({ vulnerabilities: {} }),
          stderr: '',
          exitCode: 0,
        };
      },
      {
        failOn: 'high',
        includeDevDependencies: false,
      },
      60_000,
      () => 1,
    );

    await service.getLatestScan();
    await service.getLatestScan(true);

    expect(calls).toBe(2);
  });

  it('returns error when audit output is not valid JSON', async () => {
    const service = new DependencyScanService(
      async () => ({
        stdout: 'not-json',
        stderr: '',
        exitCode: 1,
      }),
      {
        failOn: 'high',
        includeDevDependencies: false,
      },
      60_000,
      () => 1,
    );

    const result = await service.getLatestScan(true);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('Invalid npm audit JSON');
    }
  });

  it('returns error when stdout is empty', async () => {
    const service = new DependencyScanService(
      async () => ({
        stdout: '   ',
        stderr: 'command failed',
        exitCode: 1,
      }),
      {
        failOn: 'high',
        includeDevDependencies: false,
      },
      60_000,
      () => 1,
    );

    const result = await service.getLatestScan(true);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('no parsable output');
    }
  });
});
