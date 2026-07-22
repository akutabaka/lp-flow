#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const data = JSON.parse(readFileSync(path.join(here, 'lp-flow-golden-prompts.json'), 'utf8'));
const skillRoot = path.join(root, 'skills');
const skills = new Set(readdirSync(skillRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(path.join(skillRoot, entry.name, 'SKILL.md')))
  .map(entry => entry.name));
const lpFlowSource = readFileSync(path.join(root, 'scripts', 'lp-flow.mjs'), 'utf8');
const burreteTargets = new Set([
  'open_burrete_docking_view',
  'validate_trajectory_review_artifact',
  'burrete.open_workspace',
]);
const failures = [];

const listTools = spawnSync(process.execPath, [path.join(root, 'scripts', 'lp-flow.mjs'), 'list-tools'], {
  cwd: root,
  encoding: 'utf8',
});
if (listTools.status !== 0) failures.push(`public tool discovery failed: ${listTools.stderr || listTools.stdout}`);
let publicToolCount = 0;
try {
  const tools = JSON.parse(listTools.stdout || '[]');
  publicToolCount = tools.length;
  if (!tools.some(tool => tool.name === 'lp_flow_run_docking')) failures.push('public docking tool is missing');
  if (!tools.some(tool => tool.name === 'lp_flow_md_submit')) failures.push('public MD tool is missing');
} catch (error) {
  failures.push(`public tool discovery returned invalid JSON: ${error.message}`);
}

for (const item of data.cases) {
  const unresolved = item.expected_trace.filter(step => {
    if (skills.has(step)) return false;
    if (burreteTargets.has(step)) return !lpFlowSource.includes(step);
    return true;
  });
  if (unresolved.length) failures.push(`${item.id}: unresolved trace steps: ${unresolved.join(', ')}`);
  console.log(`${item.id}: ${unresolved.length ? 'FAIL' : 'PASS'} (${item.expected_trace.join(' -> ')})`);
}

if (failures.length) {
  console.error('Golden prompt route replay FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Golden prompt route replay PASSED (${data.cases.length} cases, ${skills.size} skills, ${publicToolCount} public tools)`);
