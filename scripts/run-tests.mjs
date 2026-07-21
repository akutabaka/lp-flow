#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'scripts/check-static.mjs',
  'scripts/check-source-release.mjs',
  'tests/mcp/check_stdio_conformance.mjs',
  'tests/contracts/check_public_contract.mjs',
  'tests/contracts/check_pipeline_skills_contract.mjs',
  'tests/golden-prompts/validate_golden_prompts.mjs',
  'tests/execution/check_pipeline_execution_smoke.mjs',
  'tests/contracts/check_source_package.mjs',
];

for (const relative of tests) {
  const result = spawnSync(process.execPath, [relative], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

console.log('LP-Flow full test suite PASSED');
