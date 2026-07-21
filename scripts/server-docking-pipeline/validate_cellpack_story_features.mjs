#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStory,
  coordinateGeometry,
  enrichEntities,
  framingPolicy,
  groupSummaries,
  validateMvsj,
} from './make_cellpack_story.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function findNodes(node, kind, output = []) {
  if (node?.kind === kind) output.push(node);
  for (const child of node?.children || []) findNodes(child, kind, output);
  return output;
}

function main() {
  const bounds = {
    min: [-3000, -3100, -3050],
    max: [3100, 3150, 3075],
    center: [50, 25, 12.5],
    extent: [6100, 6250, 6125],
    radius: 5333.659,
  };
  const inspection = {
    assembly_id: '1',
    assembly_bounds: bounds,
    source_bounds: bounds,
    entities: [
      {
        id: '1',
        description: 'surface.MG_001_MONOMER',
        details: null,
        label: 'surface.MG_001_MONOMER',
        label_source: 'bcif:entity.pdbx_description',
      },
      {
        id: '2',
        description: 'interior.MG_002_MONOMER',
        details: null,
        label: 'interior.MG_002_MONOMER',
        label_source: 'bcif:entity.pdbx_description',
      },
      {
        id: '3',
        description: 'DNA_FIBER',
        details: null,
        label: 'DNA_FIBER',
        label_source: 'bcif:entity.pdbx_description',
      },
    ],
  };
  const entities = enrichEntities(inspection, { entries: new Map() });
  const story = buildStory({
    inputPath: path.resolve('synthetic_cellpack.bcif'),
    assetName: 'synthetic_cellpack.bcif',
    inspection,
    entities,
    title: 'Synthetic CellPACK feature validation',
    cutaway: true,
    axis: 'x',
    offset: 0,
    maxGroupScenes: 5,
  });
  const validation = validateMvsj(story);
  assert.equal(validation.ok, true, validation.issues.join('\n'));

  const geometry = coordinateGeometry(bounds);
  assert.deepEqual(geometry, {
    extent_x: 6100,
    extent_y: 6250,
    extent_z: 6125,
    max_axis_extent: 6250,
    bounding_box_diagonal: 10667.152,
    unit_policy: 'Report source Cartesian values as coordinate units unless physical units are explicitly supported by source metadata.',
    physical_unit_claimed: false,
    physical_unit: null,
    physical_unit_source: null,
  });

  const exteriorText = story.snapshots[0].metadata.description;
  assert.match(exteriorText, /Coordinate extent: 6100 x 6250 x 6125 coordinate units/);
  assert.match(exteriorText, /Max-axis diameter proxy: 6250 coordinate units/);
  assert.match(exteriorText, /Bounding-box diagonal: 10667\.152 coordinate units/);
  assert.match(exteriorText, /Physical units not specified in source metadata\./);
  assert.match(exteriorText, /Groups from source metadata or explicit annotations: `surface`, `interior`, `fiber`\./);
  assert.doesNotMatch(exteriorText, /(?:\bnm\b|Å|angstrom)/i);

  const focusNodes = story.snapshots.flatMap(item => findNodes(item.root, 'focus'));
  assert.equal(focusNodes.length, story.snapshots.length);
  assert.ok(focusNodes.every(node => node.params.radius === 8267.171));

  const grouped = new Map();
  for (const entity of entities) {
    if (!grouped.has(entity.group)) grouped.set(entity.group, []);
    grouped.get(entity.group).push(entity);
  }
  const summaries = groupSummaries([...grouped.entries()]);
  assert.ok(summaries.every(group => group.source_type === 'metadata-token'));
  assert.ok(summaries.every(group => group.formal_biological_ontology_claimed === false));

  const framing = framingPolicy(bounds);
  assert.equal(framing.focus_radius_factor, 1.55);
  assert.equal(framing.reset_zoom_controlled_by_story, false);

  console.log(JSON.stringify({
    ok: true,
    validation,
    coordinate_geometry: geometry,
    groups: summaries.map(({ entities: members, ...group }) => group),
    camera_framing: framing,
  }, null, 2));
}

if (path.resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
