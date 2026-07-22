#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const entrypoint = path.join(repoRoot, 'scripts', 'lp-flow.mjs');
const node = process.execPath;
const { classifySlurmEligibilityOutput, classifySlurmQueueOutput } = await import(pathToFileURL(entrypoint).href);
const keepTemp = process.argv.includes('--keep-temp');
const failures = [];
const passes = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  passes.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function runCli(args, label, options = {}) {
  const result = spawnSync(node, [entrypoint, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  assert(!result.error, `${label}: failed to start: ${result.error?.message}`);
  if (options.expectStatus === undefined) {
    assert(result.status === 0, `${label}: expected exit 0, got ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  } else {
    assert(result.status === options.expectStatus, `${label}: expected exit ${options.expectStatus}, got ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    text: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`${label}: failed to parse JSON: ${error.message}\n${result.stdout}`);
    return null;
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureFile(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function tinyReceptorPdb() {
  return [
    'HEADER    LP-FLOW EXECUTION SMOKE RECEPTOR',
    'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 20.00           N',
    'ATOM      2  CA  ALA A   1       1.458   0.000   0.000  1.00 20.00           C',
    'ATOM      3  C   ALA A   1       1.958   1.420   0.000  1.00 20.00           C',
    'ATOM      4  O   ALA A   1       1.250   2.380   0.000  1.00 20.00           O',
    'TER',
    'END',
    '',
  ].join('\n');
}

function tinyLigandSdf() {
  return [
    'lp_flow_smoke_ligand',
    '  LP-Flow',
    '',
    '  1  0  0  0  0  0            999 V2000',
    '    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0',
    'M  END',
    '$$$$',
    '',
  ].join('\n');
}

function tinyLigandPdb() {
  return [
    'HETATM    1  C1  LIG A   1       0.000   0.000   0.000  1.00 20.00           C',
    'END',
    '',
  ].join('\n');
}

function tinyGro() {
  return [
    'LP-Flow execution smoke',
    '1',
    '    1ALA      N    1   0.000   0.000   0.000',
    '   1.00000   1.00000   1.00000',
    '',
  ].join('\n');
}

function tinyMultimodelPdb() {
  return [
    'MODEL        1',
    'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 20.00           N',
    'ENDMDL',
    'MODEL        2',
    'ATOM      1  N   ALA A   1       0.010   0.000   0.000  1.00 20.00           N',
    'ENDMDL',
    'END',
    '',
  ].join('\n');
}

function createFixture(root) {
  const caseDir = path.join(root, 'case');
  const packageDir = path.join(root, 'run_package');
  const mdDir = path.join(root, 'md');
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(mdDir, { recursive: true });

  ensureFile(path.join(caseDir, 'receptor.pdb'), tinyReceptorPdb());
  ensureFile(path.join(caseDir, 'full_complex.pdb'), tinyReceptorPdb());
  ensureFile(path.join(caseDir, 'ligand.sdf'), tinyLigandSdf());
  ensureFile(path.join(mdDir, 'reference.gro'), tinyGro());
  ensureFile(path.join(mdDir, 'trajectory.xtc'), 'LP_FLOW_EXECUTION_SMOKE_TRAJECTORY_PLACEHOLDER\n');
  ensureFile(path.join(mdDir, 'md_nowater_multimodel.pdb'), tinyMultimodelPdb());
  ensureFile(path.join(mdDir, 'md.tpr'), 'LP_FLOW_EXECUTION_SMOKE_TPR_PLACEHOLDER\n');

  const profilePath = path.join(root, 'profile.json');
  writeJson(profilePath, {
    profile_name: 'execution-smoke',
    ssh_alias: 'execution-smoke-host',
    username: 'execution_smoke_user',
    remote_work_root: '/home/execution_smoke_user/lp_flow_runs',
    shared_software_policy: 'read_only',
    gpu_policy: 'check_before_use',
    gnina: '/opt/lp-flow/bin/gnina',
    smina: '/opt/lp-flow/bin/smina',
    obabel: '/opt/lp-flow/bin/obabel',
    ligand_charge: 0,
    acpype: '/opt/lp-flow/bin/acpype',
    gromacs: '/opt/gromacs/bin/gmx',
    matcha_checkout: '/opt/matcha',
    matcha_python: '/opt/matcha/.venv/bin/python',
    matcha_checkpoints: '/opt/matcha/checkpoints',
  });

  const configPath = path.join(root, 'docking_config.json');
  writeJson(configPath, {
    folder: caseDir,
    profile_path: profilePath,
    methods: ['gnina', 'smina', 'matcha'],
    receptor: 'receptor.pdb',
    ligands: ['ligand.sdf'],
    active_site: {
      center: [0, 0, 0],
      size: [12, 12, 12],
    },
    gnina: '/opt/lp-flow/bin/gnina',
    smina: '/opt/lp-flow/bin/smina',
    obabel: '/opt/lp-flow/bin/obabel',
    ligand_charge: 0,
    ligand_charge_source: 'fixture_explicit_formal_charge',
    timestamp: 'execution_smoke',
  });

  return {
    caseDir,
    packageDir,
    mdDir,
    profilePath,
    configPath,
    remoteDir: '/home/execution_smoke_user/lp_flow_runs/md_execution_smoke',
    mdScript: 'scripts/run_md.sh',
  };
}

function readPackageJson(packageDir, name) {
  const filePath = path.join(packageDir, name);
  assert(existsSync(filePath), `expected package file: ${filePath}`);
  return existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : null;
}

function checkStatusAndDiscovery() {
  const status = parseJson(runCli(['status'], 'status'), 'status');
  assert(status?.ok === true, 'status: expected ok=true');
  assert(status?.plugin_root === '<installed-plugin>', 'status: expected redacted plugin_root');
  assert(status?.mcp_config === '.mcp.json', 'status: expected relative mcp_config');
  assert(typeof status?.configured_profile_count === 'number', 'status: expected configured_profile_count');
  const tools = parseJson(runCli(['list-tools'], 'list-tools'), 'list-tools') || [];
  const names = tools.map(tool => tool.name);
  for (const name of ['lp_flow_run_docking', 'lp_flow_md_submit']) {
    assert(names.includes(name), `list-tools: expected ${name}`);
  }
  assert(!names.includes('lp_flow_md_trajectory_serve'), 'list-tools: legacy trajectory viewer must stay hidden from public discovery');
  pass('runtime discovery/status/list-tools execute successfully');
}

function checkDockingRunPackage(fixture) {
  const result = parseJson(
    runCli(['run', 'docking', '--config', fixture.configPath, '--out-dir', fixture.packageDir], 'run docking'),
    'run docking',
  );
  assert(result?.workflow === 'run docking', 'run docking: expected workflow label');
  assert(result?.phase === 'prepare_run_package', 'run docking: expected explicit package-preparation phase');
  assert(result?.ok === true, `run docking: expected ok=true, got ${JSON.stringify(result?.needs || result?.payload_errors || result)}`);
  assert(result?.executed_remote === false, 'run docking: must not execute remote compute');
  assert(result?.out_dir === fixture.packageDir, 'run docking: expected requested output directory');

  for (const file of [
    'run_plan.json',
    'upload_manifest.json',
    'download_manifest.json',
    'remote_preflight.sh',
    'remote_docking_payload.sh',
    path.join('scripts', 'run_md_from_best_pose.sh'),
    'run_manifest.json',
    'build_summary_wide.py',
    'commands.txt',
  ]) {
    assert(existsSync(path.join(fixture.packageDir, file)), `run package missing ${file}`);
  }
  assert(!existsSync(path.join(fixture.packageDir, 'gpu_watcher.sh')), 'run package: scheduler-backed packages must not stage gpu_watcher.sh');

  const plan = readPackageJson(fixture.packageDir, 'run_plan.json');
  assert(plan?.ok === true, 'run_plan: expected ok=true');
  assert(JSON.stringify(plan?.methods) === JSON.stringify(['gnina', 'smina', 'matcha']), `run_plan: expected methods gnina,smina,matcha, got ${JSON.stringify(plan?.methods)}`);
  assert(plan?.active_site?.mode !== 'missing', 'run_plan: expected active_site');
  assert(plan?.inputs?.receptor?.relative_path === 'receptor.pdb', 'run_plan: expected receptor staged');
  assert(plan?.inputs?.ligands?.length === 1, 'run_plan: expected one ligand');
  assert(plan.inputs.ligands[0]?.relative_path === 'ligand.sdf', 'run_plan: explicit ligands must override receptor-like files in the task folder');
  assert(plan?.remote?.run_dir?.startsWith('/home/execution_smoke_user/lp_flow_runs/'), 'run_plan: remote run dir must stay inside profile root');
  assert(
    plan?.remote_commands?.package_results?.includes('--exclude') && plan.remote_commands.package_results.includes('/boltz/cache'),
    'run_plan: package_results must exclude heavy runtime caches',
  );
  assert(
    plan?.remote_commands?.run_docking_payload?.includes('.lp_flow_remote_payload.lock') &&
      plan.remote_commands.run_docking_payload.includes('mkdir "$lock"') &&
      plan.remote_commands.run_docking_payload.includes('lock was stale; removing'),
    'run_plan: resource-intensive payload must use the remote single-run lock',
  );

  const upload = readPackageJson(fixture.packageDir, 'upload_manifest.json');
  assert(Array.isArray(upload) && upload.length >= 2, 'upload_manifest: expected input and script uploads');
  assert(upload.some(item => item.role === 'receptor'), 'upload_manifest: expected receptor upload');
  assert(upload.some(item => item.role === 'ligand'), 'upload_manifest: expected ligand upload');
  assert(upload.some(item => item.role === 'script' && item.remote_path.endsWith('/remote_docking_payload.sh')), 'upload_manifest: expected payload script upload');
  assert(upload.some(item => item.role === 'script' && item.remote_path.endsWith('/scripts/run_md_from_best_pose.sh')), 'upload_manifest: expected downstream MD script upload');
  assert(upload.some(item => item.role === 'script' && item.remote_path.endsWith('/scripts/place_ligand_from_pose.py')), 'upload_manifest: expected ligand placement helper upload');
  assert(upload.some(item => item.role === 'manifest' && item.remote_path.endsWith('/results/run_manifest.json')), 'upload_manifest: expected structured run manifest upload');

  const payload = readFileSync(path.join(fixture.packageDir, 'remote_docking_payload.sh'), 'utf8');
  assert(payload.includes('RUN_GNINA=1'), 'payload: expected GNINA enabled');
  assert(payload.includes('RUN_SMINA=1'), 'payload: expected SMINA enabled');
  assert(payload.includes('RUN_MATCHA=1'), 'payload: expected Matcha enabled when requested');
  assert(payload.includes('local status=$?') && payload.includes('if [[ "$status" -eq 0 ]]'), 'payload: command failures must preserve the real exit status');
  assert(payload.includes('MATCHA_BOX_SIZE_ARGS=') && payload.includes("grep -q -- '--size-x'"), 'payload: expected Matcha size args to be guarded by CLI help');
  assert(payload.includes('SUMMARY_METHODS='), 'payload: expected summary method plumbing');
  assert(payload.includes('runtime_status.csv'), 'payload: expected machine-readable runtime status artifact');
  assert(payload.includes('unavailable_status'), 'payload: expected unavailable status distinct from scientific failure');
  assert(payload.includes('gnina docking failed') && payload.includes('smina docking failed'), 'payload: docking command failures must become method failures');
  assert(payload.includes('summary_wide.csv generation failed') && payload.includes('exit 70'), 'payload: summary generation failure must be terminal');
  assert(payload.includes('package_ready_for_pose_review'), 'payload: expected pose-review handoff generation after docking summary');
  const mdScript = readFileSync(path.join(fixture.packageDir, 'scripts', 'run_md_from_best_pose.sh'), 'utf8');
  assert(mdScript.includes('pipeline_handoff.json not found'), 'downstream MD script: expected docking handoff guard');
  assert(mdScript.includes('pose_review_status.json not found'), 'downstream MD script: expected recorded Burrete review guard');
  assert(mdScript.includes("review_status not in {'opened', 'reviewed', 'unavailable'}"), 'downstream MD script: expected exact review status gate');
  assert(mdScript.includes('MD_SMOKE_OK'), 'downstream MD script: expected terminal success marker');
  assert(mdScript.includes('chemistry_h.mol2'), 'downstream MD script: expected clean ligand chemistry for ACPYPE');
  assert(mdScript.includes('place_ligand_from_pose.py'), 'downstream MD script: expected validated pose-placement helper');
  assert(!mdScript.includes('pose_h.mol2'), 'downstream MD script: must not parameterize the docked pose directly');
  assert(mdScript.includes('nowater_multimodel.pdb'), 'downstream MD script: expected no-water multi-model display PDB');
  assert(mdScript.includes('NVT_XTC_STRIDE=$(( (NVT_STEPS + DISPLAY_MAX_MODELS - 1) / DISPLAY_MAX_MODELS ))'), 'downstream MD script: expected 100-frame trajectory sampling');
  assert(mdScript.includes('select -s "$MD_DIR/prepared/npt.tpr"'), 'downstream MD script: expected NPT GROMACS selection');
  assert(mdScript.includes('prepared/npt.mdp'), 'downstream MD script: expected NPT setup');
  assert(mdScript.includes('pcoupl = C-rescale'), 'downstream MD script: expected C-rescale NPT pressure coupling');
  assert(mdScript.includes('refcoord_scaling = com'), 'downstream MD script: expected center-of-mass reference-coordinate scaling');
  assert(mdScript.includes('mdrun -deffnm "$MD_DIR/prepared/npt"'), 'downstream MD script: expected NPT execution');
  assert(mdScript.includes('or resname $LIGAND_RESNAME'), 'downstream MD script: expected runtime ligand resname selection');
  assert(!mdScript.includes('1 | 13'), 'downstream MD script: must not use hard-coded GROMACS group indices');
  assert(!mdScript.includes('Protein_UNL'), 'downstream MD script: must not assume UNL residue name');
  assert(mdScript.includes('receptor residues are never removed automatically'), 'downstream MD script: expected safe receptor failure policy');
  assert(mdScript.includes('-pbc mol -center -ur compact'), 'downstream MD script: expected PBC-safe display centering');
  assert(mdScript.includes('-fit rot+trans'), 'downstream MD script: expected protein-aligned display frames');
  assert(mdScript.includes('DISPLAY_MAX_MODELS="100"'), 'downstream MD script: expected 100-frame Burrete display target');
  assert(mdScript.includes('required_models = min'), 'downstream MD script: expected sparse display-frame QC');
  assert(mdScript.includes('nowater_multimodel.raw.pdb'), 'downstream MD script: expected raw PDB cleanup stage');
  assert(mdScript.includes('DISPLAY_QC_FAIL PBC-like coordinate jump'), 'downstream MD script: expected PBC-jump display QC');
  assert(mdScript.includes('display_qc.json'), 'downstream MD script: expected display QC artifact');
  assert(!mdScript.includes('-maxwarn 1'), 'downstream MD script: must not suppress GROMACS preprocessing warnings');
  const commands = readFileSync(path.join(fixture.packageDir, 'commands.txt'), 'utf8');
  assert(commands.includes('run_md_from_best_pose.sh'), 'commands.txt: expected downstream MD command');
  pass('run docking executes local package generation and validates package artifacts');
}

function checkPrepareRedockingCase(root) {
  const pdbPath = path.join(root, 'prepare_source.pdb');
  const outDir = path.join(root, 'prepared_case');
  ensureFile(pdbPath, [
    'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 20.00           N',
    'ATOM      2  CA  ALA A   1       1.500   0.000   0.000  1.00 20.00           C',
    'ATOM      3  C   ALA A   1       2.000   1.400   0.000  1.00 20.00           C',
    'ATOM      4  O   ALA A   1       1.300   2.300   0.000  1.00 20.00           O',
    'HETATM    5  C1  LIG A 101       3.000   3.000   3.000  1.00 20.00           C',
    'HETATM    6  C2  LIG A 101       4.000   3.000   3.000  1.00 20.00           C',
    'HETATM    7  O1  GOL A 102       8.000   8.000   8.000  1.00 20.00           O',
    'END',
    '',
  ].join('\n'));
  const result = parseJson(
    runCli(['prepare-redocking-case', '--pdb-file', pdbPath, '--out-dir', outDir, '--profile-name', 'execution-smoke'], 'prepare-redocking-case'),
    'prepare-redocking-case',
  );
  assert(result?.ok === true, 'prepare-redocking-case: expected ok=true');
  assert(result?.selected_ligand?.resname === 'LIG', 'prepare-redocking-case: expected co-crystal ligand LIG');
  assert(existsSync(path.join(outDir, 'receptor.pdb')), 'prepare-redocking-case: expected receptor.pdb');
  assert(existsSync(path.join(outDir, 'ligands', 'LIG.pdb')), 'prepare-redocking-case: expected ligand PDB');
  const config = JSON.parse(readFileSync(path.join(outDir, 'docking_config.json'), 'utf8'));
  assert(config.receptor === 'receptor.pdb', 'prepare-redocking-case: config should set explicit receptor');
  assert(config.ligands?.[0] === 'ligands/LIG.pdb', 'prepare-redocking-case: config should set explicit ligand');
  pass('prepare-redocking-case builds receptor/ligand/config from a co-crystal PDB');
}

function checkRemoteDryRunExecutionPlan(fixture) {
  const plan = parseJson(
    runCli(['remote-command-plan', '--package-dir', fixture.packageDir, '--profile-path', fixture.profilePath], 'remote-command-plan'),
    'remote-command-plan',
  );
  assert(plan?.ok === true, 'remote-command-plan: expected ok=true');
  const stepNames = (plan?.steps || []).map(step => step.step);
  for (const step of ['create_remote', 'upload', 'preflight', 'check_docking_scheduler', 'run_docking_payload', 'check_docking_payload_status', 'open_burrete_pose_review', 'check_md_scheduler', 'run_md_from_best_pose', 'check_md_from_best_pose_status', 'open_burrete_trajectory_review', 'package_results', 'download_archive', 'cleanup']) {
    assert(stepNames.includes(step), `remote-command-plan: missing step ${step}`);
  }
  assert(!stepNames.includes('gpu_watcher'), 'remote-command-plan: gpu_watcher must not be a default execution step');
  const createStep = (plan?.steps || []).find(step => step.step === 'create_remote');
  const createCommand = createStep?.commands?.[0]?.command_line || '';
  assert(createCommand.includes('/scripts'), 'remote-command-plan: create_remote must create the scripts directory before upload');
  const uploadStep = (plan?.steps || []).find(step => step.step === 'upload');
  const uploadDirectoryCommand = uploadStep?.commands?.[0]?.command_line || '';
  assert(uploadDirectoryCommand.includes('mkdir -p') && uploadDirectoryCommand.includes('/scripts'), 'remote-command-plan: upload must create manifest parent directories when executed independently');
  const packageStep = (plan?.steps || []).find(step => step.step === 'package_results');
  const packageCommand = packageStep?.commands?.[0]?.command_line || '';
  assert(packageCommand.includes('--exclude') && packageCommand.includes('/boltz/cache'), 'remote-command-plan: package_results must exclude heavy runtime caches');
  const payloadStep = (plan?.steps || []).find(step => step.step === 'run_docking_payload');
  const payloadCommand = payloadStep?.commands?.[0]?.command_line || '';
  assert(payloadCommand.includes('.lp_flow_remote_payload.lock'), 'remote-command-plan: run_docking_payload must include the remote single-run lock');
  assert(payloadCommand.includes('lock was stale; removing'), 'remote-command-plan: run_docking_payload must clean stale locks before failing active runs');
  assert(!payloadCommand.includes('gpu_watcher.sh'), 'remote-command-plan: run_docking_payload must not use GPU watcher as default');
  const poseReview = (plan?.steps || []).find(step => step.step === 'open_burrete_pose_review');
  assert(poseReview?.handoff === true && poseReview?.target === 'burrete:molecule-collection', 'remote-command-plan: expected Burrete pose handoff before MD');
  assert(poseReview?.status_file?.endsWith('/results/pose_review_status.json'), 'remote-command-plan: expected persistent pose-review status artifact');
  const mdStep = (plan?.steps || []).find(step => step.step === 'run_md_from_best_pose');
  const mdCommand = mdStep?.commands?.[0]?.command_line || '';
  assert(mdStep?.resource_intensive === true, 'remote-command-plan: downstream MD step must be resource_intensive');
  assert(mdCommand.includes('scripts/run_md_from_best_pose.sh'), 'remote-command-plan: downstream MD step must call run_md_from_best_pose.sh');
  assert(mdStep?.precondition_command?.command_line?.includes('pose_review_status.json'), 'remote-command-plan: MD must enforce recorded pose-review status before submit');
  const trajectoryReview = (plan?.steps || []).find(step => step.step === 'open_burrete_trajectory_review');
  assert(trajectoryReview?.handoff === true && trajectoryReview?.target === 'burrete:trajectory-review', 'remote-command-plan: expected Burrete trajectory handoff after MD');
  const cleanup = (plan?.steps || []).find(step => step.step === 'cleanup');
  assert(cleanup?.disabled === true && cleanup?.destructive === true, 'remote-command-plan: cleanup must be disabled/destructive');

  const slurmProfilePath = path.join(path.dirname(fixture.profilePath), 'profile.slurm.json');
  const slurmProfile = JSON.parse(readFileSync(fixture.profilePath, 'utf8'));
  slurmProfile.scheduler = 'slurm';
  slurmProfile.scheduler_time = '00:30:00';
  slurmProfile.scheduler_gpu_gres = 'gpu:1';
  slurmProfile.scheduler_max_queue_wait_minutes = 30;
  writeJson(slurmProfilePath, slurmProfile);
  const slurmPlan = parseJson(
    runCli(['remote-command-plan', '--package-dir', fixture.packageDir, '--profile-path', slurmProfilePath], 'remote-command-plan slurm'),
    'remote-command-plan slurm',
  );
  const slurmPayload = (slurmPlan?.steps || []).find(step => step.step === 'run_docking_payload');
  const slurmCommand = slurmPayload?.commands?.[0]?.command_line || '';
  assert(slurmPayload?.scheduler === 'slurm', 'remote-command-plan slurm: expected scheduler=slurm');
  assert(slurmCommand.includes('sbatch') && slurmCommand.includes('--wrap'), 'remote-command-plan slurm: expected sbatch submission');
  assert(slurmCommand.includes('--gres') && slurmCommand.includes('gpu:1'), 'remote-command-plan slurm: GPU-bound methods must request the configured GPU GRES');
  assert(!slurmCommand.includes('gpu_watcher.sh'), 'remote-command-plan slurm: must not use GPU watcher');
  const schedulerEligibility = (slurmPlan?.steps || []).find(step => step.step === 'check_docking_scheduler');
  const schedulerEligibilityCommand = schedulerEligibility?.commands?.[0]?.command_line || '';
  assert(schedulerEligibility?.scheduler_eligibility === true, 'remote-command-plan slurm: must expose scheduler eligibility before submission');
  assert(schedulerEligibilityCommand.includes('sbatch') && schedulerEligibilityCommand.includes('--test-only'), 'remote-command-plan slurm: eligibility must use sbatch --test-only');
  assert(schedulerEligibilityCommand.includes('--gres') && schedulerEligibilityCommand.includes('gpu:1'), 'remote-command-plan slurm: eligibility must use the same GPU GRES as submission');
  assert(slurmPayload?.scheduler_eligibility_command?.command_line?.includes('--test-only'), 'remote-command-plan slurm: payload submission must recheck eligibility before submitting');
  const gninaOnlyPackage = path.join(path.dirname(fixture.packageDir), 'run_package_gnina_only');
  runCli(['run', 'docking', '--config', fixture.configPath, '--out-dir', gninaOnlyPackage, '--methods', 'gnina'], 'run docking gnina-only');
  const gninaOnlyPlan = parseJson(
    runCli(['remote-command-plan', '--package-dir', gninaOnlyPackage, '--profile-path', slurmProfilePath], 'remote-command-plan slurm gnina-only'),
    'remote-command-plan slurm gnina-only',
  );
  const gninaOnlySubmit = (gninaOnlyPlan?.steps || []).find(step => step.step === 'run_docking_payload');
  assert(gninaOnlySubmit?.commands?.[0]?.command_line?.includes('--gres') && gninaOnlySubmit.commands[0].command_line.includes('gpu:1'), 'remote-command-plan slurm: GNINA-only GPU submit must request configured GRES');
  const deferredEligibility = classifySlurmEligibilityOutput(
    'sbatch: Job 24093 to start at 2026-08-04T12:45:10\nLP_FLOW_SCHEDULER_TEST|0|2026-08-04T12:45:10|1785840310',
    30,
  );
  assert(deferredEligibility?.status === 'eligible' && deferredEligibility?.queue_advisory, 'remote-command-plan slurm: a delayed test-only start must remain eligible with a queue advisory');
  const queuedStatus = classifySlurmQueueOutput('LP_FLOW_QUEUE|PENDING|2026-08-04T12:45:10|Priority', 30);
  assert(queuedStatus?.status === 'queued' && queuedStatus?.queue_advisory, 'remote-command-plan slurm: a long queued job must stay queued with an advisory');
  const slurmStatus = (slurmPlan?.steps || []).find(step => step.step === 'check_docking_payload_status');
  assert(slurmStatus?.scheduler_status === true && slurmStatus?.queue_max_wait_minutes === 30, 'remote-command-plan slurm: status must classify long queue waits');
  assert(!Object.hasOwn(slurmStatus || {}, 'deferred_cancel_command'), 'remote-command-plan slurm: queued jobs must not be cancelled automatically');
  const mdSchedulerEligibility = (slurmPlan?.steps || []).find(step => step.step === 'check_md_scheduler');
  assert(mdSchedulerEligibility?.commands?.[0]?.command_line?.includes('--test-only'), 'remote-command-plan slurm: MD eligibility must use sbatch --test-only');
  const slurmMd = (slurmPlan?.steps || []).find(step => step.step === 'run_md_from_best_pose');
  assert(slurmMd?.scheduler_eligibility_command?.command_line?.includes('--test-only'), 'remote-command-plan slurm: MD submit must recheck test-only eligibility');

  const dryRun = parseJson(
    runCli(['remote-execute-step', '--package-dir', fixture.packageDir, '--profile-path', fixture.profilePath, '--step', 'preflight'], 'remote-execute-step dry-run'),
    'remote-execute-step dry-run',
  );
  assert(dryRun?.ok === true, 'remote-execute-step dry-run: expected ok=true');
  assert(dryRun?.executed === false, 'remote-execute-step dry-run: must not execute without execute=true');

  const missingReviewStatus = parseJson(
    runCli(
      ['remote-execute-step', '--package-dir', fixture.packageDir, '--profile-path', fixture.profilePath, '--step', 'open_burrete_pose_review'],
      'remote-execute-step missing handoff status',
      { expectStatus: 1 },
    ),
    'remote-execute-step missing handoff status',
  );
  assert(missingReviewStatus?.blocked === true, 'remote-execute-step pose review: missing exact handoff status must block completion');

  const reviewRecordDryRun = parseJson(
    runCli([
      'remote-execute-step', '--package-dir', fixture.packageDir, '--profile-path', fixture.profilePath,
      '--step', 'open_burrete_pose_review', '--handoff-status', 'opened', '--handoff-url', 'burrete://audit',
    ], 'remote-execute-step handoff record dry-run'),
    'remote-execute-step handoff record dry-run',
  );
  assert(reviewRecordDryRun?.ok === true && reviewRecordDryRun?.executed === false, 'remote-execute-step pose review: exact status should produce a safe record dry-run');
  assert(reviewRecordDryRun?.result_links?.[0]?.url === 'burrete://audit', 'remote-execute-step pose review: opened review must return a clickable result link');

  const blocked = parseJson(
    runCli(
      ['remote-execute-step', '--package-dir', fixture.packageDir, '--profile-path', fixture.profilePath, '--step', 'run_docking_payload', '--execute', 'true'],
      'remote-execute-step resource guard',
      { expectStatus: 1 },
    ),
    'remote-execute-step resource guard',
  );
  assert(blocked?.ok === false, 'remote-execute-step resource guard: expected ok=false without confirmation');
  assert(blocked?.blocked === true, 'remote-execute-step resource guard: expected blocked=true');
  assert(String(blocked?.reason || '').includes('confirm_resource_use=true'), 'remote-execute-step resource guard: expected confirmation reason');
  pass('remote execution path is executable as a dry-run and blocks heavy steps without explicit confirmation');
}

function checkPdbLigandDoesNotCreateFalseReceptorWarning(root) {
  const caseDir = path.join(root, 'pdb_ligand_case');
  mkdirSync(caseDir, { recursive: true });
  ensureFile(path.join(caseDir, 'receptor.pdb'), tinyReceptorPdb());
  ensureFile(path.join(caseDir, 'ligand_EOR.pdb'), tinyLigandPdb());

  const validation = parseJson(
    runCli(['validate-case', '--folder', caseDir], 'validate-case pdb ligand'),
    'validate-case pdb ligand',
  );
  assert(validation?.ok === true, 'validate-case pdb ligand: expected ok=true');
  assert(validation?.receptor?.relative_path === 'receptor.pdb', 'validate-case pdb ligand: expected receptor.pdb');
  assert(validation?.ligands?.length === 1, 'validate-case pdb ligand: expected one ligand');
  assert(
    !(validation?.warnings || []).some(item => String(item).includes('Multiple receptor-like files')),
    'validate-case pdb ligand: ligand_*.pdb must not create a receptor ambiguity warning',
  );
  pass('PDB ligand files do not create false receptor ambiguity warnings');
}

function checkMdDryRunExecution(fixture) {
  const submit = parseJson(
    runCli([
      'md',
      'submit',
      '--profile-path',
      fixture.profilePath,
      '--remote-dir',
      fixture.remoteDir,
      '--script',
      fixture.mdScript,
      '--job-id',
      'md_execution_smoke',
    ], 'md submit dry-run'),
    'md submit dry-run',
  );
  assert(submit?.ok === true, 'md submit dry-run: expected ok=true');
  assert(submit?.executed === false, 'md submit dry-run: must not submit without execute=true');
  assert(submit?.remote_dir === fixture.remoteDir, 'md submit dry-run: expected remote_dir');
  assert(submit?.script === fixture.mdScript, 'md submit dry-run: expected relative script');
  assert(submit?.command?.argv?.length > 0, 'md submit dry-run: expected SSH argv');

  const slurmProfilePath = path.join(path.dirname(fixture.profilePath), 'md.profile.slurm.json');
  const slurmProfile = JSON.parse(readFileSync(fixture.profilePath, 'utf8'));
  slurmProfile.scheduler = 'slurm';
  slurmProfile.scheduler_time = '00:30:00';
  writeJson(slurmProfilePath, slurmProfile);
  const slurmSubmit = parseJson(
    runCli([
      'md', 'submit', '--profile-path', slurmProfilePath, '--remote-dir', fixture.remoteDir,
      '--script', fixture.mdScript, '--job-id', 'md_execution_smoke',
    ], 'md submit slurm dry-run'),
    'md submit slurm dry-run',
  );
  assert(slurmSubmit?.scheduler === 'slurm', 'md submit slurm dry-run: expected scheduler=slurm');
  assert(slurmSubmit?.eligibility_command?.command_line?.includes('--test-only'), 'md submit slurm dry-run: expected sbatch --test-only eligibility');
  assert(slurmSubmit?.command?.command_line?.includes('sbatch'), 'md submit slurm dry-run: expected sbatch submit command');

  const unsafe = runCli([
    'md',
    'submit',
    '--profile-path',
    fixture.profilePath,
    '--remote-dir',
    '/tmp/not-inside-root',
    '--script',
    fixture.mdScript,
    '--job-id',
    'md_execution_smoke',
  ], 'md submit unsafe remote dir', { expectStatus: 1 });
  assert(unsafe.text.includes('Unsafe remote_dir'), 'md submit unsafe remote dir: expected safety error');
  pass('MD execution path performs dry-run command construction and safety validation');
}

function checkMdSmokeTemplate(fixture) {
  const templateDir = path.join(fixture.mdDir, 'smoke_template');
  const missingCharge = runCli([
    'md',
    'smoke-template',
    '--out-dir',
    templateDir,
    '--receptor',
    'input/receptor.pdb',
    '--pose',
    'input/top_pose.sdf',
  ], 'md smoke-template missing charge', { expectStatus: 1 });
  assert(missingCharge.text.includes('ligand_charge is required'), 'md smoke-template: missing ligand_charge must fail clearly');

  const result = parseJson(runCli([
    'md',
    'smoke-template',
    '--out-dir',
    templateDir,
    '--receptor',
    'input/receptor.pdb',
    '--pose',
    'input/top_pose.sdf',
    '--ligand-charge',
    '0',
    '--ligand-id',
    'LIG',
  ], 'md smoke-template'), 'md smoke-template');
  assert(result?.ok === true, 'md smoke-template: expected ok=true');
  assert(result?.ready_to_submit === false, 'md smoke-template: template must not claim ready_to_submit');
  const script = path.join(templateDir, 'scripts', 'run_md_smoke.sh');
  const manifestPath = path.join(templateDir, 'md_smoke_manifest.json');
  assert(existsSync(script), 'md smoke-template: expected script');
  assert(existsSync(manifestPath), 'md smoke-template: expected manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(manifest.ligand_charge === 0, 'md smoke-template manifest: expected ligand_charge');
  assert(manifest.expected_outputs.display === 'md/md_nowater_multimodel.pdb', 'md smoke-template manifest: expected no-water display PDB');
  const scriptText = readFileSync(script, 'utf8');
  assert(scriptText.includes('LIGAND_CHARGE="0"'), 'md smoke-template script: expected ligand charge');
  assert(scriptText.includes('md_nowater_multimodel.pdb'), 'md smoke-template script: expected display artifact name');
  pass('MD smoke-template writes a charge-gated package contract without claiming MD completion');
}

function checkTrajectoryHandoffPolicy() {
  const help = runCli(['md', '--help'], 'md help').text;
  assert(!help.includes('trajectory-serve'), 'md help: removed local viewer must stay absent');
  assert(help.includes('bounded no-water multi-frame PDB display artifact'), 'md help: expected Burrete display artifact policy');

  const removed = runCli(['md', 'trajectory-serve'], 'removed MD trajectory viewer', { expectStatus: 1 });
  assert(removed.text.includes('Unknown md action: trajectory-serve'), 'removed MD trajectory viewer: expected unknown action');
  pass('MD trajectory review uses the Burrete display artifact contract without a bundled local viewer');
}

function checkTrajectoryManifestWriter(fixture) {
  const manifestPath = path.join(fixture.mdDir, 'trajectory_manifest.json');
  const displayPath = path.join(fixture.mdDir, 'md_nowater_multimodel.pdb');
  const tprPath = path.join(fixture.mdDir, 'md.tpr');
  const xtcPath = path.join(fixture.mdDir, 'trajectory.xtc');
  const result = parseJson(
    runCli([
      'md',
      'trajectory-manifest',
      '--out',
      manifestPath,
      '--display',
      displayPath,
      '--topology',
      tprPath,
      '--trajectory',
      xtcPath,
      '--stage-status',
      'em=ok;nvt=ok;visualization=reopenable_package',
    ], 'md trajectory-manifest'),
    'md trajectory-manifest',
  );
  assert(result?.ok === true, 'md trajectory-manifest: expected ok=true');
  assert(existsSync(manifestPath), 'md trajectory-manifest: expected manifest file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(manifest.intended_viewer === 'Burrete', 'trajectory manifest: intended_viewer must be Burrete');
  assert(manifest.display === 'md_nowater_multimodel.pdb', 'trajectory manifest: display must be relative no-water multimodel PDB');
  assert(manifest.display_role === 'burrete_display_multimodel_pdb', 'trajectory manifest: display_role mismatch');
  assert(manifest.display_water === 'no_bulk_water', 'trajectory manifest: display_water mismatch');
  assert(manifest.native_trajectory === 'trajectory.xtc', 'trajectory manifest: native trajectory provenance missing');
  assert(manifest.native_topology === 'md.tpr', 'trajectory manifest: native topology provenance missing');
  assert(manifest.native_topology_role === 'provenance', 'trajectory manifest: native topology must be provenance');
  assert(manifest.visualization_status === 'reopenable_package', 'trajectory manifest: expected reopenable_package status');
  assert(manifest.reopen_command?.includes('burrete:trajectory-review'), 'trajectory manifest: expected Burrete reopen command');
  assert(manifest.display_qc?.models === 2 && manifest.display_qc?.atoms_per_model === 1, 'trajectory manifest: expected validated multi-model display QC');

  const invalid = runCli([
    'md', 'trajectory-manifest', '--out', path.join(fixture.mdDir, 'invalid_manifest.json'),
    '--display', path.join(fixture.mdDir, 'does_not_exist.pdb'),
  ], 'md trajectory-manifest missing display', { expectStatus: 1 });
  assert(invalid.text.includes('display does not exist'), 'md trajectory-manifest: nonexistent display must fail instead of claiming reopenable package');
  pass('MD trajectory manifest writer produces Burrete display/provenance contract');
}

function checkStrictPipelineInspection(root) {
  const runDir = path.join(root, 'strict_pipeline_run');
  const resultsDir = path.join(runDir, 'results');
  for (const name of ['gnina', 'smina', 'boltz', 'matcha', 'logs']) mkdirSync(path.join(resultsDir, name), { recursive: true });
  ensureFile(path.join(resultsDir, 'summary_wide.csv'), 'case,smina_status\nsmoke,ok\n');
  ensureFile(path.join(resultsDir, 'summary_wide_notes.md'), '# Summary\n');
  writeJson(path.join(resultsDir, 'pose_review_status.json'), {
    status: 'opened',
    handoff_url: 'http://127.0.0.1:60001/?pose-review=smoke',
  });
  writeJson(path.join(resultsDir, 'trajectory_review_status.json'), {
    status: 'reviewed',
    handoff_url: 'http://127.0.0.1:60002/?trajectory-review=smoke',
  });
  ensureFile(path.join(runDir, 'md_from_best_pose', 'outputs', 'display.pdb'), 'MODEL        1\nENDMDL\nEND\n');
  writeJson(path.join(runDir, 'md_from_best_pose', 'outputs', 'trajectory_manifest.json'), {
    display: 'md_from_best_pose/outputs/display.pdb',
  });
  const displayQc = path.join(runDir, 'md_from_best_pose', 'outputs', 'display_qc.json');
  writeJson(displayQc, { models: 100, required_models: 100 });

  const valid = parseJson(
    runCli(['inspect-results', '--results-dir', resultsDir, '--strict'], 'strict pipeline inspection'),
    'strict pipeline inspection',
  );
  assert(valid?.ok === true, 'strict pipeline inspection: opened Burrete reviews and 100 display frames must pass');
  assert(valid?.result_links?.length === 2, 'strict pipeline inspection: docking and MD Burrete links must be returned as final deliverables');

  writeJson(displayQc, { models: 3, required_models: 100 });
  const shortDisplay = parseJson(
    runCli(['inspect-results', '--results-dir', resultsDir, '--strict'], 'strict pipeline short display', { expectStatus: 1 }),
    'strict pipeline short display',
  );
  assert(shortDisplay?.pipeline?.missing?.some(item => item.includes('display_qc.json')), 'strict pipeline inspection: a three-model display must fail');
  pass('strict inspection rejects missing Burrete evidence and sparse MD displays');
}

function main() {
  assert(existsSync(entrypoint), `entrypoint missing: ${entrypoint}`);
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'lp-flow-execution-smoke-'));
  try {
    const fixture = createFixture(tempRoot);
    checkStatusAndDiscovery();
    checkPrepareRedockingCase(tempRoot);
    checkPdbLigandDoesNotCreateFalseReceptorWarning(tempRoot);
    checkDockingRunPackage(fixture);
    checkRemoteDryRunExecutionPlan(fixture);
    checkMdDryRunExecution(fixture);
    checkMdSmokeTemplate(fixture);
    checkTrajectoryManifestWriter(fixture);
    checkTrajectoryHandoffPolicy();
    checkStrictPipelineInspection(tempRoot);

    if (failures.length) {
      console.error('LP-Flow pipeline execution smoke FAILED');
      console.error(`Temp dir: ${tempRoot}`);
      for (const item of failures) console.error(`- ${item}`);
      process.exit(1);
    }

    console.log('LP-Flow pipeline execution smoke PASSED');
    console.log(`Temp dir: ${tempRoot}${keepTemp ? '' : ' (removed)'}`);
    for (const item of passes) console.log(`- ${item}`);
  } finally {
    if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
