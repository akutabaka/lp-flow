#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const excludedDirectories = new Set(['.git', 'dist', 'node_modules', 'profiles', 'runtime', 'outputs', 'results', '.lp-flow-runs']);
const excludedNames = new Set(['.env', '.DS_Store', 'Thumbs.db']);
const excludedExtensions = new Set(['.zip', '.tar', '.gz', '.tgz', '.bcif', '.xtc', '.trr', '.tpr', '.edr', '.log']);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const requestedOutDir = option('--out-dir');
const destination = path.resolve(requestedOutDir || path.join(tmpdir(), `${manifest.name}-${manifest.version}-source`));

function includeSource(source) {
  const relative = path.relative(root, source);
  const segments = relative.split(path.sep);
  if (segments.some(segment => excludedDirectories.has(segment))) return false;
  const base = path.basename(source);
  if (excludedNames.has(base) || /^\.env(?:\.|$)/.test(base)) return false;
  return !excludedExtensions.has(path.extname(base).toLowerCase());
}

if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

for (const entry of readdirSync(root)) {
  const source = path.join(root, entry);
  if (!includeSource(source)) continue;
  cpSync(source, path.join(destination, entry), { recursive: true, filter: includeSource });
}

writeFileSync(path.join(destination, '.lp-flow-source-release.json'), `${JSON.stringify({
  schema: 'lp-flow.source-release.v1',
  name: manifest.name,
  version: manifest.version,
  source_root: path.basename(root),
}, null, 2)}\n`);
console.log(destination);
