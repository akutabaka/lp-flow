#!/usr/bin/env node
/**
 * Generate a Mol View Stories source folder for docking review.
 *
 * The output is intentionally dependency-light: it creates the folder-based
 * story format used by molstar/mol-view-stories CLI, plus a manifest. If the
 * upstream MVS CLI/Deno runtime is available, the folder can be exported to
 * html/mvsx/mvstory without changing the generated source.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCORE_COLUMNS = [
  'gnina_minimized_affinity',
  'gnina_minimized_cnnscore',
  'gnina_minimized_cnnaffinity',
  'smina_minimized_affinity',
  'matcha_best_minimizedAffinity',
  'matcha_best_minimizedCNNscore',
  'matcha_best_minimizedCNNaffinity',
  'boltz_confidence_score',
  'boltz_affinity_pred_value',
  'boltz_deltaG_kcal_mol_approx',
];

const STATUS_COLUMNS = [
  'gnina_status',
  'smina_status',
  'matcha_status',
  'boltz_status',
];

const FORMAT_BY_SUFFIX = new Map([
  ['.pdb', 'pdb'],
  ['.ent', 'pdb'],
  ['.cif', 'mmcif'],
  ['.mmcif', 'mmcif'],
  ['.sdf', 'sdf'],
  ['.mol2', 'mol2'],
  ['.mol', 'mol'],
]);

const ANGSTROM = '\u00C5';

const INTERACTION_PRIORITY = new Map([
  ['metal_coordination', 0],
  ['ionic', 1],
  ['hydrogen_bond', 2],
  ['pi_stacking', 3],
  ['hydrophobic', 4],
  ['generic_contact', 5],
]);

const INTERACTION_COLORS = {
  metal_coordination: '#7C3AED',
  ionic: '#DC2626',
  hydrogen_bond: '#2563EB',
  pi_stacking: '#A21CAF',
  hydrophobic: '#CA8A04',
  generic_contact: '#4B5563',
};

const INTERACTION_LABELS = {
  metal_coordination: 'metal coordination',
  ionic: 'ionic / salt bridge',
  hydrogen_bond: 'hydrogen bond',
  pi_stacking: 'pi-pi stacking',
  hydrophobic: 'hydrophobic contact',
  generic_contact: 'generic close contact',
};

const INTERACTION_COLOR_NAMES = {
  metal_coordination: 'violet',
  ionic: 'red',
  hydrogen_bond: 'blue',
  pi_stacking: 'magenta',
  hydrophobic: 'ochre / orange',
  generic_contact: 'gray',
};

const METAL_ELEMENTS = new Set([
  'LI', 'NA', 'K', 'RB', 'CS', 'MG', 'CA', 'SR', 'BA',
  'MN', 'FE', 'CO', 'NI', 'CU', 'ZN', 'CD', 'HG',
]);
const HALOGEN_ELEMENTS = new Set(['F', 'CL', 'BR', 'I']);
const HYDROPHOBIC_RESIDUES = new Set(['ALA', 'VAL', 'LEU', 'ILE', 'MET', 'PRO', 'PHE', 'TRP', 'TYR']);
const PROTEIN_POSITIVE_ATOMS = new Set(['LYS:NZ', 'ARG:NE', 'ARG:NH1', 'ARG:NH2']);
const PROTEIN_NEGATIVE_ATOMS = new Set(['ASP:OD1', 'ASP:OD2', 'GLU:OE1', 'GLU:OE2']);
const PROTEIN_ACCEPTOR_ATOMS = new Set([
  'ASP:OD1', 'ASP:OD2', 'GLU:OE1', 'GLU:OE2',
  'ASN:OD1', 'GLN:OE1', 'SER:OG', 'THR:OG1', 'TYR:OH',
  'HIS:ND1', 'HIS:NE2', 'CYS:SG',
]);
const PROTEIN_AROMATIC_RINGS = {
  PHE: [['CG', 'CD1', 'CE1', 'CZ', 'CE2', 'CD2']],
  TYR: [['CG', 'CD1', 'CE1', 'CZ', 'CE2', 'CD2']],
  HIS: [['CG', 'ND1', 'CE1', 'NE2', 'CD2']],
  TRP: [
    ['CG', 'CD1', 'NE1', 'CE2', 'CD2'],
    ['CD2', 'CE2', 'CZ2', 'CH2', 'CZ3', 'CE3'],
  ],
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const raw = item.slice(2);
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    let value = eq >= 0 ? raw.slice(eq + 1) : true;
    if (value === true && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    const normalized = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(args, normalized)) {
      if (!Array.isArray(args[normalized])) args[normalized] = [args[normalized]];
      args[normalized].push(value);
    } else {
      args[normalized] = value;
    }
  }
  return args;
}

function usage() {
  return `Usage:
  node make_docking_story.mjs --results-dir <results> [--out-dir <results/molview_stories/docking_story>] [--case <name>]
                              [--receptor <file>] [--reference-ligand label=file] [--pose label=file]
                              [--top-ligands 5] [--poses-per-ligand all] [--center x,y,z] [--active-site-note text]

Output:
  story.yaml, story.js, scenes/*, assets/*, story_manifest.json, README.md

Multi-record SDF pose files:
  SDF files with multiple $$$$ records are expanded into separate pose scenes.
  Contacts, distances, and interaction types are recomputed for each SDF record.
  Use --poses-per-ligand <n|all> to limit pose scenes per selected ligand.
`;
}

function must(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function maybeReadJson(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

function normalizePath(file) {
  return path.resolve(String(file));
}

function copyFile(source, target) {
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
  return fs.statSync(target).size;
}

function writeAssetContent(contents, target) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, contents, 'utf8');
  return fs.statSync(target).size;
}

function safeId(value, prefix = 'item') {
  let id = String(value || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!id) id = prefix;
  if (!/^[A-Za-z_]/.test(id)) id = `${prefix}_${id}`;
  return id;
}

function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function yamlString(value) {
  const text = String(value ?? '');
  return JSON.stringify(text);
}

function markdownEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function detectFormat(file, explicit) {
  if (explicit) return String(explicit).toLowerCase();
  const suffix = path.extname(file).toLowerCase();
  return FORMAT_BY_SUFFIX.get(suffix) || 'pdb';
}

function splitLabelPath(spec) {
  const text = String(spec || '');
  const eq = text.indexOf('=');
  if (eq < 0) {
    const file = normalizePath(text);
    return { label: path.basename(file, path.extname(file)), file };
  }
  const label = text.slice(0, eq).trim();
  const file = normalizePath(text.slice(eq + 1).trim());
  return { label: label || path.basename(file, path.extname(file)), file };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(v => String(v).trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function readSummary(resultsDir) {
  const file = path.join(resultsDir, 'summary_wide.csv');
  if (!fs.existsSync(file)) return { file: null, rows: [] };
  return { file, rows: parseCsv(fs.readFileSync(file, 'utf8')) };
}

function numeric(value) {
  const text = String(value ?? '').trim();
  if (!text || /^nan$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function bestSortValue(row) {
  for (const key of ['gnina_minimized_affinity', 'smina_minimized_affinity', 'gnina_score_only_affinity']) {
    const value = numeric(row[key]);
    if (value !== null) return value;
  }
  return Number.POSITIVE_INFINITY;
}

function makeScoreLines(row) {
  const lines = [];
  for (const key of SCORE_COLUMNS) {
    const value = String(row[key] ?? '').trim();
    if (value) lines.push({ key, value });
  }
  return lines;
}

function makeStatusLines(row) {
  const lines = [];
  for (const key of STATUS_COLUMNS) {
    const value = String(row[key] ?? '').trim();
    if (value) lines.push({ key, value });
  }
  return lines;
}

function inferCaseName(resultsDir, manifest, explicitCase) {
  if (explicitCase) return String(explicitCase);
  if (manifest?.case) return String(manifest.case);
  const parent = path.basename(path.dirname(resultsDir));
  return parent || path.basename(resultsDir);
}

function readMolstarManifest(resultsDir) {
  const file = path.join(resultsDir, 'molstar', 'manifest.json');
  const manifest = maybeReadJson(file);
  return { file: manifest ? file : null, manifest };
}

function addEntry(entries, used, sourceFile, role, label, explicitFormat = null) {
  if (!sourceFile || !fs.existsSync(sourceFile)) return null;
  const id = uniqueId(safeId(label || path.basename(sourceFile, path.extname(sourceFile)), role), used);
  const format = detectFormat(sourceFile, explicitFormat);
  const suffix = path.extname(sourceFile) || `.${format}`;
  return entries.push({
    id,
    role,
    label: label || id,
    sourceFile,
    assetName: `${id}${suffix}`,
    format,
  }) && entries[entries.length - 1];
}

function normalizeSdfRecord(record, index = 0, label = 'ligand') {
  const lines = String(record || '').replace(/\s+$/g, '').split(/\r?\n/);
  while (lines.length && lines[0].trim() === '') lines.shift();
  const countsIndex = lines.findIndex(line => /\bV(2000|3000)\b/i.test(line) && /^\s*\d+\s+\d+/.test(line));
  if (countsIndex < 0) return `${lines.join('\n')}\n$$$$\n`;
  const body = lines.slice(countsIndex);
  const header = lines.slice(0, countsIndex).filter(line => line.trim() !== '').slice(0, 3);
  while (header.length < 3) {
    if (header.length === 0) header.push(`${label} pose ${index + 1}`);
    else if (header.length === 1) header.push('LP-Flow');
    else header.push('');
  }
  return `${[...header.slice(0, 3), ...body].join('\n')}\n$$$$\n`;
}

function sdfRecords(file) {
  if (!file || !/\.sdf$/i.test(file) || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('$$$$')
    .filter(record => record.trim())
    .map((record, index) => normalizeSdfRecord(record, index, path.basename(file, path.extname(file))));
}

function expandSelectedPoseItem(item) {
  const entry = item.entry;
  const records = sdfRecords(entry.sourceFile);
  if (records.length <= 1) {
    return [{
      ...item,
      entry: {
        ...entry,
        parentId: entry.id,
        parentLabel: entry.label,
        poseRecordIndex: 0,
        poseRecordCount: Math.max(1, records.length),
      },
      poseOrdinal: 1,
      poseCount: Math.max(1, records.length),
    }];
  }
  return records.map((record, index) => {
    const poseOrdinal = index + 1;
    const poseLabel = `${entry.label} pose ${poseOrdinal}`;
    const id = `${entry.id}_pose_${String(poseOrdinal).padStart(2, '0')}`;
    return {
      ...item,
      label: poseLabel,
      poseOrdinal,
      poseCount: records.length,
      entry: {
        ...entry,
        id,
        label: poseLabel,
        parentId: entry.id,
        parentLabel: entry.label,
        poseRecordIndex: index,
        poseRecordCount: records.length,
        assetName: `${safeId(entry.label, 'pose')}_pose${String(poseOrdinal).padStart(2, '0')}.sdf`,
        assetContent: record,
      },
    };
  });
}

function expandSelectedPoseItems(items, args) {
  const rawLimit = args.posesPerLigand || args.poses_per_ligand || args.poseLimit || args.pose_limit || 'all';
  const limit = String(rawLimit).toLowerCase() === 'all'
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Number.parseInt(rawLimit, 10) || 1);
  return items.flatMap(item => expandSelectedPoseItem(item).slice(0, limit));
}

function collectEntries(args, resultsDir, molstarManifest) {
  const entries = [];
  const used = new Set();
  if (molstarManifest?.files?.length) {
    const molstarDir = path.join(resultsDir, 'molstar');
    for (const item of molstarManifest.files) {
      if (!['receptor', 'reference', 'pose'].includes(item.role)) continue;
      let sourceFile = null;
      if (item.data_file) sourceFile = path.join(molstarDir, item.data_file);
      if (!sourceFile || !fs.existsSync(sourceFile)) sourceFile = item.source_path;
      addEntry(entries, used, sourceFile, item.role, item.label || item.id, item.format);
    }
  }

  if (args.receptor && !entries.some(e => e.role === 'receptor')) {
    addEntry(entries, used, normalizePath(args.receptor), 'receptor', 'Receptor');
  }

  const refs = args.referenceLigand || args.reference || [];
  for (const spec of (Array.isArray(refs) ? refs : [refs]).filter(Boolean)) {
    const parsed = splitLabelPath(spec);
    addEntry(entries, used, parsed.file, 'reference', parsed.label);
  }

  const poses = args.pose || args.poses || [];
  for (const spec of (Array.isArray(poses) ? poses : [poses]).filter(Boolean)) {
    const parsed = splitLabelPath(spec);
    addEntry(entries, used, parsed.file, 'pose', parsed.label);
  }

  if (!entries.some(e => e.role === 'pose')) {
    const gninaDir = path.join(resultsDir, 'gnina');
    if (fs.existsSync(gninaDir)) {
      for (const name of fs.readdirSync(gninaDir).sort()) {
        if (!/_gnina\.sdf$/i.test(name)) continue;
        const label = name.replace(/_gnina\.sdf$/i, '');
        addEntry(entries, used, path.join(gninaDir, name), 'pose', label, 'sdf');
      }
    }
  }

  return entries;
}

function parseCenter(value) {
  if (!value) return null;
  const parts = String(value).split(',').map(v => Number(v.trim()));
  if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) return null;
  return parts;
}

function cameraFor(center) {
  if (!center) return null;
  const [x, y, z] = center;
  return {
    target: [x, y, z],
    position: [x + 18, y + 18, z + 18],
    up: [0, 1, 0],
    fov: 45,
    mode: 'perspective',
  };
}

function yamlCamera(camera) {
  if (!camera) return '';
  return [
    'camera:',
    `  mode: ${yamlString(camera.mode)}`,
    `  target: [${camera.target.map(v => Number(v.toFixed(3))).join(', ')}]`,
    `  position: [${camera.position.map(v => Number(v.toFixed(3))).join(', ')}]`,
    `  up: [${camera.up.join(', ')}]`,
    `  fov: ${camera.fov}`,
  ].join('\n');
}

function loadStructureJs(varName, assetName, format) {
  return `const ${varName} = builder\n  .download({ url: ${jsString(assetName)} })\n  .parse({ format: ${jsString(format)} })\n  .modelStructure({});`;
}

function hexNumber(color) {
  return Number.parseInt(String(color).replace(/^#/, ''), 16);
}

function elementColorJs(carbonColor) {
  return `.color({
    custom: {
      molstar_color_theme_name: "element-symbol",
      molstar_color_theme_params: {
        carbonColor: { name: "uniform", params: { value: ${hexNumber(carbonColor)} } }
      }
    }
  })`;
}

function receptorJs(entry) {
  return `${loadStructureJs('receptor', entry.assetName, entry.format)}

const receptorPolymer = receptor.component({ selector: "polymer" });
const receptorPolymerRepr = receptorPolymer.representation({ type: "cartoon" });
receptorPolymerRepr.color({ color: "#A9B7C8" });
receptorPolymerRepr.opacity({ opacity: 0.55 });

receptor
  .component({ selector: "ligand" })
  .representation({ type: "ball_and_stick" })
  ${elementColorJs('#59A14F')};`;
}

function referenceJs(entry, index, opacity = 0.22) {
  const name = `reference${index}`;
  return `${loadStructureJs(name, entry.assetName, entry.format)}

${name}
  .component({ selector: "all" })
  .representation({
    type: "ball_and_stick",
    custom: {
      molstar_representation_params: {
        sizeFactor: 0.28
      }
    }
  })
  ${elementColorJs('#F28E2B')}
  .opacity({ opacity: ${Number(opacity).toFixed(2)} });`;
}

function poseJs(entry, varName = 'pose', carbonColor = '#E15759') {
  return `${loadStructureJs(varName, entry.assetName, entry.format)}

${varName}
  .component({ selector: "all" })
  .focus({})
  .representation({
    type: "ball_and_stick",
    custom: {
      molstar_representation_params: {
        sizeFactor: 0.28
      }
    }
  })
  ${elementColorJs(carbonColor)};`;
}

function writeScene(storyDir, folder, options) {
  const sceneDir = path.join(storyDir, 'scenes', folder);
  ensureDir(sceneDir);
  const base = path.basename(folder);
  const cameraText = yamlCamera(options.camera);
  const yaml = [
    `header: ${yamlString(options.header)}`,
    `key: ${yamlString(options.key || folder)}`,
    'linger_duration_ms: 8000',
    'transition_duration_ms: 1000',
    cameraText,
  ].filter(Boolean).join('\n') + '\n';
  fs.writeFileSync(path.join(sceneDir, `${base}.yaml`), yaml, 'utf8');
  fs.writeFileSync(path.join(sceneDir, `${base}.md`), `${options.markdown.trim()}\n`, 'utf8');
  fs.writeFileSync(path.join(sceneDir, `${base}.js`), `${options.javascript.trim()}\n`, 'utf8');
}

function ligandRowsById(summaryRows) {
  const map = new Map();
  for (const row of summaryRows) {
    const raw = row.input_ligand || row.ligand || row.case || '';
    const fileStem = path.basename(String(raw), path.extname(String(raw)));
    const ids = new Set([
      safeId(fileStem, 'lig'),
      safeId(String(raw).replace(/_gnina$/i, ''), 'lig'),
      safeId(String(row.case || ''), 'lig'),
      fileStem,
      String(raw),
    ].filter(Boolean));
    for (const id of ids) if (!map.has(id)) map.set(id, row);
  }
  return map;
}

function rowForPose(entry, rowsById) {
  const candidates = [
    entry.id,
    entry.label,
    entry.label.replace(/\s+/g, '_'),
    entry.assetName.replace(/_gnina_top\d*\.sdf$/i, '').replace(/_gnina\.sdf$/i, ''),
    entry.sourceFile ? path.basename(entry.sourceFile, path.extname(entry.sourceFile)).replace(/_gnina$/i, '') : '',
  ];
  for (const candidate of candidates) {
    if (rowsById.has(candidate)) return rowsById.get(candidate);
    const safe = safeId(candidate, 'lig');
    if (rowsById.has(safe)) return rowsById.get(safe);
  }
  return null;
}

function scoreMarkdown(row) {
  if (!row) return 'No score row was found for this pose in `summary_wide.csv`.';
  const scores = makeScoreLines(row);
  const statuses = makeStatusLines(row);
  const table = scores.length
    ? ['| Score field | Value |', '|---|---|', ...scores.map(s => `| \`${s.key}\` | ${markdownEscape(s.value)} |`)].join('\n')
    : 'No numeric score fields were populated.';
  const statusText = statuses.length
    ? ['| Method status | Value |', '|---|---|', ...statuses.map(s => `| \`${s.key}\` | ${markdownEscape(s.value)} |`)].join('\n')
    : 'No method status fields were populated.';
  return `${table}\n\n${statusText}`;
}

function parsePdbAtoms(file) {
  if (!file || !/\.pdb$/i.test(file) || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.startsWith('ATOM') || line.startsWith('HETATM'))
    .map((line, index) => ({
      serial: Number(line.slice(6, 11)),
      recordType: line.slice(0, 6).trim(),
      x: Number(line.slice(30, 38)),
      y: Number(line.slice(38, 46)),
      z: Number(line.slice(46, 54)),
      element: (line.slice(76, 78).trim() || line.slice(12, 16).replace(/[0-9]/g, '').trim()[0] || 'C').toUpperCase(),
      atomName: line.slice(12, 16).trim(),
      resn: line.slice(17, 20).trim(),
      chain: line.slice(21, 22).trim(),
      resi: line.slice(22, 26).trim(),
      index,
    }))
    .filter(atom => Number.isFinite(atom.x + atom.y + atom.z));
}

function parseSdfMolecule(file, recordIndex = 0) {
  if (!file || !/\.sdf$/i.test(file) || !fs.existsSync(file)) return { atoms: [], bonds: [] };
  const records = sdfRecords(file);
  const record = records[recordIndex] || records[0] || '';
  const lines = record.split(/\r?\n/);
  const countsIndex = lines.findIndex(line => /\bV(2000|3000)\b/i.test(line) && /^\s*\d+\s+\d+/.test(line));
  const countsLineIndex = countsIndex >= 0 ? countsIndex : 3;
  const counts = lines[countsLineIndex] || '';
  const atomCount = Number(counts.slice(0, 3));
  const bondCount = Number(counts.slice(3, 6));
  if (!Number.isFinite(atomCount) || atomCount <= 0) return { atoms: [], bonds: [] };
  const chargeByCode = new Map([[1, 3], [2, 2], [3, 1], [5, -1], [6, -2], [7, -3]]);
  const atoms = [];
  for (let index = 0; index < atomCount; index += 1) {
    const line = lines[countsLineIndex + 1 + index] || '';
    const chargeCode = Number(line.slice(36, 39));
    atoms.push({
      x: Number(line.slice(0, 10)),
      y: Number(line.slice(10, 20)),
      z: Number(line.slice(20, 30)),
      element: (line.slice(31, 34).trim() || 'C').toUpperCase(),
      atomIndex: index + 1,
      formalCharge: chargeByCode.get(chargeCode) || 0,
    });
  }
  const bonds = [];
  if (Number.isFinite(bondCount)) {
    for (let index = 0; index < bondCount; index += 1) {
      const line = lines[countsLineIndex + 1 + atomCount + index] || '';
      const a = Number(line.slice(0, 3));
      const b = Number(line.slice(3, 6));
      const order = Number(line.slice(6, 9));
      if (a > 0 && b > 0) bonds.push({ a, b, order: Number.isFinite(order) ? order : 1 });
    }
  }
  for (const line of lines.slice(countsLineIndex + 1 + atomCount + Math.max(0, bondCount || 0))) {
    if (!line.startsWith('M  CHG')) continue;
    const count = Number(line.slice(6, 9));
    for (let index = 0; index < count; index += 1) {
      const atomIndex = Number(line.slice(10 + index * 8, 13 + index * 8));
      const charge = Number(line.slice(14 + index * 8, 17 + index * 8));
      const atom = atoms[atomIndex - 1];
      if (atom && Number.isFinite(charge)) atom.formalCharge = charge;
    }
  }
  return {
    atoms: atoms.filter(atom => Number.isFinite(atom.x + atom.y + atom.z)),
    bonds,
  };
}

function parsePoseAtoms(file, recordIndex = 0) {
  if (/\.sdf$/i.test(file)) return parseSdfMolecule(file, recordIndex).atoms;
  if (/\.pdb$/i.test(file)) return parsePdbAtoms(file).map((atom, index) => ({
    x: atom.x,
    y: atom.y,
    z: atom.z,
    element: atom.element,
    atomIndex: index + 1,
    formalCharge: 0,
  }));
  return [];
}

function atomDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function atomCenter(atoms) {
  if (!atoms.length) return null;
  return atoms.reduce((center, atom) => ({
    x: center.x + atom.x / atoms.length,
    y: center.y + atom.y / atoms.length,
    z: center.z + atom.z / atoms.length,
  }), { x: 0, y: 0, z: 0 });
}

function residueKey(atom) {
  const chain = atom.chain ? `.${atom.chain}` : '';
  return `${atom.resn}${atom.resi}${chain}`;
}

function residueDisplay(contact) {
  const resn = contact.residueName || '';
  const number = Number(contact.residueNumber);
  return `${resn}${Number.isFinite(number) ? number : String(contact.residueNumber || '').trim()}`;
}

function bondedNeighbors(molecule, atom) {
  return molecule.bonds
    .filter(bond => bond.a === atom.atomIndex || bond.b === atom.atomIndex)
    .map(bond => ({
      atom: molecule.atoms[(bond.a === atom.atomIndex ? bond.b : bond.a) - 1],
      order: bond.order,
    }))
    .filter(item => item.atom);
}

function proteinAtomKey(atom) {
  return `${atom.resn}:${atom.atomName}`;
}

function proteinCharge(atom) {
  const key = proteinAtomKey(atom);
  if (PROTEIN_POSITIVE_ATOMS.has(key)) return 1;
  if (PROTEIN_NEGATIVE_ATOMS.has(key)) return -1;
  return 0;
}

function ligandCanAccept(molecule, atom) {
  if (!['N', 'O', 'S'].includes(atom.element) || atom.formalCharge > 0) return false;
  const neighbors = bondedNeighbors(molecule, atom);
  if (atom.element === 'N') {
    const valence = neighbors.reduce((sum, item) => sum + Math.max(1, item.order), 0);
    if (valence >= 4) return false;
    const attachedToCarbonyl = neighbors.some(item =>
      item.atom.element === 'C' &&
      bondedNeighbors(molecule, item.atom).some(other => other.atom.element === 'O' && other.order >= 2)
    );
    if (attachedToCarbonyl) return false;
  }
  return true;
}

function ligandHasExplicitDonorHydrogen(molecule, atom) {
  if (!['N', 'O', 'S'].includes(atom.element) || atom.formalCharge < 0) return false;
  return bondedNeighbors(molecule, atom).some(item => item.atom.element === 'H');
}

function proteinCanDonate(atom) {
  if (atom.atomName === 'N') return true;
  return new Set([
    'ARG:NE', 'ARG:NH1', 'ARG:NH2', 'ASN:ND2', 'GLN:NE2', 'HIS:ND1', 'HIS:NE2',
    'LYS:NZ', 'SER:OG', 'THR:OG1', 'TRP:NE1', 'TYR:OH', 'CYS:SG',
  ]).has(proteinAtomKey(atom));
}

function classifyAtomContact(molecule, ligandAtom, receptorAtom, distance) {
  const ligandCharge = ligandAtom.formalCharge || 0;
  const receptorCharge = proteinCharge(receptorAtom);
  if (
    (METAL_ELEMENTS.has(ligandAtom.element) && ['N', 'O', 'S', 'P'].includes(receptorAtom.element)) ||
    (METAL_ELEMENTS.has(receptorAtom.element) && ['N', 'O', 'S', 'P'].includes(ligandAtom.element))
  ) {
    if (distance <= 3.0) {
      return {
        type: 'metal_coordination',
        evidence: 'metal-to-N/O/S/P atom distance <= 3.0 Angstrom',
        fallback: false,
      };
    }
  }
  if (ligandCharge && receptorCharge && Math.sign(ligandCharge) !== Math.sign(receptorCharge) && distance <= 4.0) {
    return {
      type: 'ionic',
      evidence: 'opposite explicit/formal ligand and residue-side-chain charges within 4.0 Angstrom',
      fallback: false,
    };
  }
  if (
    distance <= 3.6 &&
    ((ligandCanAccept(molecule, ligandAtom) && proteinCanDonate(receptorAtom)) ||
      (ligandHasExplicitDonorHydrogen(molecule, ligandAtom) && PROTEIN_ACCEPTOR_ATOMS.has(proteinAtomKey(receptorAtom))))
  ) {
    return {
      type: 'hydrogen_bond',
      evidence: ligandHasExplicitDonorHydrogen(molecule, ligandAtom)
        ? 'explicit ligand donor hydrogen plus compatible receptor acceptor; heavy-atom distance <= 3.6 Angstrom'
        : 'compatible receptor donor and ligand acceptor; heavy-atom distance <= 3.6 Angstrom',
      fallback: false,
    };
  }
  if (
    distance <= 4.0 &&
    (ligandAtom.element === 'C' || HALOGEN_ELEMENTS.has(ligandAtom.element)) &&
    receptorAtom.element === 'C' &&
    HYDROPHOBIC_RESIDUES.has(receptorAtom.resn) &&
    !['N', 'CA', 'C', 'O', 'OXT'].includes(receptorAtom.atomName)
  ) {
    return {
      type: 'hydrophobic',
      evidence: 'ligand carbon/halogen to hydrophobic residue side-chain carbon within 4.0 Angstrom',
      fallback: false,
    };
  }
  return {
    type: 'generic_contact',
    evidence: 'nearest atom-atom distance within 4.2 Angstrom; chemistry was insufficient for a safer type',
    fallback: true,
  };
}

function finalAtomContact(molecule, ligandAtom, receptorAtom, distance) {
  const classification = classifyAtomContact(molecule, ligandAtom, receptorAtom, distance);
  return {
    residue: residueKey(receptorAtom),
    residueName: receptorAtom.resn,
    residueNumber: receptorAtom.resi,
    chain: receptorAtom.chain,
    receptorAtom: receptorAtom.atomName,
    ligandAtom: `${ligandAtom.element}${ligandAtom.atomIndex}`,
    distance: Number(distance.toFixed(2)),
    interactionType: classification.type,
    evidence: classification.evidence,
    source: 'computed_from_input_coordinates',
    fallback: classification.fallback,
    start: [ligandAtom.x, ligandAtom.y, ligandAtom.z],
    end: [receptorAtom.x, receptorAtom.y, receptorAtom.z],
  };
}

function vectorSubtract(a, b) {
  return [a.x - b.x, a.y - b.y, a.z - b.z];
}

function vectorCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vectorNorm(vector) {
  const length = Math.hypot(...vector);
  return length ? vector.map(value => value / length) : null;
}

function ringGeometry(atoms) {
  if (atoms.length < 3) return null;
  const center = atomCenter(atoms);
  const normal = vectorNorm(vectorCross(
    vectorSubtract(atoms[1], atoms[0]),
    vectorSubtract(atoms[2], atoms[0]),
  ));
  return center && normal ? { center, normal } : null;
}

function canonicalCycle(indices) {
  const rotations = [];
  for (const direction of [indices, [...indices].reverse()]) {
    for (let offset = 0; offset < direction.length; offset += 1) {
      rotations.push([...direction.slice(offset), ...direction.slice(0, offset)].join('-'));
    }
  }
  return rotations.sort()[0];
}

function ligandAromaticRings(molecule) {
  const adjacency = new Map();
  for (const atom of molecule.atoms) adjacency.set(atom.atomIndex, []);
  for (const bond of molecule.bonds) {
    adjacency.get(bond.a)?.push({ index: bond.b, order: bond.order });
    adjacency.get(bond.b)?.push({ index: bond.a, order: bond.order });
  }
  const cycles = new Map();
  function walk(start, current, pathIndices, pathOrders) {
    if (pathIndices.length > 6) return;
    for (const edge of adjacency.get(current) || []) {
      if (edge.index === start && pathIndices.length >= 5) {
        const key = canonicalCycle(pathIndices);
        const orders = [...pathOrders, edge.order];
        const atoms = pathIndices.map(index => molecule.atoms[index - 1]).filter(Boolean);
        const allowedElements = atoms.every(atom => ['C', 'N', 'O', 'S'].includes(atom.element));
        const aromaticLike = orders.filter(order => order === 4).length >= 3 ||
          orders.filter(order => order >= 2).length >= 2;
        if (allowedElements && aromaticLike && !cycles.has(key)) cycles.set(key, atoms);
        continue;
      }
      if (pathIndices.includes(edge.index)) continue;
      walk(start, edge.index, [...pathIndices, edge.index], [...pathOrders, edge.order]);
    }
  }
  for (const atom of molecule.atoms) walk(atom.atomIndex, atom.atomIndex, [atom.atomIndex], []);
  return [...cycles.values()].map(atoms => ({ atoms, geometry: ringGeometry(atoms) })).filter(ring => ring.geometry);
}

function proteinAromaticRings(receptorAtoms) {
  const residues = new Map();
  for (const atom of receptorAtoms) {
    if (!PROTEIN_AROMATIC_RINGS[atom.resn]) continue;
    const key = residueKey(atom);
    if (!residues.has(key)) residues.set(key, []);
    residues.get(key).push(atom);
  }
  const rings = [];
  for (const [residue, atoms] of residues) {
    for (const atomNames of PROTEIN_AROMATIC_RINGS[atoms[0].resn]) {
      const ringAtoms = atomNames.map(name => atoms.find(atom => atom.atomName === name)).filter(Boolean);
      const geometry = ringAtoms.length === atomNames.length ? ringGeometry(ringAtoms) : null;
      if (geometry) rings.push({ residue, atoms: ringAtoms, geometry });
    }
  }
  return rings;
}

function piStackingContacts(molecule, receptorAtoms) {
  const ligandRings = ligandAromaticRings(molecule);
  const receptorRings = proteinAromaticRings(receptorAtoms);
  const contacts = [];
  for (const ligandRing of ligandRings) {
    for (const receptorRing of receptorRings) {
      const distance = atomDistance(ligandRing.geometry.center, receptorRing.geometry.center);
      if (distance > 5.5) continue;
      const dot = Math.min(1, Math.abs(
        ligandRing.geometry.normal[0] * receptorRing.geometry.normal[0] +
        ligandRing.geometry.normal[1] * receptorRing.geometry.normal[1] +
        ligandRing.geometry.normal[2] * receptorRing.geometry.normal[2]
      ));
      const angle = Math.acos(dot) * 180 / Math.PI;
      if (!(angle <= 30 || angle >= 60)) continue;
      const receptorAtom = receptorRing.atoms[0];
      contacts.push({
        residue: receptorRing.residue,
        residueName: receptorAtom.resn,
        residueNumber: receptorAtom.resi,
        chain: receptorAtom.chain,
        receptorAtom: 'aromatic_ring_centroid',
        ligandAtom: 'aromatic_ring_centroid',
        distance: Number(distance.toFixed(2)),
        interactionType: 'pi_stacking',
        evidence: `aromatic ring centroid distance <= 5.5 Angstrom and ring-normal angle ${angle.toFixed(1)} degrees`,
        source: 'computed_from_input_coordinates_and_sdf_bond_orders',
        fallback: false,
        start: [ligandRing.geometry.center.x, ligandRing.geometry.center.y, ligandRing.geometry.center.z],
        end: [receptorRing.geometry.center.x, receptorRing.geometry.center.y, receptorRing.geometry.center.z],
      });
    }
  }
  return contacts;
}

function contactMapForPose(receptorAtoms, poseEntry) {
  const molecule = /\.sdf$/i.test(poseEntry.sourceFile)
    ? parseSdfMolecule(poseEntry.sourceFile, poseEntry.poseRecordIndex || 0)
    : { atoms: parsePoseAtoms(poseEntry.sourceFile, poseEntry.poseRecordIndex || 0), bonds: [] };
  const poseAtoms = molecule.atoms;
  if (!receptorAtoms.length || !poseAtoms.length) {
    return { contacts: [], ligandCenter: atomCenter(poseAtoms), supported: false };
  }
  const candidates = piStackingContacts(molecule, receptorAtoms);
  for (const ligandAtom of poseAtoms) {
    for (const receptorAtom of receptorAtoms) {
      if (receptorAtom.resn === 'HOH' || receptorAtom.resn === 'UNL') continue;
      const distance = atomDistance(ligandAtom, receptorAtom);
      if (distance <= 4.2) {
        candidates.push(finalAtomContact(molecule, ligandAtom, receptorAtom, distance));
      }
    }
  }
  candidates.sort((a, b) => {
    return (INTERACTION_PRIORITY.get(a.interactionType) ?? 99) - (INTERACTION_PRIORITY.get(b.interactionType) ?? 99) ||
      a.distance - b.distance;
  });
  const seenResidues = new Set();
  const contacts = [];
  for (const item of candidates) {
    if (seenResidues.has(item.residue)) continue;
    seenResidues.add(item.residue);
    contacts.push(item);
    if (contacts.length >= 6) break;
  }
  return {
    contacts,
    ligandCenter: atomCenter(poseAtoms),
    supported: true,
    typingPolicy: 'conservative_geometry_and_explicit_chemistry',
  };
}

function vectorJs(values) {
  return `[${values.map(value => Number(value).toFixed(3)).join(', ')}]`;
}

function contactSelectorJs(contact) {
  const fields = [];
  if (contact.chain) fields.push(`auth_asym_id: ${jsString(contact.chain)}`);
  const residueNumber = Number(contact.residueNumber);
  if (Number.isFinite(residueNumber)) fields.push(`auth_seq_id: ${residueNumber}`);
  return `{ ${fields.join(', ')} }`;
}

function contactMarkdown(contactMap) {
  if (!contactMap.supported) return 'Contact map was not computed because the receptor/pose format was not supported for coordinate parsing.';
  if (!contactMap.contacts.length) return 'No contacts within 4.2 Angstrom were found for this pose.';
  const presentTypes = [...new Set(contactMap.contacts.map(contact => contact.interactionType))]
    .sort((a, b) => (INTERACTION_PRIORITY.get(a) ?? 99) - (INTERACTION_PRIORITY.get(b) ?? 99));
  const legendRows = presentTypes.map(type => {
    const label = INTERACTION_LABELS[type] || type;
    const colorName = INTERACTION_COLOR_NAMES[type] || 'custom';
    const color = INTERACTION_COLORS[type] || INTERACTION_COLORS.generic_contact;
    return `- **${label}**: ${colorName} dashed line (${color})`;
  });
  return [
    '## Computed contacts',
    '',
    '### Distance and interaction color legend',
    '',
    ...legendRows,
    '- Residue side chains use blue element-aware styling; residue labels use amber text for contrast.',
    '- If a contact cannot be typed conservatively, it remains `generic_contact`.',
    '',
    '### Contacts in this scene',
    '',
    ...contactMap.contacts.map(contact => {
      const fallback = contact.fallback ? ' (generic fallback)' : '';
      const label = INTERACTION_LABELS[contact.interactionType] || contact.interactionType;
      return `- **${residueDisplay(contact)}**: \`${contact.interactionType}\` (${label})${fallback}, ${contact.receptorAtom} to ${contact.ligandAtom} = ${contact.distance} ${ANGSTROM}`;
    }),
    '',
    'Dashed measurements are computed directly from the input coordinates. Typed interactions use conservative atom/residue rules; uncertain contacts remain generic.',
  ].join('\n');
}

function contactJs(contactMap) {
  if (!contactMap.contacts.length) return '';
  const selectors = contactMap.contacts.map(contact => `    ${contactSelectorJs(contact)}`).join(',\n');
  const residueJs = `receptor
  .component({ selector: [
${selectors}
  ] })
  .representation({
    type: "ball_and_stick",
    custom: {
      molstar_representation_params: {
        sizeFactor: 0.28
      }
    }
  })
  ${elementColorJs('#2563EB')};`;
  const distances = contactMap.contacts.map(contact => {
    const color = INTERACTION_COLORS[contact.interactionType] || INTERACTION_COLORS.generic_contact;
    return `builder.primitives({
    opacity: 0.92,
    label_attachment: "middle-center",
    label_show_tether: false
  })
  .distance({
    start: ${vectorJs(contact.start)},
    end: ${vectorJs(contact.end)},
    radius: 0.035,
    dash_length: 0.12,
    color: ${jsString(color)},
    label_template: ${jsString(`${contact.distance.toFixed(1)} ${ANGSTROM}`)},
    label_size: 0.78,
    label_color: ${jsString(color)}
  });`;
  }).join('\n\n');
  const labels = contactMap.contacts.map(contact => {
    return `receptor.primitives()
  .label({
    position: ${contactSelectorJs(contact)},
    text: ${jsString(residueDisplay(contact))},
    label_color: "#FACC15",
    label_size: 0.92
  });`;
  }).join('\n\n');
  return [residueJs, distances, labels].filter(Boolean).join('\n\n');
}

function poseBrowserMarkdown(poseItems, currentIndex = null) {
  if (poseItems.length <= 1) return '';
  const groups = new Map();
  for (const item of poseItems) {
    const label = item.entry.parentLabel || item.label.replace(/\s+pose\s+\d+$/i, '') || item.label;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const rows = [];
  for (const [groupLabel, items] of groups) {
    const links = items.map(item => {
      const itemIndex = poseItems.indexOf(item);
      const poseNumber = Number.isFinite(item.entry.poseRecordIndex) ? item.entry.poseRecordIndex + 1 : itemIndex + 1;
      const text = `pose ${poseNumber}`;
      const link = `[${text}](#${safeId(item.entry.label, 'ligand')})`;
      if (itemIndex === currentIndex) return `**${link}**`;
      return link;
    }).join(' | ');
    rows.push(`- **${markdownEscape(groupLabel)}**: ${links}`);
  }
  return [
    '## Pose browser',
    '',
    'Switch docking poses here or with the story next/previous controls. Each pose scene recomputes pocket residues, distances, and interaction types from that pose record.',
    '',
    ...rows,
    '',
  ].join('\n');
}

function poseNavigationMarkdown(poseItems, index) {
  if (poseItems.length <= 1) return '';
  const current = poseItems[index];
  const previous = index > 0 ? poseItems[index - 1] : null;
  const next = index < poseItems.length - 1 ? poseItems[index + 1] : null;
  const links = [];
  if (previous) links.push(`[Previous pose: ${markdownEscape(previous.label)}](#${safeId(previous.entry.label, 'ligand')})`);
  if (next) links.push(`[Next pose: ${markdownEscape(next.label)}](#${safeId(next.entry.label, 'ligand')})`);
  return [
    '## Pose navigation',
    '',
    `Pose ${index + 1} of ${poseItems.length}: **${markdownEscape(current.label)}**.`,
    'Use the story controls to step through poses, or use the direct pose links below.',
    '',
    links.join(' | '),
    '',
  ].filter(Boolean).join('\n');
}

function rankingMarkdown(ranked) {
  if (!ranked.length) return 'No ligand ranking could be computed from `summary_wide.csv`.';
  return [
    '| Rank | Ligand | Primary score | Status notes |',
    '|---:|---|---:|---|',
    ...ranked.map((item, idx) => {
      const score = bestSortValue(item.row);
      const status = makeStatusLines(item.row).map(s => `${s.key}=${s.value}`).join('; ') || 'n/a';
      return `| ${idx + 1} | ${markdownEscape(item.label)} | ${Number.isFinite(score) ? score : 'n/a'} | ${markdownEscape(status)} |`;
    }),
  ].join('\n');
}

function isReferenceLikePose(item) {
  const key = `${item?.entry?.id || ''} ${item?.entry?.label || ''}`.toLowerCase();
  return key.includes('reflig') || key.includes('ref_lig') || key.includes('reference_ligand');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const resultsDir = normalizePath(must(args.resultsDir || args.results_dir || args._[0], 'results-dir is required'));
  if (!fs.existsSync(resultsDir) || !fs.statSync(resultsDir).isDirectory()) {
    throw new Error(`results-dir does not exist or is not a directory: ${resultsDir}`);
  }

  const { file: molstarManifestFile, manifest: molstarManifest } = readMolstarManifest(resultsDir);
  const summary = readSummary(resultsDir);
  const caseName = inferCaseName(resultsDir, molstarManifest, args.case);
  const outDir = normalizePath(args.outDir || args.out_dir || path.join(resultsDir, 'molview_stories', 'docking_story'));
  const storyDir = outDir;
  const assetsDir = path.join(storyDir, 'assets');
  ensureDir(assetsDir);
  ensureDir(path.join(storyDir, 'scenes'));

  const entries = collectEntries(args, resultsDir, molstarManifest);
  const receptor = entries.find(e => e.role === 'receptor');
  const references = entries.filter(e => e.role === 'reference');
  const poses = entries.filter(e => e.role === 'pose');
  if (!receptor) throw new Error('No receptor found. Provide --receptor or generate results/molstar/manifest.json first.');
  const receptorAtoms = parsePdbAtoms(receptor.sourceFile);

  for (const entry of [receptor, ...references]) {
    entry.assetBytes = copyFile(entry.sourceFile, path.join(assetsDir, entry.assetName));
  }

  const rowsById = ligandRowsById(summary.rows);
  const poseItems = poses.map(entry => ({ entry, row: rowForPose(entry, rowsById), label: entry.label }));
  const ranked = poseItems
    .filter(item => item.row)
    .sort((a, b) => bestSortValue(a.row) - bestSortValue(b.row));
  const topLimit = Math.max(1, Number.parseInt(args.topLigands || args.top_ligands || '5', 10) || 5);
  let selectedPoseItems = [
    ...ranked.slice(0, topLimit),
    ...poseItems.filter(item => !item.row).slice(0, Math.max(0, topLimit - ranked.length)),
  ];
  selectedPoseItems = [
    ...selectedPoseItems.filter(isReferenceLikePose),
    ...selectedPoseItems.filter(item => !isReferenceLikePose(item)),
  ];
  selectedPoseItems = expandSelectedPoseItems(selectedPoseItems, args);
  for (const item of selectedPoseItems) {
    const target = path.join(assetsDir, item.entry.assetName);
    item.entry.assetBytes = item.entry.assetContent !== undefined
      ? writeAssetContent(item.entry.assetContent, target)
      : copyFile(item.entry.sourceFile, target);
  }
  for (const item of selectedPoseItems) {
    item.contactMap = contactMapForPose(receptorAtoms, item.entry);
  }
  const center = parseCenter(args.center);
  const camera = cameraFor(center);
  const activeSiteNote =
    args.activeSiteNote ||
    args.active_site_note ||
    molstarManifest?.active_site_note ||
    'Active-site note was not provided.';

  const sceneFolders = [];
  const topPoseItem = selectedPoseItems[0] || null;
  const topPoseCamera = topPoseItem?.contactMap?.ligandCenter
    ? {
        target: [
          topPoseItem.contactMap.ligandCenter.x,
          topPoseItem.contactMap.ligandCenter.y,
          topPoseItem.contactMap.ligandCenter.z,
        ],
        position: [
          topPoseItem.contactMap.ligandCenter.x + 18,
          topPoseItem.contactMap.ligandCenter.y - 21,
          topPoseItem.contactMap.ligandCenter.z + 25,
        ],
        up: [0, 1, 0],
        fov: 45,
        mode: 'perspective',
      }
    : camera;
  const overviewFolder = '00_overview';
  sceneFolders.push(overviewFolder);
  writeScene(storyDir, overviewFolder, {
    header: `Docking overview: ${caseName}`,
    key: 'overview',
    camera: topPoseCamera,
    markdown: `# Docking overview: ${caseName}

This scene compares the brightly rendered reference ligand with the top-ranked docked pose in its receptor and pocket context.

${poseBrowserMarkdown(selectedPoseItems)}

**Active-site context:** ${activeSiteNote}

**What is highlighted automatically**

- receptor polymer as cartoon
- approved reference or box ligand, when present, as bright opaque orange-carbon sticks
- top-ranked docked pose as bright red-carbon sticks
- nearby pocket residues and coordinate-derived dashed distance measurements
- score/status fields from \`summary_wide.csv\`

${topPoseItem ? `## Top pose: ${topPoseItem.label}

${topPoseItem.row && Number.isFinite(bestSortValue(topPoseItem.row)) ? `**Primary ranking score:** ${bestSortValue(topPoseItem.row)}` : '**Primary ranking score:** not available'}

${contactMarkdown(topPoseItem.contactMap)}
` : 'No docked pose was available for the overview.'}

${rankingMarkdown(ranked.slice(0, topLimit).map(item => ({ label: item.label, row: item.row })))}

${selectedPoseItems.length ? `## Pose review start

Start pose review: [${markdownEscape(selectedPoseItems[0].label)}](#${safeId(selectedPoseItems[0].entry.label, 'ligand')}). The story contains ${selectedPoseItems.length} pose scenes; each pose scene recomputes contacts and distances from its own coordinates.` : ''}
`,
    javascript: [
      receptorJs(receptor),
      ...references.map((entry, index) => referenceJs(entry, index + 1, 1.0)),
      topPoseItem ? poseJs(topPoseItem.entry, 'topPose', '#D62728') : '',
      topPoseItem ? contactJs(topPoseItem.contactMap) : '',
    ].join('\n\n'),
  });

  selectedPoseItems.forEach((item, index) => {
    const folder = `${String(sceneFolders.length).padStart(2, '0')}_${safeId(item.entry.label, 'lig')}`;
    sceneFolders.push(folder);
    const primaryScore = item.row ? bestSortValue(item.row) : null;
    const contactMap = item.contactMap;
    const isReferencePoseScene = isReferenceLikePose(item);
    const referenceOpacity = isReferencePoseScene ? 1.0 : 0.18;
    const sceneReferences = isReferencePoseScene ? [] : references;
    const poseCarbonColor = isReferencePoseScene ? '#F28E2B' : '#E15759';
    const contactCamera = contactMap.ligandCenter
      ? {
          target: [contactMap.ligandCenter.x, contactMap.ligandCenter.y, contactMap.ligandCenter.z],
          position: [contactMap.ligandCenter.x + 15, contactMap.ligandCenter.y - 18, contactMap.ligandCenter.z + 22],
          up: [0, 1, 0],
          fov: 45,
          mode: 'perspective',
        }
      : camera;
    writeScene(storyDir, folder, {
      header: `${item.entry.label}: docking pose`,
      key: safeId(item.entry.label, 'ligand'),
      camera: contactCamera,
      markdown: `# ${item.entry.label}: pose and contact map

This scene highlights the ligand, the box-reference ligand, nearby pocket residues, and computed atom-atom contact distances from the docked pose.

${poseBrowserMarkdown(selectedPoseItems, index)}

${primaryScore !== null && Number.isFinite(primaryScore) ? `**Primary ranking score:** ${primaryScore}` : '**Primary ranking score:** not available'}

${scoreMarkdown(item.row)}

${contactMarkdown(contactMap)}

${poseNavigationMarkdown(selectedPoseItems, index)}

**Interpretation note:** Lower docking affinity values are generally better for GNINA/SMINA affinity fields. CNN and Boltz/Matcha fields have method-specific meanings; keep failed, skipped, or missing method statuses explicit.
`,
    javascript: [
      receptorJs(receptor),
        ...sceneReferences.map((entry, refIndex) => referenceJs(entry, refIndex + 1, referenceOpacity)),
        poseJs(item.entry, 'pose', poseCarbonColor),
        contactJs(contactMap),
      ].join('\n\n'),
    });
  });

  const storyYaml = [
    `title: ${yamlString(`Docking story: ${caseName}`)}`,
    `author_note: ${yamlString('Generated by LP-Flow plugin from docking outputs. Review scores and method statuses before scientific interpretation.')}`,
    '',
    'settings:',
    '  autoPlay: false',
    '  loopStory: false',
    '  showControls: true',
    '',
    'scenes:',
    ...sceneFolders.map(folder => `  - folder: ${yamlString(folder)}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storyDir, 'story.yaml'), storyYaml, 'utf8');
  fs.writeFileSync(path.join(storyDir, 'story.js'), '// Global JavaScript is intentionally empty; each scene is self-contained.\n', 'utf8');

  const readme = `# Docking Story: ${caseName}

This folder is a Mol View Stories source story generated from LP-Flow docking outputs.

## Files

- \`story.yaml\`: story metadata and scene order
- \`scenes/\`: one overview scene plus top ligand pose scenes; a pose named like \`reflig\` is placed immediately after overview when present
- \`assets/\`: copied receptor/reference/pose files used by scenes
- \`story_manifest.json\`: deterministic generation metadata, interaction evidence, and visualization decisions

## Contact interpretation

Distances and residue identities are computed from the copied input coordinates. Interaction types use conservative chemistry and geometry rules. Contacts that do not meet a supported rule remain \`generic_contact\`; they are not silently promoted to hydrogen bonds or other specific interactions.

Each scene with contacts includes an interaction color legend in the story text. Distance lines use the interaction color; residue side chains and residue labels use blue styling.

Multi-record SDF pose files are expanded into separate pose scenes. Distances and interaction typing are recomputed from the specific SDF record used by that scene.

Ligands and pocket residues use element-aware coloring: carbon carries the scene emphasis color while heteroatoms retain the Mol* element-symbol palette.

## Optional Export

If the upstream Mol View Stories CLI is available:

\`\`\`bash
mvs build "${storyDir}" --format html -o "${path.join(storyDir, 'docking_story.html')}"
mvs build "${storyDir}" --format mvstory -o "${path.join(storyDir, 'docking_story.mvstory')}"
mvs build "${storyDir}" --format mvsx -o "${path.join(storyDir, 'docking_story.mvsx')}"
\`\`\`

Without the CLI, open this folder in the Mol View Stories web app or use the generated \`story.yaml\` and scene files as the editable story source.
`;
  fs.writeFileSync(path.join(storyDir, 'README.md'), readme, 'utf8');

  const manifest = {
    ok: true,
    kind: 'lp_flow_mol_view_story_source',
    case: caseName,
    created_utc: new Date().toISOString(),
    results_dir: resultsDir,
    out_dir: storyDir,
    molstar_manifest: molstarManifestFile,
    summary_csv: summary.file,
    active_site_note: activeSiteNote,
    receptor: receptor.id,
    reference_count: references.length,
    pose_count: poses.length,
    selected_pose_count: selectedPoseItems.length,
    poses_per_ligand: args.posesPerLigand || args.poses_per_ligand || args.poseLimit || args.pose_limit || 'all',
    entries: [receptor, ...references, ...selectedPoseItems.map(item => item.entry)].map(entry => ({
      id: entry.id,
      role: entry.role,
      label: entry.label,
      parent_id: entry.parentId || null,
      parent_label: entry.parentLabel || null,
      pose_record_index: entry.poseRecordIndex ?? null,
      pose_record_count: entry.poseRecordCount ?? null,
      source_file: entry.sourceFile,
      asset: `assets/${entry.assetName}`,
      format: entry.format,
      bytes: entry.assetBytes,
    })),
    ranking: ranked.map((item, index) => ({
      rank: index + 1,
      ligand: item.label,
      primary_score: bestSortValue(item.row),
      statuses: Object.fromEntries(makeStatusLines(item.row).map(s => [s.key, s.value])),
    })),
    contacts: Object.fromEntries(selectedPoseItems.map(item => [
      item.label,
      {
        computed: Boolean(item.contactMap?.supported),
        contact_count: item.contactMap?.contacts?.length || 0,
        typing_policy: item.contactMap?.typingPolicy || null,
        interactions: (item.contactMap?.contacts || []).map(contact => ({
          ligand_id: item.entry.id,
          parent_ligand_id: item.entry.parentId || item.entry.id,
          pose_record_index: item.entry.poseRecordIndex ?? null,
          pose_record_count: item.entry.poseRecordCount ?? null,
          residue_id: residueDisplay(contact),
          residue_name: contact.residueName,
          residue_number: contact.residueNumber,
          chain: contact.chain || null,
          ligand_atom: contact.ligandAtom,
          residue_atom: contact.receptorAtom,
          distance_angstrom: contact.distance,
          interaction_type: contact.interactionType,
          evidence: contact.evidence,
          source: contact.source,
          computed: true,
          fallback: contact.fallback,
        })),
      },
    ])),
    visualization_decisions: {
      overview_reference: 'opaque_bright_element_aware',
      overview_top_pose: topPoseItem?.entry?.id || null,
      ligand_scene_reference_opacity: 0.18,
      ligand_atom_coloring: 'element-symbol with scene-specific carbon color',
      ligand_size_factor: 0.28,
      reference_ligand_size_factor: 0.28,
      pocket_residue_coloring: 'element-symbol with blue carbon color',
      pocket_residue_size_factor: 0.28,
      distance_rendering: `MolViewSpec dashed distance primitives with explicit viewer-facing labels formatted as 0.0 ${ANGSTROM}; labels use middle-center attachment and are not intentionally rotated along the measurement line`,
      interaction_policy: 'Only supported coordinate/chemistry rules receive a specific type; all uncertain contacts are generic_contact.',
      multi_pose_policy: 'multi-record SDF files are split into one scene/asset per record; contacts are recomputed for each record',
      pose_navigation: 'pose records are emitted as separate ordered story scenes with direct previous/next markdown scene links when multiple poses are present',
      interaction_color_legend: Object.fromEntries(Object.entries(INTERACTION_COLORS).map(([key, color]) => [
        key,
        {
          label: INTERACTION_LABELS[key] || key,
          color,
          color_name: INTERACTION_COLOR_NAMES[key] || 'custom',
        },
      ])),
      reference_like_pose_scene_order: 'pose entries named like reflig are placed after overview, before other docked ligand pose scenes',
    },
    outputs: {
      story_yaml: path.join(storyDir, 'story.yaml'),
      scenes_dir: path.join(storyDir, 'scenes'),
      assets_dir: path.join(storyDir, 'assets'),
      readme: path.join(storyDir, 'README.md'),
    },
  };
  fs.writeFileSync(path.join(storyDir, 'story_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify(manifest, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
