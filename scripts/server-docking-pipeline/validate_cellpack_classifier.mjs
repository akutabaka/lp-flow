#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCellpackModel } from './lib/binary_cif_inspector.mjs';
import { classifyStoryInput } from './lib/story_input_classifier.mjs';
import { readAnnotationMap } from './make_cellpack_story.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function assertClassification(name, inspection, expected) {
  const result = classifyStoryInput(inspection);
  if (result.classification !== expected) {
    throw new Error(`${name}: expected ${expected}, received ${result.classification}\n${JSON.stringify(result, null, 2)}`);
  }
  return { name, expected, result };
}

function syntheticCases() {
  return [
    assertClassification('packed positive', {
      atom_count: 120000,
      asym_count: 180,
      operation_count: 2200,
      assembly_gen_row_count: 180,
      total_instance_count: 3200,
      max_entity_instance_count: 500,
      assembly_bounds: { extent: [1200, 1100, 1000] },
      entities: Array.from({ length: 20 }, (_, index) => ({
        description: index % 2 ? 'surface component' : 'interior cargo',
        instance_count: 160,
        references: [],
      })),
    }, 'cellpack-mesoscale'),
    assertClassification('ordinary negative', {
      atom_count: 327,
      asym_count: 1,
      operation_count: 1,
      assembly_gen_row_count: 1,
      total_instance_count: 1,
      max_entity_instance_count: 1,
      assembly_bounds: { extent: [30, 24, 22] },
      entities: [{ description: 'plant seed protein', instance_count: 1, references: [] }],
    }, 'ordinary-structure'),
    assertClassification('ambiguous', {
      atom_count: 25000,
      asym_count: 12,
      operation_count: 12,
      assembly_gen_row_count: 4,
      total_instance_count: 24,
      max_entity_instance_count: 4,
      assembly_bounds: { extent: [320, 280, 260] },
      entities: Array.from({ length: 6 }, () => ({ instance_count: 4, references: [] })),
    }, 'ambiguous'),
    assertClassification('invalid', {
      atom_count: 0,
      asym_count: 0,
      operation_count: 0,
      entities: [],
    }, 'invalid-or-unsupported'),
  ];
}

function annotationProvenanceCase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-flow-cellpack-'));
  const annotationPath = path.join(tempDir, 'annotation.json');
  try {
    fs.writeFileSync(annotationPath, JSON.stringify({
      components: [{ label_entity_id: '1', label: 'Invented label' }],
    }), 'utf8');
    try {
      readAnnotationMap(annotationPath);
    } catch (error) {
      if (String(error?.message || error).includes('requires explicit provenance/source')) {
        return { name: 'annotation provenance refusal', expected: 'refused', result: 'refused' };
      }
      throw error;
    }
    throw new Error('annotation provenance refusal: unprovenanced visible label was accepted');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function inspectFile(role, rawPath, expected) {
  if (!rawPath) return null;
  const inputPath = path.resolve(String(rawPath));
  if (!fs.existsSync(inputPath)) throw new Error(`${role} file does not exist: ${inputPath}`);
  return assertClassification(role, inspectCellpackModel(inputPath), expected);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = syntheticCases();
  results.push(annotationProvenanceCase());
  const positive = inspectFile('positive BCIF', args.positive, 'cellpack-mesoscale');
  const negative = inspectFile('negative BCIF', args.negative, 'ordinary-structure');
  if (positive) results.push(positive);
  if (negative) results.push(negative);
  console.log(JSON.stringify({ ok: true, cases: results }, null, 2));
}

if (path.resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { assertClassification, syntheticCases };
