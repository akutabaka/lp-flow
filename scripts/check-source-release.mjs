#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = mkdtempSync(path.join(tmpdir(), 'lp-flow-source-release-'));

try {
  const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-source-release.mjs'), '--out-dir', staging], { cwd: root, encoding: 'utf8' });
  process.stdout.write(build.stdout || '');
  process.stderr.write(build.stderr || '');
  if (build.status !== 0) process.exit(build.status ?? 1);

  const check = spawnSync(process.execPath, [path.join(staging, 'tests', 'contracts', 'check_release_hygiene.mjs')], { cwd: staging, encoding: 'utf8' });
  process.stdout.write(check.stdout || '');
  process.stderr.write(check.stderr || '');
  process.exitCode = check.status ?? 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
