#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STORY_MODES, resolveStoryMode } from './story_modes.mjs';

function parseMode(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mode') return { mode: argv[i + 1], remove: [i, i + 1] };
    if (argv[i].startsWith('--mode=')) return { mode: argv[i].slice(7), remove: [i] };
  }
  return { mode: null, remove: [] };
}

function usage() {
  const rows = Object.values(STORY_MODES)
    .map(mode => `  ${mode.id.padEnd(12)} ${mode.status.padEnd(11)} ${mode.description}`)
    .join('\n');
  return `Usage:
  node scripts/make_story.mjs --mode <mode> [mode-specific options]
  node scripts/make_story.mjs --list-modes

Modes:
${rows}
`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list-modes')) {
    console.log(JSON.stringify(STORY_MODES, null, 2));
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const parsed = parseMode(argv);
  if (!parsed.mode) throw new Error('--mode is required');
  const mode = resolveStoryMode(parsed.mode);
  if (mode.status !== 'implemented' || !mode.generator) {
    throw new Error(`Story mode "${mode.id}" is ${mode.status}; no generator is available yet`);
  }
  const forwarded = argv.filter((_, index) => !parsed.remove.includes(index));
  const result = spawnSync(process.execPath, [mode.generator, ...forwarded], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
