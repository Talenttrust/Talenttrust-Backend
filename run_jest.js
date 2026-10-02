const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const jestArgs = [
  '--coverage',
  '--coverageReporters=text',
  '--coverageReporters=json-summary',
  '--coverageReporters=json',
  'src/observability/metrics-service.test.ts',
  'src/observability/metrics-catalog.test.ts',
  'src/middleware/metricsAuth.test.ts',
  'src/routes/metrics.routes.test.ts',
  'src/routes/metrics-validation-handler.test.ts',
  'src/observability/metrics-validation.test.ts',
  'src/observability/observability-config.test.ts',
  '--runInBand',
  '--colors=false',
];

const jestPath = path.join(__dirname, 'node_modules', '.bin', 'jest.cmd');

const child = spawn(jestPath, jestArgs, {
  cwd: __dirname,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => {
  stdout += data.toString();
  process.stdout.write(data);
});

child.stderr.on('data', (data) => {
  stderr += data.toString();
  process.stderr.write(data);
});

child.on('close', (code) => {
  fs.writeFileSync(path.join(__dirname, 'jest_stdout.txt'), stdout, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'jest_stderr.txt'), stderr, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'jest_exitcode.txt'), String(code), 'utf8');
  process.exit(code);
});
