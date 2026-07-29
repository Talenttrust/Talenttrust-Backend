const { execSync } = require('child_process');
try {
  execSync('npx jest src/audit/router.write.test.ts', { stdio: 'pipe' });
} catch (e) {
  console.log(e.stdout.toString());
}
