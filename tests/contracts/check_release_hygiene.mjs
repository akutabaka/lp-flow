#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function read(relative) {
  return readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

function filesUnder(relative = '.') {
  const start = path.join(root, relative);
  const files = [];
  const stack = existsSync(start) ? [start] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (['.git', 'dist', 'runtime', 'node_modules'].includes(entry.name)) continue;
        stack.push(full);
      }
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
const packageJson = JSON.parse(read('package.json'));
assert(manifest.name === 'lp-flow', 'manifest name must be lp-flow');
assert(manifest.version === packageJson.version, 'manifest and package versions must match');
assert((manifest.interface?.defaultPrompt || []).length <= 3, 'manifest exposes more than three default prompts');
assert(manifest.license === packageJson.license, 'manifest and package license states must match');
assert(manifest.license === 'CC-BY-NC-4.0', 'public release must declare CC-BY-NC-4.0');
assert(existsSync(path.join(root, 'LICENSE')), 'public release must include a LICENSE notice');
assert(read('LICENSE').includes('creativecommons.org/licenses/by-nc/4.0/'), 'LICENSE must link to the CC BY-NC 4.0 legal code');

const binaryExtensions = /\.(?:png|jpe?g|gif|webp|bcif|xtc|trr|tpr)$/i;
const combined = filesUnder().filter(file => !binaryExtensions.test(file)).map(file => readFileSync(file, 'utf8')).join('\n');
const windowsHome = String.fromCharCode(67, 58, 92, 85, 115, 101, 114, 115, 92);
const escapedWindowsHome = String.fromCharCode(67, 58, 92, 92, 85, 115, 101, 114, 115, 92, 92);
assert(!combined.includes(`${windowsHome}rina`), 'maintainer-specific Windows home path leaked into source');
assert(!combined.includes(escapedWindowsHome), 'maintainer-specific escaped Windows home path leaked into source');
assert(!/AKIA[0-9A-Z]{16}/.test(combined), 'AWS access-key-shaped value found in source');
assert(!/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(combined), 'private-key block found in source');

function containsCyrillic(value) {
  if (typeof value === 'string') return /[\p{Script=Cyrillic}]/u.test(value);
  if (Array.isArray(value)) return value.some(containsCyrillic);
  return value && typeof value === 'object' && Object.values(value).some(containsCyrillic);
}

assert(!containsCyrillic(manifest), 'plugin manifest contains non-English Cyrillic metadata');

const oversized = filesUnder().filter(file => statSync(file).size > 50 * 1024 * 1024);
assert(oversized.length === 0, `files larger than 50 MiB found: ${oversized.map(file => path.relative(root, file)).join(', ')}`);
const gitignore = read('.gitignore');
assert(gitignore.includes('runtime/'), 'local runtime directory must be ignored by source control');
assert(!existsSync(path.join(root, 'runtime')), 'public source tree must not contain a bundled runtime directory');
const gitFiles = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
if (gitFiles.status === 0) {
  const tracked = gitFiles.stdout.split(/\r?\n/).filter(Boolean);
  assert(!tracked.some(file => /(^|\/)(?:runtime|dist)\//.test(file) || /(^|\/)node\.exe$/i.test(file) || /\.(?:zip|tar|tar\.gz)$/i.test(file)), 'tracked source must not contain runtimes, dist files, node.exe, or release archives');
}

for (const required of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', '.gitattributes', '.github/workflows/ci.yml']) {
  assert(existsSync(path.join(root, ...required.split('/'))), `missing public-release file: ${required}`);
}
assert(existsSync(path.join(root, 'third_party', 'mol-view-stories-LICENSE.txt')), 'bundled Mol View Stories assets require an MIT notice');
const notices = read('THIRD_PARTY_NOTICES.md');
assert(notices.includes('Mol View Stories 5.8.0'), 'third-party notices must list bundled Mol View Stories assets');
assert(notices.includes('mol-view-stories-LICENSE.txt'), 'third-party notices must point to the bundled Mol View Stories notice');

if (failures.length) {
  console.error('Release hygiene check FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Release hygiene check PASSED');
