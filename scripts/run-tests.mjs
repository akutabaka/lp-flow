#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'scripts/check-static.mjs',
  'scripts/check-source-release.mjs',
  'tests/mcp/check_stdio_conformance.mjs',
  'tests/mcp/check_cancellation.mjs',
  'tests/integration/check_burrete_host_integration.mjs',
  'tests/contracts/check_public_contract.mjs',
  'tests/contracts/check_pipeline_skills_contract.mjs',
  'tests/golden-prompts/validate_golden_prompts.mjs',
  'tests/golden-prompts/replay_golden_prompts.mjs',
  'tests/execution/check_pipeline_execution_smoke.mjs',
  'tests/contracts/check_source_package.mjs',
];
let burreteHostStatus = 'NOT_RUN';

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
  if (relative.endsWith('check_burrete_host_integration.mjs')) {
    burreteHostStatus = /BURRETE_HOST_STATUS=(PASSED|SKIPPED)/.exec(result.stdout || '')?.[1] || 'UNKNOWN';
  }
}

console.log(`LP-Flow full test suite PASSED (Burrete host: ${burreteHostStatus})`);
