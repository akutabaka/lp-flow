#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_VERSION = await fs.readFile(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8')
  .then(raw => JSON.parse(raw).version)
  .catch(() => '0.1.0');
const DOCKING_SKILL = path.join(PLUGIN_ROOT, 'skills', 'gnina-smina-docking');
const SERVER_DOCKING_SCRIPTS = path.join(PLUGIN_ROOT, 'scripts', 'server-docking-pipeline');
const GROMACS_MD_SKILL = path.join(PLUGIN_ROOT, 'skills', 'gromacs-md');
const RECEPTOR_EXTS = new Set(['.pdb', '.cif']);
const LIGAND_EXTS = new Set(['.sdf', '.mol2', '.pdb', '.smi', '.smiles']);
const GENERATED_DIR_NAMES = new Set([
  'results',
  'prepared',
  'gnina',
  'gnina_top3',
  'smina',
  'boltz',
  'matcha',
  'molstar',
  'pymol',
  'logs',
]);
const DEFAULT_METHODS = ['gnina', 'smina', 'boltz'];
const VALID_METHODS = new Set(['gnina', 'smina', 'boltz', 'matcha']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function explicitTrue(value) {
  return value === true || value === 'true' || value === '1';
}

function splitList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!value) return [];
  return String(value).split(path.delimiter).map(item => item.trim()).filter(Boolean);
}

function getEnv(name) {
  return typeof process !== 'undefined' && process.env ? process.env[name] : '';
}

function currentPlatform() {
  return typeof process !== 'undefined' && process.platform ? process.platform : os.platform();
}

function stem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function ext(filePath) {
  return path.extname(filePath).toLowerCase();
}

function toPosixRelative(filePath) {
  return filePath.split(path.sep).join('/');
}

function sanitizeId(value, prefix, viewer = false) {
  const raw = normalizeString(value);
  const pattern = viewer ? /[^A-Za-z0-9_]+/g : /[^A-Za-z0-9_.-]+/g;
  let safe = raw.replace(pattern, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!safe || safe[0] === '.' || safe[0] === '-') safe = `${prefix}_${safe}`.replace(/_+$/g, '');
  return safe;
}

function sanitizeRunToken(value, fallback = 'run') {
  const safe = sanitizeId(String(value || fallback), fallback, false);
  return safe.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function uniqueId(base, used) {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function isAuxiliary(filePath) {
  const name = path.basename(filePath).toLowerCase();
  return name.endsWith('-sf.cif') || ext(filePath) === '.mtz';
}

function hasGeneratedPart(parts) {
  return parts.some(part => GENERATED_DIR_NAMES.has(part.toLowerCase()));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function walkFiles(root) {
  const files = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function defaultSearchRoots() {
  const explicit = splitList(getEnv('LP_FLOW_DOCKING_ROOTS') || getEnv('LP_FLOW_DOCKING_ROOT'));
  if (explicit.length) return explicit;
  return [path.resolve(typeof process !== 'undefined' && process.cwd ? process.cwd() : '.')];
}

async function validateCaseFolder(input) {
  const folder = normalizeString(input.folder || input.task_dir || input.taskDir);
  if (!folder) throw new Error('folder is required');
  const taskDir = path.resolve(folder);
  const taskStat = await statOrNull(taskDir);
  if (!taskStat || !taskStat.isDirectory()) {
    throw new Error(`Task folder does not exist or is not a directory: ${taskDir}`);
  }

  const receptorCandidates = [];
  const ligandCandidates = [];
  const ignoredAuxiliary = [];
  const ignoredGenerated = [];
  const resolveTaskFile = async (value, label) => {
    const raw = normalizeString(value);
    if (!raw) return null;
    const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(taskDir, raw));
    const root = path.resolve(taskDir);
    if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      throw new Error(`${label} must stay inside the task folder: ${raw}`);
    }
    const stat = await statOrNull(resolved);
    if (!stat || !stat.isFile()) throw new Error(`${label} file not found: ${raw}`);
    return resolved;
  };

  const explicitReceptor = await resolveTaskFile(input.receptor || input.receptor_path || input.receptorPath, 'receptor');
  const rawExplicitLigands = input.ligands || input.ligand || input.ligand_paths || input.ligandPaths;
  const explicitLigandValues = Array.isArray(rawExplicitLigands)
    ? rawExplicitLigands
    : normalizeString(rawExplicitLigands)
      ? splitList(rawExplicitLigands)
      : [];
  const explicitLigands = [];
  for (const item of explicitLigandValues) explicitLigands.push(await resolveTaskFile(item, 'ligand'));

  for (const filePath of await walkFiles(taskDir)) {
    const rel = path.relative(taskDir, filePath);
    const relParts = rel.split(path.sep);
    if (hasGeneratedPart(relParts)) {
      ignoredGenerated.push(rel);
      continue;
    }
    if (isAuxiliary(filePath)) {
      ignoredAuxiliary.push(rel);
      continue;
    }
    const suffix = ext(filePath);
    if (RECEPTOR_EXTS.has(suffix)) receptorCandidates.push(filePath);
    if (LIGAND_EXTS.has(suffix)) ligandCandidates.push(filePath);
  }

  const receptorOnly = receptorCandidates.filter(candidate => {
    const suffix = ext(candidate);
    return suffix === '.cif' || !stem(candidate).toLowerCase().includes('lig');
  });

  let receptor = null;
  if (explicitReceptor) receptor = explicitReceptor;
  else if (receptorCandidates.length === 1) receptor = receptorCandidates[0];
  else if (receptorOnly.length === 1) receptor = receptorOnly[0];

  const usedWorking = new Set();
  const usedViewer = new Set();
  const ligands = [];
  const ligandSource = explicitLigands.length ? explicitLigands : ligandCandidates;
  for (const filePath of ligandSource) {
    if (receptor && path.resolve(filePath) === path.resolve(receptor)) continue;
    const original = stem(filePath);
    const working = uniqueId(sanitizeId(original, 'lig', false), usedWorking);
    const viewer = uniqueId(sanitizeId(working, 'lig', true), usedViewer);
    const fileStat = await fs.stat(filePath);
    ligands.push({
      input_path: path.resolve(filePath),
      relative_path: toPosixRelative(path.relative(taskDir, filePath)),
      original_id: original,
      working_id: working,
      viewer_id: viewer,
      pymol_id: viewer,
      format: ext(filePath).replace(/^\./, ''),
      size_bytes: fileStat.size,
      status: fileStat.size === 0 ? 'failed' : 'ok',
      error: fileStat.size === 0 ? 'empty ligand file' : '',
    });
  }

  const warnings = [];
  const errors = [];
  if (!receptor) errors.push('Expected exactly one unambiguous receptor candidate.');
  if (!ligands.length) errors.push('No ligand candidates found.');
  if (!explicitReceptor && receptorOnly.length > 1) {
    warnings.push('Multiple receptor-like files found; receptor selection may require user confirmation.');
  }

  const caseOriginal = path.basename(taskDir);
  const caseWorking = sanitizeId(caseOriginal, 'case', false);
  const caseViewer = sanitizeId(caseWorking, 'case', true);
  return {
    task_dir: taskDir,
    case_original: caseOriginal,
    case_working_id: caseWorking,
    case_viewer_id: caseViewer,
    case_pymol_id: caseViewer,
    receptor: receptor
      ? {
          input_path: path.resolve(receptor),
          relative_path: toPosixRelative(path.relative(taskDir, receptor)),
          original_id: stem(receptor),
          working_id: sanitizeId(stem(receptor), 'receptor', false),
          viewer_id: sanitizeId(stem(receptor), 'receptor', true),
          pymol_id: sanitizeId(stem(receptor), 'receptor', true),
          format: ext(receptor).replace(/^\./, ''),
          size_bytes: (await fs.stat(receptor)).size,
        }
      : null,
    ligands,
    ignored_auxiliary: ignoredAuxiliary.map(toPosixRelative),
    ignored_generated: ignoredGenerated.map(toPosixRelative),
    warnings,
    errors,
    ok: errors.length === 0,
  };
}

function parsePdbAtomCoord(line) {
  return [
    Number.parseFloat(line.slice(30, 38)),
    Number.parseFloat(line.slice(38, 46)),
    Number.parseFloat(line.slice(46, 54)),
  ];
}

function pdbHetKey(line) {
  return {
    resname: line.slice(17, 20).trim(),
    chain: line.slice(21, 22).trim() || '_',
    seq: line.slice(22, 26).trim(),
  };
}

function isSolventLikeHet(resname) {
  return new Set(['HOH', 'WAT', 'DOD', 'SOL']).has(String(resname || '').toUpperCase());
}

async function prepareRedockingCase(input) {
  const pdbId = normalizeString(input.pdb_id || input.pdbId || input.id).toUpperCase();
  const pdbFile = normalizeString(input.pdb_file || input.pdbFile || input.input);
  const outDirRaw = normalizeString(input.out_dir || input.outDir || input.output);
  if (!pdbId && !pdbFile) throw new Error('pdb-id or pdb-file is required');
  if (!outDirRaw) throw new Error('out-dir is required');
  const outDir = path.resolve(outDirRaw);
  await fs.mkdir(path.join(outDir, 'ligands'), { recursive: true });

  const sourceName = pdbId || stem(pdbFile).toUpperCase();
  const pdbPath = path.join(outDir, `${sourceName}.pdb`);
  let pdbText = '';
  if (pdbFile) {
    const resolved = path.resolve(pdbFile);
    pdbText = await fs.readFile(resolved, 'utf8');
    await fs.writeFile(pdbPath, pdbText, 'utf8');
  } else {
    const url = `https://files.rcsb.org/download/${encodeURIComponent(pdbId)}.pdb`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`RCSB download failed for ${pdbId}: HTTP ${response.status}`);
    pdbText = await response.text();
    await fs.writeFile(pdbPath, pdbText, 'utf8');
  }

  const lines = pdbText.split(/\r?\n/);
  const receptorLines = [];
  const ligands = new Map();
  for (const line of lines) {
    if (line.startsWith('ATOM  ') || line.startsWith('TER')) receptorLines.push(line);
    if (!line.startsWith('HETATM')) continue;
    const key = pdbHetKey(line);
    if (!key.resname || isSolventLikeHet(key.resname)) continue;
    const id = `${key.resname}:${key.chain}:${key.seq}`;
    if (!ligands.has(id)) ligands.set(id, { ...key, id, lines: [], coords: [] });
    const entry = ligands.get(id);
    entry.lines.push(line);
    const coord = parsePdbAtomCoord(line);
    if (coord.every(Number.isFinite)) entry.coords.push(coord);
  }
  if (!receptorLines.some(line => line.startsWith('ATOM  '))) throw new Error('No ATOM records found for receptor');
  const ligandCandidates = [...ligands.values()]
    .filter(item => item.lines.length > 0 && item.coords.length > 0)
    .sort((a, b) => b.lines.length - a.lines.length);
  if (!ligandCandidates.length) throw new Error('No non-water co-crystal ligand found in PDB');
  const selected = ligandCandidates[0];

  const receptorPath = path.join(outDir, 'receptor.pdb');
  const ligandPath = path.join(outDir, 'ligands', `${selected.resname}.pdb`);
  await fs.writeFile(receptorPath, `${receptorLines.join('\n')}\nEND\n`, 'ascii');
  await fs.writeFile(ligandPath, `${selected.lines.join('\n')}\nEND\n`, 'ascii');

  const axes = [0, 1, 2].map(index => selected.coords.map(coord => coord[index]));
  const center = axes.map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
  const size = axes.map(values => Math.max(20, Math.max(...values) - Math.min(...values) + 12));
  const methods = parseMethods(input.methods || input.method || 'gnina,smina,boltz,matcha');
  const profileName = normalizeString(input.profile_name || input.profileName);
  const config = {
    folder: outDir,
    ...(profileName ? { profile_name: profileName } : {}),
    methods,
    receptor: 'receptor.pdb',
    ligands: [`ligands/${selected.resname}.pdb`],
    active_site: {
      mode: 'manual',
      center: center.map(value => Number(value.toFixed(3))),
      size: size.map(value => Number(value.toFixed(3))),
      units: 'angstrom',
      source: `${sourceName} co-crystal ligand ${selected.resname} ${selected.chain} ${selected.seq}`,
    },
    exhaustiveness: Number.parseInt(input.exhaustiveness || '8', 10),
    num_modes: Number.parseInt(input.num_modes || input.numModes || '10', 10),
    matcha_samples: Number.parseInt(input.matcha_samples || input.matchaSamples || '10', 10),
  };
  const configPath = path.join(outDir, 'docking_config.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    workflow: 'prepare-redocking-case',
    pdb_id: pdbId || null,
    source_pdb: pdbPath,
    out_dir: outDir,
    receptor: receptorPath,
    ligand: ligandPath,
    selected_ligand: {
      resname: selected.resname,
      chain: selected.chain,
      seq: selected.seq,
      atom_count: selected.lines.length,
    },
    active_site: config.active_site,
    config: configPath,
    next_command: `lp-flow run docking --config ${shellQuote(configPath)} --out-dir ${shellQuote(path.join(outDir, 'run_package'))}`,
  };
}

function normalizeQuery(value) {
  const raw = normalizeString(value).replace(/^"|"$/g, '');
  const parsed = path.parse(raw);
  const queryStem = parsed.ext ? parsed.name : raw;
  const queryFilename = parsed.ext ? parsed.base : `${raw}.pdb`;
  return {
    queryStem: queryStem.toLowerCase(),
    queryFilename: queryFilename.toLowerCase(),
  };
}

async function findCaseFolder(input) {
  const value = normalizeString(input.input || input.query || input.value);
  if (!value) throw new Error('input is required');
  const roots = (Array.isArray(input.roots) && input.roots.length ? input.roots : splitList(input.root))
    .map(String)
    .filter(Boolean);
  const searchRoots = (roots.length ? roots : defaultSearchRoots()).map(root => path.resolve(root));
  const candidate = path.resolve(value);
  const candidateStat = await statOrNull(candidate);

  if (candidateStat) {
    if (candidateStat.isDirectory()) {
      const parts = path.normalize(candidate).split(path.sep);
      if (hasGeneratedPart(parts)) {
        return {
          ok: false,
          mode: 'generated_output_folder',
          task_folder: '',
          matches: [],
          errors: [`Generated output folder cannot be used as a task folder: ${candidate}`],
        };
      }
      return {
        ok: true,
        mode: 'explicit_folder',
        task_folder: candidate,
        matches: [{ task_folder: candidate, receptor_file: '' }],
        errors: [],
      };
    }
    if (candidateStat.isFile() && RECEPTOR_EXTS.has(ext(candidate)) && !isAuxiliary(candidate)) {
      const parts = path.normalize(candidate).split(path.sep);
      if (!hasGeneratedPart(parts)) {
        return {
          ok: true,
          mode: 'receptor_file',
          task_folder: path.dirname(candidate),
          matches: [{ task_folder: path.dirname(candidate), receptor_file: candidate }],
          errors: [],
        };
      }
    }
    return {
      ok: false,
      mode: 'unsupported_existing_path',
      task_folder: '',
      matches: [],
      errors: [`Existing path is not a supported task folder or receptor file: ${candidate}`],
    };
  }

  const { queryStem, queryFilename } = normalizeQuery(value);
  const matches = [];
  const seenFolders = new Set();
  for (const root of searchRoots) {
    const rootStat = await statOrNull(root);
    if (!rootStat || !rootStat.isDirectory()) continue;
    for (const filePath of await walkFiles(root)) {
      const relParts = path.relative(root, filePath).split(path.sep);
      if (hasGeneratedPart(relParts) || isAuxiliary(filePath) || !RECEPTOR_EXTS.has(ext(filePath))) continue;
      const name = path.basename(filePath).toLowerCase();
      const fileStem = stem(filePath).toLowerCase();
      if (name !== queryFilename && fileStem !== queryStem) continue;
      const folder = path.dirname(path.resolve(filePath));
      if (seenFolders.has(folder)) continue;
      seenFolders.add(folder);
      matches.push({ task_folder: folder, receptor_file: path.resolve(filePath), matched_name: path.basename(filePath) });
    }
  }

  if (matches.length === 1) {
    return { ok: true, mode: 'pdb_query', task_folder: matches[0].task_folder, matches, errors: [] };
  }
  if (!matches.length) {
    return { ok: false, mode: 'pdb_query', task_folder: '', matches: [], errors: ['No matching receptor file found in configured search roots.'] };
  }
  return {
    ok: false,
    mode: 'ambiguous_pdb_query',
    task_folder: '',
    matches,
    errors: ['Multiple matching task folders found; user must choose one.'],
  };
}

function parsePort(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid SSH port: ${value}`);
  return parsed;
}

function configBaseDirs() {
  const dirs = [];
  const explicit = normalizeString(getEnv('LP_FLOW_DOCKING_CONFIG'));
  if (explicit) dirs.push(explicit);
  const appData = normalizeString(getEnv('APPDATA'));
  if (appData) dirs.push(path.join(appData, 'LP-FlowDocking'));
  const userProfile = normalizeString(getEnv('USERPROFILE'));
  if (userProfile) dirs.push(path.join(userProfile, '.config', 'lp-flow'));
  const home = normalizeString(getEnv('HOME'));
  if (home) dirs.push(path.join(home, '.config', 'lp-flow'));
  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function isLegacyProfilePath(filePath) {
  return path.resolve(filePath).split(path.sep).some(segment => segment.toLowerCase() === 'lp-flowdocking');
}

function profileFileCandidates(profileName) {
  const safeName = sanitizeId(profileName || 'default', 'profile', false);
  const candidates = [];
  for (const base of configBaseDirs()) {
    candidates.push(path.join(base, 'profiles', `${safeName}.json`));
    candidates.push(path.join(base, `${safeName}.json`));
  }
  return candidates;
}

async function readProfileJson(filePath) {
  const resolved = path.resolve(filePath);
  const data = await readJsonFile(resolved, `profile file ${resolved}`);
  if (data?.profiles && typeof data.profiles === 'object' && !Array.isArray(data.profiles)) {
    const requested = normalizeString(data.default_profile || data.defaultProfile || Object.keys(data.profiles)[0]);
    if (!requested || !data.profiles[requested]) throw new Error(`No usable profile found in ${resolved}`);
    return { ...data.profiles[requested], profile_name: data.profiles[requested].profile_name || requested };
  }
  return data;
}

async function loadNamedProfile(profileName) {
  for (const candidate of profileFileCandidates(profileName || 'default')) {
    if (await exists(candidate)) {
      const profile = await readProfileJson(candidate);
      return isLegacyProfilePath(candidate)
        ? { ...profile, profile_warning: 'Legacy LP-FlowDocking profile discovery is read-only. Move this profile to the canonical lp-flow configuration directory.' }
        : profile;
    }
  }
  throw new Error(`Profile "${profileName || 'default'}" was not found. Use profile_path, profile_json, or create a local profile under ${configBaseDirs().join(' or ')}`);
}

async function listConfiguredProfiles() {
  const profiles = [];
  const seen = new Set();
  for (const base of configBaseDirs()) {
    const dirs = [base, path.join(base, 'profiles')];
    for (const dir of dirs) {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
        const filePath = path.join(dir, entry.name);
        let raw;
        try {
          raw = await readProfileJson(filePath);
        } catch {
          continue;
        }
        const name = normalizeString(raw.profile_name || raw.profileName || raw.name || stem(entry.name));
        if (!name || seen.has(name)) continue;
        seen.add(name);
        profiles.push({
          profile_name: name,
          profile_path: filePath,
          has_remote_work_root: Boolean(normalizeString(raw.remote_work_root || raw.remoteWorkRoot)),
          has_docking_tools: Boolean(normalizeString(raw.gnina || raw.gnina_path || raw.smina || raw.smina_path || raw.obabel || raw.obabel_path)),
          has_boltz: Boolean(normalizeString(raw.boltz_env || raw.boltzEnv || raw.boltz_checkout || raw.boltzCheckout || raw.abcfold_checkout || raw.abcfoldCheckout)),
          has_matcha: Boolean(normalizeString(raw.matcha_python || raw.matchaPython || raw.matcha_checkout || raw.matchaCheckout)),
          has_gromacs: Boolean(normalizeString(raw.gromacs || raw.gmx || raw.gromacs_path || raw.gromacsPath || raw.gmx_path || raw.gmxPath)),
          scheduler: profileScheduler(raw) || null,
        });
      }
    }
  }
  return profiles.sort((a, b) => a.profile_name.localeCompare(b.profile_name));
}

function assertPattern(value, pattern, label) {
  if (value && !pattern.test(value)) throw new Error(`${label} has invalid characters: ${value}`);
}

function assertSafeSshAlias(value) {
  if (!value) return;
  assertPattern(value, /^[A-Za-z0-9_.-]+$/, 'ssh_alias');
  if (value.startsWith('-')) throw new Error('ssh_alias must not start with -');
}

function assertSafeHost(value) {
  if (!value) return;
  assertPattern(value, /^[A-Za-z0-9_.:-]+$/, 'host');
  if (value.startsWith('-')) throw new Error('host must not start with -');
}

function assertSafeProfileToken(value, label) {
  if (!value) return;
  assertPattern(value, /^[A-Za-z0-9_.-]+$/, label);
  if (value.startsWith('-')) throw new Error(`${label} must not start with -`);
}

function parseSafeSshCommand(commandLine) {
  const parts = splitCommandLine(commandLine);
  if (!parts.length) return [];
  assertCommandExecutable(parts, ['ssh', 'ssh.exe'], 'ssh_command');
  const safe = [parts[0]];
  let target = '';
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '-p') {
      const port = parsePort(parts[i + 1]);
      safe.push('-p', String(port));
      i += 1;
      continue;
    }
    if (part === '-l') {
      const login = normalizeString(parts[i + 1]);
      assertSafeProfileToken(login, 'ssh_command -l user');
      safe.push('-l', login);
      i += 1;
      continue;
    }
    if (part.startsWith('-')) {
      throw new Error(`ssh_command option is not allowed in execution profiles: ${part}`);
    }
    if (target) throw new Error('ssh_command must contain exactly one remote target');
    assertPattern(part, /^[A-Za-z0-9_.@:-]+$/, 'ssh_command target');
    target = part;
  }
  if (!target) throw new Error('ssh_command must include a remote target');
  safe.push(target);
  return safe;
}

function normalizeProfile(rawProfile, overrides = {}) {
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    throw new Error('profile must be an object');
  }
  const source = { ...rawProfile, ...overrides };
  const profileName = normalizeString(source.profile_name || source.profileName || source.name);
  const username = normalizeString(source.username);
  const sshAlias = normalizeString(source.ssh_alias || source.sshAlias || source.host_alias || source.hostAlias);
  const sshCommand = normalizeString(source.ssh_command || source.sshCommand);
  const host = normalizeString(source.host);
  const remoteWorkRoot = normalizeString(source.remote_work_root || source.remoteWorkRoot).replace(/\/+$/g, '');
  const missing = [];
  if (!profileName) missing.push('profile_name');
  if (!remoteWorkRoot) missing.push('remote_work_root');
  if (!sshAlias && !sshCommand && !host) missing.push('ssh_alias or ssh_command or host');
  if (host && !sshAlias && !sshCommand && !username) missing.push('username');
  if (missing.length) throw new Error(`Missing required profile fields: ${missing.join(', ')}`);
  const profileRef = normalizeString(source.profile_ref || source.profileRef || profileName);
  const remoteHome = normalizeString(source.remote_home || source.remoteHome);
  assertSafeProfileToken(profileName, 'profile_name');
  assertSafeProfileToken(profileRef, 'profile_ref');
  if (username) assertSafeProfileToken(username, 'username');
  assertSafeSshAlias(sshAlias);
  assertSafeHost(host);
  if (sshCommand) parseSafeSshCommand(sshCommand);
  normalizePosixAbsolute(remoteWorkRoot, 'remote_work_root');
  if (remoteHome) normalizePosixAbsolute(remoteHome, 'remote_home');
  const sharedSoftwarePolicy = normalizeString(source.shared_software_policy || source.sharedSoftwarePolicy) || 'read_only';
  const gpuPolicy = normalizeString(source.gpu_policy || source.gpuPolicy) || 'check_before_use';
  const scheduler = normalizeString(source.scheduler || source.queue || source.batch_system || source.batchSystem).toLowerCase();
  const schedulerGpuGres = normalizeString(source.scheduler_gpu_gres || source.schedulerGpuGres);
  if (sharedSoftwarePolicy !== 'read_only') throw new Error('shared_software_policy must be read_only');
  if (gpuPolicy !== 'check_before_use') throw new Error('gpu_policy must be check_before_use');
  if (scheduler && !['slurm', 'ssh-inline'].includes(scheduler)) throw new Error('scheduler must be slurm or ssh-inline');
  if (schedulerGpuGres && !/^[A-Za-z0-9_.:-]+$/.test(schedulerGpuGres)) throw new Error('scheduler_gpu_gres has invalid characters');
  return {
    profile_name: profileName,
    profile_ref: profileRef,
    ssh_alias: sshAlias,
    ssh_command: sshCommand,
    host_alias: sshAlias,
    host,
    port: parsePort(source.port),
    username,
    remote_home: remoteHome,
    remote_work_root: remoteWorkRoot,
    shared_software_policy: sharedSoftwarePolicy,
    gpu_policy: gpuPolicy,
    scheduler,
    scheduler_partition: normalizeString(source.scheduler_partition || source.schedulerPartition),
    scheduler_account: normalizeString(source.scheduler_account || source.schedulerAccount),
    scheduler_time: normalizeString(source.scheduler_time || source.schedulerTime),
    scheduler_gpu_gres: schedulerGpuGres,
    profile_warning: normalizeString(source.profile_warning),
    scheduler_max_queue_wait_minutes: normalizeString(source.scheduler_max_queue_wait_minutes || source.schedulerMaxQueueWaitMinutes),
    micromamba: normalizeString(source.micromamba),
    docking_env: normalizeString(source.docking_env || source.dockingEnv),
    boltz_env: normalizeString(source.boltz_env || source.boltzEnv),
    boltz_checkout: normalizeString(source.boltz_checkout || source.boltzCheckout || source.abcfold_checkout || source.abcfoldCheckout),
    boltz_weights_readonly: normalizeString(source.boltz_weights_readonly || source.boltzWeightsReadonly),
    boltz_writable_cache: normalizeString(source.boltz_writable_cache || source.boltzWritableCache),
    matcha_checkout: normalizeString(source.matcha_checkout || source.matchaCheckout),
    matcha_python: normalizeString(source.matcha_python || source.matchaPython),
    matcha_checkpoints: normalizeString(source.matcha_checkpoints || source.matchaCheckpoints),
    gnina: normalizeString(source.gnina || source.gnina_path || source.gninaPath),
    smina: normalizeString(source.smina || source.smina_path || source.sminaPath),
    obabel: normalizeString(source.obabel || source.obabel_path || source.obabelPath),
    gromacs: normalizeString(source.gromacs || source.gmx || source.gromacs_path || source.gromacsPath || source.gmx_path || source.gmxPath),
    ld_library_path: normalizeString(source.ld_library_path || source.ldLibraryPath || source.gromacs_ld_library_path || source.gromacsLdLibraryPath),
    mdtools_env: normalizeString(source.mdtools_env || source.mdtoolsEnv),
    acpype: normalizeString(source.acpype || source.acpype_path || source.acpypePath),
    antechamber: normalizeString(source.antechamber || source.antechamber_path || source.antechamberPath),
    parmchk2: normalizeString(source.parmchk2 || source.parmchk2_path || source.parmchk2Path),
    tleap: normalizeString(source.tleap || source.tleap_path || source.tleapPath),
    ssh_batch_mode: source.ssh_batch_mode ?? source.sshBatchMode,
    ssh_connect_timeout: normalizeString(source.ssh_connect_timeout || source.sshConnectTimeout),
    ssh_control_master: source.ssh_control_master ?? source.sshControlMaster,
    ssh_control_persist: normalizeString(source.ssh_control_persist || source.sshControlPersist),
    ssh_control_path: normalizeString(source.ssh_control_path || source.sshControlPath),
    ssh_session_persist: normalizeString(source.ssh_session_persist || source.sshSessionPersist),
  };
}

function profileOverrides(input) {
  const overrides = {};
  for (const [target, keys] of Object.entries({
    profile_name: ['profile_name', 'profileName'],
    ssh_alias: ['ssh_alias', 'sshAlias', 'host_alias', 'hostAlias'],
    ssh_command: ['ssh_command', 'sshCommand'],
    host: ['host'],
    port: ['port'],
    username: ['username'],
    remote_home: ['remote_home', 'remoteHome'],
    remote_work_root: ['remote_work_root', 'remoteWorkRoot'],
    scheduler: ['scheduler', 'queue', 'batch_system', 'batchSystem'],
    scheduler_partition: ['scheduler_partition', 'schedulerPartition'],
    scheduler_account: ['scheduler_account', 'schedulerAccount'],
    scheduler_time: ['scheduler_time', 'schedulerTime'],
    scheduler_gpu_gres: ['scheduler_gpu_gres', 'schedulerGpuGres'],
    scheduler_max_queue_wait_minutes: ['scheduler_max_queue_wait_minutes', 'schedulerMaxQueueWaitMinutes'],
    micromamba: ['micromamba'],
    docking_env: ['docking_env', 'dockingEnv'],
    boltz_env: ['boltz_env', 'boltzEnv'],
    boltz_checkout: ['boltz_checkout', 'boltzCheckout', 'abcfold_checkout', 'abcfoldCheckout'],
    boltz_weights_readonly: ['boltz_weights_readonly', 'boltzWeightsReadonly'],
    boltz_writable_cache: ['boltz_writable_cache', 'boltzWritableCache'],
    matcha_checkout: ['matcha_checkout', 'matchaCheckout'],
    matcha_python: ['matcha_python', 'matchaPython'],
    matcha_checkpoints: ['matcha_checkpoints', 'matchaCheckpoints'],
    gnina: ['gnina', 'gnina_path', 'gninaPath'],
    smina: ['smina', 'smina_path', 'sminaPath'],
    obabel: ['obabel', 'obabel_path', 'obabelPath'],
    gromacs: ['gromacs', 'gmx', 'gromacs_path', 'gromacsPath', 'gmx_path', 'gmxPath'],
    ld_library_path: ['ld_library_path', 'ldLibraryPath', 'gromacs_ld_library_path', 'gromacsLdLibraryPath'],
    mdtools_env: ['mdtools_env', 'mdtoolsEnv'],
    acpype: ['acpype', 'acpype_path', 'acpypePath'],
    antechamber: ['antechamber', 'antechamber_path', 'antechamberPath'],
    parmchk2: ['parmchk2', 'parmchk2_path', 'parmchk2Path'],
    tleap: ['tleap', 'tleap_path', 'tleapPath'],
    ssh_batch_mode: ['ssh_batch_mode', 'sshBatchMode'],
    ssh_connect_timeout: ['ssh_connect_timeout', 'sshConnectTimeout'],
    ssh_control_master: ['ssh_control_master', 'sshControlMaster'],
    ssh_control_persist: ['ssh_control_persist', 'sshControlPersist'],
    ssh_control_path: ['ssh_control_path', 'sshControlPath'],
    ssh_session_persist: ['ssh_session_persist', 'sshSessionPersist', 'session_persist', 'sessionPersist', 'persist'],
  })) {
    for (const key of keys) {
      if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
        overrides[target] = input[key];
        break;
      }
    }
  }
  return overrides;
}

async function resolveProfile(input = {}) {
  const explicitProfile = input.profile && typeof input.profile === 'object' ? input.profile : null;
  const profileJson = normalizeString(input.profile_json || input.profileJson);
  const profilePath = normalizeString(input.profile_path || input.profilePath || getEnv('LP_FLOW_DOCKING_PROFILE_PATH'));
  const profileName = normalizeString(input.profile_name || input.profileName || input.name || getEnv('LP_FLOW_DOCKING_PROFILE') || 'default');
  let rawProfile;
  if (explicitProfile) rawProfile = explicitProfile;
  else if (profileJson) rawProfile = JSON.parse(profileJson);
  else if (profilePath) {
    rawProfile = await readProfileJson(profilePath);
    if (isLegacyProfilePath(profilePath)) {
      rawProfile = { ...rawProfile, profile_warning: 'Legacy LP-FlowDocking profile discovery is read-only. Move this profile to the canonical lp-flow configuration directory.' };
    }
  }
  else rawProfile = await loadNamedProfile(profileName);
  return normalizeProfile(rawProfile, profileOverrides(input));
}

function executionProfileSourceProvided(input = {}) {
  return Boolean(
    input.profile ||
    input.profile_json ||
    input.profileJson ||
    input.profile_path ||
    input.profilePath ||
    input.profile_name ||
    input.profileName ||
    getEnv('LP_FLOW_DOCKING_PROFILE') ||
    getEnv('LP_FLOW_DOCKING_PROFILE_PATH')
  );
}

function shellQuote(value) {
  const text = String(value);
  const platform = currentPlatform();
  if (platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function splitCommandLine(commandLine) {
  const text = normalizeString(commandLine);
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('Unclosed quote in command line');
  if (current) parts.push(current);
  return parts;
}

function commandLineFromArgv(argv) {
  return argv.map(shellQuote).join(' ');
}

function assertCommandExecutable(argv, allowedNames, label) {
  if (!Array.isArray(argv) || !argv.length) throw new Error(`${label} command is empty`);
  const executable = path.basename(String(argv[0])).toLowerCase();
  const allowed = allowedNames.map(name => name.toLowerCase());
  if (!allowed.includes(executable)) {
    throw new Error(`${label} command must start with ${allowedNames.join(' or ')}, got ${argv[0]}`);
  }
}

function booleanLike(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1' || value === 1 || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 0 || value === 'no') return false;
  return fallback;
}

function sshControlPersist(profile) {
  const raw = normalizeString(
    profile.ssh_control_persist ||
    profile.sshControlPersist ||
    getEnv('LP_FLOW_SSH_CONTROL_PERSIST') ||
    '10m'
  );
  if (!/^[A-Za-z0-9]+$/.test(raw)) throw new Error(`ssh_control_persist has invalid characters: ${raw}`);
  return raw;
}

function sshControlEnabled(profile) {
  const profileValue = profile.ssh_control_master ?? profile.sshControlMaster;
  const envValue = getEnv('LP_FLOW_SSH_CONTROLMASTER');
  const explicitProfile = profileValue !== undefined && profileValue !== null && profileValue !== '';
  const explicitEnv = envValue !== undefined && envValue !== null && envValue !== '';
  if (explicitProfile) return booleanLike(profileValue, false);
  if (explicitEnv) return booleanLike(envValue, false);
  // OpenSSH ControlMaster is unreliable with Windows named pipes/sockets in the
  // Codex desktop environment ("getsockname failed: Not a socket"). Keep it
  // opt-in on Windows and default-on elsewhere.
  return currentPlatform() !== 'win32';
}

function sshControlDisabledReason(profile) {
  const profileValue = profile.ssh_control_master ?? profile.sshControlMaster;
  const envValue = getEnv('LP_FLOW_SSH_CONTROLMASTER');
  if (!booleanLike(profileValue, booleanLike(envValue, true))) {
    return 'disabled by profile or LP_FLOW_SSH_CONTROLMASTER';
  }
  if (currentPlatform() === 'win32') {
    return 'disabled by default on Windows because OpenSSH ControlMaster can fail with "getsockname failed: Not a socket"; set ssh_control_master=true or LP_FLOW_SSH_CONTROLMASTER=1 to opt in';
  }
  return 'disabled';
}

function sshSessionPersist(input = {}, profile = {}) {
  const raw = normalizeString(
    input.persist ||
    input.session_persist ||
    input.sessionPersist ||
    input.ssh_session_persist ||
    input.sshSessionPersist ||
    profile.ssh_session_persist ||
    profile.sshSessionPersist ||
    getEnv('LP_FLOW_SSH_SESSION_PERSIST') ||
    '8h'
  );
  if (!/^[A-Za-z0-9]+$/.test(raw)) throw new Error(`ssh_session_persist has invalid characters: ${raw}`);
  return raw;
}

function profileWithSessionControl(profile, input = {}) {
  return {
    ...profile,
    ssh_control_master: true,
    ssh_control_persist: sshSessionPersist(input, profile),
  };
}

function sshControlTargetKey(profile) {
  const sshAlias = normalizeString(profile.ssh_alias || profile.sshAlias || profile.host_alias || profile.hostAlias);
  if (sshAlias) return `alias:${sshAlias}`;
  const host = normalizeString(profile.host);
  const username = normalizeString(profile.username);
  if (host && username) return `host:${username}@${host}:${profile.port || 22}`;
  const sshParts = parseSafeSshCommand(profile.ssh_command || profile.sshCommand || '');
  return `command:${sshParts.join(' ')}`;
}

function sshControlPath(profile) {
  const explicit = normalizeString(profile.ssh_control_path || profile.sshControlPath || getEnv('LP_FLOW_SSH_CONTROL_PATH'));
  if (explicit) return path.resolve(explicit).replace(/\\/g, '/');
  const key = sshControlTargetKey(profile);
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `lpd-ssh-${hash}`).replace(/\\/g, '/');
}

function sshControlSettings(profile) {
  const enabled = sshControlEnabled(profile);
  if (!enabled) {
    return {
      enabled: false,
      reason: sshControlDisabledReason(profile),
    };
  }
  return {
    enabled: true,
    control_master: 'auto',
    control_persist: sshControlPersist(profile),
    control_path: sshControlPath(profile),
  };
}

function sshControlOptions(profile) {
  const control = sshControlSettings(profile);
  if (!control.enabled) return [];
  return [
    '-o',
    `ControlMaster=${control.control_master}`,
    '-o',
    `ControlPersist=${control.control_persist}`,
    '-o',
    `ControlPath=${control.control_path}`,
  ];
}

function sshBatchModeEnabled(profile) {
  return booleanLike(profile.ssh_batch_mode ?? profile.sshBatchMode ?? getEnv('LP_FLOW_SSH_BATCHMODE'), true);
}

function sshConnectTimeout(profile) {
  const raw = normalizeString(profile.ssh_connect_timeout || profile.sshConnectTimeout || getEnv('LP_FLOW_SSH_CONNECT_TIMEOUT') || '15');
  if (!/^[0-9]{1,4}$/.test(raw)) throw new Error(`ssh_connect_timeout must be an integer number of seconds: ${raw}`);
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error(`ssh_connect_timeout is out of range: ${raw}`);
  return String(seconds);
}

function sshSafetyOptions(profile) {
  const options = [];
  if (sshBatchModeEnabled(profile)) options.push('-o', 'BatchMode=yes');
  options.push('-o', `ConnectTimeout=${sshConnectTimeout(profile)}`);
  return options;
}

function profileSshArgv(profile) {
  const sshAlias = normalizeString(profile.ssh_alias || profile.sshAlias || profile.host_alias || profile.hostAlias);
  if (sshAlias) {
    assertSafeSshAlias(sshAlias);
    return ['ssh', ...sshSafetyOptions(profile), ...sshControlOptions(profile), sshAlias];
  }
  const sshCommand = normalizeString(profile.ssh_command || profile.sshCommand);
  if (sshCommand) {
    const parts = parseSafeSshCommand(sshCommand);
    if (parts.length) return [parts[0], ...sshSafetyOptions(profile), ...sshControlOptions(profile), ...parts.slice(1)];
  }
  const host = normalizeString(profile.host);
  const username = normalizeString(profile.username);
  if (!host || !username) throw new Error('profile requires ssh_alias, ssh_command, or host+username');
  assertSafeHost(host);
  assertSafeProfileToken(username, 'username');
  const argv = ['ssh', ...sshSafetyOptions(profile), ...sshControlOptions(profile)];
  if (profile.port) argv.push('-p', String(profile.port));
  argv.push(`${username}@${host}`);
  return argv;
}

function profileRemoteTarget(profile) {
  const sshAlias = normalizeString(profile.ssh_alias || profile.sshAlias || profile.host_alias || profile.hostAlias);
  if (sshAlias) {
    assertSafeSshAlias(sshAlias);
    return sshAlias;
  }
  const host = normalizeString(profile.host);
  const username = normalizeString(profile.username);
  if (host && username) {
    assertSafeHost(host);
    assertSafeProfileToken(username, 'username');
    return `${username}@${host}`;
  }
  const sshParts = parseSafeSshCommand(profile.ssh_command || profile.sshCommand || '');
  const last = sshParts[sshParts.length - 1] || '';
  if (last && !last.startsWith('-')) return last;
  throw new Error('profile requires ssh_alias, host+username, or safe ssh_command for scp operations');
}

function profileScpArgv(profile) {
  const argv = ['scp', ...sshSafetyOptions(profile), ...sshControlOptions(profile)];
  const sshAlias = normalizeString(profile.ssh_alias || profile.sshAlias || profile.host_alias || profile.hostAlias);
  if (profile.port && !sshAlias) argv.push('-P', String(profile.port));
  return argv;
}

function profileScpRecursiveArgv(profile) {
  const argv = profileScpArgv(profile);
  return [argv[0], '-r', ...argv.slice(1)];
}

function sshRemoteCommand(profile, remoteCommand) {
  const argv = [...profileSshArgv(profile), remoteCommand];
  return {
    kind: 'ssh',
    argv,
    command_line: commandLineFromArgv(argv),
    ssh_control: sshControlSettings(profile),
  };
}

function remoteResourceLockCommand(remoteWorkRoot, runDir, payloadCommand) {
  const root = normalizeString(remoteWorkRoot).replace(/\/+$/g, '');
  const lockDir = `${root}/.lp_flow_remote_payload.lock`;
  return [
    `lock=${posixQuote(lockDir)}; run_dir=${posixQuote(runDir)};`,
    `if ! mkdir "$lock" 2>/dev/null; then`,
    `old_pid="$(cat "$lock/pid" 2>/dev/null | tr -cd '0-9')" ;`,
    `if test -n "$old_pid" && kill -0 "$old_pid" 2>/dev/null; then`,
    `echo "LP-Flow remote payload lock is active: $lock" >&2;`,
    `test -f "$lock/run_dir" && { echo "active_run_dir=$(cat "$lock/run_dir")" >&2; };`,
    `exit 75;`,
    `fi;`,
    `echo "LP-Flow remote payload lock was stale; removing: $lock" >&2;`,
    `rm -rf "$lock";`,
    `if ! mkdir "$lock" 2>/dev/null; then echo "LP-Flow remote payload lock is active after stale cleanup: $lock" >&2; exit 75; fi;`,
    `fi;`,
    `printf '%s\\n' "$run_dir" > "$lock/run_dir";`,
    `printf '%s\\n' "$$" > "$lock/pid";`,
    `trap 'rm -rf "$lock"' EXIT INT TERM;`,
    payloadCommand,
  ].join(' ');
}

function profileScheduler(profile = {}) {
  return normalizeString(profile.scheduler || profile.queue || profile.batch_system || profile.batchSystem || '').toLowerCase();
}

function profileQueueWaitMinutes(profile = {}) {
  const value = Number.parseInt(profile.scheduler_max_queue_wait_minutes || profile.schedulerMaxQueueWaitMinutes || '30', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 60) : 30;
}

function slurmSubmitCommand(runDir, jobName, relativeScript, profile = {}, options = {}) {
  const safeJob = sanitizeId(jobName, 'lp_flow_job', false);
  const script = normalizeString(relativeScript);
  const args = ['sbatch', '--parsable', '--job-name', safeJob, '--chdir', posixQuote(runDir), '--output', posixQuote(`logs/${safeJob}-%j.out`)];
  const partition = normalizeString(profile.scheduler_partition || profile.schedulerPartition);
  const account = normalizeString(profile.scheduler_account || profile.schedulerAccount);
  const time = normalizeString(profile.scheduler_time || profile.schedulerTime);
  const gres = normalizeString(options.gres || options.scheduler_gres || options.schedulerGres);
  if (partition) args.push('--partition', posixQuote(partition));
  if (account) args.push('--account', posixQuote(account));
  if (time) args.push('--time', posixQuote(time));
  if (gres) args.push('--gres', posixQuote(gres));
  args.push('--wrap', posixQuote(`bash ${script}`));
  return [
    `cd ${posixQuote(runDir)}`,
    'mkdir -p logs results',
    `jobid=$(${args.join(' ')})`,
    `printf '%s\\n' "$jobid" > ${posixQuote(`logs/${safeJob}.slurm_job_id`)}`,
    `printf '{"scheduler":"slurm","job_name":%s,"job_id":"%s","script":%s,"submitted_at":%s}\\n' ${posixQuote(JSON.stringify(safeJob))} "$jobid" ${posixQuote(JSON.stringify(script))} ${posixQuote(JSON.stringify(new Date().toISOString()))} > ${posixQuote(`logs/${safeJob}.slurm_status.json`)}`,
    `echo "SLURM_JOB_ID=$jobid"`,
  ].join('; ');
}

function slurmEligibilityCommand(runDir, jobName, relativeScript, profile = {}, options = {}) {
  const safeJob = sanitizeId(jobName, 'lp_flow_job', false);
  const script = normalizeString(relativeScript);
  const args = ['sbatch', '--test-only', '--job-name', safeJob, '--chdir', posixQuote(runDir), '--output', posixQuote(`logs/${safeJob}-%j.out`)];
  const partition = normalizeString(profile.scheduler_partition || profile.schedulerPartition);
  const account = normalizeString(profile.scheduler_account || profile.schedulerAccount);
  const time = normalizeString(profile.scheduler_time || profile.schedulerTime);
  const gres = normalizeString(options.gres || options.scheduler_gres || options.schedulerGres);
  if (partition) args.push('--partition', posixQuote(partition));
  if (account) args.push('--account', posixQuote(account));
  if (time) args.push('--time', posixQuote(time));
  if (gres) args.push('--gres', posixQuote(gres));
  args.push('--wrap', posixQuote(`bash ${script}`));
  return [
    `cd ${posixQuote(runDir)}`,
    'mkdir -p logs results',
    `scheduler_test="$(${args.join(' ')} 2>&1)"`,
    'scheduler_code=$?',
    'printf "%s\\n" "$scheduler_test"',
    `scheduler_start="$(printf '%s\\n' "$scheduler_test" | sed -n 's/.*to start at \\([^[:space:]]*\\).*/\\1/p' | head -n 1)"`,
    'if test -n "$scheduler_start"; then scheduler_epoch="$(date -d "$scheduler_start" +%s 2>/dev/null || true)"; else scheduler_epoch=""; fi',
    `printf 'LP_FLOW_SCHEDULER_TEST|%s|%s|%s\\n' "$scheduler_code" "$scheduler_start" "$scheduler_epoch"`,
    'exit "$scheduler_code"',
  ].join('; ');
}

function slurmStatusCommand(runDir, jobName, expectedFile) {
  const safeJob = sanitizeId(jobName, 'lp_flow_job', false);
  const expected = normalizeString(expectedFile);
  return [
    `cd ${posixQuote(runDir)}`,
    `jobid="$(cat ${posixQuote(`logs/${safeJob}.slurm_job_id`)} 2>/dev/null || true)"`,
    `echo job_name=${posixQuote(safeJob)}`,
    'echo scheduler=slurm',
    'echo job_id="$jobid"',
    'if test -n "$jobid"; then squeue -j "$jobid" 2>/dev/null || true; fi',
    'if test -n "$jobid"; then queue_row="$(squeue -h -j "$jobid" -o "%T|%S|%R" 2>/dev/null || true)"; test -n "$queue_row" && echo "LP_FLOW_QUEUE|$queue_row"; fi',
    'if test -n "$jobid" && command -v sacct >/dev/null 2>&1; then sacct -j "$jobid" --format=JobID,State,ExitCode,Elapsed -n 2>/dev/null || true; fi',
    expected ? `if test -f ${posixQuote(expected)}; then echo expected_output=present:${posixQuote(expected)}; else echo expected_output=missing:${posixQuote(expected)}; fi` : 'true',
  ].join('; ');
}

function classifySlurmQueueOutput(output, maxWaitMinutes = 30) {
  const match = /LP_FLOW_QUEUE\|([^|\r\n]+)\|([^|\r\n]+)\|([^\r\n]+)/.exec(String(output || ''));
  if (!match) return { status: 'not_queued' };
  const state = normalizeString(match[1]).toLowerCase();
  const projectedStart = normalizeString(match[2]);
  const reason = normalizeString(match[3]);
  if (state !== 'pending') return { status: state || 'unknown', projected_start: projectedStart, reason };
  const startMs = Date.parse(projectedStart);
  const waitMinutes = Number.isFinite(startMs) ? Math.max(0, Math.round((startMs - Date.now()) / 60000)) : null;
  if (waitMinutes !== null && waitMinutes > maxWaitMinutes) {
    return {
      status: 'queued',
      projected_start: projectedStart,
      projected_wait_minutes: waitMinutes,
      reason,
      queue_advisory: `Projected wait exceeds the profile advisory of ${maxWaitMinutes} minutes.`,
      recommended_next_step: 'Keep this single Slurm job queued and poll its status; do not submit a duplicate job.',
    };
  }
  return { status: 'queued', projected_start: projectedStart, projected_wait_minutes: waitMinutes, reason };
}

function classifySlurmEligibilityOutput(output, maxWaitMinutes = 30) {
  const match = /LP_FLOW_SCHEDULER_TEST\|([^|\r\n]*)\|([^|\r\n]*)\|([^\r\n]*)/.exec(String(output || ''));
  if (!match) return { status: 'unknown', reason: 'Slurm test-only output did not include a scheduler marker.' };
  const exitCode = Number.parseInt(match[1], 10);
  const projectedStart = normalizeString(match[2]);
  const startEpoch = Number.parseInt(match[3], 10);
  if (exitCode !== 0) {
    return { status: 'unavailable', exit_code: exitCode, reason: 'Slurm rejected the test-only resource request.' };
  }
  if (!projectedStart || !Number.isFinite(startEpoch)) {
    return { status: 'eligible', reason: 'Slurm accepted the resource request without a deferred start time.' };
  }
  const waitMinutes = Math.max(0, Math.round((startEpoch * 1000 - Date.now()) / 60000));
  if (waitMinutes > maxWaitMinutes) {
    return {
      status: 'eligible',
      projected_start: projectedStart,
      projected_wait_minutes: waitMinutes,
      queue_advisory: `Projected wait exceeds the profile advisory of ${maxWaitMinutes} minutes.`,
      reason: 'Slurm accepted the request; submission will remain queued until scheduled resources are available.',
      recommended_next_step: 'Submit this one job, then poll its status. Do not create a duplicate submission.',
    };
  }
  return { status: 'eligible', projected_start: projectedStart, projected_wait_minutes: waitMinutes };
}

function heavyRemoteCommand(profile, remoteWorkRoot, runDir, jobName, relativeScript, options = {}) {
  if (profileScheduler(profile) === 'slurm') {
    return slurmSubmitCommand(runDir, jobName, relativeScript, profile, options);
  }
  return remoteResourceLockCommand(
    remoteWorkRoot,
    runDir,
    `cd ${posixQuote(runDir)} && bash ${posixQuote(`${runDir}/${relativeScript}`)}`,
  );
}

function scpUploadCommand(profile, localPath, remotePath) {
  const target = `${profileRemoteTarget(profile)}:${remotePath}`;
  const argv = [...profileScpArgv(profile), localPath, target];
  return {
    kind: 'scp_upload',
    argv,
    command_line: commandLineFromArgv(argv),
    ssh_control: sshControlSettings(profile),
  };
}

function scpDownloadCommand(profile, remotePath, localPath, recursive = false) {
  const source = `${profileRemoteTarget(profile)}:${remotePath}`;
  const argv = [...(recursive ? profileScpRecursiveArgv(profile) : profileScpArgv(profile)), source, localPath];
  return {
    kind: 'scp_download',
    argv,
    command_line: commandLineFromArgv(argv),
    ssh_control: sshControlSettings(profile),
  };
}

function sshSessionCommand(profile, action, input = {}) {
  const sessionProfile = profileWithSessionControl(profile, input);
  const base = profileSshArgv(sessionProfile);
  const target = base[base.length - 1];
  const prefix = base.slice(0, -1);
  let argv;
  if (action === 'open') {
    argv = [
      prefix[0],
      '-M',
      '-N',
      '-f',
      ...prefix.slice(1).map(item => item === 'ControlMaster=auto' ? 'ControlMaster=yes' : item),
      target,
    ];
  } else if (action === 'check' || action === 'exit' || action === 'stop') {
    argv = [
      prefix[0],
      '-O',
      action === 'stop' ? 'exit' : action,
      ...prefix.slice(1),
      target,
    ];
  } else {
    throw new Error(`Unknown SSH session action: ${action}`);
  }
  return {
    kind: `ssh_session_${action === 'stop' ? 'exit' : action}`,
    argv,
    command_line: commandLineFromArgv(argv),
    ssh_control: sshControlSettings(sessionProfile),
    note: action === 'open'
      ? 'Starts a background OpenSSH ControlMaster. Later SSH/SCP workflow commands reuse the same ControlPath instead of creating a fresh connection.'
      : 'Uses the existing OpenSSH ControlMaster control socket.',
  };
}

function parseMethods(value) {
  const raw = Array.isArray(value) ? value : value ? String(value).split(',') : DEFAULT_METHODS;
  const methods = [];
  for (const item of raw) {
    const method = String(item).trim().toLowerCase();
    if (!method) continue;
    if (!VALID_METHODS.has(method)) throw new Error(`Unknown docking/scoring method: ${method}`);
    if (!methods.includes(method)) methods.push(method);
  }
  return methods.length ? methods : [...DEFAULT_METHODS];
}

function timestampUtcCompact(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function validateRemoteChildPath(allowedRootRaw, runDirRaw) {
  const errors = [];
  if (!allowedRootRaw) errors.push('allowed_root is required');
  if (!runDirRaw) errors.push('run_dir is required');
  const checkPath = (value, label) => {
    const text = normalizeString(value);
    if (!text.startsWith('/')) errors.push(`${label} must be an absolute POSIX path`);
    const parts = text.split('/').filter(Boolean);
    if (parts.includes('.') || parts.includes('..')) errors.push(`${label} must not contain . or .. path segments`);
    return `/${parts.join('/')}`.replace(/\/+$/g, '');
  };
  const allowedRoot = checkPath(allowedRootRaw, 'allowed_root');
  const runDir = checkPath(runDirRaw, 'run_dir');
  if (!errors.length) {
    if (allowedRoot === '/') errors.push('allowed_root must not be filesystem root');
    if (runDir === allowedRoot) errors.push('run_dir must be a child of allowed_root, not allowed_root itself');
    if (!runDir.startsWith(`${allowedRoot}/`)) errors.push('run_dir must be inside allowed_root');
  }
  return { ok: errors.length === 0, allowedRoot, runDir, errors };
}


function parseJsonMaybe(text) {
  const raw = normalizeString(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function requireExplicitPath(value, label, sources) {
  const resolved = normalizeString(value);
  if (resolved) return resolved;
  throw new Error(`${label} is required. Provide ${sources.join(' or ')}; this plugin does not use hidden server or machine-specific fallback paths.`);
}

function firstExplicit(input, keys, envNames = []) {
  for (const key of keys) {
    const value = normalizeString(input?.[key]);
    if (value) return value;
  }
  for (const name of envNames) {
    const value = normalizeString(getEnv(name));
    if (value) return value;
  }
  return '';
}

function resolveDockingToolPaths(input = {}, profile = {}, methods = DEFAULT_METHODS) {
  const source = { ...(profile || {}), ...(input || {}) };
  const methodList = parseMethods(methods);
  const gnina = firstExplicit(source, ['gnina', 'gnina_path', 'gninaPath'], ['LP_FLOW_GNINA']);
  const smina = firstExplicit(source, ['smina', 'smina_path', 'sminaPath'], ['LP_FLOW_SMINA']);
  const obabel = firstExplicit(source, ['obabel', 'obabel_path', 'obabelPath'], ['LP_FLOW_OBABEL']);
  return {
    gnina: methodList.some(method => ['gnina', 'matcha'].includes(method))
      ? requireExplicitPath(gnina, 'GNINA path', ['--gnina <path>', 'config.gnina', 'profile.gnina', 'LP_FLOW_GNINA'])
      : gnina,
    smina: methodList.includes('smina')
      ? requireExplicitPath(smina, 'SMINA path', ['--smina <path>', 'config.smina', 'profile.smina', 'LP_FLOW_SMINA'])
      : smina,
    obabel: methodList.length
      ? requireExplicitPath(obabel, 'Open Babel path', ['--obabel <path>', 'config.obabel', 'profile.obabel', 'LP_FLOW_OBABEL'])
      : obabel,
  };
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths) {
  for (const item of paths.filter(Boolean)) {
    const resolved = path.resolve(item);
    if (await pathExists(resolved)) return resolved;
  }
  return null;
}

async function writeMdTrajectoryManifest(input = {}) {
  const outRaw = normalizeString(input.out || input.manifest || input.trajectory_manifest || input.trajectoryManifest);
  const displayRaw = normalizeString(input.display || input.display_pdb || input.displayPdb || input.multimodel_pdb || input.multimodelPdb);
  if (!outRaw) throw new Error('out is required; pass --out <trajectory_manifest.json>');
  if (!displayRaw) throw new Error('display is required; pass --display <md_nowater_multimodel.pdb>');
  const node = normalizeString(input.node) || (typeof process !== 'undefined' && process.execPath ? process.execPath : 'node');
  const script = path.join(PLUGIN_ROOT, 'scripts', 'gromacs-md', 'write_burrete_trajectory_manifest.mjs');
  const argv = [node, script, '--out', path.resolve(outRaw), '--display', path.resolve(displayRaw)];
  const optionMap = [
    ['topology', 'topology'],
    ['trajectory', 'trajectory'],
    ['structure', 'structure'],
    ['preview_metadata', 'preview-metadata'],
    ['previewMetadata', 'preview-metadata'],
    ['visualization_status', 'visualization-status'],
    ['visualizationStatus', 'visualization-status'],
    ['codex_browser_status', 'codex-browser-status'],
    ['codexBrowserStatus', 'codex-browser-status'],
    ['codex_observe_ready', 'codex-observe-ready'],
    ['codexObserveReady', 'codex-observe-ready'],
    ['reopen_command', 'reopen-command'],
    ['reopenCommand', 'reopen-command'],
    ['blocker_error', 'blocker-error'],
    ['blockerError', 'blocker-error'],
    ['stage_status', 'stage-status'],
    ['stageStatus', 'stage-status'],
    ['source_run', 'source-run'],
    ['sourceRun', 'source-run'],
    ['burrete_url', 'burrete-url'],
    ['burreteUrl', 'burrete-url'],
    ['url_scope', 'url-scope'],
    ['urlScope', 'url-scope'],
  ];
  const seen = new Set();
  for (const [key, flag] of optionMap) {
    if (seen.has(flag)) continue;
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    argv.push(`--${flag}`, String(value));
    seen.add(flag);
  }
  const result = await runCommand(argv, input);
  if (!result.ok) {
    return {
      ok: false,
      command: { argv },
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error || result.stderr || 'trajectory manifest writer failed',
      timed_out: result.timed_out,
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return {
    ok: true,
    manifest: path.resolve(outRaw),
    display: path.resolve(displayRaw),
    command: { argv },
    writer: parsed,
  };
}

async function writeMdSmokeTemplate(input = {}) {
  const outDirRaw = normalizeString(input.out_dir || input.outDir || input.out || input.package_dir || input.packageDir);
  if (!outDirRaw) throw new Error('out_dir is required; pass --out-dir <md_smoke_package>');
  const ligandChargeRaw = input.ligand_charge ?? input.ligandCharge;
  if (ligandChargeRaw === undefined || ligandChargeRaw === null || ligandChargeRaw === '') {
    throw new Error('ligand_charge is required for MD smoke template generation');
  }
  const ligandCharge = Number.parseInt(ligandChargeRaw, 10);
  if (!Number.isInteger(ligandCharge)) throw new Error('ligand_charge must be an integer');

  const outDir = path.resolve(outDirRaw);
  const receptor = normalizeString(input.receptor) || 'input/receptor.pdb';
  const pose = normalizeString(input.pose || input.ligand || input.top_pose || input.topPose) || 'input/top_pose.sdf';
  const ligandId = sanitizeId(normalizeString(input.ligand_id || input.ligandId) || 'LIG', 'LIG', false).toUpperCase().slice(0, 12);
  const jobId = sanitizeId(normalizeString(input.job_id || input.jobId) || 'md_smoke', 'md_smoke', false);
  const steps = Number.parseInt(input.steps || input.nvt_steps || input.nvtSteps || 5000, 10);
  if (!Number.isInteger(steps) || steps <= 0) throw new Error('steps must be a positive integer');

  await fs.mkdir(path.join(outDir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'input'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'md'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'logs'), { recursive: true });

  const scriptPath = path.join(outDir, 'scripts', 'run_md_smoke.sh');
  const manifestPath = path.join(outDir, 'md_smoke_manifest.json');
  const script = `#!/usr/bin/env bash
set -euo pipefail

RUN_DIR="\${RUN_DIR:-$(pwd)}"
GMX="\${GMX:-gmx}"
OBABEL="\${OBABEL:-obabel}"
ACPYPE="\${ACPYPE:-acpype}"
RECEPTOR="\${RECEPTOR:-${receptor}}"
POSE="\${POSE:-${pose}}"
LIGAND_CHARGE="${ligandCharge}"
LIGAND_ID="${ligandId}"
NVT_STEPS="${steps}"

mkdir -p "$RUN_DIR"/{input,prepared,topology,md,logs,results}
exec > >(tee -a "$RUN_DIR/logs/md_smoke.log") 2>&1

echo "== LP-Flow GROMACS MD smoke template =="
date
echo "RECEPTOR=$RECEPTOR"
echo "POSE=$POSE"
echo "LIGAND_CHARGE=$LIGAND_CHARGE"

test -s "$RECEPTOR"
test -s "$POSE"
command -v "$GMX" >/dev/null
command -v "$OBABEL" >/dev/null
command -v "$ACPYPE" >/dev/null

awk '/^ATOM  / {print} /^TER/ {print} END {print "END"}' "$RECEPTOR" > "$RUN_DIR/prepared/receptor_clean.pdb"
"$OBABEL" "$POSE" -O "$RUN_DIR/prepared/ligand_${ligandId}.mol2" --gen3d
"$ACPYPE" -i "$RUN_DIR/prepared/ligand_${ligandId}.mol2" -b "$LIGAND_ID" -n "$LIGAND_CHARGE" -c gas -f > "$RUN_DIR/logs/acpype.log" 2>&1

cat > "$RUN_DIR/results/md_smoke_status.json" <<JSON
{
  "status": "template_prepared",
  "note": "Topology assembly and GROMACS EM/NVT commands must be filled by the validated MD backend before claiming MD completion.",
  "display": "md/md_nowater_multimodel.pdb",
  "native_trajectory": "md/nvt.xtc",
  "native_topology": "md/nvt.tpr"
}
JSON
`;
  await fs.writeFile(scriptPath, script.replace(/\r\n/g, '\n'), { mode: 0o755 });
  const manifest = {
    schema: 'lp-flow.md-smoke-template.v1',
    job_id: jobId,
    ready_to_submit: false,
    reason: 'Template requires validated backend topology assembly before claiming MD completion.',
    receptor,
    pose,
    ligand_id: ligandId,
    ligand_charge: ligandCharge,
    script: toPosixRelative(path.relative(outDir, scriptPath)),
    expected_outputs: {
      display: 'md/md_nowater_multimodel.pdb',
      native_trajectory: 'md/nvt.xtc',
      native_topology: 'md/nvt.tpr',
      trajectory_manifest: 'md/trajectory_manifest.json',
      logs: 'logs/md_smoke.log',
    },
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    out_dir: outDir,
    script: scriptPath,
    manifest: manifestPath,
    ready_to_submit: false,
    reason: manifest.reason,
  };
}

function safeRemoteCleanupCheck(input) {
  const allowedRootRaw = normalizeString(input.allowed_root || input.allowedRoot);
  const runDirRaw = normalizeString(input.run_dir || input.runDir);
  const { ok, allowedRoot, runDir, errors } = validateRemoteChildPath(allowedRootRaw, runDirRaw);
  const cleanupScript = path.posix.join(runDir, 'safe_remote_cleanup.sh');
  return {
    ok,
    allowed_root_canonical: allowedRoot,
    run_dir_canonical: runDir,
    errors,
    command_line: !ok
      ? ''
      : `bash ${posixQuote(cleanupScript)} ${posixQuote(runDir)} ${posixQuote(allowedRoot)}`,
    note: 'Upload/copy safe_remote_cleanup.sh into the run folder and call it with positional args: run_dir allowed_root. Do not rm -rf directly.',
    cleanup_script_hint: cleanupScript,
  };
}

function packageResultsCommand(runDir) {
  const parent = path.posix.dirname(runDir);
  const base = path.posix.basename(runDir);
  return [
    `cd ${posixQuote(parent)}`,
    '&&',
    'tar',
    '--exclude', posixQuote(`${base}/boltz/cache`),
    '--exclude', posixQuote(`${base}/matcha/*/*/work/cache`),
    '--exclude', posixQuote(`${base}/matcha/*/*/work/runs/*/any_conf/*_embeddings_pt_full`),
    '-czf',
    posixQuote(`${base}.tar.gz`),
    posixQuote(base),
  ].join(' ');
}

async function buildRunPlan(input) {
  const folderInput = normalizeString(input.folder || input.task_dir || input.taskDir || input.input);
  if (!folderInput) throw new Error('folder is required');
  const profile = await resolveProfile(input);
  const validation = await validateCaseFolder({ ...input, folder: folderInput });
  const methods = parseMethods(input.methods || input.method);
  const computeDevice = normalizeString(input.compute_device || input.computeDevice || 'gpu').toLowerCase();
  if (!['cpu', 'gpu'].includes(computeDevice)) throw new Error('compute_device must be cpu or gpu');
  const toolPaths = resolveDockingToolPaths(input, profile, methods);
  const mode = normalizeString(input.mode) || 'full-docking';
  const timestamp = sanitizeRunToken(input.timestamp || timestampUtcCompact(), 'run');
  const runId = sanitizeRunToken(`${validation.case_working_id}_${timestamp}`, 'run');
  const remoteWorkRoot = normalizeString(profile.remote_work_root).replace(/\/+$/g, '');
  const runDir = `${remoteWorkRoot}/${runId}`;
  const remotePathCheck = validateRemoteChildPath(remoteWorkRoot, runDir);
  const localResultsDir = path.join(validation.task_dir, 'results');
  const localPackage = path.join(validation.task_dir, `${runId}.tar.gz`);
  const activeSite = normalizeActiveSiteInput(input);
  const needs = [];

  if (!validation.ok) needs.push('fix_input_validation_errors');
  if (!profile.ssh_alias && !profile.ssh_command && !profile.host) needs.push('ssh_target_in_profile');
  if (!profile.username) needs.push('username_in_profile');
  if (!profile.remote_work_root) needs.push('remote_work_root_in_profile');
  if (!activeSite) needs.push('active_site_definition');
  if (methods.includes('boltz') && !profile.boltz_env) needs.push('boltz_env_in_profile');
  if (methods.includes('boltz') && !profile.boltz_checkout) needs.push('boltz_checkout_in_profile');
  if (methods.includes('boltz') && !profile.boltz_weights_readonly) needs.push('boltz_weights_readonly_in_profile');
  if (methods.includes('matcha') && !profile.matcha_checkout) needs.push('matcha_checkout_in_profile');
  if (methods.includes('matcha') && !profile.matcha_python) needs.push('matcha_python_in_profile');
  if (methods.includes('matcha') && !profile.matcha_checkpoints) needs.push('matcha_checkpoints_in_profile');
  if (!remotePathCheck.ok) needs.push('safe_remote_run_dir');

  const uploadFiles = [];
  if (validation.receptor) {
    uploadFiles.push({
      role: 'receptor',
      local_path: validation.receptor.input_path,
      remote_path: `${runDir}/input/${path.posix.basename(validation.receptor.relative_path)}`,
      working_id: validation.receptor.working_id,
    });
  }
  for (const ligand of validation.ligands) {
    uploadFiles.push({
      role: 'ligand',
      local_path: ligand.input_path,
      remote_path: `${runDir}/input/ligands/${path.posix.basename(ligand.relative_path)}`,
      working_id: ligand.working_id,
      original_id: ligand.original_id,
    });
  }

  const dockingGpuGres = computeDevice === 'gpu' && methods.some(method => ['gnina', 'boltz', 'matcha'].includes(method))
    ? normalizeString(profile.scheduler_gpu_gres || profile.schedulerGpuGres)
    : '';
  const remoteCommands = {
    preflight: [
      'hostname',
      'whoami',
      'date',
      'pwd',
      'command -v nvidia-smi || true',
      'nvidia-smi || true',
      'nvidia-smi pmon -c 1 || true',
    ],
    create_run_dir: `mkdir -p ${posixQuote(`${runDir}/input/ligands`)} ${posixQuote(`${runDir}/logs`)} ${posixQuote(`${runDir}/results`)} ${posixQuote(`${runDir}/scripts`)}`,
    run_docking_payload: heavyRemoteCommand(profile, remoteWorkRoot, runDir, 'lp_flow_payload', 'remote_docking_payload.sh', { gres: dockingGpuGres }),
    docking_payload_status: profileScheduler(profile) === 'slurm'
      ? slurmStatusCommand(runDir, 'lp_flow_payload', 'results/summary_wide.csv')
      : `cd ${posixQuote(runDir)}; if test -f results/summary_wide.csv; then echo expected_output=present:results/summary_wide.csv; else echo expected_output=missing:results/summary_wide.csv; fi; tail -n 80 logs/remote_docking_payload.log 2>/dev/null || true`,
    package_results: packageResultsCommand(runDir),
    cleanup_after_download: safeRemoteCleanupCheck({ allowed_root: remoteWorkRoot, run_dir: runDir }).command_line,
  };

  return {
    ok: validation.ok && remotePathCheck.ok && needs.length === 0,
    mode,
    methods,
    compute_device: computeDevice,
    case: {
      original: validation.case_original,
      working_id: validation.case_working_id,
      run_id: runId,
    },
    profile: {
      profile_name: profile.profile_name,
      profile_ref: profile.profile_ref || profile.profile_name,
      username: profile.username,
      remote_work_root: remoteWorkRoot,
      shared_software_policy: profile.shared_software_policy,
      scheduler: profileScheduler(profile) || 'ssh-inline',
      scheduler_partition: profile.scheduler_partition || profile.schedulerPartition,
      scheduler_account: profile.scheduler_account || profile.schedulerAccount,
      scheduler_time: profile.scheduler_time || profile.schedulerTime,
      scheduler_gpu_gres: profile.scheduler_gpu_gres || profile.schedulerGpuGres,
      scheduler_max_queue_wait_minutes: profileQueueWaitMinutes(profile),
      micromamba: profile.micromamba,
      boltz_env: profile.boltz_env,
      boltz_checkout: profile.boltz_checkout,
      boltz_weights_readonly: profile.boltz_weights_readonly,
      boltz_writable_cache: profile.boltz_writable_cache,
      matcha_checkout: profile.matcha_checkout,
      matcha_python: profile.matcha_python,
      matcha_checkpoints: profile.matcha_checkpoints,
      gromacs: profile.gromacs,
      ld_library_path: profile.ld_library_path,
      acpype: profile.acpype,
      mdtools_env: profile.mdtools_env,
    },
    tools: {
      gnina: toolPaths.gnina,
      smina: toolPaths.smina,
      obabel: toolPaths.obabel,
    },
    local: {
      task_dir: validation.task_dir,
      results_dir: localResultsDir,
      package_path: localPackage,
    },
    remote: {
      run_dir: runDir,
      input_dir: `${runDir}/input`,
      logs_dir: `${runDir}/logs`,
      results_dir: `${runDir}/results`,
      package_path: `${path.posix.dirname(runDir)}/${path.posix.basename(runDir)}.tar.gz`,
      path_check: remotePathCheck,
    },
    active_site: activeSite || { status: 'missing', required: true },
    inputs: {
      receptor: validation.receptor,
      ligands: validation.ligands,
      ignored_generated_count: validation.ignored_generated.length,
      warnings: validation.warnings,
      errors: validation.errors,
    },
    upload_files: uploadFiles,
    download_files: [
      { role: 'remote_archive', remote_path: `${path.posix.dirname(runDir)}/${path.posix.basename(runDir)}.tar.gz`, local_path: localPackage },
      { role: 'results_folder', remote_path: `${runDir}/results`, local_path: localResultsDir },
    ],
    remote_commands: remoteCommands,
    needs,
    warnings: [
      ...validation.warnings,
      ...(activeSite ? [] : ['Active site is missing; do not run blind docking.']),
      ...(methods.includes('boltz') && profile.boltz_weights_readonly ? ['Boltz weights/cache path is shared; keep it read-only unless profile provides writable cache.'] : []),
    ],
  };
}

function buildSummaryCommand(input) {
  const runDir = normalizeString(input.run_dir || input.runDir);
  if (!runDir) throw new Error('run_dir is required');
  const python = normalizeString(input.python) || 'python';
  const script = path.join(SERVER_DOCKING_SCRIPTS, 'build_summary_wide.py');
  const args = [script, '--run-dir', runDir];
  for (const method of parseMethods(input.methods || input.method)) args.push('--method', method);
  const out = normalizeString(input.out);
  if (out) args.push('--out', out);
  const argv = [python, ...args];
  return {
    ok: true,
    cwd: PLUGIN_ROOT,
    argv,
    command_line: argv.map(shellQuote).join(' '),
  };
}

function bashArray(name, values) {
  return `${name}=(${values.map(value => posixQuote(value)).join(' ')})`;
}

function numericTriple(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (raw.length !== 3) return null;
  const parsed = raw.map(item => Number.parseFloat(item));
  if (parsed.some(item => !Number.isFinite(item))) return null;
  return parsed;
}

function parseJsonObject(value, label) {
  const text = normalizeString(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label} JSON must decode to an object`);
}

function normalizeActiveSiteInput(input) {
  const direct = input.active_site || input.activeSite;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  if (typeof direct === 'string' && direct.trim()) return parseJsonObject(direct, 'active_site');
  const json = input.active_site_json || input.activeSiteJson;
  if (json) return parseJsonObject(json, 'active_site_json');

  const center = numericTriple(input.center || input.box_center || input.boxCenter);
  const size = numericTriple(input.size || input.box_size || input.boxSize);
  if (center || size) {
    const site = {};
    if (center) site.center = center;
    if (size) site.size = size;
    return site;
  }

  const referenceLigand = normalizeString(
    input.reference_ligand_remote_path ||
    input.referenceLigandRemotePath ||
    input.autobox_ligand_remote_path ||
    input.autoboxLigandRemotePath ||
    input.reference_ligand ||
    input.referenceLigand ||
    input.autobox_ligand ||
    input.autoboxLigand
  );
  if (referenceLigand) {
    return {
      reference_ligand_remote_path: referenceLigand,
      autobox_add: input.autobox_add || input.autoboxAdd,
    };
  }
  return null;
}

function activeSiteBox(activeSite) {
  const site = activeSite && typeof activeSite === 'object' ? activeSite : {};
  const center = numericTriple(site.center || site.box_center || site.boxCenter || site.center_xyz || site.centerXyz);
  const size = numericTriple(site.size || site.box_size || site.boxSize || site.size_xyz || site.sizeXyz);
  const referenceLigand = normalizeString(
    site.reference_ligand_remote_path ||
    site.referenceLigandRemotePath ||
    site.autobox_ligand_remote_path ||
    site.autoboxLigandRemotePath ||
    site.reference_ligand ||
    site.referenceLigand ||
    site.autobox_ligand ||
    site.autoboxLigand
  );
  const autoboxAdd = Number.parseFloat(site.autobox_add || site.autoboxAdd || 4);
  if (center && size) {
    const gnina = [
      '--center_x', String(center[0]),
      '--center_y', String(center[1]),
      '--center_z', String(center[2]),
      '--size_x', String(size[0]),
      '--size_y', String(size[1]),
      '--size_z', String(size[2]),
    ];
    const matcha = [
      '--center-x', String(center[0]),
      '--center-y', String(center[1]),
      '--center-z', String(center[2]),
    ];
    const matchaSize = [
      '--size-x', String(size[0]),
      '--size-y', String(size[1]),
      '--size-z', String(size[2]),
    ];
    return { ok: true, mode: 'manual_box', gnina, smina: gnina, matcha, matcha_size: matchaSize, errors: [] };
  }
  if (referenceLigand) {
    const args = ['--autobox_ligand', referenceLigand, '--autobox_add', String(Number.isFinite(autoboxAdd) ? autoboxAdd : 4)];
    return { ok: true, mode: 'reference_ligand', gnina: args, smina: args, matcha: ['--autobox-ligand', referenceLigand], matcha_size: [], errors: [] };
  }
  return {
    ok: false,
    mode: 'missing',
    gnina: [],
    smina: [],
    matcha: [],
    matcha_size: [],
    errors: ['active_site must provide either numeric center+size triples or a reference_ligand_remote_path/autobox_ligand path'],
  };
}

function uploadByRole(plan, role, workingId = '') {
  const files = Array.isArray(plan.upload_files) ? plan.upload_files : [];
  return files.find(item => item.role === role && (!workingId || item.working_id === workingId)) || null;
}

function buildRemoteDockingPayloadFromPlan(plan, input = {}) {
  const errors = [];
  const runDir = plan?.remote?.run_dir;
  if (!runDir) errors.push('run_plan.remote.run_dir is required');
  const receptorUpload = uploadByRole(plan, 'receptor');
  if (!receptorUpload?.remote_path) errors.push('run_plan.upload_files is missing receptor remote_path');
  const ligands = Array.isArray(plan?.inputs?.ligands) ? plan.inputs.ligands : [];
  if (!ligands.length) errors.push('run_plan.inputs.ligands is empty');
  const methods = parseMethods(input.methods || plan.methods);
  const box = activeSiteBox(plan.active_site);
  errors.push(...box.errors);

  const ligandRows = ligands.map(ligand => {
    const upload = uploadByRole(plan, 'ligand', ligand.working_id);
    if (!upload?.remote_path) errors.push(`missing remote_path for ligand ${ligand.working_id}`);
    return {
      id: ligand.working_id,
      input_name: path.basename(ligand.input_path || ligand.relative_path || upload?.local_path || ligand.original_id || ligand.working_id),
      remote_path: upload?.remote_path || '',
      original_id: ligand.original_id || ligand.working_id,
    };
  });

  const profile = plan.profile || {};
  const computeDevice = normalizeString(input.compute_device || input.computeDevice || plan.compute_device || 'gpu').toLowerCase();
  const tools = plan.tools || {};
  const gpuId = normalizeString(input.gpu_id || input.gpuId || '0');
  const exhaustiveness = Number.parseInt(input.exhaustiveness || 8, 10);
  const numModes = Number.parseInt(input.num_modes || input.numModes || 10, 10);
  const toolPaths = resolveDockingToolPaths({ ...tools, ...input }, profile, methods);
  const gninaPath = toolPaths.gnina;
  const sminaPath = toolPaths.smina;
  const obabelPath = toolPaths.obabel;
  const micromamba = normalizeString(input.micromamba) || profile.micromamba || '';
  const boltzEnv = normalizeString(input.boltz_env || input.boltzEnv) || profile.boltz_env || '';
  const boltzWeights = normalizeString(input.boltz_weights_readonly || input.boltzWeightsReadonly) || profile.boltz_weights_readonly || '';
  const boltzWritableCache = normalizeString(input.boltz_writable_cache || input.boltzWritableCache) || profile.boltz_writable_cache || '';
  const boltzCheckout = normalizeString(input.boltz_checkout || input.boltzCheckout || input.abcfold_checkout || input.abcfoldCheckout) || profile.boltz_checkout || profile.abcfold_checkout || '';
  const matchaCheckout = normalizeString(input.matcha_checkout || input.matchaCheckout) || profile.matcha_checkout || '';
  const matchaPython = normalizeString(input.matcha_python || input.matchaPython) || profile.matcha_python || '';
  const matchaCheckpoints = normalizeString(input.matcha_checkpoints || input.matchaCheckpoints) || profile.matcha_checkpoints || '';
  const matchaSamples = Number.parseInt(input.matcha_samples || input.matchaSamples || 10, 10);
  if (methods.includes('boltz') && !micromamba) errors.push('Boltz requested but micromamba is missing from profile/input');
  if (methods.includes('boltz') && !boltzEnv) errors.push('Boltz requested but boltz_env is missing from profile/input');
  if (methods.includes('boltz') && !boltzCheckout) errors.push('Boltz requested but boltz_checkout is missing from profile/input');
  if (methods.includes('matcha') && !matchaCheckout) errors.push('Matcha requested but matcha_checkout is missing from profile/input');
  if (methods.includes('matcha') && !matchaPython) errors.push('Matcha requested but matcha_python is missing from profile/input');
  if (methods.includes('matcha') && !matchaCheckpoints) errors.push('Matcha requested but matcha_checkpoints is missing from profile/input');
  if (!/^[0-9]+$/.test(gpuId)) errors.push('gpu_id must be a single numeric GPU index');
  if (!['cpu', 'gpu'].includes(computeDevice)) errors.push('compute_device must be cpu or gpu');

  const methodFlags = {
    gnina: methods.includes('gnina') ? '1' : '0',
    smina: methods.includes('smina') ? '1' : '0',
    boltz: methods.includes('boltz') ? '1' : '0',
    matcha: methods.includes('matcha') ? '1' : '0',
  };
  const summaryLigands = ligandRows.map(ligand => `${ligand.input_name}:${ligand.id}`);
  const scriptPath = `${runDir || '<remote_run_dir>'}/remote_docking_payload.sh`;
  const commandLine = runDir ? `bash ${posixQuote(scriptPath)}` : '';
  const summaryMethods = methods;

  const script = `#!/usr/bin/env bash
set -uo pipefail

RUN_DIR=${posixQuote(runDir || '')}
GPU_ID="\${GPU_ID:-\${1:-${gpuId}}}"
COMPUTE_DEVICE=${posixQuote(computeDevice)}
GN=${posixQuote(gninaPath)}
SM=${posixQuote(sminaPath)}
OB=${posixQuote(obabelPath)}
MM=${posixQuote(micromamba)}
BOLTZ_ENV=${posixQuote(boltzEnv)}
BOLTZ_WEIGHTS_READONLY=${posixQuote(boltzWeights)}
BOLTZ_WRITABLE_CACHE=${posixQuote(boltzWritableCache)}
BOLTZ_CHECKOUT=${posixQuote(boltzCheckout)}
MATCHA_CHECKOUT=${posixQuote(matchaCheckout)}
MATCHA_PY=${posixQuote(matchaPython)}
MATCHA_CHECKPOINTS=${posixQuote(matchaCheckpoints)}
MATCHA_SAMPLES=${Number.isFinite(matchaSamples) && matchaSamples > 0 ? matchaSamples : 10}
RECEPTOR_INPUT=${posixQuote(receptorUpload?.remote_path || '')}
RECEPTOR_INPUT_NAME=${posixQuote(receptorUpload ? path.basename(receptorUpload.local_path || receptorUpload.remote_path) : '')}
EXHAUSTIVENESS=${Number.isFinite(exhaustiveness) && exhaustiveness > 0 ? exhaustiveness : 8}
NUM_MODES=${Number.isFinite(numModes) && numModes > 0 ? numModes : 10}
RUN_GNINA=${methodFlags.gnina}
RUN_SMINA=${methodFlags.smina}
RUN_BOLTZ=${methodFlags.boltz}
RUN_MATCHA=${methodFlags.matcha}
BOX_MODE=${posixQuote(box.mode)}
BOX_OK=${box.ok ? 1 : 0}
BOX_ERROR=${posixQuote(box.errors.join('; '))}

${bashArray('LIGAND_IDS', ligandRows.map(ligand => ligand.id))}
${bashArray('LIGAND_INPUTS', ligandRows.map(ligand => ligand.remote_path))}
${bashArray('LIGAND_SUMMARY', summaryLigands)}
${bashArray('GNINA_BOX_ARGS', box.gnina)}
${bashArray('SMINA_BOX_ARGS', box.smina)}
${bashArray('MATCHA_BOX_ARGS', box.matcha)}
${bashArray('MATCHA_BOX_SIZE_ARGS', box.matcha_size || [])}
${bashArray('SUMMARY_METHODS', summaryMethods)}

mkdir -p "$RUN_DIR"/{logs,results,prepared,gnina,smina,boltz/out,matcha}
LOG_MAIN="$RUN_DIR/logs/remote_docking_payload.log"
exec > >(tee -a "$LOG_MAIN") 2>&1
cd "$RUN_DIR"

echo "== LP-Flow remote docking payload =="
date
echo "RUN_DIR=$RUN_DIR"
echo "GPU_ID=$GPU_ID"
echo "COMPUTE_DEVICE=$COMPUTE_DEVICE"

GNINA_DEVICE_ARGS=(--device "$GPU_ID")
if [[ "$COMPUTE_DEVICE" == "cpu" ]]; then
  GNINA_DEVICE_ARGS=(--cpu)
fi
echo "BOX_MODE=$BOX_MODE"

if [[ "$BOX_OK" != "1" ]]; then
  echo "ERROR: $BOX_ERROR"
  exit 64
fi

STATUS_OVERRIDES=()
MATCHA_RESULTS=()
PYTHON_BIN="\${PYTHON_BIN:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN=python
fi

printf 'component,status,command,version,backend,error,log_file\\n' > "$RUN_DIR/results/runtime_status.csv"
runtime_row() {
  local component="$1" command="$2" backend="$3"
  local status="ok" version="" error=""
  if [[ -z "$command" ]]; then
    status="unavailable"
    error="command missing from active profile"
  elif [[ "$command" = */* && ! -x "$command" ]]; then
    status="unavailable"
    error="configured command is not executable"
  elif [[ "$command" != */* ]] && ! command -v "$command" >/dev/null 2>&1; then
    status="unavailable"
    error="command not found in resolved runtime"
  else
    version="$("$command" --version 2>&1 | head -n 1 | tr ',\\r\\n' '   ' || true)"
  fi
  printf '%s,%s,%s,%s,%s,%s,%s\\n' "$component" "$status" "$command" "$version" "$backend" "$error" "logs/preflight.log" >> "$RUN_DIR/results/runtime_status.csv"
}
runtime_row obabel "$OB" cpu
[[ "$RUN_GNINA" == "1" ]] && runtime_row gnina "$GN" "$COMPUTE_DEVICE"
[[ "$RUN_SMINA" == "1" ]] && runtime_row smina "$SM" cpu
[[ "$RUN_BOLTZ" == "1" ]] && runtime_row boltz_micromamba "$MM" "$COMPUTE_DEVICE"
[[ "$RUN_MATCHA" == "1" ]] && runtime_row matcha_python "$MATCHA_PY" "$COMPUTE_DEVICE"

fail_status() {
  local ligand="$1"
  local method="$2"
  local reason="$3"
  STATUS_OVERRIDES+=("\${ligand}:\${method}=failed:\${reason}")
}

unavailable_status() {
  local ligand="$1"
  local method="$2"
  local reason="$3"
  STATUS_OVERRIDES+=("\${ligand}:\${method}=unavailable:\${reason}")
}

run_cmd() {
  local label="$1"
  local log="$2"
  shift 2
  echo "== $label ==" > "$log"
  echo "$*" >> "$log"
  "$@" >> "$log" 2>&1
  local status=$?
  if [[ "$status" -eq 0 ]]; then
    echo "OK: $label"
    return 0
  fi
  echo "FAILED($status): $label; see $log"
  return "$status"
}

prepare_receptor() {
  if [[ ! -f "$RECEPTOR_INPUT" ]]; then
    echo "Missing receptor input: $RECEPTOR_INPUT"
    return 1
  fi
  case "\${RECEPTOR_INPUT,,}" in
    *.pdb)
      cp "$RECEPTOR_INPUT" "$RUN_DIR/prepared/receptor.pdb"
      ;;
    *.cif)
      "$OB" -icif "$RECEPTOR_INPUT" -opdb -O "$RUN_DIR/prepared/receptor.pdb" > "$RUN_DIR/logs/receptor_obabel.log" 2>&1
      ;;
    *)
      echo "Unsupported receptor format: $RECEPTOR_INPUT"
      return 1
      ;;
  esac
  "$OB" -ipdb "$RUN_DIR/prepared/receptor.pdb" -opdbqt -O "$RUN_DIR/prepared/receptor.pdbqt" -xr > "$RUN_DIR/logs/receptor_pdbqt.log" 2>&1
}

prepare_ligand() {
  local input="$1"
  local sdf="$2"
  local pdbqt="$3"
  if [[ ! -f "$input" ]]; then
    echo "Missing ligand input: $input"
    return 1
  fi
  case "\${input,,}" in
    *.sdf)
      cp "$input" "$sdf"
      ;;
    *.smi|*.smiles)
      "$OB" -ismi "$input" -osdf -O "$sdf" --gen3d
      ;;
    *.mol2)
      "$OB" -imol2 "$input" -osdf -O "$sdf"
      ;;
    *.pdb)
      "$OB" -ipdb "$input" -osdf -O "$sdf"
      ;;
    *)
      echo "Unsupported ligand format: $input"
      return 1
      ;;
  esac
  "$OB" -isdf "$sdf" -opdbqt -O "$pdbqt"
}

if ! prepare_receptor; then
  echo "ERROR: receptor preparation failed"
  exit 65
fi

prepare_boltz_cache() {
  if [[ -n "$BOLTZ_WRITABLE_CACHE" ]]; then
    export BOLTZ_CACHE="$BOLTZ_WRITABLE_CACHE"
  else
    export BOLTZ_CACHE="$RUN_DIR/boltz/cache"
  fi
  mkdir -p "$BOLTZ_CACHE" || return 1
  if [[ -n "$BOLTZ_WEIGHTS_READONLY" && -d "$BOLTZ_WEIGHTS_READONLY" ]]; then
    for source in "$BOLTZ_WEIGHTS_READONLY"/*; do
      [[ -e "$source" ]] || continue
      target="$BOLTZ_CACHE/$(basename "$source")"
      [[ -e "$target" ]] || ln -s "$source" "$target" || return 1
    done
  fi
}

  if [[ "$RUN_BOLTZ" == "1" ]]; then
    if [[ ! -x "$MM" || -z "$BOLTZ_ENV" ]]; then
      echo "Boltz runtime preflight failed; Boltz will be marked failed."
      RUN_BOLTZ=0
      for ligand_id in "\${LIGAND_IDS[@]}"; do
      unavailable_status "$ligand_id" boltz "Boltz runtime preflight failed"
    done
  else
    if ! prepare_boltz_cache; then
      echo "Boltz writable cache preflight failed; Boltz will be marked failed."
      RUN_BOLTZ=0
      for ligand_id in "\${LIGAND_IDS[@]}"; do
        unavailable_status "$ligand_id" boltz "Boltz writable cache preflight failed"
      done
    fi
    if [[ "$RUN_BOLTZ" == "1" && "$BOLTZ_ENV" = /* ]]; then
      BOLTZ_RUN=("$MM" run -p "$BOLTZ_ENV")
    elif [[ "$RUN_BOLTZ" == "1" ]]; then
      BOLTZ_RUN=("$MM" run -n "$BOLTZ_ENV")
    fi
  fi
fi

write_boltz_yaml() {
  local receptor_pdb="$1"
  local ligand_sdf="$2"
  local out_yaml="$3"
  local smiles
  smiles="$("$OB" -isdf "$ligand_sdf" -osmi 2>/dev/null | awk 'NR==1 {print $1}')"
  if [[ -z "$smiles" ]]; then
    echo "Boltz YAML failed: ligand SMILES extraction failed"
    return 1
  fi
  "$PYTHON_BIN" - "$receptor_pdb" "$smiles" "$out_yaml" <<'PY'
import json
import sys
from collections import OrderedDict

receptor_pdb, smiles, out_yaml = sys.argv[1:4]
aa = {
    'ALA':'A','ARG':'R','ASN':'N','ASP':'D','CYS':'C','GLN':'Q','GLU':'E','GLY':'G',
    'HIS':'H','ILE':'I','LEU':'L','LYS':'K','MET':'M','PHE':'F','PRO':'P','SER':'S',
    'THR':'T','TRP':'W','TYR':'Y','VAL':'V','SEC':'U','PYL':'O',
}
chains = OrderedDict()
seen = set()
with open(receptor_pdb, encoding='utf-8', errors='replace') as handle:
    for line in handle:
        if not line.startswith('ATOM'):
            continue
        name = line[12:16].strip()
        resn = line[17:20].strip()
        chain = (line[21].strip() or 'A')
        resid = (chain, line[22:26].strip(), line[26].strip())
        if name != 'CA' or resid in seen or resn not in aa:
            continue
        seen.add(resid)
        chains.setdefault(chain, []).append(aa[resn])
if not chains:
    raise SystemExit('no protein sequence extracted from receptor PDB')
used = set()
with open(out_yaml, 'w', encoding='utf-8') as out:
    out.write('version: 1\\nsequences:\\n')
    for chain, letters in chains.items():
        chain_id = ''.join(ch for ch in chain if ch.isalnum())[:1].upper() or 'A'
        base = chain_id
        idx = 1
        while chain_id in used or chain_id == 'L':
            chain_id = chr(ord('A') + (idx % 26))
            idx += 1
        used.add(chain_id)
        out.write('  - protein:\\n')
        out.write(f'      id: {chain_id}\\n')
        out.write(f'      sequence: {"".join(letters)}\\n')
        out.write('      msa: empty\\n')
    out.write('  - ligand:\\n')
    out.write('      id: L\\n')
    out.write(f'      smiles: {json.dumps(smiles)}\\n')
    out.write('properties:\\n')
    out.write('  - affinity:\\n')
    out.write('      binder: L\\n')
PY
}

if [[ "$RUN_MATCHA" == "1" ]]; then
  if [[ ! -x "$MATCHA_PY" || ! -d "$MATCHA_CHECKOUT" || ! -d "$MATCHA_CHECKPOINTS" || ! -x "$GN" ]]; then
    echo "Matcha runtime preflight failed; Matcha will be marked failed."
    RUN_MATCHA=0
    for ligand_id in "\${LIGAND_IDS[@]}"; do
      unavailable_status "$ligand_id" matcha "Matcha runtime preflight failed"
    done
  fi
fi

for idx in "\${!LIGAND_IDS[@]}"; do
  ligand_id="\${LIGAND_IDS[$idx]}"
  ligand_input="\${LIGAND_INPUTS[$idx]}"
  ligand_sdf="$RUN_DIR/prepared/\${ligand_id}.sdf"
  ligand_pdbqt="$RUN_DIR/prepared/\${ligand_id}.pdbqt"
  echo "== Ligand $ligand_id =="

  if ! prepare_ligand "$ligand_input" "$ligand_sdf" "$ligand_pdbqt" > "$RUN_DIR/logs/\${ligand_id}_prep.log" 2>&1; then
    echo "Ligand prep failed for $ligand_id"
    [[ "$RUN_GNINA" == "1" ]] && fail_status "$ligand_id" gnina "ligand prep failed"
    [[ "$RUN_SMINA" == "1" ]] && fail_status "$ligand_id" smina "ligand prep failed"
    [[ "$RUN_BOLTZ" == "1" ]] && fail_status "$ligand_id" boltz "ligand prep failed"
    [[ "$RUN_MATCHA" == "1" ]] && fail_status "$ligand_id" matcha "ligand prep failed"
    continue
  fi

  if [[ "$RUN_GNINA" == "1" ]]; then
    run_cmd "$ligand_id gnina score_only" "$RUN_DIR/logs/\${ligand_id}_gnina_score_only.log" \\
      env CUDA_VISIBLE_DEVICES="$GPU_ID" "$GN" \\
      --receptor "$RUN_DIR/prepared/receptor.pdb" \\
      --ligand "$ligand_sdf" \\
      "\${GNINA_DEVICE_ARGS[@]}" \\
      --cnn_scoring rescore \\
      --score_only \\
      -o "$RUN_DIR/gnina/\${ligand_id}_gnina_score_only.sdf" || fail_status "$ligand_id" gnina "gnina score_only failed"

    run_cmd "$ligand_id gnina minimize" "$RUN_DIR/logs/\${ligand_id}_gnina.log" \\
      env CUDA_VISIBLE_DEVICES="$GPU_ID" "$GN" \\
      --receptor "$RUN_DIR/prepared/receptor.pdb" \\
      --ligand "$ligand_sdf" \\
      "\${GNINA_DEVICE_ARGS[@]}" \\
      --cnn_scoring rescore \\
      --minimize \\
      -o "$RUN_DIR/gnina/\${ligand_id}_gnina_minimized.sdf" || fail_status "$ligand_id" gnina "gnina minimize failed"

    run_cmd "$ligand_id gnina dock" "$RUN_DIR/logs/\${ligand_id}_gnina_docking.log" \\
      env CUDA_VISIBLE_DEVICES="$GPU_ID" "$GN" \\
      --receptor "$RUN_DIR/prepared/receptor.pdb" \\
      --ligand "$ligand_sdf" \\
      "\${GNINA_BOX_ARGS[@]}" \\
      --exhaustiveness "$EXHAUSTIVENESS" \\
      --num_modes "$NUM_MODES" \\
      "\${GNINA_DEVICE_ARGS[@]}" \\
      -o "$RUN_DIR/gnina/\${ligand_id}_gnina.sdf" || fail_status "$ligand_id" gnina "gnina docking failed"
  fi

  if [[ "$RUN_SMINA" == "1" ]]; then
    run_cmd "$ligand_id smina score_only" "$RUN_DIR/logs/\${ligand_id}_smina_score_only.log" \\
      "$SM" --receptor "$RUN_DIR/prepared/receptor.pdbqt" --ligand "$ligand_pdbqt" \\
      --score_only -o "$RUN_DIR/smina/\${ligand_id}_smina_score_only.pdbqt" || fail_status "$ligand_id" smina "smina score_only failed"

    run_cmd "$ligand_id smina minimize" "$RUN_DIR/logs/\${ligand_id}_smina.log" \\
      "$SM" --receptor "$RUN_DIR/prepared/receptor.pdbqt" --ligand "$ligand_pdbqt" \\
      --minimize -o "$RUN_DIR/smina/\${ligand_id}_smina_minimized.pdbqt" || fail_status "$ligand_id" smina "smina minimize failed"

    run_cmd "$ligand_id smina dock" "$RUN_DIR/logs/\${ligand_id}_smina_docking.log" \\
      "$SM" -r "$RUN_DIR/prepared/receptor.pdbqt" -l "$ligand_pdbqt" \\
      "\${SMINA_BOX_ARGS[@]}" \\
      --exhaustiveness "$EXHAUSTIVENESS" --num_modes "$NUM_MODES" \\
      -o "$RUN_DIR/smina/\${ligand_id}_smina.pdbqt" || fail_status "$ligand_id" smina "smina docking failed"
  fi

  if [[ "$RUN_BOLTZ" == "1" ]]; then
    boltz_out="$RUN_DIR/boltz/out/\${ligand_id}"
    mkdir -p "$boltz_out"
    boltz_yaml="$RUN_DIR/boltz/\${ligand_id}.yaml"
    if write_boltz_yaml "$RUN_DIR/prepared/receptor.pdb" "$ligand_sdf" "$boltz_yaml" > "$RUN_DIR/logs/\${ligand_id}_boltz_yaml.log" 2>&1; then
      run_cmd "$ligand_id boltz predict" "$boltz_out/\${ligand_id}_boltz_predict.log" \\
        env CUDA_VISIBLE_DEVICES="$GPU_ID" BOLTZ_CACHE="$BOLTZ_CACHE" "\${BOLTZ_RUN[@]}" \\
        boltz predict "$boltz_yaml" \\
        --out_dir "$boltz_out" \\
        --cache "$BOLTZ_CACHE" \\
        --model boltz2 \\
        --accelerator "$COMPUTE_DEVICE" \\
        --devices 1 \\
        --recycling_steps 1 \\
        --diffusion_samples 1 \\
        --sampling_steps 20 \\
        --diffusion_samples_affinity 1 \\
        --sampling_steps_affinity 20 \\
        --max_parallel_samples 1 \\
        --no_kernels \\
        --override || fail_status "$ligand_id" boltz "boltz predict failed"
    else
      fail_status "$ligand_id" boltz "boltz YAML generation failed"
    fi
  fi

  if [[ "$RUN_MATCHA" == "1" ]]; then
    matcha_out="$RUN_DIR/matcha/\${ligand_id}"
    matcha_run_name="\${ligand_id}_matcha"
    mkdir -p "$matcha_out"
    matcha_box_args=("\${MATCHA_BOX_ARGS[@]}")
    if "$MATCHA_PY" -m matcha.cli --help 2>&1 | grep -q -- '--size-x'; then
      matcha_box_args+=("\${MATCHA_BOX_SIZE_ARGS[@]}")
    else
      echo "INFO: Matcha CLI has no --size-x option; using center/autobox args only." >> "$RUN_DIR/logs/\${ligand_id}_matcha.log"
    fi
    if run_cmd "$ligand_id matcha" "$RUN_DIR/logs/\${ligand_id}_matcha.log" \\
      env CUDA_VISIBLE_DEVICES="$GPU_ID" PYTHONPATH="$MATCHA_CHECKOUT\${PYTHONPATH:+:$PYTHONPATH}" "$MATCHA_PY" -m matcha.cli \\
      --receptor "$RUN_DIR/prepared/receptor.pdb" \\
      --ligand "$ligand_sdf" \\
      --out "$matcha_out" \\
      --run-name "$matcha_run_name" \\
      --n-samples "$MATCHA_SAMPLES" \\
      --device "$([[ "$COMPUTE_DEVICE" == gpu ]] && echo "cuda:$GPU_ID" || echo cpu)" \\
      --checkpoints "$MATCHA_CHECKPOINTS" \\
      "\${matcha_box_args[@]}" \\
      --scorer gnina \\
      --scorer-path "$GN" \\
      --scorer-minimize \\
      --overwrite \\
      --keep-workdir \\
      --num-dataloader-workers 0; then
      matcha_best=""
      matcha_poses=""
      matcha_timing=""
      matcha_best_candidates=(
        "$matcha_out/\${matcha_run_name}_best.sdf"
        "$matcha_out/\${matcha_run_name}/\${matcha_run_name}_best.sdf"
      )
      matcha_poses_candidates=(
        "$matcha_out/\${matcha_run_name}_poses.sdf"
        "$matcha_out/\${matcha_run_name}/\${matcha_run_name}_poses.sdf"
      )
      matcha_timing_candidates=(
        "$matcha_out/run_timing.json"
        "$matcha_out/\${matcha_run_name}/run_timing.json"
      )
      for candidate in "\${matcha_best_candidates[@]}"; do
        [[ -f "$candidate" ]] && matcha_best="$candidate" && break
      done
      for candidate in "\${matcha_poses_candidates[@]}"; do
        [[ -f "$candidate" ]] && matcha_poses="$candidate" && break
      done
      for candidate in "\${matcha_timing_candidates[@]}"; do
        [[ -f "$candidate" ]] && matcha_timing="$candidate" && break
      done
      if [[ -n "$matcha_best" ]]; then
        stable_best="$RUN_DIR/matcha/\${ligand_id}_matcha_best.sdf"
        stable_poses="$RUN_DIR/matcha/\${ligand_id}_matcha_poses.sdf"
        stable_timing="$RUN_DIR/matcha/\${ligand_id}_matcha_run_timing.json"
        cp "$matcha_best" "$stable_best"
        [[ -n "$matcha_poses" ]] && cp "$matcha_poses" "$stable_poses"
        [[ -n "$matcha_timing" ]] && cp "$matcha_timing" "$stable_timing"
        matcha_metrics="$RUN_DIR/matcha/\${ligand_id}_matcha_metrics.txt"
        if "$MATCHA_PY" "$RUN_DIR/parse_matcha_result.py" --ligand-id "$ligand_id" --best-sdf "$stable_best" --timing-json "$stable_timing" > "$matcha_metrics" 2> "$RUN_DIR/logs/\${ligand_id}_matcha_parse.log"; then
          MATCHA_RESULTS+=("$(cat "$matcha_metrics")")
        else
          fail_status "$ligand_id" matcha "matcha parser failed"
        fi
      else
        fail_status "$ligand_id" matcha "matcha best pose not found"
      fi
    else
      fail_status "$ligand_id" matcha "matcha run failed"
    fi
  fi
done

SUMMARY_ARGS=("$RUN_DIR/build_summary_wide.py" --run-dir "$RUN_DIR" --case ${posixQuote(plan?.case?.working_id || plan?.case?.run_id || 'case')} --receptor "$RECEPTOR_INPUT_NAME" --out "$RUN_DIR/results/summary_wide.csv")
for ligand_pair in "\${LIGAND_SUMMARY[@]}"; do
  SUMMARY_ARGS+=(--ligand "$ligand_pair")
done
for method in "\${SUMMARY_METHODS[@]}"; do
  SUMMARY_ARGS+=(--method "$method")
done
for override in "\${STATUS_OVERRIDES[@]}"; do
  SUMMARY_ARGS+=(--method-status "$override")
done
for matcha_result in "\${MATCHA_RESULTS[@]}"; do
  SUMMARY_ARGS+=(--matcha-result "$matcha_result")
done

if ! run_cmd "build summary_wide.csv" "$RUN_DIR/logs/build_summary_wide.log" "$PYTHON_BIN" "\${SUMMARY_ARGS[@]}"; then
  echo "ERROR: summary_wide.csv generation failed"
  exit 70
fi

if ! "$PYTHON_BIN" - <<'PY'
from pathlib import Path
import csv, json

run = Path('.')
summary = run / 'results' / 'summary_wide.csv'
rows = list(csv.DictReader(summary.open(newline='', encoding='utf-8-sig')))
candidates = []
for row in rows:
    ligand = Path(row.get('input_ligand') or 'ligand').stem
    for source, column in (
        ('matcha_best', 'matcha_best_pose'),
        ('gnina_docked', 'gnina_docking_pose'),
        ('smina_docked', 'smina_docking_pose'),
    ):
        raw = (row.get(column) or '').strip()
        pose = Path(raw) if raw else None
        if pose and pose.is_file() and pose.stat().st_size > 0:
            candidates.append({'source': source, 'ligand': ligand, 'pose': str(pose), 'row': row})

if not candidates:
    raise SystemExit('no successful docking/Matcha pose artifact is available for Burrete review')

priority = {'matcha_best': 0, 'gnina_docked': 1, 'smina_docked': 2}
candidates.sort(key=lambda item: (priority[item['source']], item['ligand']))
selected = candidates[0]
chemistry = run / 'prepared' / f"{selected['ligand']}.sdf"
if not chemistry.is_file() or chemistry.stat().st_size == 0:
    raise SystemExit(f'clean ligand chemistry artifact is missing for {selected["ligand"]}: {chemistry}')
handoff = {
    'schema': 'lp-flow.pipeline-handoff.v1',
    'status': 'package_ready_for_pose_review',
    'receptor': 'prepared/receptor.pdb',
    'selected_pose_source': selected['source'],
    'selected_ligand': selected['ligand'],
    'selected_pose': selected['pose'],
    'ligand_chemistry': str(chemistry),
    'selection_reason': 'method-priority fallback; Burrete review is required before MD',
    'pose_candidates': [
        {'source': item['source'], 'ligand': item['ligand'], 'pose': item['pose']}
        for item in candidates
    ],
    'pose_review': {
        'target': 'burrete:molecule-collection',
        'status': 'pending',
        'status_file': 'results/pose_review_status.json',
    },
}
(run / 'results' / 'pipeline_handoff.json').write_text(json.dumps(handoff, indent=2) + '\\n', encoding='utf-8')
manifest_path = run / 'results' / 'run_manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {'schema': 'lp-flow.run-manifest.v1'}
manifest['phase'] = 'pose_review_pending'
manifest['status'] = 'docking_completed'
manifest.setdefault('phases', {})['runtime_preflight'] = {'status': 'ok', 'artifact': 'results/runtime_status.csv'}
manifest['phases']['docking'] = {'status': 'completed_with_method_statuses', 'artifact': 'results/summary_wide.csv'}
manifest['phases']['pose_review'] = {'status': 'pending', 'artifact': 'results/pose_review_status.json'}
manifest['method_statuses'] = [
    {key: row.get(key, '') for key in ('input_ligand', 'gnina_status', 'smina_status', 'boltz_status', 'matcha_status')}
    for row in rows
]
manifest_path.write_text(json.dumps(manifest, indent=2) + '\\n', encoding='utf-8')
print(json.dumps(handoff, indent=2))
PY
then
  echo "ERROR: pose-review handoff generation failed"
  exit 71
fi
echo "Payload complete"
`;

  return {
    ok: errors.length === 0,
    errors,
    script_path: scriptPath,
    command_line: commandLine,
    resource_intensive: true,
    methods,
    ligand_count: ligandRows.length,
    box_mode: box.mode,
    script,
  };
}

async function inspectResults(input) {
  const resultsDirRaw = normalizeString(input.results_dir || input.resultsDir || input.folder);
  if (!resultsDirRaw) throw new Error('results_dir is required');
  const resultsDir = path.resolve(resultsDirRaw);
  const strict = input.strict === true || input.validate_pipeline === true;
  const runDir = path.basename(resultsDir).toLowerCase() === 'results' ? path.dirname(resultsDir) : resultsDir;
  const runResultsDir = path.join(runDir, 'results');
  const expectedDirs = ['gnina', 'smina', 'boltz', 'matcha', 'logs'];
  const expectedFiles = ['summary_wide.csv', 'summary_wide_notes.md'];
  const dirs = {};
  const files = {};
  for (const item of expectedDirs) dirs[item] = (await statOrNull(path.join(resultsDir, item)))?.isDirectory() || false;
  for (const item of expectedFiles) {
    const itemPath = path.join(resultsDir, item);
    const itemStat = await statOrNull(itemPath);
    files[toPosixRelative(item)] = itemStat?.isFile() ? { exists: true, size_bytes: itemStat.size } : { exists: false, size_bytes: 0 };
  }
  let summary = null;
  const summaryPath = path.join(resultsDir, 'summary_wide.csv');
  if (files['summary_wide.csv'].exists) {
    const text = await fs.readFile(summaryPath, 'utf8');
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    summary = {
      row_count: Math.max(0, lines.length - 1),
      columns: lines.length ? lines[0].split(',') : [],
    };
  }
  const missing = [
    ...Object.entries(dirs).filter(([, ok]) => !ok).map(([name]) => `${name}/`),
    ...Object.entries(files).filter(([, meta]) => !meta.exists).map(([name]) => name),
  ];
  const readJson = async filePath => {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  };
  const poseReview = await readJson(path.join(runResultsDir, 'pose_review_status.json'));
  const trajectoryReview = await readJson(path.join(runResultsDir, 'trajectory_review_status.json'));
  const mdManifest = await readJson(path.join(runDir, 'md_from_best_pose', 'outputs', 'trajectory_manifest.json'));
  const displayQc = await readJson(path.join(runDir, 'md_from_best_pose', 'outputs', 'display_qc.json'));
  const reviewValid = review => ['opened', 'reviewed'].includes(String(review?.status || '').toLowerCase()) && Boolean(normalizeString(review?.handoff_url || review?.url));
  const displayValid = Boolean(displayQc)
    && Number.isInteger(displayQc.models)
    && displayQc.models >= Number(displayQc.required_models || 2)
    && typeof mdManifest?.display === 'string';
  const pipelineMissing = [];
  if (!poseReview) pipelineMissing.push('results/pose_review_status.json');
  else if (!reviewValid(poseReview)) pipelineMissing.push('results/pose_review_status.json: opened/reviewed status with handoff_url');
  if (!trajectoryReview) pipelineMissing.push('results/trajectory_review_status.json');
  else if (!reviewValid(trajectoryReview)) pipelineMissing.push('results/trajectory_review_status.json: opened/reviewed status with handoff_url');
  if (!mdManifest) pipelineMissing.push('md_from_best_pose/outputs/trajectory_manifest.json');
  if (!displayValid) pipelineMissing.push('md_from_best_pose/outputs/display_qc.json: sufficient multi-model display');
  const resultLinks = [
    ['Docking pose review', poseReview, 'burrete:molecule-collection'],
    ['MD trajectory review', trajectoryReview, 'burrete:trajectory-review'],
  ].flatMap(([label, review, target]) => {
    const url = normalizeString(review?.handoff_url || review?.url);
    return url ? [{ label, target, url, status: normalizeString(review?.status) }] : [];
  });
  return {
    ok: strict ? missing.length === 0 && pipelineMissing.length === 0 : missing.length === 0,
    results_dir: resultsDir,
    dirs,
    files,
    summary,
    missing,
    pipeline: {
      strict,
      run_dir: runDir,
      pose_review: poseReview,
      trajectory_review: trajectoryReview,
      md_manifest: mdManifest,
      display_qc: displayQc,
      missing: pipelineMissing,
    },
    result_links: resultLinks,
  };
}

function buildMdFromBestPoseScript(plan, input = {}) {
  const gmx = normalizeString(plan?.profile?.gromacs || input.gromacs || input.gmx);
  const obabel = normalizeString(plan?.tools?.obabel || input.obabel);
  const acpype = normalizeString(plan?.profile?.acpype || input.acpype);
  const ldLibraryPath = normalizeString(plan?.profile?.ld_library_path || input.ld_library_path || input.gromacs_ld_library_path);
  const mdtoolsEnv = normalizeString(plan?.profile?.mdtools_env || input.mdtools_env);
  const ligandChargeRaw = input.md_ligand_charge ?? input.ligand_charge ?? input.ligandCharge;
  const ligandCharge = ligandChargeRaw === undefined || ligandChargeRaw === null || ligandChargeRaw === ''
    ? null
    : Number.parseInt(ligandChargeRaw, 10);
  const ligandChargeSource = normalizeString(input.md_ligand_charge_source || input.ligand_charge_source || input.ligandChargeSource) || 'user_or_chemistry_preflight';
  const nvtSteps = Number.parseInt(input.md_nvt_steps ?? input.nvt_steps ?? input.nvtSteps ?? 1000, 10);
  const nptSteps = Number.parseInt(input.md_npt_steps ?? input.npt_steps ?? input.nptSteps ?? nvtSteps, 10);
  const displayMaxModels = Number.parseInt(input.md_display_max_models ?? input.display_max_models ?? input.displayMaxModels ?? 100, 10);
  const mdProtocol = normalizeString(input.md_protocol || input.protocol) || 'amber99sb-ildn_gaff2';
  const displayPrefix = sanitizeId(normalizeString(input.md_display_prefix || input.display_prefix) || `${plan.case.working_id}_top_pose_nvt`, 'md_display', false);
  const errors = [];
  if (!gmx) errors.push('gromacs_path_missing');
  if (!obabel) errors.push('obabel_path_missing');
  if (!acpype) errors.push('acpype_path_missing');
  if (ligandCharge === null) errors.push('ligand_charge_missing');
  else if (!Number.isInteger(ligandCharge)) errors.push('ligand_charge_not_integer');
  if (!Number.isInteger(nvtSteps) || nvtSteps <= 0) errors.push('nvt_steps_not_positive');
  if (!Number.isInteger(nptSteps) || nptSteps <= 0) errors.push('npt_steps_not_positive');
  if (!Number.isInteger(displayMaxModels) || displayMaxModels < 2 || displayMaxModels > 500) errors.push('display_max_models_must_be_between_2_and_500');
  if (mdProtocol !== 'amber99sb-ildn_gaff2') errors.push('unsupported_md_protocol');

  const script = `#!/usr/bin/env bash
set -euo pipefail

RUN_DIR="\${RUN_DIR:-$(pwd)}"
GMX=${posixQuote(gmx || 'gmx')}
OBABEL=${posixQuote(obabel || 'obabel')}
ACPYPE=${posixQuote(acpype || 'acpype')}
LIGAND_CHARGE="${Number.isInteger(ligandCharge) ? ligandCharge : ''}"
LIGAND_CHARGE_SOURCE=${posixQuote(ligandChargeSource)}
NVT_STEPS="${Number.isInteger(nvtSteps) && nvtSteps > 0 ? nvtSteps : 1000}"
NPT_STEPS="${Number.isInteger(nptSteps) && nptSteps > 0 ? nptSteps : 1000}"
DISPLAY_MAX_MODELS="${Number.isInteger(displayMaxModels) && displayMaxModels >= 2 && displayMaxModels <= 500 ? displayMaxModels : 100}"
# Keep the no-water Burrete display smooth and bounded. The t=0 frame can add
# one MODEL beyond this interval target.
NVT_XTC_STRIDE=$(( (NVT_STEPS + DISPLAY_MAX_MODELS - 1) / DISPLAY_MAX_MODELS ))
if [ "$NVT_XTC_STRIDE" -lt 1 ]; then NVT_XTC_STRIDE=1; fi
MD_DIR="\${MD_DIR:-md_from_best_pose}"
DISPLAY_PREFIX=${posixQuote(displayPrefix)}
MD_PROTOCOL=${posixQuote(mdProtocol)}

${ldLibraryPath ? `export LD_LIBRARY_PATH=${posixQuote(ldLibraryPath)}:\${LD_LIBRARY_PATH:-}` : '# LD_LIBRARY_PATH supplied by environment/profile if needed'}
${mdtoolsEnv ? `export PATH=${posixQuote(`${mdtoolsEnv.replace(/\/+$/g, '')}/bin`)}:\${PATH:-}` : '# mdtools PATH supplied by environment/profile if needed'}

cd "$RUN_DIR"
mkdir -p "$MD_DIR"/{prepared,topology,logs,outputs,ligand} results
exec > >(tee -a "$MD_DIR/logs/run_md_from_best_pose.log") 2>&1

echo "== LP-Flow MD from best docking pose =="
date
echo "RUN_DIR=$RUN_DIR"
echo "GMX=$GMX"
echo "OBABEL=$OBABEL"
echo "ACPYPE=$ACPYPE"
echo "LIGAND_CHARGE=$LIGAND_CHARGE"
echo "NVT_STEPS=$NVT_STEPS"
echo "NPT_STEPS=$NPT_STEPS"
echo "DISPLAY_MAX_MODELS=$DISPLAY_MAX_MODELS"
echo "MD_PROTOCOL=$MD_PROTOCOL"

test -x "$GMX"
test -x "$OBABEL"
test -x "$ACPYPE"

python - <<'PY'
from pathlib import Path
import json

run = Path('.')
handoff_path = run / 'results' / 'pipeline_handoff.json'
review_path = run / 'results' / 'pose_review_status.json'
if not handoff_path.exists():
    raise SystemExit('pipeline_handoff.json not found; docking payload did not produce a pose package')
if not review_path.exists():
    raise SystemExit('pose_review_status.json not found; record Burrete pose review/open status before MD')

handoff = json.loads(handoff_path.read_text(encoding='utf-8'))
review = json.loads(review_path.read_text(encoding='utf-8'))
review_status = str(review.get('status') or '').lower()
if review_status not in {'opened', 'reviewed', 'unavailable'}:
    raise SystemExit(f'pose review status does not permit MD: {review_status or "missing"}')

pose = Path(review.get('selected_pose') or handoff.get('selected_pose') or '')
receptor = Path(handoff.get('receptor') or 'prepared/receptor.pdb')
ligand = str(handoff.get('selected_ligand') or pose.stem or 'ligand')
chemistry = Path(handoff.get('ligand_chemistry') or '')
if not pose.is_file() or pose.stat().st_size == 0:
    raise SystemExit(f'reviewed pose artifact missing or empty: {pose}')
if not receptor.is_file() or receptor.stat().st_size == 0:
    raise SystemExit(f'receptor artifact missing or empty: {receptor}')
if not chemistry.is_file() or chemistry.stat().st_size == 0:
    raise SystemExit(f'clean ligand chemistry artifact missing or empty: {chemistry}')

handoff['pose_review'] = review
handoff['md'] = {
    'command': 'bash scripts/run_md_from_best_pose.sh',
    'engine': 'gromacs',
    'backend': 'cpu',
    'expected_display': 'md_from_best_pose/outputs/${displayPrefix}_nowater_multimodel.pdb',
    'native_trajectory': 'md_from_best_pose/prepared/npt.xtc',
    'native_topology': 'md_from_best_pose/prepared/npt.tpr',
}
handoff_path.write_text(json.dumps(handoff, indent=2) + '\\n', encoding='utf-8')
Path('md_from_best_pose/selected_pose_path.txt').write_text(str(pose) + '\\n', encoding='utf-8')
Path('md_from_best_pose/selected_receptor_path.txt').write_text(str(receptor) + '\\n', encoding='utf-8')
Path('md_from_best_pose/selected_ligand_id.txt').write_text(ligand + '\\n', encoding='utf-8')
Path('md_from_best_pose/selected_ligand_chemistry_path.txt').write_text(str(chemistry) + '\\n', encoding='utf-8')
print(json.dumps(handoff, indent=2))
PY

POSE="$(cat "$MD_DIR/selected_pose_path.txt")"
RECEPTOR="$(cat "$MD_DIR/selected_receptor_path.txt")"
SELECTED_LIGAND="$(cat "$MD_DIR/selected_ligand_id.txt")"
CHEMISTRY="$(cat "$MD_DIR/selected_ligand_chemistry_path.txt")"
echo "POSE=$POSE"
echo "RECEPTOR=$RECEPTOR"
echo "CHEMISTRY=$CHEMISTRY"
if [[ -z "$LIGAND_CHARGE" ]]; then
  echo "ERROR: ligand_charge is required; derive formal charge from the selected chemistry input or record a validated protonation-state assumption before ACPYPE."
  exit 65
fi
echo "LIGAND_CHARGE_SOURCE=$LIGAND_CHARGE_SOURCE"

python - <<'PY'
from pathlib import Path
src = Path('md_from_best_pose/selected_receptor_path.txt').read_text().strip()
out = Path('md_from_best_pose/prepared/receptor_md_clean.pdb')
lines = Path(src).read_text(errors='replace').splitlines()
out.write_text('\\n'.join(line for line in lines if line.startswith('ATOM  ') or line.startswith('TER')) + '\\nEND\\n')
PY

if ! "$GMX" pdb2gmx -f "$MD_DIR/prepared/receptor_md_clean.pdb" -o "$MD_DIR/prepared/protein.gro" -p "$MD_DIR/topology/topol.top" -water tip3p -ff amber99sb-ildn -ignh > "$MD_DIR/logs/pdb2gmx.log" 2>&1; then
  echo "ERROR: pdb2gmx failed; receptor residues are never removed automatically. Inspect $MD_DIR/logs/pdb2gmx.log and repair the receptor explicitly."
  exit 72
fi

"$OBABEL" "$CHEMISTRY" -O "$MD_DIR/ligand/chemistry_h.mol2" -h > "$MD_DIR/logs/obabel_chemistry_h.log" 2>&1
"$OBABEL" "$CHEMISTRY" -O "$MD_DIR/ligand/chemistry_for_placement.sdf" -d > "$MD_DIR/logs/obabel_chemistry_placement.log" 2>&1
"$OBABEL" "$POSE" -O "$MD_DIR/ligand/pose_for_placement.sdf" -d > "$MD_DIR/logs/obabel_pose_placement.log" 2>&1
rm -rf "$MD_DIR/LIGPOSE.acpype"
( cd "$MD_DIR" && "$ACPYPE" -i ligand/chemistry_h.mol2 -b LIGPOSE -o gmx -c gas -n "$LIGAND_CHARGE" > logs/acpype.log 2>&1 )
cp "$MD_DIR/LIGPOSE.acpype/LIGPOSE_GMX.itp" "$MD_DIR/topology/LIGPOSE_GMX.itp"
python scripts/place_ligand_from_pose.py \
  --chemistry "$MD_DIR/ligand/chemistry_for_placement.sdf" \
  --pose "$MD_DIR/ligand/pose_for_placement.sdf" \
  --gro "$MD_DIR/LIGPOSE.acpype/LIGPOSE_GMX.gro" \
  --out "$MD_DIR/ligand/LIGPOSE_placed.gro" \
  --report "$MD_DIR/outputs/ligand_placement.json" > "$MD_DIR/logs/place_ligand.log" 2>&1

python - <<'PY'
from pathlib import Path
md = Path('md_from_best_pose')
top = md/'topology/topol.top'
text = top.read_text().splitlines()
out = []
inserted = False
for line in text:
    out.append(line)
    if not inserted and line.strip().startswith('#include') and 'forcefield.itp' in line:
        out.append('#include "LIGPOSE_GMX.itp"')
        inserted = True
for i, line in enumerate(out):
    if line.strip() == '[ molecules ]':
        j = i + 1
        while j < len(out) and (not out[j].strip() or out[j].lstrip().startswith(';')):
            j += 1
        if j < len(out):
            j += 1
        out.insert(j, 'LIGPOSE             1')
        break
top.write_text('\\n'.join(out)+'\\n')

protein = (md/'prepared/protein.gro').read_text().splitlines()
lig = (md/'ligand/LIGPOSE_placed.gro').read_text().splitlines()
pn = int(protein[1].strip())
ln = int(lig[1].strip())
body = protein[2:2+pn] + lig[2:2+ln]
box = protein[2+pn]
(md/'prepared/complex.gro').write_text('\\n'.join(['LP-Flow complex', f'{len(body):5d}', *body, box])+'\\n')
ligand_resname = lig[2][5:10].strip() if ln else ''
if not ligand_resname:
    raise SystemExit('could not determine ligand residue name from ACPYPE GRO')
(md/'selected_ligand_resname.txt').write_text(ligand_resname+'\\n')
PY

cat > "$MD_DIR/prepared/ions.mdp" <<'EOF'
integrator = steep
emtol = 1000
emstep = 0.01
nsteps = 100
cutoff-scheme = Verlet
coulombtype = PME
rcoulomb = 1.0
rvdw = 1.0
pbc = xyz
EOF
cat > "$MD_DIR/prepared/em.mdp" <<'EOF'
integrator = steep
emtol = 500
emstep = 0.01
nsteps = 500
cutoff-scheme = Verlet
coulombtype = PME
rcoulomb = 1.0
rvdw = 1.0
pbc = xyz
EOF
cat > "$MD_DIR/prepared/nvt.mdp" <<EOF
integrator = md
dt = 0.002
nsteps = $NVT_STEPS
nstxout-compressed = $NVT_XTC_STRIDE
nstenergy = 100
nstlog = 100
continuation = no
define = -DPOSRES
constraint_algorithm = lincs
constraints = h-bonds
cutoff-scheme = Verlet
coulombtype = PME
rcoulomb = 1.0
rvdw = 1.0
tcoupl = V-rescale
tc-grps = System
tau_t = 0.1
ref_t = 300
pcoupl = no
pbc = xyz
gen_vel = yes
gen_temp = 300
gen_seed = 20260715
EOF
cat > "$MD_DIR/prepared/npt.mdp" <<EOF
integrator = md
dt = 0.002
nsteps = $NPT_STEPS
nstxout-compressed = $NVT_XTC_STRIDE
nstenergy = 100
nstlog = 100
continuation = yes
define = -DPOSRES
constraint_algorithm = lincs
constraints = h-bonds
cutoff-scheme = Verlet
coulombtype = PME
rcoulomb = 1.0
rvdw = 1.0
tcoupl = V-rescale
tc-grps = System
tau_t = 0.1
ref_t = 300
pcoupl = C-rescale
pcoupltype = isotropic
tau_p = 2.0
ref_p = 1.0
compressibility = 4.5e-5
refcoord_scaling = com
pbc = xyz
gen_vel = no
EOF

"$GMX" editconf -f "$MD_DIR/prepared/complex.gro" -o "$MD_DIR/prepared/boxed.gro" -c -d 1.0 -bt dodecahedron > "$MD_DIR/logs/editconf.log" 2>&1
"$GMX" solvate -cp "$MD_DIR/prepared/boxed.gro" -cs spc216.gro -p "$MD_DIR/topology/topol.top" -o "$MD_DIR/prepared/solv.gro" > "$MD_DIR/logs/solvate.log" 2>&1
"$GMX" grompp -f "$MD_DIR/prepared/ions.mdp" -c "$MD_DIR/prepared/solv.gro" -p "$MD_DIR/topology/topol.top" -o "$MD_DIR/prepared/ions.tpr" > "$MD_DIR/logs/grompp_ions.log" 2>&1
printf 'SOL\\n' | "$GMX" genion -s "$MD_DIR/prepared/ions.tpr" -o "$MD_DIR/prepared/solv_ions.gro" -p "$MD_DIR/topology/topol.top" -neutral > "$MD_DIR/logs/genion.log" 2>&1
"$GMX" grompp -f "$MD_DIR/prepared/em.mdp" -c "$MD_DIR/prepared/solv_ions.gro" -p "$MD_DIR/topology/topol.top" -o "$MD_DIR/prepared/em.tpr" > "$MD_DIR/logs/grompp_em.log" 2>&1
"$GMX" mdrun -deffnm "$MD_DIR/prepared/em" -nb cpu -pme cpu > "$MD_DIR/logs/mdrun_em.log" 2>&1
"$GMX" grompp -f "$MD_DIR/prepared/nvt.mdp" -c "$MD_DIR/prepared/em.gro" -r "$MD_DIR/prepared/em.gro" -p "$MD_DIR/topology/topol.top" -o "$MD_DIR/prepared/nvt.tpr" > "$MD_DIR/logs/grompp_nvt.log" 2>&1
"$GMX" mdrun -deffnm "$MD_DIR/prepared/nvt" -nb cpu -pme cpu > "$MD_DIR/logs/mdrun_nvt.log" 2>&1
"$GMX" grompp -f "$MD_DIR/prepared/npt.mdp" -c "$MD_DIR/prepared/nvt.gro" -r "$MD_DIR/prepared/nvt.gro" -t "$MD_DIR/prepared/nvt.cpt" -p "$MD_DIR/topology/topol.top" -o "$MD_DIR/prepared/npt.tpr" > "$MD_DIR/logs/grompp_npt.log" 2>&1
"$GMX" mdrun -deffnm "$MD_DIR/prepared/npt" -nb cpu -pme cpu > "$MD_DIR/logs/mdrun_npt.log" 2>&1
LIGAND_RESNAME="$(cat "$MD_DIR/selected_ligand_resname.txt")"
"$GMX" select -s "$MD_DIR/prepared/npt.tpr" -select "group \"Protein\" or resname $LIGAND_RESNAME" -on "$MD_DIR/prepared/preview_nowater.ndx" > "$MD_DIR/logs/select_nowater.log" 2>&1
printf '0\\n0\\n' | "$GMX" trjconv -s "$MD_DIR/prepared/npt.tpr" -f "$MD_DIR/prepared/npt.xtc" -n "$MD_DIR/prepared/preview_nowater.ndx" -o "$MD_DIR/prepared/npt_display_centered.xtc" -pbc mol -center -ur compact > "$MD_DIR/logs/trjconv_display_center.log" 2>&1
printf '0\\n0\\n' | "$GMX" trjconv -s "$MD_DIR/prepared/npt.tpr" -f "$MD_DIR/prepared/npt_display_centered.xtc" -n "$MD_DIR/prepared/preview_nowater.ndx" -o "$MD_DIR/outputs/${displayPrefix}_nowater_multimodel.raw.pdb" -fit rot+trans > "$MD_DIR/logs/trjconv_multimodel.log" 2>&1
awk '
  !started && /^TITLE/ { title=$0; next }
  !started && /^CRYST1/ { crystal=$0; next }
  /^MODEL/ {
    if (!started++) {
      if (title != "") print title
      if (crystal != "") print crystal
    }
    print
    next
  }
  /^(ATOM  |HETATM)/ { print; next }
  /^ENDMDL/ { print }
  END { if (started) print "END" }
' "$MD_DIR/outputs/${displayPrefix}_nowater_multimodel.raw.pdb" > "$MD_DIR/outputs/${displayPrefix}_nowater_multimodel.pdb"
rm -f "$MD_DIR/outputs/${displayPrefix}_nowater_multimodel.raw.pdb"

python - <<PY
import json
import math
import statistics
from pathlib import Path

display = Path('$MD_DIR/outputs/${displayPrefix}_nowater_multimodel.pdb')
frames, frame = [], []
for line in display.read_text(errors='replace').splitlines():
    if line.startswith('MODEL'):
        frame = []
    elif line.startswith(('ATOM  ', 'HETATM')):
        frame.append(tuple(float(line[i:j]) for i, j in ((30, 38), (38, 46), (46, 54))))
    elif line.startswith('ENDMDL') and frame:
        frames.append(frame)

required_models = min(int('$DISPLAY_MAX_MODELS'), int('$NPT_STEPS') + 1)
if len(frames) < required_models or len({len(item) for item in frames}) != 1:
    raise SystemExit('DISPLAY_QC_FAIL inconsistent multi-model PDB frames')

step_distances = []
for previous, current in zip(frames, frames[1:]):
    step_distances.extend(math.dist(a, b) for a, b in zip(previous, current))
median_step = statistics.median(step_distances)
max_step = max(step_distances)
if max_step > 25 and max_step > max(1.0, median_step * 25):
    raise SystemExit(f'DISPLAY_QC_FAIL PBC-like coordinate jump: {max_step:.3f} A')

(display.parent / 'display_qc.json').write_text(json.dumps({
    'status': 'ok',
    'models': len(frames),
    'required_models': required_models,
    'display_max_models': int('$DISPLAY_MAX_MODELS'),
    'atoms_per_model': len(frames[0]),
    'median_step_displacement_a': round(median_step, 4),
    'max_step_displacement_a': round(max_step, 4),
}, indent=2) + '\\n')
PY

python - <<PY
import json
from pathlib import Path
md = Path('$MD_DIR')
preview = {
  'schema': 'lp-flow.preview-nowater.v1',
  'selection': 'Protein or ligand',
  'ligand_resname': (md/'selected_ligand_resname.txt').read_text().strip(),
  'frame_stride_steps': int('$NVT_XTC_STRIDE'),
  'display_max_models': int('$DISPLAY_MAX_MODELS'),
  'bulk_water_included': False,
  'display_qc': str((md/'outputs/display_qc.json').resolve()),
}
(md/'outputs/preview_nowater.json').write_text(json.dumps(preview, indent=2)+'\\n')
manifest = {
  'schema': 'lp-flow.trajectory-manifest.v1',
  'intended_viewer': 'Burrete',
  'engine': 'gromacs',
  'protocol': {
    'id': '$MD_PROTOCOL',
    'protein_force_field': 'amber99sb-ildn',
    'ligand_force_field': 'GAFF2 via ACPYPE',
    'tutorial_equivalence': 'not_claimed',
  },
  'ligand_charge': int('$LIGAND_CHARGE'),
  'ligand_charge_source': '$LIGAND_CHARGE_SOURCE',
  'backend': 'cpu',
  'completed_stages': ['pdb2gmx','ligand_acpype','ligand_pose_placement','solvate','genion','em','nvt','npt','cleanup_multimodel_pdb'],
  'display': str((md/'outputs/${displayPrefix}_nowater_multimodel.pdb').resolve()),
  'display_role': 'burrete_display_multimodel_pdb',
  'display_water': 'no_bulk_water',
  'display_qc': str((md/'outputs/display_qc.json').resolve()),
  'preview_metadata': str((md/'outputs/preview_nowater.json').resolve()),
  'native_trajectory': str((md/'prepared/npt.xtc').resolve()),
  'native_topology': str((md/'prepared/npt.tpr').resolve()),
  'native_topology_role': 'provenance',
  'topology_text': str((md/'topology/topol.top').resolve()),
  'structure': str((md/'prepared/npt.gro').resolve()),
  'ligand_placement': str((md/'outputs/ligand_placement.json').resolve()),
  'pose_source': Path('$MD_DIR/selected_pose_path.txt').read_text().strip(),
  'visualization_status': 'reopenable_package',
  'reopen_command': 'burrete:trajectory-review'
}
(md/'outputs/trajectory_manifest.json').write_text(json.dumps(manifest, indent=2)+'\\n')
(Path('results')/'md_handoff_status.json').write_text(json.dumps({'status':'package_ready','manifest':str((md/'outputs/trajectory_manifest.json').resolve()),'display':manifest['display']}, indent=2)+'\\n')
run_manifest_path = Path('results/run_manifest.json')
run_manifest = json.loads(run_manifest_path.read_text()) if run_manifest_path.exists() else {'schema': 'lp-flow.run-manifest.v1'}
run_manifest['phase'] = 'trajectory_review_pending'
run_manifest['status'] = 'md_completed'
run_manifest.setdefault('phases', {})['md'] = {'status': 'ok', 'artifact': 'md_from_best_pose/outputs/trajectory_manifest.json'}
run_manifest['phases']['trajectory_review'] = {'status': 'pending', 'artifact': 'results/trajectory_review_status.json'}
run_manifest_path.write_text(json.dumps(run_manifest, indent=2)+'\\n')
PY

tar -czf md_from_best_pose_bundle.tar.gz "$MD_DIR"
echo "MD_SMOKE_OK"
ls -lh "$MD_DIR/outputs" "$MD_DIR/prepared/npt.xtc" "$MD_DIR/prepared/npt.tpr" md_from_best_pose_bundle.tar.gz
`;

  return {
    ok: errors.length === 0,
    errors,
    script,
    script_path: 'scripts/run_md_from_best_pose.sh',
    command_line: 'bash scripts/run_md_from_best_pose.sh',
    resource_intensive: true,
    engine: 'gromacs',
    backend: 'cpu',
    expected_outputs: {
      bundle: 'md_from_best_pose_bundle.tar.gz',
      manifest: 'md_from_best_pose/outputs/trajectory_manifest.json',
      display: `md_from_best_pose/outputs/${displayPrefix}_nowater_multimodel.pdb`,
      native_trajectory: 'md_from_best_pose/prepared/npt.xtc',
      native_topology: 'md_from_best_pose/prepared/npt.tpr',
    },
  };
}

async function writeRunPackage(input) {
  let packageInput = { ...(input || {}) };
  if (normalizeString(packageInput.config)) {
    const loaded = await loadWorkflowConfig(packageInput.config);
    packageInput = mergeConfigWithArgs(loaded.config, packageInput);
    packageInput.config_path = loaded.path;
  }
  const plan = await buildRunPlan(packageInput);
  const outDirRaw = normalizeString(packageInput.out_dir || packageInput.outDir);
  const outDir = path.resolve(outDirRaw || path.join(plan.local.task_dir, 'results', 'mcp_run_plan', plan.case.run_id));
  const cleanupCheck = safeRemoteCleanupCheck({
    allowed_root: plan.profile.remote_work_root,
    run_dir: plan.remote.run_dir,
  });
  const payload = buildRemoteDockingPayloadFromPlan(plan, packageInput);
  const mdFromBestPose = buildMdFromBestPoseScript(plan, packageInput);
  const mdRemoteCommand = heavyRemoteCommand(
    plan.profile,
    plan.profile.remote_work_root,
    plan.remote.run_dir,
    'lp_flow_md_from_best_pose',
    'scripts/run_md_from_best_pose.sh',
  );
  const mdEligibilityCommand = profileScheduler(plan.profile) === 'slurm'
    ? slurmEligibilityCommand(plan.remote.run_dir, 'lp_flow_md_from_best_pose', 'scripts/run_md_from_best_pose.sh', plan.profile)
    : '';

  const preflightScript = `#!/usr/bin/env bash
set -euo pipefail
cd ${posixQuote(plan.remote.run_dir)}
mkdir -p logs results
{
  echo "== host =="
  hostname
  echo "== user =="
  whoami
  echo "== date =="
  date
  echo "== pwd =="
  pwd
  echo "== nvidia-smi =="
  command -v nvidia-smi || true
  nvidia-smi || true
  echo "== nvidia-smi pmon =="
  nvidia-smi pmon -c 1 || true
} 2>&1 | tee logs/preflight.log
`;

  const commandsText = [
    '# LP-Flow run package',
    '',
    '# 1. Create remote run folder',
    plan.remote_commands.create_run_dir,
    '',
    '# 2. Upload files listed in upload_manifest.json into their remote_path locations.',
    '',
    '# 3. Run remote preflight',
    `bash ${posixQuote(`${plan.remote.run_dir}/remote_preflight.sh`)}`,
    '',
    '# 4. Resource-intensive docking payload; submit through the configured scheduler when available',
    plan.remote_commands.run_docking_payload,
    '',
    '# 5. Check docking payload status',
    plan.remote_commands.docking_payload_status,
    '',
    '# 6. Open selected/top docking pose in Burrete using results/pipeline_handoff.json before MD',
    'burrete:molecule-collection',
    '',
    '# 7. Check CPU MD scheduler eligibility before submit',
    mdEligibilityCommand || '# ssh-inline profile: no Slurm eligibility step',
    '',
    '# 8. Run CPU MD smoke from best available reviewed pose after Burrete pose status exists',
    mdRemoteCommand,
    '',
    '# 9. Open MD trajectory/display package in Burrete after trajectory_manifest.json exists',
    'burrete:trajectory-review',
    '',
    '# 10. Package remote results after docking, visualization handoffs, and MD',
    plan.remote_commands.package_results,
    '',
    '# 11. Download files listed in download_manifest.json.',
    '',
    '# 12. Cleanup only after confirmed download',
    cleanupCheck.command_line,
    '',
  ].join('\n');

  const scriptUploads = [
    {
      role: 'manifest',
      local_path: path.join(outDir, 'run_manifest.json'),
      remote_path: `${plan.remote.run_dir}/results/run_manifest.json`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'remote_preflight.sh'),
      remote_path: `${plan.remote.run_dir}/remote_preflight.sh`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'safe_remote_cleanup.sh'),
      remote_path: `${plan.remote.run_dir}/safe_remote_cleanup.sh`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'remote_docking_payload.sh'),
      remote_path: `${plan.remote.run_dir}/remote_docking_payload.sh`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'build_summary_wide.py'),
      remote_path: `${plan.remote.run_dir}/build_summary_wide.py`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'parse_matcha_result.py'),
      remote_path: `${plan.remote.run_dir}/parse_matcha_result.py`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'scripts', 'run_md_from_best_pose.sh'),
      remote_path: `${plan.remote.run_dir}/scripts/run_md_from_best_pose.sh`,
      mode: '0644',
    },
    {
      role: 'script',
      local_path: path.join(outDir, 'scripts', 'place_ligand_from_pose.py'),
      remote_path: `${plan.remote.run_dir}/scripts/place_ligand_from_pose.py`,
      mode: '0644',
    },
  ];
  const stagedInputUploads = plan.upload_files.map(item => {
    const remoteCheck = validateRemoteChildPath(plan.remote.run_dir, item.remote_path);
    if (!remoteCheck.ok) throw new Error(`Unsafe upload remote path for ${item.role || 'input'}: ${remoteCheck.errors.join('; ')}`);
    const relativeRemote = path.posix.relative(plan.remote.run_dir, remoteCheck.runDir);
    const localStagedPath = path.join(outDir, ...relativeRemote.split('/'));
    return {
      ...item,
      source_local_path: item.local_path,
      local_path: localStagedPath,
      remote_path: remoteCheck.runDir,
    };
  });
  let safeCleanupScript = await fs.readFile(path.join(SERVER_DOCKING_SCRIPTS, 'safe_remote_cleanup.sh'), 'utf8');
  if (!safeCleanupScript.endsWith('\n')) safeCleanupScript += '\n';
  let summaryScript = await fs.readFile(path.join(SERVER_DOCKING_SCRIPTS, 'build_summary_wide.py'), 'utf8');
  if (!summaryScript.endsWith('\n')) summaryScript += '\n';
  let matchaParserScript = await fs.readFile(path.join(SERVER_DOCKING_SCRIPTS, 'parse_matcha_result.py'), 'utf8');
  if (!matchaParserScript.endsWith('\n')) matchaParserScript += '\n';
  let ligandPlacementScript = await fs.readFile(path.join(PLUGIN_ROOT, 'scripts', 'gromacs-md', 'place_ligand_from_pose.py'), 'utf8');
  if (!ligandPlacementScript.endsWith('\n')) ligandPlacementScript += '\n';

  const files = {
    'run_manifest.json': JSON.stringify({
      schema: 'lp-flow.run-manifest.v1',
      run_id: plan.case.run_id,
      phase: 'prepare_run_package',
      status: 'prepared_not_executed',
      created_at: new Date().toISOString(),
      methods: Object.fromEntries(plan.methods.map(method => [method, { status: 'planned' }])),
      phases: {
        package_preparation: { status: 'ok' },
        runtime_preflight: { status: 'pending', artifact: 'results/runtime_status.csv' },
        docking: { status: 'pending', artifact: 'results/summary_wide.csv' },
        pose_review: { status: 'pending', artifact: 'results/pose_review_status.json' },
        md: { status: 'pending', artifact: 'md_from_best_pose/outputs/trajectory_manifest.json' },
        trajectory_review: { status: 'pending', artifact: 'results/trajectory_review_status.json' },
      },
    }, null, 2) + '\n',
    'run_plan.json': JSON.stringify(plan, null, 2) + '\n',
    'upload_manifest.json': JSON.stringify([...stagedInputUploads, ...scriptUploads], null, 2) + '\n',
    'download_manifest.json': JSON.stringify(plan.download_files, null, 2) + '\n',
    'remote_preflight.sh': preflightScript,
    'safe_remote_cleanup.sh': safeCleanupScript,
    'remote_docking_payload.sh': payload.script,
    [path.join('scripts', 'run_md_from_best_pose.sh')]: mdFromBestPose.script,
    [path.join('scripts', 'place_ligand_from_pose.py')]: ligandPlacementScript,
    'build_summary_wide.py': summaryScript,
    'parse_matcha_result.py': matchaParserScript,
    'commands.txt': commandsText,
  };

  await fs.mkdir(outDir, { recursive: true });
  const written = [];
  for (const item of stagedInputUploads) {
    await fs.mkdir(path.dirname(item.local_path), { recursive: true });
    await fs.copyFile(item.source_local_path, item.local_path);
    written.push(item.local_path);
  }
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(outDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, 'utf8');
    written.push(filePath);
  }

  return {
    ok: plan.ok && cleanupCheck.ok && payload.ok && mdFromBestPose.ok,
    out_dir: outDir,
    run_id: plan.case.run_id,
    remote_run_dir: plan.remote.run_dir,
    files: written,
    plan_ok: plan.ok,
    cleanup_ok: cleanupCheck.ok,
    payload_ok: payload.ok,
    payload_errors: payload.errors,
    md_ok: mdFromBestPose.ok,
    md_errors: mdFromBestPose.errors,
    upload_count: stagedInputUploads.length + scriptUploads.length,
    needs: plan.needs,
    warnings: plan.warnings,
  };
}

async function readJsonFile(filePath, label) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function localPathInside(rootRaw, childRaw) {
  const root = path.resolve(String(rootRaw));
  const child = path.resolve(String(childRaw));
  const relative = path.relative(root, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeManifestItems(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} must be an array`);
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const localPath = normalizeString(item.local_path || item.localPath);
    const remotePath = normalizeString(item.remote_path || item.remotePath);
    if (!localPath) throw new Error(`${label}[${index}].local_path is required`);
    if (!remotePath) throw new Error(`${label}[${index}].remote_path is required`);
    return { ...item, local_path: path.resolve(localPath), remote_path: remotePath };
  });
}

function assertLocalPathAllowed(localPath, roots, label) {
  if (!roots.some(root => localPathInside(root, localPath))) {
    throw new Error(`${label} local_path is outside allowed task/package roots: ${localPath}`);
  }
}

function normalizePosixAbsolute(value, label) {
  const text = normalizeString(value);
  if (!text.startsWith('/')) throw new Error(`${label} must be an absolute POSIX path`);
  const parts = text.split('/').filter(Boolean);
  if (parts.includes('.') || parts.includes('..')) throw new Error(`${label} must not contain . or .. path segments`);
  return `/${parts.join('/')}`;
}

function validateRunPackageManifests(packageDir, runPlan, uploadManifestRaw, downloadManifestRaw) {
  const runDir = validateRemoteChildPath(runPlan.profile.remote_work_root, runPlan.remote.run_dir).runDir;
  const taskDir = normalizeString(runPlan?.local?.task_dir || runPlan?.local?.taskDir);
  const uploadLocalRoots = [packageDir].filter(Boolean).map(item => path.resolve(item));
  const downloadLocalRoots = [packageDir, taskDir].filter(Boolean).map(item => path.resolve(item));
  if (!uploadLocalRoots.length) throw new Error('package_dir is required for upload manifest validation');
  if (!downloadLocalRoots.length) throw new Error('run_plan.local.task_dir or package_dir is required for download manifest validation');

  const uploadManifest = normalizeManifestItems(uploadManifestRaw, 'upload_manifest.json');
  for (const [index, item] of uploadManifest.entries()) {
    assertLocalPathAllowed(item.local_path, uploadLocalRoots, `upload_manifest.json[${index}]`);
    const remoteCheck = validateRemoteChildPath(runDir, item.remote_path);
    if (!remoteCheck.ok) {
      throw new Error(`upload_manifest.json[${index}].remote_path must be inside remote run dir: ${remoteCheck.errors.join('; ')}`);
    }
    item.remote_path = remoteCheck.runDir;
  }

  const expectedArchive = `${path.posix.dirname(runDir)}/${path.posix.basename(runDir)}.tar.gz`;
  const downloadManifest = normalizeManifestItems(downloadManifestRaw, 'download_manifest.json');
  for (const [index, item] of downloadManifest.entries()) {
    assertLocalPathAllowed(item.local_path, downloadLocalRoots, `download_manifest.json[${index}]`);
    const remotePath = normalizePosixAbsolute(item.remote_path, `download_manifest.json[${index}].remote_path`);
    const remoteCheck = validateRemoteChildPath(runDir, remotePath);
    if (!remoteCheck.ok && remotePath !== expectedArchive) {
      throw new Error(`download_manifest.json[${index}].remote_path must be inside remote run dir or equal expected archive ${expectedArchive}`);
    }
    item.remote_path = remoteCheck.ok ? remoteCheck.runDir : remotePath;
  }

  return { uploadManifest, downloadManifest };
}

async function readRunPackage(input) {
  const packageDirRaw = normalizeString(input.package_dir || input.packageDir || input.folder);
  if (!packageDirRaw) throw new Error('package_dir is required');
  const packageDir = path.resolve(packageDirRaw);
  const packageStat = await statOrNull(packageDir);
  if (!packageStat || !packageStat.isDirectory()) throw new Error(`package_dir does not exist or is not a directory: ${packageDir}`);
  const runPlan = await readJsonFile(path.join(packageDir, 'run_plan.json'), 'run_plan.json');
  const uploadManifest = await readJsonFile(path.join(packageDir, 'upload_manifest.json'), 'upload_manifest.json');
  const downloadManifest = await readJsonFile(path.join(packageDir, 'download_manifest.json'), 'download_manifest.json');
  if (!runPlan?.remote?.run_dir || !runPlan?.profile?.remote_work_root) throw new Error('run_plan.json is missing remote.run_dir or profile.remote_work_root');
  const safe = validateRemoteChildPath(runPlan.profile.remote_work_root, runPlan.remote.run_dir);
  if (!safe.ok) throw new Error(`Unsafe run package remote path: ${safe.errors.join('; ')}`);
  const manifests = validateRunPackageManifests(packageDir, runPlan, uploadManifest, downloadManifest);
  return { packageDir, runPlan, uploadManifest: manifests.uploadManifest, downloadManifest: manifests.downloadManifest };
}

async function buildDockingPayload(input) {
  const { runPlan } = await readRunPackage(input);
  const payload = buildRemoteDockingPayloadFromPlan(runPlan, input);
  if (!(input.include_script === true || input.includeScript === true || input.include_script === 'true')) {
    return { ...payload, script: undefined };
  }
  return payload;
}

async function resolveExecutionProfile(input, runPlan) {
  if (!executionProfileSourceProvided(input)) {
    throw new Error('A fresh local execution profile is required. Pass profile, profile_json, profile_path, or profile_name; run_plan.json SSH data is intentionally not trusted.');
  }
  const profile = await resolveProfile(input);
  const packageRoot = normalizeString(runPlan?.profile?.remote_work_root).replace(/\/+$/g, '');
  const localRoot = normalizeString(profile.remote_work_root).replace(/\/+$/g, '');
  if (!packageRoot || packageRoot !== localRoot) {
    throw new Error(`Execution profile remote_work_root (${localRoot || '<missing>'}) must match package remote_work_root (${packageRoot || '<missing>'})`);
  }
  profileSshArgv(profile);
  profileScpArgv(profile);
  return profile;
}

async function buildRemoteExecutionPlanFromPackage(pkg, input = {}) {
  const { packageDir, runPlan, uploadManifest, downloadManifest } = pkg;
  const profile = await resolveExecutionProfile(input, runPlan);
  const packageRoot = normalizeString(runPlan.profile.remote_work_root).replace(/\/+$/g, '');
  const pathCheck = validateRemoteChildPath(packageRoot, runPlan.remote.run_dir);
  if (!pathCheck.ok) throw new Error(`Unsafe package run dir: ${pathCheck.errors.join('; ')}`);
  const runDir = pathCheck.runDir;
  const runComputeDevice = normalizeString(input.compute_device || input.computeDevice || runPlan.compute_device || 'gpu').toLowerCase();
  const runGpuGres = runComputeDevice === 'gpu' && (runPlan.methods || []).some(method => ['gnina', 'boltz', 'matcha'].includes(method))
    ? normalizeString(profile.scheduler_gpu_gres || profile.schedulerGpuGres)
    : '';
  const expectedRemoteCommands = {
    create_run_dir: `mkdir -p ${posixQuote(`${runDir}/input/ligands`)} ${posixQuote(`${runDir}/logs`)} ${posixQuote(`${runDir}/results`)} ${posixQuote(`${runDir}/scripts`)}`,
    docking_scheduler_eligibility: profileScheduler(profile) === 'slurm'
      ? slurmEligibilityCommand(runDir, 'lp_flow_payload', 'remote_docking_payload.sh', profile, { gres: runGpuGres })
      : '',
    run_docking_payload: heavyRemoteCommand(profile, packageRoot, runDir, 'lp_flow_payload', 'remote_docking_payload.sh', { gres: runGpuGres }),
    docking_payload_status: profileScheduler(profile) === 'slurm'
      ? slurmStatusCommand(runDir, 'lp_flow_payload', 'results/summary_wide.csv')
      : `cd ${posixQuote(runDir)}; if test -f results/summary_wide.csv; then echo expected_output=present:results/summary_wide.csv; else echo expected_output=missing:results/summary_wide.csv; fi; tail -n 80 logs/remote_docking_payload.log 2>/dev/null || true`,
    run_md_from_best_pose: heavyRemoteCommand(profile, packageRoot, runDir, 'lp_flow_md_from_best_pose', 'scripts/run_md_from_best_pose.sh'),
    md_scheduler_eligibility: profileScheduler(profile) === 'slurm'
      ? slurmEligibilityCommand(runDir, 'lp_flow_md_from_best_pose', 'scripts/run_md_from_best_pose.sh', profile)
      : '',
    md_pose_review_precondition: `cd ${posixQuote(runDir)}; test -s results/pipeline_handoff.json; test -s results/pose_review_status.json; grep -Eq '"status"[[:space:]]*:[[:space:]]*"(opened|reviewed|unavailable)"' results/pose_review_status.json`,
    md_from_best_pose_status: profileScheduler(profile) === 'slurm'
      ? slurmStatusCommand(runDir, 'lp_flow_md_from_best_pose', 'md_from_best_pose/outputs/trajectory_manifest.json')
      : `cd ${posixQuote(runDir)}; if test -f md_from_best_pose/outputs/trajectory_manifest.json; then echo expected_output=present:md_from_best_pose/outputs/trajectory_manifest.json; else echo expected_output=missing:md_from_best_pose/outputs/trajectory_manifest.json; fi; tail -n 80 md_from_best_pose/logs/run_md_from_best_pose.log 2>/dev/null || true`,
    package_results: packageResultsCommand(runDir),
    cleanup_after_download: safeRemoteCleanupCheck({ allowed_root: packageRoot, run_dir: runDir }).command_line,
  };
  const steps = [];

  steps.push({
    step: 'create_remote',
    description: 'Create the remote run folder and subdirectories.',
    destructive: false,
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.create_run_dir)],
  });

  steps.push({
    step: 'upload',
    description: 'Create manifest parent directories, then upload input files and run scripts.',
    destructive: false,
    commands: [
      sshRemoteCommand(
        profile,
        `mkdir -p ${Array.from(new Set(uploadManifest.map(item => path.posix.dirname(item.remote_path)))).map(posixQuote).join(' ')}`,
      ),
      ...uploadManifest.map(item => scpUploadCommand(profile, item.local_path, item.remote_path)),
    ],
  });

  steps.push({
    step: 'preflight',
    description: 'Run remote host/user/date/GPU preflight and write logs/preflight.log.',
    destructive: false,
    commands: [sshRemoteCommand(profile, `bash ${posixQuote(`${runDir}/remote_preflight.sh`)}`)],
  });

  steps.push({
    step: 'check_docking_scheduler',
    description: 'Use Slurm test-only with the exact docking resources. A projected start beyond the profile advisory is recorded, then one job is submitted and kept in the scheduler queue.',
    destructive: false,
    scheduler_eligibility: profileScheduler(profile) === 'slurm',
    queue_max_wait_minutes: profileQueueWaitMinutes(profile),
    commands: profileScheduler(profile) === 'slurm'
      ? [sshRemoteCommand(profile, expectedRemoteCommands.docking_scheduler_eligibility)]
      : [],
  });

  steps.push({
    step: 'run_docking_payload',
    description: profileScheduler(profile) === 'slurm'
      ? 'Check Slurm eligibility with the exact payload resources, then submit one GNINA/SMINA/Boltz/Matcha job. A long projected wait is advisory, not a cancellation trigger.'
      : 'Run remote_docking_payload.sh directly for GNINA/SMINA/Boltz/Matcha methods in the package.',
    destructive: false,
    resource_intensive: true,
    scheduler: profileScheduler(profile) || 'ssh-inline',
    scheduler_eligibility_command: profileScheduler(profile) === 'slurm'
      ? sshRemoteCommand(profile, expectedRemoteCommands.docking_scheduler_eligibility)
      : null,
    queue_max_wait_minutes: profileQueueWaitMinutes(profile),
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.run_docking_payload)],
  });

  steps.push({
    step: 'check_docking_payload_status',
    description: 'Check docking/scoring completion and retain a queued Slurm job until it completes or is explicitly cancelled.',
    destructive: false,
    scheduler_status: profileScheduler(profile) === 'slurm',
    queue_max_wait_minutes: profileQueueWaitMinutes(profile),
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.docking_payload_status)],
  });

  steps.push({
    step: 'open_burrete_pose_review',
    description: 'Open receptor context plus selected/top pose package in Burrete before MD. Use results/pipeline_handoff.json and record the Burrete link/status in the report.',
    destructive: false,
    handoff: true,
    target: 'burrete:molecule-collection',
    required_before: 'run_md_from_best_pose',
    expected_artifact: `${runDir}/results/pipeline_handoff.json`,
    status_file: `${runDir}/results/pose_review_status.json`,
    commands: [],
  });

  steps.push({
    step: 'check_md_scheduler',
    description: 'Use Slurm test-only with the exact CPU MD resources. A projected start beyond the profile advisory is recorded, then one job is submitted and kept in the scheduler queue.',
    destructive: false,
    scheduler_eligibility: profileScheduler(profile) === 'slurm',
    queue_max_wait_minutes: profileQueueWaitMinutes(profile),
    commands: profileScheduler(profile) === 'slurm'
      ? [sshRemoteCommand(profile, expectedRemoteCommands.md_scheduler_eligibility)]
      : [],
  });

  steps.push({
    step: 'run_md_from_best_pose',
    description: 'After summary_wide.csv and Burrete pose-review status exist, run CPU GROMACS smoke MD from the best available reviewed pose and write a no-water multi-model PDB plus trajectory manifest for Burrete.',
    destructive: false,
    resource_intensive: true,
    scheduler: profileScheduler(profile) || 'ssh-inline',
    precondition_command: sshRemoteCommand(profile, expectedRemoteCommands.md_pose_review_precondition),
    scheduler_eligibility_command: profileScheduler(profile) === 'slurm'
      ? sshRemoteCommand(profile, expectedRemoteCommands.md_scheduler_eligibility)
      : null,
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.run_md_from_best_pose)],
  });

  steps.push({
    step: 'check_md_from_best_pose_status',
    description: 'Check MD smoke completion and retain a queued Slurm job until it completes or is explicitly cancelled.',
    destructive: false,
    scheduler_status: profileScheduler(profile) === 'slurm',
    queue_max_wait_minutes: profileQueueWaitMinutes(profile),
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.md_from_best_pose_status)],
  });

  steps.push({
    step: 'open_burrete_trajectory_review',
    description: 'Open the no-water multi-frame display PDB and trajectory manifest in Burrete; return link/status in the report.',
    destructive: false,
    handoff: true,
    target: 'burrete:trajectory-review',
    expected_artifact: `${runDir}/md_from_best_pose/outputs/trajectory_manifest.json`,
    status_file: `${runDir}/results/trajectory_review_status.json`,
    commands: [],
  });

  steps.push({
    step: 'package_results',
    description: 'Create a remote tar.gz archive after docking/scoring and MD outputs exist.',
    destructive: false,
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.package_results)],
  });

  const archiveDownload = downloadManifest.find(item => item.role === 'remote_archive') || downloadManifest[0];
  if (archiveDownload) {
    steps.push({
      step: 'download_archive',
      description: 'Download the packaged remote results archive.',
      destructive: false,
      commands: [scpDownloadCommand(profile, archiveDownload.remote_path, archiveDownload.local_path, false)],
    });
  }

  steps.push({
    step: 'cleanup',
    description: 'Cleanup is intentionally not executable through this MCP layer. Use explicit user approval and safe_remote_cleanup.sh only after confirmed downloads.',
    destructive: true,
    disabled: true,
    commands: [sshRemoteCommand(profile, expectedRemoteCommands.cleanup_after_download)],
  });

  return {
    ok: true,
    package_dir: packageDir,
    run_id: runPlan.case.run_id,
    remote_run_dir: runDir,
    ssh_control: sshControlSettings(profile),
    steps,
    allowed_execute_steps: ['create_remote', 'upload', 'preflight', 'check_docking_scheduler', 'run_docking_payload', 'check_docking_payload_status', 'open_burrete_pose_review', 'check_md_scheduler', 'run_md_from_best_pose', 'check_md_from_best_pose_status', 'open_burrete_trajectory_review', 'package_results', 'download_archive'],
    note: 'This plan uses argv arrays for remote execution and explicit Burrete handoff steps for visualization. Cleanup is listed for review only and is not executable by remote_execute_step. Resource-intensive steps require confirm_resource_use=true.',
  };
}

async function buildRemoteCommandPlan(input) {
  return buildRemoteExecutionPlanFromPackage(await readRunPackage(input), input);
}

async function runCommand(argv, options = {}) {
  const { spawn } = await import('node:child_process');
  const timeoutMs = Number.parseInt(options.timeout_ms || options.timeoutMs || 300000, 10);
  const maxOutputBytes = Number.parseInt(options.max_output_bytes || options.maxOutputBytes || 200000, 10);
  return await new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(argv[0], argv.slice(1), { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let terminationSignal = null;
    let settled = false;
    const append = (kind, chunk) => {
      const text = chunk.toString('utf8');
      if (kind === 'stdout') stdout = (stdout + text).slice(-maxOutputBytes);
      else stderr = (stderr + text).slice(-maxOutputBytes);
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({ ...payload, elapsed_ms: Date.now() - startedMs, termination_signal: terminationSignal });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminationSignal = 'SIGTERM';
      child.kill('SIGTERM');
    }, timeoutMs);
    const forceTimer = setTimeout(() => {
      if (!timedOut || settled) return;
      terminationSignal = currentPlatform() === 'win32' ? 'terminate' : 'SIGKILL';
      child.kill(currentPlatform() === 'win32' ? undefined : 'SIGKILL');
    }, timeoutMs + 2000);
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.on('error', error => {
      finish({ ok: false, started_at: startedAt, argv, exit_code: null, error: error.message, stdout, stderr, timed_out: timedOut });
    });
    child.on('close', code => {
      finish({ ok: code === 0 && !timedOut, started_at: startedAt, argv, exit_code: code, stdout, stderr, timed_out: timedOut });
    });
  });
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCommandWithRetry(argv, options = {}) {
  const attempts = Math.min(Math.max(Number.parseInt(options.retries || options.retry_count || options.retryCount || 1, 10), 1), 10);
  const delayMs = Math.min(Math.max(Number.parseInt(options.retry_delay_ms || options.retryDelayMs || 2000, 10), 0), 60000);
  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runCommand(argv, options);
    results.push({ attempt, result });
    if (result.ok || attempt >= attempts) return { final: result, attempts: results };
    if (delayMs > 0) await sleepMs(delayMs);
  }
  return { final: results[results.length - 1]?.result || { ok: false, argv, error: 'No attempts were run' }, attempts: results };
}

function mdJobId(input = {}) {
  const explicit = normalizeString(input.job_id || input.jobId || input.name);
  const base = explicit || `md_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  return sanitizeId(base, 'md_job');
}

function mdRemoteDirFromInput(input = {}, profile) {
  const raw = normalizeString(input.remote_dir || input.remoteDir || input.run_dir || input.runDir);
  if (!raw) throw new Error('remote_dir is required');
  const root = normalizeString(profile.remote_work_root).replace(/\/+$/g, '');
  const check = validateRemoteChildPath(root, raw);
  if (!check.ok) throw new Error(`Unsafe remote_dir: ${check.errors.join('; ')}`);
  return check.runDir;
}

function mdRelativeScript(input = {}) {
  const script = normalizeString(input.script || input.script_path || input.scriptPath || 'scripts/run_md.sh');
  if (!script || script.startsWith('/') || script.includes('\\')) {
    throw new Error('script must be a relative POSIX path inside remote_dir');
  }
  const parts = script.split('/').filter(Boolean);
  if (!parts.length || parts.includes('.') || parts.includes('..')) {
    throw new Error('script must not contain empty, . or .. path segments');
  }
  if (!parts[parts.length - 1].endsWith('.sh')) {
    throw new Error('script must point to a .sh file');
  }
  return parts.join('/');
}

function mdRemotePaths(remoteDir, jobId, logName = '') {
  const safeLog = sanitizeId(logName || `${jobId}.nohup`, 'md_log');
  return {
    remoteDir,
    logsDir: `${remoteDir}/logs`,
    pidFile: `${remoteDir}/logs/${jobId}.pid`,
    statusFile: `${remoteDir}/logs/${jobId}.status.json`,
    logFile: `${remoteDir}/logs/${safeLog}.log`,
  };
}

async function mdResolveProfile(input = {}) {
  const profile = await resolveProfile(input);
  profileSshArgv(profile);
  profileScpArgv(profile);
  return profile;
}

async function mdConnectCheck(input = {}) {
  const profile = await mdResolveProfile(input);
  const command = [
    'set -e',
    'echo LP_FLOW_SSH_OK',
    'hostname',
    'whoami',
    'date -Is',
    'printf "control_path=%s\\n" "$SSH_CONNECTION"',
  ].join('; ');
  const remote = sshRemoteCommand(profile, command);
  const retried = await runCommandWithRetry(remote.argv, {
    ...input,
    retries: input.retries || input.retry_count || input.retryCount || 3,
    retry_delay_ms: input.retry_delay_ms || input.retryDelayMs || 3000,
    timeout_ms: input.timeout_ms || input.timeoutMs || 20000,
    max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 20000,
  });
  const result = retried.final;
  return {
    ok: result.ok,
    kind: 'lp-flow-md-connect-check',
    profile_name: profile.profile_name,
    remote_work_root: profile.remote_work_root,
    ssh_control: sshControlSettings(profile),
    command: remote,
    attempts: retried.attempts,
    result,
  };
}

async function remoteSessionAction(input = {}, action = 'open') {
  const sessionInput = {
    ...input,
    ssh_control_master: true,
    ssh_control_persist: sshSessionPersist(input),
  };
  const profile = await mdResolveProfile(sessionInput);
  const normalizedAction = action === 'close' ? 'exit' : action;
  const command = sshSessionCommand(profile, normalizedAction, sessionInput);
  const shouldExecute = explicitTrue(input.execute);
  if (!shouldExecute) {
    return {
      ok: true,
      executed: false,
      kind: `lp-flow-remote-session-${action}`,
      profile_name: profile.profile_name,
      remote_work_root: profile.remote_work_root,
      ssh_control: sshControlSettings(profileWithSessionControl(profile, sessionInput)),
      command,
      note: 'Dry run. Pass execute=true to run this explicit session action.',
    };
  }
  const result = await runCommand(command.argv, {
    ...input,
    timeout_ms: input.timeout_ms || input.timeoutMs || (action === 'open' ? 30000 : 15000),
    max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 40000,
  });
  let check = null;
  if (action === 'open' && result.ok) {
    const checkCommand = sshSessionCommand(profile, 'check', sessionInput);
    check = await runCommand(checkCommand.argv, {
      ...input,
      timeout_ms: input.timeout_ms || input.timeoutMs || 15000,
      max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 40000,
    });
  }
  return {
    ok: result.ok && (!check || check.ok),
    executed: true,
    kind: `lp-flow-remote-session-${action}`,
    profile_name: profile.profile_name,
    remote_work_root: profile.remote_work_root,
    ssh_control: sshControlSettings(profileWithSessionControl(profile, sessionInput)),
    command,
    result,
    check,
  };
}

async function remoteSessionOpen(input = {}) {
  return remoteSessionAction(input, 'open');
}

async function remoteSessionCheck(input = {}) {
  return remoteSessionAction(input, 'check');
}

async function remoteSessionClose(input = {}) {
  return remoteSessionAction(input, 'close');
}

async function mdSubmit(input = {}) {
  const profile = await mdResolveProfile(input);
  const remoteDir = mdRemoteDirFromInput(input, profile);
  const script = mdRelativeScript(input);
  const jobId = mdJobId(input);
  const paths = mdRemotePaths(remoteDir, jobId, input.log_name || input.logName);
  const remoteScript = `${remoteDir}/${script}`;
  const inlineRemoteCommand = [
    'set -euo pipefail',
    `cd ${posixQuote(remoteDir)}`,
    `mkdir -p ${posixQuote(paths.logsDir)}`,
    `test -f ${posixQuote(remoteScript)}`,
    `chmod +x ${posixQuote(remoteScript)}`,
    `nohup bash ${posixQuote(remoteScript)} > ${posixQuote(paths.logFile)} 2>&1 &`,
    'pid=$!',
    `printf '%s\\n' "$pid" > ${posixQuote(paths.pidFile)}`,
    `printf '{"job_id":%s,"pid":%s,"remote_dir":%s,"script":%s,"log_file":%s,"submitted_at":%s}\\n' ${posixQuote(JSON.stringify(jobId))} "$pid" ${posixQuote(JSON.stringify(remoteDir))} ${posixQuote(JSON.stringify(script))} ${posixQuote(JSON.stringify(paths.logFile))} ${posixQuote(JSON.stringify(new Date().toISOString()))} > ${posixQuote(paths.statusFile)}`,
    `echo ${posixQuote(`SUBMITTED ${jobId}`)}`,
    'echo "PID=$pid"',
  ].join(' && ');
  const scheduler = profileScheduler(profile) || 'ssh-inline';
  const eligibility = scheduler === 'slurm'
    ? sshRemoteCommand(profile, slurmEligibilityCommand(remoteDir, jobId, script, profile))
    : null;
  const remote = sshRemoteCommand(
    profile,
    scheduler === 'slurm'
      ? slurmSubmitCommand(remoteDir, jobId, script, profile)
      : inlineRemoteCommand,
  );
  if (!explicitTrue(input.execute)) {
    return {
      ok: true,
      executed: false,
      kind: 'lp-flow-md-submit',
      job_id: jobId,
      remote_dir: remoteDir,
      script,
      scheduler,
      paths,
      eligibility_command: eligibility,
      command: remote,
      note: scheduler === 'slurm'
        ? 'Dry run. Slurm --test-only will run before submit when execute=true.'
        : 'Dry run. Pass execute=true to submit the MD job.',
    };
  }
  let eligibilityResult = null;
  let schedulerEligibility = null;
  if (eligibility) {
    eligibilityResult = await runCommand(eligibility.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 30000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 40000 });
    schedulerEligibility = classifySlurmEligibilityOutput(
      `${eligibilityResult.stdout}\n${eligibilityResult.stderr}`,
      profileQueueWaitMinutes(profile),
    );
    if (!eligibilityResult.ok || schedulerEligibility.status !== 'eligible') {
      return {
        ok: schedulerEligibility.status === 'deferred',
        executed: false,
        kind: 'lp-flow-md-submit',
        job_id: jobId,
        remote_dir: remoteDir,
        script,
        scheduler,
        scheduler_eligibility: schedulerEligibility,
        eligibility_result: eligibilityResult,
        note: 'No MD job was submitted because Slurm eligibility was not accepted within the configured queue limit.',
      };
    }
  }
  const result = await runCommand(remote.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 30000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 40000 });
  return {
    ok: result.ok,
    executed: true,
    kind: 'lp-flow-md-submit',
    job_id: jobId,
    remote_dir: remoteDir,
    script,
    scheduler,
    paths,
    ssh_control: sshControlSettings(profile),
    command: remote,
    eligibility_result: eligibilityResult,
    scheduler_eligibility: schedulerEligibility,
    result,
  };
}

async function mdStatus(input = {}) {
  const profile = await mdResolveProfile(input);
  const remoteDir = mdRemoteDirFromInput(input, profile);
  const jobId = mdJobId(input);
  const paths = mdRemotePaths(remoteDir, jobId, input.log_name || input.logName);
  const scheduler = profileScheduler(profile) || 'ssh-inline';
  const remoteCommand = scheduler === 'slurm'
    ? slurmStatusCommand(remoteDir, jobId, '')
    : [
      `cd ${posixQuote(remoteDir)}`,
      `echo job_id=${posixQuote(jobId)}`,
      `echo remote_dir=${posixQuote(remoteDir)}`,
      `if [ -f ${posixQuote(paths.pidFile)} ]; then pid=$(cat ${posixQuote(paths.pidFile)}); echo pid=$pid; ps -fp "$pid" 2>/dev/null || true; else echo pid_file_missing=${posixQuote(paths.pidFile)}; fi`,
      `if [ -f ${posixQuote(paths.statusFile)} ]; then echo '--- status-json'; cat ${posixQuote(paths.statusFile)}; fi`,
      `echo '--- result-packages'; find ${posixQuote(remoteDir)} -maxdepth 3 -type f \\( -name '*.tar.gz' -o -name '*results*.zip' \\) -printf '%p %s bytes\\n' 2>/dev/null | sort | tail -20`,
      `echo '--- log-tail'; if [ -f ${posixQuote(paths.logFile)} ]; then tail -n ${Number.parseInt(input.tail || 40, 10)} ${posixQuote(paths.logFile)}; else find ${posixQuote(remoteDir)}/logs -maxdepth 1 -type f -name '*.log' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- | xargs -r tail -n ${Number.parseInt(input.tail || 40, 10)}; fi`,
    ].join('; ');
  const remote = sshRemoteCommand(profile, remoteCommand);
  const result = await runCommand(remote.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 30000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 120000 });
  return {
    ok: result.ok,
    kind: 'lp-flow-md-status',
    job_id: jobId,
    remote_dir: remoteDir,
    scheduler,
    paths,
    ssh_control: sshControlSettings(profile),
    result,
  };
}

async function mdLog(input = {}) {
  const profile = await mdResolveProfile(input);
  const remoteDir = mdRemoteDirFromInput(input, profile);
  const jobId = mdJobId(input);
  const paths = mdRemotePaths(remoteDir, jobId, input.log_name || input.logName);
  const lines = Math.min(Math.max(Number.parseInt(input.lines || input.tail || 120, 10), 1), 5000);
  const remoteCommand = [
    `cd ${posixQuote(remoteDir)}`,
    `if [ -f ${posixQuote(paths.logFile)} ]; then tail -n ${lines} ${posixQuote(paths.logFile)}; else find logs -maxdepth 1 -type f -name '*.log' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- | xargs -r tail -n ${lines}; fi`,
  ].join('; ');
  const remote = sshRemoteCommand(profile, remoteCommand);
  const result = await runCommand(remote.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 30000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 200000 });
  return {
    ok: result.ok,
    kind: 'lp-flow-md-log',
    job_id: jobId,
    remote_dir: remoteDir,
    paths,
    result,
  };
}

async function mdResult(input = {}) {
  const profile = await mdResolveProfile(input);
  const remoteDir = mdRemoteDirFromInput(input, profile);
  const localOut = normalizeString(input.out_dir || input.outDir || input.local_dir || input.localDir);
  const archive = normalizeString(input.archive || input.remote_archive || input.remoteArchive);
  const findCommand = `find ${posixQuote(remoteDir)} -maxdepth 3 -type f \\( -name '*.tar.gz' -o -name '*results*.zip' \\) -printf '%T@ %p %s\\n' 2>/dev/null | sort -nr | head -1`;
  if (!explicitTrue(input.download)) {
    const remote = sshRemoteCommand(profile, findCommand);
    const result = await runCommand(remote.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 30000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 40000 });
    return {
      ok: result.ok,
      downloaded: false,
      kind: 'lp-flow-md-result',
      remote_dir: remoteDir,
      ssh_control: sshControlSettings(profile),
      result,
      note: 'Pass download=true and out_dir=<local folder> to download the newest archive, or pass archive=<remote archive path>.',
    };
  }
  if (!localOut) throw new Error('out_dir is required when download=true');
  await fs.mkdir(path.resolve(localOut), { recursive: true });
  let remoteArchive = archive;
  if (!remoteArchive) {
    const listed = await runCommand(sshRemoteCommand(profile, findCommand).argv, { ...input, timeout_ms: 30000, max_output_bytes: 20000 });
    if (!listed.ok) {
      return { ok: false, downloaded: false, kind: 'lp-flow-md-result', remote_dir: remoteDir, reason: 'Could not list remote result archives', listed };
    }
    const line = normalizeString(listed.stdout).split(/\r?\n/).filter(Boolean)[0] || '';
    const match = /^[0-9.]+\s+(.+)\s+\d+$/.exec(line);
    if (!match) throw new Error(`No result archive found under ${remoteDir}`);
    remoteArchive = match[1];
  }
  const check = validateRemoteChildPath(normalizeString(profile.remote_work_root).replace(/\/+$/g, ''), remoteArchive);
  if (!check.ok) throw new Error(`Unsafe remote archive: ${check.errors.join('; ')}`);
  const localPath = path.join(path.resolve(localOut), path.posix.basename(check.runDir));
  const command = scpDownloadCommand(profile, check.runDir, localPath);
  const result = await runCommand(command.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 300000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 80000 });
  return {
    ok: result.ok,
    downloaded: result.ok,
    kind: 'lp-flow-md-result',
    remote_dir: remoteDir,
    remote_archive: check.runDir,
    local_path: localPath,
    command,
    result,
  };
}

async function mdAnalyzeTpr(input = {}) {
  const profile = await mdResolveProfile(input);
  const tpr = normalizeString(input.tpr || input.remote_tpr || input.remoteTpr);
  if (!tpr) throw new Error('tpr is required');
  const root = normalizeString(profile.remote_work_root).replace(/\/+$/g, '');
  const check = validateRemoteChildPath(root, tpr);
  if (!check.ok) throw new Error(`Unsafe tpr path: ${check.errors.join('; ')}`);
  const gmx = requireExplicitPath(input.gmx || input.gmx_path || input.gmxPath || profile.gromacs || profile.gmx, 'GROMACS path', ['--gmx <path>', 'profile.gromacs']);
  const ldLibraryPath = normalizeString(input.ld_library_path || input.ldLibraryPath || profile.ld_library_path || profile.ldLibraryPath);
  const ldExport = ldLibraryPath
    ? `export LD_LIBRARY_PATH=${posixQuote(ldLibraryPath)}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}`
    : 'true';
  const remoteCommand = [
    ldExport,
    `${posixQuote(gmx)} dump -s ${posixQuote(check.runDir)} | head -n ${Math.min(Math.max(Number.parseInt(input.lines || 240, 10), 20), 2000)}`,
  ].join('; ');
  const remote = sshRemoteCommand(profile, remoteCommand);
  const result = await runCommand(remote.argv, { ...input, timeout_ms: input.timeout_ms || input.timeoutMs || 60000, max_output_bytes: input.max_output_bytes || input.maxOutputBytes || 200000 });
  return {
    ok: result.ok,
    kind: 'lp-flow-md-analyze-tpr',
    tpr: check.runDir,
    gmx,
    result,
  };
}

async function remoteExecuteStep(input) {
  const packagePlan = await buildRemoteCommandPlan(input);
  const stepName = normalizeString(input.step);
  if (!stepName) throw new Error('step is required');
  const step = packagePlan.steps.find(item => item.step === stepName);
  if (!step) throw new Error(`Unknown step: ${stepName}`);
  if (step.disabled || step.destructive) {
    return {
      ok: false,
      executed: false,
      step: stepName,
      blocked: true,
      reason: 'This step is disabled/destructive in the MCP executor. Review commands manually and require explicit approval outside this tool.',
      commands: step.commands,
    };
  }
  if (!packagePlan.allowed_execute_steps.includes(stepName)) {
    return {
      ok: false,
      executed: false,
      step: stepName,
      blocked: true,
      reason: 'Step is not in allowed_execute_steps.',
      commands: step.commands,
    };
  }
  if (step.handoff) {
    const handoffStatus = normalizeString(input.handoff_status || input.handoffStatus).toLowerCase();
    const allowedStatuses = new Set(['opened', 'reviewed', 'unavailable', 'blocked']);
    const executeHandoffRecord = explicitTrue(input.execute);
    if (!handoffStatus) {
      return {
        ok: false,
        executed: false,
        step: stepName,
        handoff: true,
        blocked: true,
        target: step.target,
        expected_artifact: step.expected_artifact,
        status_file: step.status_file,
        required_before: step.required_before,
        result_contract: {
          required_final_output: 'Return the opened Burrete URL and status as a clickable visualization result.',
          target: step.target,
          artifact: step.expected_artifact,
        },
        reason: `Open/review with ${step.target}, then call this step with handoff_status=opened|reviewed|unavailable|blocked and execute=true to record the exact result.`,
      };
    }
    if (!allowedStatuses.has(handoffStatus)) throw new Error(`Invalid handoff_status: ${handoffStatus}`);
    const handoffUrl = normalizeString(input.handoff_url || input.handoffUrl);
    const handoffError = normalizeString(input.handoff_error || input.handoffError);
    if ((handoffStatus === 'opened' || handoffStatus === 'reviewed') && !handoffUrl) {
      throw new Error('handoff_url is required when Burrete status is opened or reviewed');
    }
    if ((handoffStatus === 'unavailable' || handoffStatus === 'blocked') && !handoffError) {
      throw new Error('handoff_error is required when Burrete status is unavailable or blocked');
    }
    const record = {
      status: handoffStatus,
      target: step.target,
      artifact: step.expected_artifact,
      url: handoffUrl,
      error: handoffError,
      recorded_at: new Date().toISOString(),
    };
    const resultLinks = handoffUrl ? [{
      label: stepName === 'open_burrete_pose_review' ? 'Docking pose review' : 'MD trajectory review',
      target: step.target,
      url: handoffUrl,
      status: handoffStatus,
    }] : [];
    if (!executeHandoffRecord) {
      return {
        ok: true,
        executed: false,
        step: stepName,
        handoff: true,
        target: step.target,
        status_file: step.status_file,
        record,
        result_links: resultLinks,
        note: 'Dry run only. Pass execute=true to record this reviewed/open status in the remote run.',
      };
    }
    const pkg = await readRunPackage(input);
    const profile = await resolveExecutionProfile(input, pkg.runPlan);
    const recordCommand = sshRemoteCommand(
      profile,
      `mkdir -p ${posixQuote(path.posix.dirname(step.status_file))}; printf '%s\\n' ${posixQuote(JSON.stringify(record))} > ${posixQuote(step.status_file)}`,
    );
    const result = await runCommand(recordCommand.argv, input);
    return {
      ok: result.ok,
      executed: true,
      step: stepName,
      handoff: true,
      target: step.target,
      expected_artifact: step.expected_artifact,
      status_file: step.status_file,
      required_before: step.required_before,
      record,
      result_links: resultLinks,
      command: recordCommand,
      result,
    };
  }
  const execute = input.execute === true || input.execute === 'true' || input.execute === '1';
  const confirmedResourceUse =
    input.confirm_resource_use === true ||
    input.confirmResourceUse === true ||
    input.confirm_resource_use === 'true' ||
    input.confirmResourceUse === 'true' ||
    input.confirm_resource_use === '1' ||
    input.confirmResourceUse === '1';
  if (execute && step.resource_intensive && !confirmedResourceUse) {
    return {
      ok: false,
      executed: false,
      step: stepName,
      blocked: true,
      reason: 'This step can consume compute resources. Pass confirm_resource_use=true after reviewing scheduler resources and commands.',
      commands: step.commands,
    };
  }
  if (!execute) {
    return {
      ok: true,
      executed: false,
      step: stepName,
      commands: step.commands,
      note: 'Dry run only. Pass execute=true to run this single step.',
    };
  }
  const preconditionResults = [];
  if (step.precondition_command) {
    const precondition = await runCommand(step.precondition_command.argv, input);
    preconditionResults.push(precondition);
    if (!precondition.ok) {
      return {
        ok: false,
        executed: false,
        step: stepName,
        blocked: true,
        reason: 'Required prior-stage artifact/status check failed; no compute job was submitted.',
        precondition_results: preconditionResults,
      };
    }
  }
  const eligibilityResults = [];
  const schedulerEligibility = step.scheduler_eligibility
    ? null
    : step.scheduler_eligibility_command
      ? step.scheduler_eligibility_command
      : null;
  if (schedulerEligibility) {
    const result = await runCommand(schedulerEligibility.argv, input);
    eligibilityResults.push(result);
    const eligibility = classifySlurmEligibilityOutput(
      `${result.stdout}\n${result.stderr}`,
      step.queue_max_wait_minutes,
    );
    if (eligibility.status !== 'eligible') {
      return {
        ok: eligibility.status === 'deferred',
        executed: false,
        step: stepName,
        scheduler_eligibility: eligibility,
        results: eligibilityResults,
        note: 'No Slurm job was submitted because the scheduler did not accept the resource request.',
      };
    }
  }
  const results = [];
  for (const command of step.commands) {
    results.push(await runCommand(command.argv, input));
    if (!results[results.length - 1].ok) break;
  }
  const scheduler = step.scheduler_status
    ? classifySlurmQueueOutput(results.map(result => `${result.stdout}\n${result.stderr}`).join('\n'), step.queue_max_wait_minutes)
    : null;
  const schedulerEligibilityStatus = step.scheduler_eligibility
    ? classifySlurmEligibilityOutput(results.map(result => `${result.stdout}\n${result.stderr}`).join('\n'), step.queue_max_wait_minutes)
    : null;
  return {
    ok: [...preconditionResults, ...eligibilityResults, ...results].every(result => result.ok),
    executed: true,
    step: stepName,
    command_count: eligibilityResults.length + step.commands.length,
    ...(eligibilityResults.length ? { eligibility_results: eligibilityResults } : {}),
    ...(preconditionResults.length ? { precondition_results: preconditionResults } : {}),
    results,
    ...(scheduler ? { scheduler } : {}),
    ...(schedulerEligibilityStatus ? { scheduler_eligibility: schedulerEligibilityStatus } : {}),
  };
}

async function pluginStatus(input = {}) {
  const configuredProfiles = await listConfiguredProfiles();
  const includeAbsolutePaths = input.include_absolute_paths === true || input.includeAbsolutePaths === true;
  const profileCapabilities = configuredProfiles.map(({ profile_name, profile_path, ...capabilities }) => ({
    ...(includeAbsolutePaths ? { profile_name, profile_path } : {}),
    ...capabilities,
  }));
  return {
    ok: true,
    version: PLUGIN_VERSION,
    plugin_root: includeAbsolutePaths ? PLUGIN_ROOT : '<installed-plugin>',
    docking_skill: includeAbsolutePaths ? DOCKING_SKILL : 'skills/gnina-smina-docking/SKILL.md',
    mcp_config: includeAbsolutePaths ? path.join(PLUGIN_ROOT, '.mcp.json') : '.mcp.json',
    cli: includeAbsolutePaths ? path.join(PLUGIN_ROOT, 'scripts', 'lp-flow.mjs') : 'scripts/lp-flow.mjs',
    profile_schema: includeAbsolutePaths ? path.join(PLUGIN_ROOT, 'scripts', 'profile.schema.json') : 'scripts/profile.schema.json',
    docs: {
      quickstart: includeAbsolutePaths ? path.join(PLUGIN_ROOT, 'docs', 'quickstart.md') : 'docs/quickstart.md',
      security: includeAbsolutePaths ? path.join(PLUGIN_ROOT, 'SECURITY.md') : 'SECURITY.md',
      architecture: includeAbsolutePaths ? path.join(PLUGIN_ROOT, 'docs', 'architecture.md') : 'docs/architecture.md',
    },
    tools: listToolDescriptors('public').map(tool => tool.name),
    configured_profile_count: configuredProfiles.length,
    configured_profile_capabilities: profileCapabilities,
    recommended_next_step: configuredProfiles.length
      ? 'Prepare a run package, inspect its dry-run command plan, then execute approved stages through the public workflow tools.'
      : 'Create or pass a profile before remote docking, Boltz, Matcha, or GROMACS workflows.',
  };
}

const TOOL_PRESENTATION = {
  lp_flow_plugin_status: {
    title: 'LP-Flow Plugin Status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  lp_flow_md_connect_check: {
    title: 'Check MD Connection',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  lp_flow_md_submit: {
    title: 'Submit Molecular Dynamics Job',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  lp_flow_md_status: {
    title: 'Read Molecular Dynamics Status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  lp_flow_md_log: {
    title: 'Read Molecular Dynamics Log',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  lp_flow_md_result: {
    title: 'Fetch Molecular Dynamics Result',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  lp_flow_md_analyze_tpr: {
    title: 'Analyze GROMACS TPR',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  lp_flow_run_docking: {
    title: 'Prepare Docking Run Package',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  lp_flow_prepare_redocking_case: {
    title: 'Prepare Redocking Case',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  lp_flow_remote_command_plan: {
    title: 'Plan Remote Workflow Commands',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  lp_flow_remote_execute_step: {
    title: 'Execute Remote Workflow Step',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
};

const TOOLS = [
  {
    name: 'lp_flow_plugin_status',
    description: 'Return LP-Flow version, public tools, relative installation paths, and configured non-secret profile capabilities. Set include_absolute_paths only for local troubleshooting.',
    inputSchema: {
      type: 'object',
      properties: { include_absolute_paths: { type: 'boolean' } },
      additionalProperties: false,
    },
    handler: pluginStatus,
  },
  {
    name: 'lp_flow_md_connect_check',
    description: 'Check a configured remote MD profile using the plugin persistent SSH/session settings. This is read-only and runs a short remote echo/hostname/date command.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: mdConnectCheck,
  },
  {
    name: 'lp_flow_remote_session_open',
    description: 'Open an explicit long-lived OpenSSH ControlMaster session for the configured remote profile, defaulting to 8h. Later workflow commands reuse the same ControlPath instead of creating a fresh SSH connection.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        persist: { type: 'string', description: 'OpenSSH ControlPersist value for the session. Defaults to 8h.' },
        execute: { type: 'boolean', description: 'Required to run. Defaults to false for dry-run command planning.' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: remoteSessionOpen,
  },
  {
    name: 'lp_flow_remote_session_check',
    description: 'Check the existing OpenSSH ControlMaster session for the active remote profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        persist: { type: 'string' },
        execute: { type: 'boolean', description: 'Required to run. Defaults to false for dry-run command planning.' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: remoteSessionCheck,
  },
  {
    name: 'lp_flow_remote_session_close',
    description: 'Close the OpenSSH ControlMaster session for the active remote profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        persist: { type: 'string' },
        execute: { type: 'boolean', description: 'Required to run. Defaults to false for dry-run command planning.' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    handler: remoteSessionClose,
  },
  {
    name: 'lp_flow_md_submit',
    description: 'Submit a run-local MD shell script through a validated remote profile and persistent SSH/session settings. Defaults to dry-run; pass execute=true to start.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_dir: { type: 'string' },
        script: { type: 'string' },
        job_id: { type: 'string' },
        log_name: { type: 'string' },
        execute: { type: 'boolean' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      required: ['remote_dir'],
      additionalProperties: false,
    },
    handler: mdSubmit,
  },
  {
    name: 'lp_flow_md_status',
    description: 'Read MD job status, PID, newest result packages, and log tail from a validated remote run directory.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_dir: { type: 'string' },
        job_id: { type: 'string' },
        log_name: { type: 'string' },
        tail: { type: 'integer' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      required: ['remote_dir'],
      additionalProperties: false,
    },
    handler: mdStatus,
  },
  {
    name: 'lp_flow_md_log',
    description: 'Tail the log for an MD job under a validated remote run directory.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_dir: { type: 'string' },
        job_id: { type: 'string' },
        log_name: { type: 'string' },
        lines: { type: 'integer' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      required: ['remote_dir'],
      additionalProperties: false,
    },
    handler: mdLog,
  },
  {
    name: 'lp_flow_md_result',
    description: 'List or download the newest MD result archive from a validated remote run directory.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_dir: { type: 'string' },
        archive: { type: 'string' },
        download: { type: 'boolean' },
        out_dir: { type: 'string' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      required: ['remote_dir'],
      additionalProperties: false,
    },
    handler: mdResult,
  },
  {
    name: 'lp_flow_md_analyze_tpr',
    description: 'Run a read-only GROMACS dump of a remote TPR under the user work root. Requires an explicit GROMACS binary path.',
    inputSchema: {
      type: 'object',
      properties: {
        tpr: { type: 'string' },
        gmx: { type: 'string' },
        ld_library_path: { type: 'string' },
        lines: { type: 'integer' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      required: ['tpr', 'gmx'],
      additionalProperties: false,
    },
    handler: mdAnalyzeTpr,
  },
  {
    name: 'lp_flow_run_docking',
    description: 'Build a local docking/MD run package from an explicit config and output directory. This prepares commands and artifacts; remote execution is done by lp_flow_remote_command_plan and lp_flow_remote_execute_step.',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'string' },
        out_dir: { type: 'string' },
      },
      required: ['config', 'out_dir'],
      additionalProperties: false,
    },
    handler: runDockingWorkflow,
  },
  {
    name: 'lp_flow_prepare_redocking_case',
    description: 'Prepare a co-crystal redocking case from a PDB id or PDB file: split receptor and largest ligand, compute the ligand box, and write docking_config.json for lp_flow_run_docking.',
    inputSchema: {
      type: 'object',
      properties: {
        pdb_id: { type: 'string' },
        pdb_file: { type: 'string' },
        out_dir: { type: 'string' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
      },
      required: ['out_dir'],
      additionalProperties: false,
    },
    handler: prepareRedockingCase,
  },
  {
    name: 'lp_flow_resolve_profile',
    description: 'Build a non-secret remote connection profile from explicit fields, profile_json, profile_path, or a local profile_name. No shipped personal defaults are used.',
    inputSchema: {
      type: 'object',
      properties: {
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        profile: { type: 'object' },
        ssh_alias: { type: 'string' },
        ssh_command: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'integer' },
        username: { type: 'string' },
        remote_work_root: { type: 'string' },
        micromamba: { type: 'string' },
        boltz_env: { type: 'string' },
        boltz_weights_readonly: { type: 'string' },
        boltz_writable_cache: { type: 'string' },
        boltz_checkout: { type: 'string' },
        matcha_checkout: { type: 'string' },
        matcha_python: { type: 'string' },
        matcha_checkpoints: { type: 'string' },
        gnina: { type: 'string' },
        smina: { type: 'string' },
        obabel: { type: 'string' },
      },
      additionalProperties: true,
    },
    handler: resolveProfile,
  },
  {
    name: 'lp_flow_find_case_folder',
    description: 'Resolve a docking case folder from a folder path, receptor path, PDB filename, or PDB ID while excluding generated outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string' },
        roots: { type: 'array', items: { type: 'string' } },
      },
      required: ['input'],
      additionalProperties: false,
    },
    handler: findCaseFolder,
  },
  {
    name: 'lp_flow_validate_case_folder',
    description: 'Classify receptor and ligand files in a local docking task folder, sanitize IDs, and ignore generated output folders.',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string' } },
      required: ['folder'],
      additionalProperties: false,
    },
    handler: validateCaseFolder,
  },
  {
    name: 'lp_flow_safe_remote_cleanup_check',
    description: 'Check that a remote run folder is a safe child of the allowed remote work root and return a safe cleanup command.',
    inputSchema: {
      type: 'object',
      properties: {
        allowed_root: { type: 'string' },
        run_dir: { type: 'string' },
      },
      required: ['allowed_root', 'run_dir'],
      additionalProperties: false,
    },
    handler: safeRemoteCleanupCheck,
  },
  {
    name: 'lp_flow_build_run_plan',
    description: 'Build a deterministic local/remote docking run plan from a task folder, methods, active-site metadata, and an explicit or local remote profile. This does not execute SSH or docking.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string' },
        methods: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string' },
        timestamp: { type: 'string' },
        active_site: { type: 'object' },
        active_site_json: { type: 'string' },
        center: { type: 'string' },
        size: { type: 'string' },
        reference_ligand_remote_path: { type: 'string' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        gnina: { type: 'string' },
        smina: { type: 'string' },
        obabel: { type: 'string' },
      },
      required: ['folder'],
      additionalProperties: true,
    },
    handler: buildRunPlan,
  },
  {
    name: 'lp_flow_write_run_package',
    description: 'Write a deterministic local run package containing run_plan.json, upload/download manifests, preflight script, scheduler-ready payloads, and command notes. This does not execute SSH or docking.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string' },
        out_dir: { type: 'string' },
        methods: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string' },
        timestamp: { type: 'string' },
        active_site: { type: 'object' },
        active_site_json: { type: 'string' },
        center: { type: 'string' },
        size: { type: 'string' },
        reference_ligand_remote_path: { type: 'string' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        gpu_id: { type: 'string' },
        gnina: { type: 'string' },
        smina: { type: 'string' },
        obabel: { type: 'string' },
      },
      required: ['folder'],
      additionalProperties: true,
    },
    handler: writeRunPackage,
  },
  {
    name: 'lp_flow_build_docking_payload',
    description: 'Build remote_docking_payload.sh metadata for a local run package. The payload runs GNINA/SMINA/Boltz/Matcha through the configured scheduler or runtime profile; this tool does not execute it.',
    inputSchema: {
      type: 'object',
      properties: {
        package_dir: { type: 'string' },
        methods: { type: 'array', items: { type: 'string' } },
        gpu_id: { type: 'string' },
        exhaustiveness: { type: 'integer' },
        num_modes: { type: 'integer' },
        matcha_samples: { type: 'integer' },
        boltz_writable_cache: { type: 'string' },
        gnina: { type: 'string' },
        smina: { type: 'string' },
        obabel: { type: 'string' },
        matcha_checkout: { type: 'string' },
        matcha_python: { type: 'string' },
        matcha_checkpoints: { type: 'string' },
        include_script: { type: 'boolean' },
      },
      required: ['package_dir'],
      additionalProperties: true,
    },
    handler: buildDockingPayload,
  },
  {
    name: 'lp_flow_remote_command_plan',
    description: 'Read a local run package and return the dry-run remote sequence: upload, preflight, scheduler eligibility, docking payload, Burrete pose review, MD-from-best-pose, Burrete trajectory review, package, and download. This does not execute commands.',
    inputSchema: {
      type: 'object',
      properties: {
        package_dir: { type: 'string' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
      },
      required: ['package_dir'],
      additionalProperties: false,
    },
    handler: buildRemoteCommandPlan,
  },
  {
    name: 'lp_flow_remote_execute_step',
    description: 'Execute or dry-run one non-destructive remote step from a local run package. Defaults to dry-run; Slurm docking checks resource eligibility before submitting, resource-intensive docking/MD steps require confirm_resource_use=true, and cleanup is blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        package_dir: { type: 'string' },
        profile: { type: 'object' },
        profile_name: { type: 'string' },
        profile_path: { type: 'string' },
        profile_json: { type: 'string' },
        step: { type: 'string' },
        execute: { type: 'boolean' },
        confirm_resource_use: { type: 'boolean' },
        handoff_status: { type: 'string', enum: ['opened', 'reviewed', 'unavailable', 'blocked'] },
        handoff_url: { type: 'string' },
        handoff_error: { type: 'string' },
        timeout_ms: { type: 'integer' },
        max_output_bytes: { type: 'integer' },
      },
      required: ['package_dir', 'step'],
      additionalProperties: false,
    },
    handler: remoteExecuteStep,
  },
  {
    name: 'lp_flow_build_summary_command',
    description: 'Build the deterministic command for scripts/server-docking-pipeline/build_summary_wide.py without executing it.',
    inputSchema: {
      type: 'object',
      properties: {
        run_dir: { type: 'string' },
        methods: { type: 'array', items: { type: 'string' } },
        out: { type: 'string' },
        python: { type: 'string' },
      },
      required: ['run_dir'],
      additionalProperties: false,
    },
    handler: buildSummaryCommand,
  },
  {
    name: 'lp_flow_inspect_results',
    description: 'Inspect a local run/results folder for docking outputs, summary shape, and optionally strict Burrete pose/trajectory handoff evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        results_dir: { type: 'string' },
        strict: { type: 'boolean' },
      },
      required: ['results_dir'],
      additionalProperties: false,
    },
    handler: inspectResults,
  },
];

const PUBLIC_TOOL_NAMES = new Set([
  'lp_flow_plugin_status',
  'lp_flow_md_connect_check',
  'lp_flow_md_submit',
  'lp_flow_md_status',
  'lp_flow_md_log',
  'lp_flow_md_result',
  'lp_flow_md_analyze_tpr',
  'lp_flow_prepare_redocking_case',
  'lp_flow_run_docking',
  'lp_flow_remote_command_plan',
  'lp_flow_remote_execute_step',
]);

const ADVANCED_TOOL_NAMES = new Set([
  'lp_flow_remote_session_open',
  'lp_flow_remote_session_check',
  'lp_flow_remote_session_close',
]);

const INTERNAL_TOOL_DESCRIPTION_PREFIX = 'Internal tool. Use high-level public workflow tools unless maintaining the plugin.';

function toolVisibility(tool) {
  if (PUBLIC_TOOL_NAMES.has(tool.name)) return 'public';
  if (ADVANCED_TOOL_NAMES.has(tool.name)) return 'advanced';
  return 'internal';
}

function toolDiscoveryMode(input = {}) {
  const raw = normalizeString(input.visibility || input.mode || input.discovery || input.scope).toLowerCase();
  if (raw === 'internal' || raw === 'all') return 'internal';
  if (raw === 'advanced') return 'advanced';
  if (explicitTrue(input.internal) || explicitTrue(input.include_internal) || explicitTrue(input.includeInternal)) return 'internal';
  if (explicitTrue(input.advanced) || explicitTrue(input.include_advanced) || explicitTrue(input.includeAdvanced)) return 'advanced';
  return 'public';
}

function includeToolInMode(tool, mode) {
  const visibility = toolVisibility(tool);
  if (mode === 'internal') return true;
  if (mode === 'advanced') return visibility === 'public' || visibility === 'advanced';
  return visibility === 'public';
}

function cloneSchema(schema) {
  return JSON.parse(JSON.stringify(schema || { type: 'object', properties: {}, additionalProperties: false }));
}

function visibleToolSchema(tool) {
  return cloneSchema(tool.inputSchema);
}

const BASE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
  },
  additionalProperties: true,
};

const TOOL_OUTPUT_SCHEMAS = {
  lp_flow_plugin_status: {
    ...BASE_OUTPUT_SCHEMA,
    required: ['ok', 'version', 'tools', 'configured_profile_count'],
    properties: {
      ...BASE_OUTPUT_SCHEMA.properties,
      version: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      configured_profile_count: { type: 'integer', minimum: 0 },
      recommended_next_step: { type: 'string' },
    },
  },
  lp_flow_run_docking: {
    ...BASE_OUTPUT_SCHEMA,
    properties: {
      ...BASE_OUTPUT_SCHEMA.properties,
      package_dir: { type: 'string' },
      manifest: { type: 'string' },
      methods: { type: 'array', items: { type: 'string' } },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  },
  lp_flow_remote_command_plan: {
    ...BASE_OUTPUT_SCHEMA,
    properties: { ...BASE_OUTPUT_SCHEMA.properties, steps: { type: 'array' }, allowed_execute_steps: { type: 'array', items: { type: 'string' } } },
  },
  lp_flow_remote_execute_step: {
    ...BASE_OUTPUT_SCHEMA,
    properties: {
      ...BASE_OUTPUT_SCHEMA.properties,
      executed: { type: 'boolean' },
      step: { type: 'string' },
      command_count: { type: 'integer', minimum: 0 },
      results: { type: 'array' },
      timed_out: { type: 'boolean' },
    },
  },
  lp_flow_md_submit: {
    ...BASE_OUTPUT_SCHEMA,
    properties: { ...BASE_OUTPUT_SCHEMA.properties, executed: { type: 'boolean' }, job_id: { type: 'string' }, remote_dir: { type: 'string' }, status: { type: 'string' } },
  },
  lp_flow_md_status: {
    ...BASE_OUTPUT_SCHEMA,
    properties: { ...BASE_OUTPUT_SCHEMA.properties, job_id: { type: 'string' }, remote_dir: { type: 'string' }, log_tail: { type: 'string' } },
  },
  lp_flow_md_result: {
    ...BASE_OUTPUT_SCHEMA,
    properties: { ...BASE_OUTPUT_SCHEMA.properties, remote_archive: { type: 'string' }, local_archive: { type: 'string' }, checksum: { type: 'string' } },
  },
};

function toolDescriptor(tool, mode, options = {}) {
  const visibility = toolVisibility(tool);
  const description = visibility === 'internal'
    ? `${INTERNAL_TOOL_DESCRIPTION_PREFIX} ${tool.description}`
    : tool.description;
  const descriptor = {
    name: tool.name,
    title: TOOL_PRESENTATION[tool.name]?.title || tool.name,
    description,
    annotations: TOOL_PRESENTATION[tool.name]?.annotations || {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
  if (options.includeSchema) {
    descriptor.inputSchema = visibleToolSchema(tool, mode);
    descriptor.outputSchema = TOOL_OUTPUT_SCHEMAS[tool.name] || BASE_OUTPUT_SCHEMA;
  }
  return descriptor;
}

function listToolDescriptors(mode = 'public', options = {}) {
  return TOOLS
    .filter(tool => includeToolInMode(tool, mode))
    .map(tool => toolDescriptor(tool, mode, options));
}

function getTool(name) {
  return TOOLS.find(tool => tool.name === name);
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

async function callTool(name, args, mode = 'public') {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!includeToolInMode(tool, mode)) throw new Error(`Tool is not available in ${mode} MCP visibility: ${name}`);
  return await tool.handler(args || {});
}

function mcpResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpToolResult(result) {
  const isHub = result?.kind === 'molstar-viewer-hub' || Boolean(result?.hubUrl);
  const viewerUrl = normalizeString(result?.hubUrl || result?.viewerUrl || result?.viewerResource?.uri);
  if (!viewerUrl) {
    return {
      content: [{ type: 'text', text: jsonText(result) }],
      structuredContent: result && typeof result === 'object' ? result : { result },
      isError: Boolean(result?.ok === false),
    };
  }
  const resource = {
    uri: viewerUrl,
    mimeType: 'text/html',
    text: isHub
      ? 'Interactive Mol* Stories hub intended for one Codex preview tab. Open hubUrl only; switch stories inside the hub.'
      : 'Interactive Mol* viewer intended for Codex preview when the host supports preview/navigation.',
  };
  const label = isHub ? 'Viewer hub is running' : 'Viewer is running';
  return {
    content: [
      { type: 'text', text: `${label}: ${viewerUrl}\n\n${jsonText(result)}` },
      { type: 'resource', resource },
    ],
    structuredContent: result,
    _meta: {
      viewer: {
        kind: result.kind || 'molstar-viewer',
        viewerType: result.viewerType || result.viewer || 'molstory',
        displayIntent: result.displayIntent || 'open-in-codex-preview',
        viewerUrl: isHub ? undefined : viewerUrl,
        hubUrl: isHub ? viewerUrl : undefined,
        viewerUrls: isHub ? (result.viewerUrls || []) : undefined,
        artifact: result.artifact || null,
        served: Boolean(result.served),
        port: result.port || portFromViewerUrl(viewerUrl),
        externalBrowserOpenRequested: Boolean(result.externalBrowserOpenRequested),
        codexPreviewRequested: Boolean(result.codexPreviewRequested),
        codexPreview: result.codexPreview || (isHub ? codexPreviewHubInstructions(viewerUrl) : codexPreviewInstructions(viewerUrl)),
      },
    },
    isError: Boolean(result?.ok === false),
  };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function sendMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-11-25']);

async function handleMcpMessage(message, session) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    sendMessage(mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const { id, method, params } = message;
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    sendMessage(mcpError(id ?? null, -32600, 'Invalid Request'));
    return;
  }
  if (method === 'notifications/initialized') {
    if (session.initializeResponded) session.initialized = true;
    return;
  }
  if (method === 'notifications/cancelled') return;
  if (id === undefined && method.startsWith('notifications/')) return;
  try {
    if (method === 'initialize') {
      const requestedVersion = normalizeString(params?.protocolVersion);
      if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)) {
        sendMessage(mcpError(id, -32602, `Unsupported MCP protocol version: ${requestedVersion || 'missing'}`));
        return;
      }
      session.initializeResponded = true;
      sendMessage(mcpResponse(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'lp-flow', version: PLUGIN_VERSION },
        instructions: 'Validate inputs and a configured profile before heavy work. A run package or dry-run is not a scientific result. Heavy remote execution requires explicit confirmation. Visualization is complete only after a Burrete open/status record. Do not remove user data outside the configured run root.',
      }));
      return;
    }
    if (!session.initialized) {
      sendMessage(mcpError(id, -32002, 'Server not initialized'));
      return;
    }
    if (method === 'tools/list') {
      const mode = toolDiscoveryMode(params || {});
      sendMessage(mcpResponse(id, {
        tools: listToolDescriptors(mode, { includeSchema: true }),
      }));
      return;
    }
    if (method === 'tools/call') {
      const mode = toolDiscoveryMode(params || {});
      const result = await callTool(params?.name, params?.arguments || {}, mode);
      sendMessage(mcpResponse(id, mcpToolResult(result)));
      return;
    }
    if (method === 'ping') {
      sendMessage(mcpResponse(id, {}));
      return;
    }
    sendMessage(mcpError(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === 'tools/call') {
      sendMessage(mcpResponse(id, {
        content: [{ type: 'text', text: messageText }],
        isError: true,
      }));
    } else {
      sendMessage(mcpError(id, -32603, messageText));
    }
  }
}

function startMcpServer() {
  if (typeof process === 'undefined') throw new Error('process is required to start the MCP stdio server');
  let buffer = '';
  let messageQueue = Promise.resolve();
  const session = { initializeResponded: false, initialized: false };
  const enqueue = message => {
    messageQueue = messageQueue.then(() => handleMcpMessage(message, session)).catch(error => {
      sendMessage(mcpError(null, -32603, error instanceof Error ? error.message : String(error)));
    });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const rawBody = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!rawBody) continue;
      try {
        enqueue(JSON.parse(rawBody));
      } catch (error) {
        sendMessage(mcpError(null, -32700, error instanceof Error ? error.message : String(error)));
      }
    }
  });
}

function parseCliArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      result._.push(item);
      continue;
    }
    const withoutPrefix = item.slice(2);
    const eq = withoutPrefix.indexOf('=');
    const key = eq >= 0 ? withoutPrefix.slice(0, eq) : withoutPrefix;
    let value = eq >= 0 ? withoutPrefix.slice(eq + 1) : true;
    if (value === true && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    const normalizedKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(result, normalizedKey)) {
      if (!Array.isArray(result[normalizedKey])) result[normalizedKey] = [result[normalizedKey]];
      result[normalizedKey].push(value);
    } else {
      result[normalizedKey] = value;
    }
  }
  return result;
}

function parseScalarConfigValue(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(item => parseScalarConfigValue(item)).filter(item => item !== '');
  }
  return value;
}

function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = text.split(/\r?\n/);
  for (const originalLine of lines) {
    const withoutComment = originalLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)?.[0].length || 0;
    const line = withoutComment.trim();
    const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) throw new Error(`Unsupported YAML line: ${originalLine}`);
    const [, key, rawValue = ''] = match;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (rawValue === '') {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalarConfigValue(rawValue);
    }
  }
  return root;
}

async function loadWorkflowConfig(configPathRaw) {
  const configPath = normalizeString(configPathRaw);
  if (!configPath) throw new Error('config is required. Pass --config <config.json|config.yaml> for run docking.');
  const resolved = path.resolve(configPath);
  const raw = (await fs.readFile(resolved, 'utf8')).replace(/^\uFEFF/, '');
  const suffix = path.extname(resolved).toLowerCase();
  try {
    if (suffix === '.json') return { path: resolved, config: JSON.parse(raw) };
    if (['.yaml', '.yml'].includes(suffix)) return { path: resolved, config: parseSimpleYaml(raw) };
    return { path: resolved, config: JSON.parse(raw) };
  } catch (error) {
    if (!['.yaml', '.yml'].includes(suffix)) {
      try {
        return { path: resolved, config: parseSimpleYaml(raw) };
      } catch {
        // Fall through to the original error.
      }
    }
    throw new Error(`Failed to parse config ${resolved}: ${error instanceof Error ? error.message : String(error)}. Use JSON or simple key/value YAML, or pass explicit CLI flags.`);
  }
}

function mergeConfigWithArgs(config, args) {
  const merged = { ...(config || {}) };
  for (const [key, value] of Object.entries(args || {})) {
    if (key === '_' || key === 'config') continue;
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}

async function runDockingWorkflow(args) {
  const outDir = normalizeString(args.out_dir || args.outDir);
  if (!outDir) throw new Error('out-dir is required. Use run docking --config <config.yaml|json> --out-dir <package_dir>.');
  const loaded = await loadWorkflowConfig(args.config);
  const input = mergeConfigWithArgs(loaded.config, args);
  input.out_dir = outDir;
  input.folder = input.folder || input.task_dir || input.taskDir || input.input;
  if (!input.folder) {
    throw new Error('Docking config must provide folder/task_dir/input pointing to the user-provided docking case folder.');
  }
  const result = await writeRunPackage(input);
  return {
    ...result,
    workflow: 'run docking',
    phase: 'prepare_run_package',
    config_path: loaded.path,
    executed_remote: false,
    note: 'Prepared a local run package only. Inspect remote-command-plan, then execute upload/preflight/check_docking_scheduler/run_docking_payload/status, open Burrete pose review before MD, run CPU MD smoke, open Burrete trajectory review, package and download. No hidden cluster paths or validation datasets were used.',
  };
}

function printRunHelp() {
  console.log(`LP-Flow CLI - run

Usage:
  lp-flow run docking --config <config.yaml|json> --out-dir <package_dir>

Implemented workflow:
  run docking prepares a local run package from a user-provided config and output directory.
  It does not start remote compute by itself.

Notes:
  Existing run-package commands remain available:
    build-run-plan -> write-run-package -> remote-command-plan -> remote-execute-step
  Server/profile/tool paths must come from config/profile/flags/env, never hidden defaults.`);
}

function printRunDockingHelp() {
  console.log(`LP-Flow CLI - run docking

Usage:
  lp-flow run docking --config <config.yaml|json> --out-dir <package_dir>

Required config fields:
  folder/task_dir/input          User-provided docking case folder.
  profile/profile_path/profile_json/profile_name
  active_site or center+size or reference_ligand_remote_path
  gnina                         Required for GNINA or Matcha methods.
  obabel                        Required for receptor/ligand preparation.
  smina                         Required for SMINA method.

Optional:
  methods                       Comma-separated list: gnina,smina,boltz,matcha.
  gpu_id, exhaustiveness, num_modes, matcha_samples.

Behavior:
  Prepares a local run package in --out-dir.
  Does not execute SSH, GPU work, or cleanup.
  Use remote-command-plan and remote-execute-step for explicit steps:
    upload -> preflight -> check_docking_scheduler -> run_docking_payload -> check_docking_payload_status
    -> open_burrete_pose_review -> check_md_scheduler -> run_md_from_best_pose
    -> check_md_from_best_pose_status -> open_burrete_trajectory_review
    -> package_results -> download_archive
  No bundled validation datasets or hidden cluster paths are used.`);
}

function printAdvancedHelp() {
  console.log(`LP-Flow MCP-as-CLI - advanced surface

Usage:
  node scripts/lp-flow.mjs --help --advanced
  node scripts/lp-flow.mjs list-tools --advanced

Public workflows:
  node scripts/lp-flow.mjs run docking --config <config.yaml|json> --out-dir <package-dir>
  node scripts/lp-flow.mjs md <connect|submit|status|log|result|analyze-tpr> ...

Advanced workflows:
  node scripts/lp-flow.mjs session open --profile-name <profile> --persist 8h --execute true
  node scripts/lp-flow.mjs session check --profile-name <profile> --execute true
  node scripts/lp-flow.mjs session close --profile-name <profile> --execute true

Session lifecycle commands are advanced because they open or close a persistent local SSH control socket. They require --execute true.`);
}

function printInternalHelp() {
  console.log(`LP-Flow MCP-as-CLI - internal maintenance surface

Internal maintenance policy:
  These commands are preserved for direct calls, scripts, and plugin maintenance.
  They are not part of the normal public user workflow.

Internal maintenance commands:
  node scripts/lp-flow.mjs validate-case --folder <task-folder>
  node scripts/lp-flow.mjs find-case --input <folder|receptor|pdb-id> [--root <search-root>]
  node scripts/lp-flow.mjs resolve-profile --profile-name <local-profile>
  node scripts/lp-flow.mjs build-run-plan --folder <task-folder> --profile-name <local-profile> --gnina <path>
  node scripts/lp-flow.mjs write-run-package --folder <task-folder> --profile-path <profile.json> --out-dir <dir>
  node scripts/lp-flow.mjs build-docking-payload --package-dir <run-package-dir>
  node scripts/lp-flow.mjs remote-command-plan --package-dir <run-package-dir> --profile-name <local-profile>
  node scripts/lp-flow.mjs remote-execute-step --package-dir <run-package-dir> --profile-name <local-profile> --step <step> [--execute true]
  node scripts/lp-flow.mjs build-summary-command --run-dir <results-or-run-dir>
  node scripts/lp-flow.mjs inspect-results --results-dir <results-dir> [--strict]
  node scripts/lp-flow.mjs safe-cleanup-check --allowed-root <remote-root> --run-dir <remote-run-dir>
  node scripts/lp-flow.mjs list-tools --internal
Package policy:
  No bundled validation datasets or hidden machine/server path defaults are used.`);
}

function printHelp(mode = 'public') {
  if (mode === 'advanced') {
    printAdvancedHelp();
    return;
  }
  if (mode === 'internal') {
    printInternalHelp();
    return;
  }
  console.log(`LP-Flow MCP-as-CLI

Usage:
  node scripts/lp-flow.mjs mcp
  node scripts/lp-flow.mjs status
  node scripts/lp-flow.mjs list-tools
  node scripts/lp-flow.mjs prepare-redocking-case --pdb-id <pdb> --out-dir <case-dir> --profile-name <profile>
  node scripts/lp-flow.mjs md <connect|submit|status|log|result|analyze-tpr> --profile-name <profile> ...
  node scripts/lp-flow.mjs run docking --config <config.yaml|json> --out-dir <package-dir>

Workflow commands:
  run --help
  md --help

Discovery:
  list-tools              Public MCP tools only.
  list-tools --advanced   Public + advanced MCP tools.
  list-tools --internal   Public + advanced + internal/compatibility MCP tools.

More help:
  --help --advanced       Persistent runtime session commands.
  --help --internal       Low-level package and inspection commands.

Package policy:
  No bundled validation datasets or hidden machine/server path defaults are used.

Visualization policy:
  Use Burrete for ordinary molecular viewing, pose review, and trajectory review.

The same public operations are exposed as MCP tools when running the "mcp" command.`);
}

function printMdHelp() {
  console.log(`LP-Flow CLI - md

Usage:
  node scripts/lp-flow.mjs md connect --profile-name <profile>
  node scripts/lp-flow.mjs md submit --remote-dir <remote-run-dir> --script scripts/run_md.sh --job-id <id> --execute true --profile-name <profile>
  node scripts/lp-flow.mjs md status --remote-dir <remote-run-dir> --job-id <id> --profile-name <profile>
  node scripts/lp-flow.mjs md log --remote-dir <remote-run-dir> --job-id <id> [--lines 200] --profile-name <profile>
  node scripts/lp-flow.mjs md result --remote-dir <remote-run-dir> [--download true --out-dir <local-dir>] --profile-name <profile>
  node scripts/lp-flow.mjs md analyze-tpr --tpr <remote.tpr> --gmx <remote-gmx-path> [--ld-library-path <paths>] --profile-name <profile>
  node scripts/lp-flow.mjs md smoke-template --out-dir <md_smoke_package> --ligand-charge <int> [--receptor input/receptor.pdb --pose input/top_pose.sdf]
  node scripts/lp-flow.mjs md trajectory-manifest --out <trajectory_manifest.json> --display <md_nowater_multimodel.pdb> [--trajectory <md.xtc>] [--topology <md.tpr>]

Policy:
  MD commands require explicit remote_dir/tpr paths under the profile remote_work_root.
  submit runs only a relative .sh script inside remote_dir.
  smoke-template writes a package contract and script template; it is not a completed MD run.
  trajectory-manifest writes the Burrete handoff contract: display is bounded no-water multi-frame PDB; native .xtc/.tpr/topology are provenance.
  For Burrete workflow completion, use a bounded no-water multi-frame PDB display artifact and keep native .xtc/.tpr/topology for interpretation/provenance.
  SSH ControlMaster/ControlPersist is enabled by default on Unix-like hosts, disabled by default on Windows, and can be pre-opened with session open --persist 8h when supported.
  On Windows, use the normal non-multiplexed fallback or explicitly opt in with ssh_control_master=true / LP_FLOW_SSH_CONTROLMASTER=1 after verifying the SSH client supports it.
  Resource allocation follows the configured scheduler profile. GPU use, when requested by a payload, is selected by the scheduler rather than a polling watcher.`);
}

function printSessionHelp() {
  console.log(`LP-Flow CLI - session

Usage:
  node scripts/lp-flow.mjs session open --profile-name <profile> --persist 8h --execute true
  node scripts/lp-flow.mjs session check --profile-name <profile> --execute true
  node scripts/lp-flow.mjs session close --profile-name <profile> --execute true

Policy:
  session open starts a background OpenSSH ControlMaster and defaults to ControlPersist=8h.
  Workflow commands still use SSH/SCP as the transport internally, but they reuse the same ControlPath and do not create a fresh SSH login.
  The default is dry-run. Use --execute true only when the user intentionally wants to open/check/close the session.
  Disable multiplexing with ssh_control_master=false in a private profile or LP_FLOW_SSH_CONTROLMASTER=0.`);
}

function helpModeFromArgs(args = []) {
  const values = args.map(value => normalizeString(value).toLowerCase()).filter(Boolean);
  if (values.includes('--internal') || values.includes('internal')) return 'internal';
  if (values.includes('--advanced') || values.includes('advanced')) return 'advanced';
  return 'public';
}

async function main() {
  if (typeof process === 'undefined') throw new Error('process is required for CLI mode');
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp(helpModeFromArgs(rest));
    return;
  }
  if (command === 'mcp') {
    startMcpServer();
    return;
  }
  if (command === 'list-tools') {
    const args = parseCliArgs(rest);
    console.log(jsonText(listToolDescriptors(toolDiscoveryMode(args))));
    return;
  }
  if (command === 'md') {
    const [action, ...actionRest] = rest;
    if (!action || action === '--help' || action === '-h' || action === 'help') {
      printMdHelp();
      return;
    }
    if (actionRest.includes('--help') || actionRest.includes('-h')) {
      printMdHelp();
      return;
    }
    const args = parseCliArgs(actionRest);
    let result;
    if (action === 'connect') result = await mdConnectCheck(args);
    else if (action === 'submit') result = await mdSubmit(args);
    else if (action === 'status') result = await mdStatus(args);
    else if (action === 'log') result = await mdLog(args);
    else if (action === 'result') result = await mdResult(args);
    else if (action === 'analyze-tpr') result = await mdAnalyzeTpr(args);
    else if (action === 'smoke-template') result = await writeMdSmokeTemplate(args);
    else if (action === 'trajectory-manifest' || action === 'write-trajectory-manifest') result = await writeMdTrajectoryManifest(args);
    else throw new Error(`Unknown md action: ${action}`);
    console.log(jsonText(result));
    if (result?.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'session' || command === 'ssh-session' || command === 'remote-session') {
    const [action, ...actionRest] = rest;
    if (!action || action === '--help' || action === '-h' || action === 'help') {
      printSessionHelp();
      return;
    }
    if (actionRest.includes('--help') || actionRest.includes('-h')) {
      printSessionHelp();
      return;
    }
    const args = parseCliArgs(actionRest);
    let result;
    if (action === 'open' || action === 'start') result = await remoteSessionOpen(args);
    else if (action === 'check' || action === 'status') result = await remoteSessionCheck(args);
    else if (action === 'close' || action === 'stop' || action === 'exit') result = await remoteSessionClose(args);
    else throw new Error(`Unknown session action: ${action}`);
    console.log(jsonText(result));
    if (result?.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'run') {
    const [workflow, ...workflowRest] = rest;
    if (!workflow || workflow === '--help' || workflow === '-h' || workflow === 'help') {
      printRunHelp();
      return;
    }
    const args = parseCliArgs(workflowRest);
    if (workflow === 'docking') {
      if (workflowRest.includes('--help') || workflowRest.includes('-h')) {
        printRunDockingHelp();
        return;
      }
      const result = await runDockingWorkflow(args);
      console.log(jsonText(result));
      if (result?.ok === false) process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown run workflow: ${workflow}`);
  }
  const args = parseCliArgs(rest);
  let result;
  if (command === 'status') result = await pluginStatus();
  else if (command === 'prepare-redocking-case') result = await prepareRedockingCase(args);
  else if (command === 'validate-case') result = await validateCaseFolder(args);
  else if (command === 'find-case') result = await findCaseFolder({ input: args.input || args._[0], roots: args.root ? (Array.isArray(args.root) ? args.root : [args.root]) : undefined });
  else if (command === 'resolve-profile') result = await resolveProfile(args);
  else if (command === 'build-run-plan') result = await buildRunPlan({ ...args, methods: args.methods });
  else if (command === 'write-run-package') result = await writeRunPackage({ ...args, methods: args.methods });
  else if (command === 'build-docking-payload') result = await buildDockingPayload({ ...args, methods: args.methods });
  else if (command === 'remote-command-plan') result = await buildRemoteCommandPlan(args);
  else if (command === 'remote-execute-step') result = await remoteExecuteStep(args);
  else if (command === 'build-summary-command') result = buildSummaryCommand({ ...args, methods: args.methods });
  else if (command === 'inspect-results') result = await inspectResults(args);
  else if (command === 'safe-cleanup-check') result = safeRemoteCleanupCheck(args);
  else throw new Error(`Unknown command: ${command}`);
  console.log(jsonText(result));
  if (result?.ok === false) process.exitCode = 1;
}

function isCliEntrypoint() {
  if (typeof process === 'undefined' || !process.argv || !process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

export {
  buildDockingPayload,
  buildRemoteCommandPlan,
  buildRunPlan,
  buildSummaryCommand,
  classifySlurmEligibilityOutput,
  classifySlurmQueueOutput,
  callTool,
  findCaseFolder,
  inspectResults,
  remoteSessionCheck,
  remoteSessionClose,
  remoteSessionOpen,
  mdAnalyzeTpr,
  mdConnectCheck,
  mdLog,
  mdResult,
  mdStatus,
  mdSubmit,
  prepareRedockingCase,
  pluginStatus,
  remoteExecuteStep,
  resolveProfile,
  safeRemoteCleanupCheck,
  startMcpServer,
  validateCaseFolder,
  writeRunPackage,
};

if (isCliEntrypoint()) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
