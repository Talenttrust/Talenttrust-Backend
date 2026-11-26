import fs from 'fs';
import path from 'path';

/**
 * Test that all environment variables read in the codebase are documented in .env.example.
 *
 * This test scans all TypeScript files in src/ for patterns like:
 * - process.env.VARIABLE_NAME
 *
 * and ensures each variable name appears in .env.example (commented is fine).
 *
 * Allowlist contains variables that are intentionally not documented:
 * - NODE_ENV: standard Node.js environment variable
 */

const ALLOWLIST = new Set(['NODE_ENV']);

// Pattern to match environment variable usage
const PROCESS_ENV_PATTERN = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

function extractEnvVarsFromFile(filePath: string): Set<string> {
  const content = fs.readFileSync(filePath, 'utf8');
  const vars = new Set<string>();
  
  // Match process.env.VARIABLE_NAME
  let match;
  while ((match = PROCESS_ENV_PATTERN.exec(content)) !== null) {
    vars.add(match[1]);
  }
  
  return vars;
}

function extractEnvVarsFromDotenvExample(filePath: string): Set<string> {
  const content = fs.readFileSync(filePath, 'utf8');
  const vars = new Set<string>();
  
  // Match lines like VAR=value or # VAR=value (commented)
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comment-only lines
    if (!trimmed || trimmed === '#') continue;
    
    // Match variable name at start of line (possibly with # prefix for comments)
    const match = trimmed.match(/^(?:#\s*)?([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      vars.add(match[1]);
    }
  }
  
  return vars;
}

function findTsFiles(dir: string, filePaths: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTsFiles(fullPath, filePaths);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      filePaths.push(fullPath);
    }
  }
  
  return filePaths;
}

describe('.env.example coverage', () => {
  it('should document all environment variables read in the codebase', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const envExamplePath = path.join(__dirname, '..', '.env.example');
    
    // Find all TypeScript files in src/
    const tsFiles = findTsFiles(srcDir);
    
    // Extract all environment variables from TypeScript files
    const codeVars = new Set<string>();
    for (const file of tsFiles) {
      const fileVars = extractEnvVarsFromFile(file);
      for (const v of fileVars) {
        if (!ALLOWLIST.has(v)) {
          codeVars.add(v);
        }
      }
    }
    
    // Extract all environment variables from .env.example
    const exampleVars = extractEnvVarsFromDotenvExample(envExamplePath);
    
    // Find variables in code but not in .env.example
    const missingVars = [...codeVars].filter(v => !exampleVars.has(v));
    
    if (missingVars.length > 0) {
      throw new Error(
        `The following environment variables are read in the codebase but not documented in .env.example:\n` +
        missingVars.map(v => `  - ${v}`).join('\n') +
        '\n\nPlease add them to .env.example with a one-line comment describing their purpose.'
      );
    }
  });
});
