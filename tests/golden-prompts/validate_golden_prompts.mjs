#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'lp-flow-golden-prompts.json');
const data = JSON.parse(readFileSync(source, 'utf8'));
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

assert(data.version === 1, 'version must be 1');
assert(Array.isArray(data.cases) && data.cases.length >= 5, 'at least five golden prompt cases are required');
const ids = new Set();
for (const [index, item] of (data.cases || []).entries()) {
  const label = `cases[${index}]`;
  assert(typeof item.id === 'string' && item.id.length >= 4, `${label}.id is required`);
  assert(!ids.has(item.id), `${label}.id is duplicated: ${item.id}`);
  ids.add(item.id);
  assert(typeof item.prompt === 'string' && item.prompt.length >= 20, `${label}.prompt is required`);
  for (const field of ['expected_trace', 'required_artifacts', 'required_final_outputs', 'forbidden_outcomes']) {
    assert(Array.isArray(item[field]) && item[field].length > 0, `${label}.${field} must be a non-empty array`);
  }
}

const full = data.cases.find(item => item.id === 'full_3htb_jz4_cpu_pipeline');
assert(full?.expected_trace?.includes('open_burrete_docking_view'), '3HTB case must include docking Burrete review');
assert(full?.expected_trace?.includes('validate_trajectory_review_artifact'), '3HTB case must validate the MD review artifact');
assert(full?.expected_trace?.includes('burrete.open_workspace'), '3HTB case must include MD Burrete review');
assert(full?.required_final_outputs?.includes('clickable_docking_burrete_link'), '3HTB case must require a docking link');
assert(full?.required_final_outputs?.includes('clickable_md_burrete_link'), '3HTB case must require an MD link');

if (failures.length) {
  console.error('Golden prompt dataset validation FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Golden prompt dataset validation PASSED (${data.cases.length} cases)`);
