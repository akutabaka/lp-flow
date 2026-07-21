#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const dist = path.join(root, 'dist');
const archiveBase = `${plugin.name}-${plugin.version}-source`;
const archivePath = path.join(dist, `${archiveBase}.tar.gz`);
const checksumPath = `${archivePath}.sha256`;
const stage = mkdtempSync(path.join(tmpdir(), 'lp-flow-package-'));

function padString(buffer, value, offset, length) {
  Buffer.from(value, 'utf8').copy(buffer, offset, 0, length);
}

function padOctal(buffer, value, offset, length) {
  const encoded = `${Math.max(0, value).toString(8).padStart(length - 1, '0')}\0`;
  padString(buffer, encoded, offset, length);
}

function tarHeader(relative, size) {
  const header = Buffer.alloc(512, 0);
  const normalized = relative.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const name = normalized.length <= 100 ? normalized : normalized.slice(slash + 1);
  const prefix = normalized.length <= 100 ? '' : normalized.slice(0, slash);
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Archive path is too long for ustar: ${normalized}`);
  padString(header, name, 0, 100);
  padOctal(header, 0o644, 100, 8);
  padOctal(header, 0, 108, 8);
  padOctal(header, 0, 116, 8);
  padOctal(header, size, 124, 12);
  padOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  padString(header, 'ustar', 257, 6);
  padString(header, '00', 263, 2);
  padString(header, 'lp-flow', 265, 32);
  padString(header, 'lp-flow', 297, 32);
  padString(header, prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  padOctal(header, checksum, 148, 8);
  return header;
}

function listFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function sourceCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

try {
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-source-release.mjs'), '--out-dir', stage], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || 'Source release staging failed');

  const sourceFiles = listFiles(stage).map(file => {
    const data = readFileSync(file);
    return {
      path: path.relative(stage, file).replace(/\\/g, '/'),
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
  writeFileSync(path.join(stage, 'release-manifest.json'), `${JSON.stringify({
    schema: 'lp-flow.release-manifest.v1',
    name: plugin.name,
    version: plugin.version,
    source_commit: sourceCommit(),
    source_files: sourceFiles,
  }, null, 2)}\n`);

  const prefix = `${plugin.name}-${plugin.version}/`;
  const tarParts = [];
  for (const file of listFiles(stage)) {
    const data = readFileSync(file);
    tarParts.push(tarHeader(`${prefix}${path.relative(stage, file).replace(/\\/g, '/')}`, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) tarParts.push(Buffer.alloc(padding));
  }
  tarParts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(tarParts), { mtime: 0 });
  mkdirSync(dist, { recursive: true });
  writeFileSync(archivePath, archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  writeFileSync(checksumPath, `${sha256}  ${path.basename(archivePath)}\n`);
  console.log(JSON.stringify({ archive: archivePath, checksum: checksumPath, sha256, bytes: archive.length }, null, 2));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
