#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'dist', 'node_modules', 'runtime']);
const failures = [];
const files = [];
const stack = [root];
while (stack.length) {
  const current = stack.pop();
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) stack.push(full);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

for (const file of files) {
  const relative = path.relative(root, file);
  if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${relative}: ${result.stderr || 'node --check failed'}`);
  }
  if (file.endsWith('.json')) {
    try {
      JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      failures.push(`${relative}: invalid JSON (${error.message})`);
    }
  }
}

if (failures.length) {
  console.error('Static validation FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Static validation PASSED (${files.filter(file => file.endsWith('.mjs')).length} JavaScript modules, ${files.filter(file => file.endsWith('.json')).length} JSON files)`);
