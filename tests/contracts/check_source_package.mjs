#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (process.env.LP_FLOW_SKIP_PACKAGE_TEST === '1') {
  console.log('Source package check skipped inside extracted artifact test');
  process.exit(0);
}
const plugin = JSON.parse(readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const archive = path.join(root, 'dist', `${plugin.name}-${plugin.version}-source.tar.gz`);
const checksumFile = `${archive}.sha256`;
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

function unpackTarGz(buffer, destination) {
  const tar = gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const readText = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const name = readText(0, 100);
    const prefix = readText(345, 155);
    const relative = `${prefix ? `${prefix}/` : ''}${name}`;
    const size = Number.parseInt(readText(124, 12).trim() || '0', 8);
    if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`Unsafe archive path: ${relative}`);
    const target = path.join(destination, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

const packageResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'package-source-release.mjs')], { cwd: root, encoding: 'utf8' });
process.stdout.write(packageResult.stdout || '');
process.stderr.write(packageResult.stderr || '');
assert(packageResult.status === 0, 'package-source-release must succeed');
assert(existsSync(archive), 'source archive must exist');
assert(existsSync(checksumFile), 'source checksum must exist');

if (existsSync(archive)) {
  const bytes = readFileSync(archive);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert(readFileSync(checksumFile, 'utf8').startsWith(actualHash), 'checksum file must match source archive');
  const extractRoot = mkdtempSync(path.join(tmpdir(), 'lp-flow-package-extract-'));
  try {
    unpackTarGz(bytes, extractRoot);
    const pluginRoot = path.join(extractRoot, `${plugin.name}-${plugin.version}`);
    const files = [];
    const stack = [pluginRoot];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else files.push(path.relative(pluginRoot, full).replace(/\\/g, '/'));
      }
    }
    for (const forbidden of ['runtime/', 'dist/', '.git/']) {
      assert(!files.some(file => file.startsWith(forbidden)), `archive must not contain ${forbidden}`);
    }
    assert(!files.some(file => /(^|\/)node\.exe$/i.test(file) || /\.zip$/i.test(file)), 'archive must not contain node.exe or nested ZIP files');
    assert(files.includes('release-manifest.json'), 'archive must contain release-manifest.json');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const sharedOptions = {
      cwd: pluginRoot,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, LP_FLOW_SKIP_PACKAGE_TEST: '1' },
    };
    const runNpm = args => process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], sharedOptions)
      : spawnSync(npm, args, sharedOptions);
    const npmProbe = runNpm(['--version']);
    const test = npmProbe.status === 0
      ? runNpm(['test'])
      : spawnSync(process.execPath, [
        'scripts/check-source-release.mjs',
      ], sharedOptions);
    if (npmProbe.status !== 0) {
      const commands = [
        ['scripts/check-static.mjs'],
        ['tests/contracts/check_pipeline_skills_contract.mjs'],
        ['tests/mcp/check_stdio_conformance.mjs'],
        ['tests/contracts/check_public_contract.mjs'],
        ['tests/golden-prompts/validate_golden_prompts.mjs'],
        ['tests/golden-prompts/replay_golden_prompts.mjs'],
        ['tests/execution/check_pipeline_execution_smoke.mjs'],
      ];
      for (const args of commands) {
        const result = spawnSync(process.execPath, args, sharedOptions);
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        assert(result.status === 0, `extracted source archive fallback test failed: ${args.join(' ')}`);
      }
      console.log('npm unavailable in this Node runtime; ran the equivalent extracted test suite directly.');
    }
    process.stdout.write(test.stdout || '');
    process.stderr.write(test.stderr || '');
    assert(!test.error && test.status === 0, `extracted source archive ${npmProbe.status === 0 ? 'npm test' : 'release check'} must pass (exit ${test.status}; ${test.error?.message || 'no spawn error'})`);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error('Source package check FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Source package check PASSED');
