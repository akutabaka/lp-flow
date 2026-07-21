#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { metrics: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    let value = true;
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    if (key === 'metric') args.metrics.push(String(value));
    else args[key] = value;
  }
  return args;
}

function usage() {
  return `Usage:
  node write_burrete_trajectory_manifest.mjs --out <trajectory_manifest.json> --display <md_nowater_multimodel.pdb> [options]

Options:
  --topology <file>               Native topology/provenance, e.g. .tpr
  --trajectory <file>             Native trajectory/provenance, e.g. .xtc
  --structure <file>              Native stage structure/provenance, e.g. .gro/.pdb
  --preview-metadata <file>       Compact display metadata, e.g. preview_nowater.json
  --visualization-status <status> opened|reopenable_package|unavailable|blocked
  --codex-browser-status <status> opened|not_verified|unavailable
  --codex-observe-ready <bool>
  --reopen-command <command>      Command or tool target for reopening the display package
  --blocker-error <text>          Visualization or MD blocker text
  --stage-status <text>           Compact MD stage status
  --metric <label=path>           Repeat for analysis files, e.g. rmsd=analysis/rmsd.xvg
  --original-ligand <id>          Ligand name in docking/input context, e.g. lig2
  --simulation-resname <resname>  Ligand residue name in MD topology, e.g. UNL
  --receptor-selector <selector>  Viewer selector for receptor/protein
  --ligand-selector <selector>    Viewer selector for ligand
  --source-run <path>             Existing or new run directory
  --existing-run-reused <bool>
  --new-run-started <bool>
  --new-run-completed <bool>
`;
}

function asBool(value) {
  if (value === true) return true;
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true) throw new Error(`Missing --${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`);
  return path.resolve(String(value));
}

function optionalFile(value) {
  if (!value || value === true) return null;
  return path.resolve(String(value));
}

function metricEntry(raw) {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new Error(`Metric must be label=path: ${raw}`);
  return {
    label: raw.slice(0, eq),
    path: path.resolve(raw.slice(eq + 1)),
  };
}

function fileRole(role, file) {
  return file ? { role, path: file, exists: fs.existsSync(file) } : null;
}

function requireExistingFile(file, label) {
  if (!file) return;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} does not exist: ${file}`);
  }
  if (!stat.isFile() || stat.size === 0) throw new Error(`${label} is not a non-empty file: ${file}`);
}

function validateDisplayPdb(display) {
  requireExistingFile(display, 'display');
  if (path.extname(display).toLowerCase() !== '.pdb') throw new Error('display must be a PDB file');
  const lines = fs.readFileSync(display, 'utf8').split(/\r?\n/);
  const solvent = new Set(['HOH', 'WAT', 'SOL', 'TIP3', 'TIP3P', 'SPC', 'SPCE']);
  const frameCounts = [];
  let inModel = false;
  let atomCount = 0;
  const solventResidues = new Set();
  for (const line of lines) {
    if (line.startsWith('MODEL')) {
      if (inModel) throw new Error('display contains nested MODEL records');
      inModel = true;
      atomCount = 0;
      continue;
    }
    if (line.startsWith('ENDMDL')) {
      if (!inModel || atomCount === 0) throw new Error('display contains an empty or unmatched model');
      frameCounts.push(atomCount);
      inModel = false;
      continue;
    }
    if (line.startsWith('ATOM  ') || line.startsWith('HETATM')) {
      if (!inModel) throw new Error('display atoms must be enclosed in MODEL/ENDMDL records');
      atomCount += 1;
      const resname = line.slice(17, 20).trim().toUpperCase();
      if (solvent.has(resname)) solventResidues.add(resname);
    }
  }
  if (inModel) throw new Error('display has an unterminated MODEL record');
  if (frameCounts.length < 2) throw new Error('display must contain at least two trajectory-derived models');
  if (new Set(frameCounts).size !== 1) throw new Error('display models have inconsistent atom counts');
  if (solventResidues.size) throw new Error(`display contains bulk-water residue names: ${[...solventResidues].join(', ')}`);
  return { models: frameCounts.length, atoms_per_model: frameCounts[0], solvent_residues: [] };
}

function relOrAbs(file, baseDir) {
  if (!file) return null;
  const relative = path.relative(baseDir, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : file;
}

function normalizeStatus(value, fallback, allowed, label) {
  const status = value || fallback;
  if (!allowed.includes(status)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`);
  }
  return status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  const out = requireArg(args, 'out');
  const display = requireArg(args, 'display');
  const topology = optionalFile(args.topology);
  const trajectory = optionalFile(args.trajectory);
  const structure = optionalFile(args.structure);
  const previewMetadata = optionalFile(args.previewMetadata);
  const sourceRun = optionalFile(args.sourceRun);
  const metrics = args.metrics.map(metricEntry);
  const baseDir = path.dirname(out);
  const visualizationStatus = normalizeStatus(
    args.visualizationStatus,
    'reopenable_package',
    ['opened', 'reopenable_package', 'unavailable', 'blocked'],
    'visualization-status',
  );
  const codexBrowserStatus = normalizeStatus(
    args.codexBrowserStatus,
    visualizationStatus === 'opened' ? 'opened' : 'not_verified',
    ['opened', 'not_verified', 'unavailable'],
    'codex-browser-status',
  );
  const displayQc = validateDisplayPdb(display);
  for (const [file, label] of [
    [topology, 'topology'],
    [trajectory, 'trajectory'],
    [structure, 'structure'],
    [previewMetadata, 'preview-metadata'],
  ]) requireExistingFile(file, label);
  for (const metric of metrics) requireExistingFile(metric.path, `metric ${metric.label}`);

  const manifest = {
    intended_viewer: 'Burrete',
    display: relOrAbs(display, baseDir),
    display_role: 'burrete_display_multimodel_pdb',
    display_water: 'no_bulk_water',
    visualization_status: visualizationStatus,
    codex_browser_status: codexBrowserStatus,
    codex_observe_ready: asBool(args.codexObserveReady),
    display_qc: displayQc,
  };

  if (previewMetadata) manifest.preview_metadata = relOrAbs(previewMetadata, baseDir);
  if (topology) {
    manifest.native_topology = relOrAbs(topology, baseDir);
    manifest.native_topology_role = 'provenance';
  }
  if (trajectory) manifest.native_trajectory = relOrAbs(trajectory, baseDir);
  if (structure) manifest.native_structure = relOrAbs(structure, baseDir);
  if (args.reopenCommand) manifest.reopen_command = String(args.reopenCommand);
  if (args.blockerError) manifest.blocker_error = String(args.blockerError);
  if (args.stageStatus) manifest.stage_status = String(args.stageStatus);
  if (sourceRun) manifest.manifest_source = relOrAbs(sourceRun, baseDir);
  if (metrics.length) manifest.energy = metrics.map(item => `${item.label}=${relOrAbs(item.path, baseDir)}`).join(';');
  if (args.burreteUrl) manifest.burrete_url = String(args.burreteUrl);
  if (args.urlScope) manifest.url_scope = String(args.urlScope);

  if (visualizationStatus === 'reopenable_package' && !manifest.reopen_command) {
    manifest.reopen_command = `burrete:trajectory-review ${manifest.display}`;
  }

  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await fs.promises.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, manifest: out }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
