#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const sourceSkills = path.join(repoRoot, 'skills');
const entrypoint = path.join(repoRoot, 'scripts', 'lp-flow.mjs');
const completionContractsPath = path.join(repoRoot, 'tests', 'skill_completion_contracts.json');
const triggerEvalsPath = path.join(repoRoot, 'tests', 'skill_trigger_evals.json');
const node = process.execPath;

function resolveCacheSkills() {
  return process.env.LP_FLOW_SKILL_CACHE_DIR || null;
}

const cacheSkills = resolveCacheSkills();

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

function read(filePath) {
  assert(existsSync(filePath), `missing file: ${filePath}`);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function skillPath(skill, relative = 'SKILL.md') {
  return path.join(sourceSkills, skill, relative);
}

function cacheSkillPath(skill, relative = 'SKILL.md') {
  return path.join(cacheSkills, skill, relative);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label}: expected ${JSON.stringify(needle)}`);
}

function assertNotIncludes(text, needle, label) {
  assert(!text.includes(needle), `${label}: must not include ${JSON.stringify(needle)}`);
}

function assertMatches(text, pattern, label) {
  assert(pattern.test(text), `${label}: expected to match ${pattern}`);
}

function runCli(args, label) {
  const result = spawnSync(node, [entrypoint, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(!result.error, `${label}: failed to start: ${result.error?.message}`);
  assert(result.status === 0, `${label}: expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function listSkillContractFiles(root) {
  const result = [];
  for (const skill of readdirSync(root, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const skillDir = path.join(root, skill.name);
    for (const file of ['SKILL.md', path.join('agents', 'openai.yaml')]) {
      const fullPath = path.join(skillDir, file);
      if (existsSync(fullPath)) result.push(path.relative(root, fullPath));
    }
  }
  return result.sort();
}

function checkSourceCacheSync() {
  assert(existsSync(sourceSkills), `source skills folder missing: ${sourceSkills}`);
  const sourceFiles = listSkillContractFiles(sourceSkills);
  if (!cacheSkills) {
    pass('source skill contracts are present; installed-cache comparison is opt-in');
    return;
  }
  if (!existsSync(cacheSkills)) {
    fail(`configured skill cache does not exist: ${cacheSkills}`);
    return;
  }
  const cacheFiles = listSkillContractFiles(cacheSkills);
  assert(JSON.stringify(sourceFiles) === JSON.stringify(cacheFiles), `source/cache skill file lists differ\nsource=${JSON.stringify(sourceFiles)}\ncache=${JSON.stringify(cacheFiles)}`);
  for (const relative of sourceFiles) {
    const sourceText = read(path.join(sourceSkills, relative));
    const cacheText = read(path.join(cacheSkills, relative));
    assert(sourceText === cacheText, `source/cache drift in ${relative}`);
  }
  pass('source and installed cache skill contracts are synchronized');
}

function checkSkillFrontmatter() {
  const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const entry of readdirSync(sourceSkills, { withFileTypes: true }).filter(item => item.isDirectory() && existsSync(skillPath(item.name)))) {
    const text = read(skillPath(entry.name));
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    assert(match, `${entry.name}: missing YAML frontmatter`);
    if (!match) continue;
    const lines = match[1].split(/\r?\n/);
    const keys = lines.map(line => /^([A-Za-z][A-Za-z0-9-]*):/.exec(line)?.[1]).filter(Boolean);
    assert(keys.every(key => allowed.has(key)), `${entry.name}: unsupported frontmatter field(s): ${keys.filter(key => !allowed.has(key)).join(', ')}`);
    assert(keys.includes('name') && match[1].includes(`name: ${entry.name}`), `${entry.name}: name must match skill directory`);
    assert(match[1].includes('license: MIT'), `${entry.name}: skill license must match LP-Flow`);
    const metadataIndex = lines.findIndex(line => line === 'metadata:');
    assert(metadataIndex >= 0, `${entry.name}: metadata is required`);
    if (metadataIndex >= 0) {
      const metadataLines = lines.slice(metadataIndex + 1).filter(line => line.startsWith('  '));
      assert(metadataLines.length > 0, `${entry.name}: metadata must contain string entries`);
      assert(metadataLines.every(line => /^  [A-Za-z][A-Za-z0-9-]*: .+$/.test(line)), `${entry.name}: metadata values must be strings`);
    }
  }
  pass('skill frontmatter uses the supported Agent Skills fields with string metadata and the project license');
}

function checkTriggerWording() {
  const skillDirs = readdirSync(sourceSkills, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert(!skillDirs.includes('lp-flow-router'), 'focused architecture: lp-flow-router skill must be removed');

  for (const skill of ['boltz', 'gnina-smina-docking', 'gromacs-md', 'matcha-scoring']) {
    const text = read(skillPath(skill));
    assertNotIncludes(text, 'lp-flow-router', `${skill} trigger wording`);
    assertNotIncludes(text, 'selected by', `${skill} trigger wording`);
    assertNotIncludes(text, 'Downstream LP-Flow', `${skill} trigger wording`);
  }

  const boltz = read(skillPath('boltz'));
  assertIncludes(boltz, 'Structure prediction and triage', 'Boltz frontmatter');
  assertIncludes(boltz, 'confidence ranking', 'Boltz frontmatter');
  assertIncludes(boltz, 'lp-flow-requirements: configured-runtime, optional-gpu', 'Boltz requirements');
  assertIncludes(boltz, 'Heavy runs use a configured local machine\nor server profile.', 'Boltz configured machine/server profile');
  assertNotIncludes(boltz, 'validate designed binders', 'Boltz frontmatter');
  assertNotIncludes(boltz, 'AlphaFold3 alternative', 'Boltz frontmatter');
  assertIncludes(boltz, 'use it only when external\nsequence submission is allowed', 'Boltz confidential MSA guard');
  assertIncludes(boltz, 'not experimental binding validation', 'Boltz triage caveat');
  assertIncludes(boltz, 'accelerator availability from the active profile or wrapper before execution', 'Boltz runtime discovery state');

  const matcha = read(skillPath('matcha-scoring'));
  assertNotIncludes(matcha, 'GNINA requires CUDA; skipping scoring on cpu', 'Matcha global CUDA wording');
  assertIncludes(matcha, 'Keep Matcha output in `matcha_*` columns', 'Matcha output column contract');
  assertIncludes(matcha, '`matcha_status` and `matcha_error` carry the run state', 'Matcha status/error contract');
  assertIncludes(matcha, 'Resolve\ncommands, versions, writable output directory, and accelerator availability', 'Matcha runtime discovery state');
  const matchaAgent = read(skillPath('matcha-scoring', path.join('agents', 'openai.yaml')));
  assertIncludes(matchaAgent, 'Matcha checkout/checkpoints', 'Matcha agent profile/checkpoint gating');
  assertIncludes(matchaAgent, 'mark Matcha unavailable with logs', 'Matcha agent unavailable status');

  const docking = read(skillPath('gnina-smina-docking'));
  assertIncludes(docking, 'Classical protein-ligand docking, redocking, rescoring', 'Docking frontmatter');
  assertIncludes(docking, 'Burrete/Mol* review', 'Docking Mol* trigger');
  assertIncludes(docking, 'top-pose\n  packages for Burrete/Mol* review or later dynamics', 'Docking review trigger');

  const gromacs = read(skillPath('gromacs-md'));
  assertIncludes(gromacs, 'GROMACS-first molecular dynamics setup', 'GROMACS frontmatter');
  assertIncludes(gromacs, 'trajectory handoff to Burrete/Mol* visualization', 'GROMACS Mol* trajectory trigger');

  pass('focused trigger wording is portable, non-marketing, and mini-model safe');
}

function checkPipelineSkillChain() {
  for (const portable of ['boltz', 'gnina-smina-docking', 'gromacs-md', 'matcha-scoring']) {
    const text = read(skillPath(portable));
    assertNotIncludes(text, 'compute-runtime', `${portable} portable skill`);
    assertNotIncludes(text, '**Next:**', `${portable} continuation wording`);
  }

  const docking = read(skillPath('gnina-smina-docking'));
  assertNotIncludes(docking, 'gromacs-md', 'Docking should not name other focused skills');
  assertNotIncludes(docking, 'matcha-scoring', 'Docking should not name other focused skills');
  assertNotIncludes(docking, '`boltz`', 'Docking should not name other focused skills');
  for (const needle of [
    'GNINA provides docking/scoring with CNN fields',
    'resolve commands, versions, output, and CPU/GPU backend before execution',
    'SMINA is the lightweight\nVina-style cross-check',
    'lp-flow run docking --config docking.yaml --out-dir docking_run/',
    'box_center_angstrom',
    'summary_wide.csv',
    'Write pose files, raw logs, and one method-status table',
    'Open the selected/top pose or pose collection in Burrete',
    'docking package: receptor context + pose files + score table',
    'review output: Burrete link/status in report',
    'Docking, CNN, and Vina-style scores rank poses for review',
    'Open the selected/top poses in Burrete',
    '`No such file or directory` while reading receptor/ligand/pose or writing output',
  ]) {
    assertIncludes(docking, needle, 'Docking skill contract');
  }

  const gromacs = read(skillPath('gromacs-md'));
  for (const needle of [
    'GROMACS is the default MD engine for this plugin',
    'prepared coordinates and\ntopology in, smoke/equilibration structures, trajectories, metrics, and a\nreview package out',
    'resolve\nthe GROMACS command, library environment, writable output, and CPU/GPU backend',
    'Stop\nbefore topology generation if ligand chemistry is unknown',
    'Use the reviewed docking pose when available; otherwise name the pose source in\nthe run manifest',
    '| display | `md_nowater_multimodel.pdb` | Burrete/Mol* preview |',
    '| snapshot | `em.gro`, `nvt.gro` | stage snapshot only |',
    'CPU smoke with the largest useful scope',
    'Production MD is a\nseparate explicit run mode',
    'clean ligand chemistry -> ligand topology',
    'docked pose            -> ligand placement coordinates',
    'Display is separate from native trajectory provenance',
    'Write `trajectory_manifest.json` with display PDB, preview metadata, native\ntopology/trajectory',
    'stage,status,artifact,error,log_file',
    'Open the no-water multi-frame display PDB in Burrete',
    'Use explicit structure, trajectory, selection, and output-prefix fields',
    '| display | `md_nowater_multimodel.pdb` | Burrete/Mol* preview |',
    '| preview metadata | `preview_nowater.json` | selectors, frame stride, ligand names |',
    '| provenance | `md.tpr`, `md_clean.xtc`, `topol.top` | analysis/reproducibility |',
  ]) {
    assertIncludes(gromacs, needle, 'GROMACS skill contract');
  }

  const gromacsAgent = read(skillPath('gromacs-md', path.join('agents', 'openai.yaml')));
  assertIncludes(gromacsAgent, 'package a multi-frame bounded no-water PDB plus compact preview topology/metadata for Burrete display', 'GROMACS agent Burrete handoff');

  const matcha = read(skillPath('matcha-scoring'));
  assertIncludes(matcha, 'Matcha is optional and profile-backed', 'Matcha optional/profile-backed contract');
  assertIncludes(matcha, 'Heavy runs use a configured local machine or server profile.', 'Matcha configured machine/server profile');
  assertIncludes(matcha, 'methods: [matcha]', 'Matcha campaign method config');
  assertIncludes(matcha, 'If `matcha_best_pose` exists, keep it as a downstream pose artifact', 'Matcha downstream pose artifact');
  assertIncludes(matcha, 'downstream_pose_status', 'Matcha downstream status column');
  assertIncludes(matcha, 'stage receptor\nand ligand files into the run package and pass runtime-visible paths', 'Matcha remote path staging');

  pass('focused skills describe runtime -> docking -> MD -> Burrete visualization without router dependency');
}

function checkCompletionContracts() {
  assert(existsSync(completionContractsPath), `completion contract missing: ${completionContractsPath}`);
  const contracts = JSON.parse(read(completionContractsPath));
  assert(contracts.version === 1, 'completion contracts: expected version 1');
  assert(Array.isArray(contracts.cases) && contracts.cases.length >= 3, 'completion contracts: expected at least three cases');

  const byId = new Map(contracts.cases.map(item => [item.id, item]));
  const fullPipeline = byId.get('full_redocking_md_visualization');
  const links = byId.get('visualization_links_requested');
  const smoke = byId.get('md_smoke_visualization');
  assert(fullPipeline, 'completion contracts: missing full_redocking_md_visualization');
  assert(links, 'completion contracts: missing visualization_links_requested');
  assert(smoke, 'completion contracts: missing md_smoke_visualization');

  for (const [label, item] of [['full pipeline', fullPipeline], ['visualization links', links], ['MD smoke', smoke]]) {
    assert(Array.isArray(item.complete_when), `completion contracts ${label}: expected complete_when array`);
    assert(Array.isArray(item.incomplete_if), `completion contracts ${label}: expected incomplete_if array`);
    assert(item.complete_when.includes('viewer_url_or_exact_open_status_in_chat'), `completion contracts ${label}: expected viewer URL/status in chat`);
    assert(item.complete_when.includes('markdown_viewer_link_for_each_opened_review'), `completion contracts ${label}: expected clickable viewer link for opened review`);
  }

  assert(fullPipeline.complete_when.includes('plugin_or_profile_runtime_discovery'), 'completion contracts full pipeline: expected plugin/profile runtime discovery before execution status');
  assert(fullPipeline.complete_when.includes('run_manifest_json_with_phase_spans'), 'completion contracts full pipeline: expected structured run manifest');
  assert(fullPipeline.complete_when.includes('markdown_report_with_stepwise_debug_trace'), 'completion contracts full pipeline: expected debuggable markdown report');
  assert(fullPipeline.complete_when.includes('top_pose_burrete_review_before_md'), 'completion contracts full pipeline: expected top-pose Burrete review before MD');
  assert(fullPipeline.complete_when.includes('per_method_status_rows'), 'completion contracts full pipeline: expected per-method status rows');
  assert(fullPipeline.complete_when.includes('best_valid_pose_artifact_downstream'), 'completion contracts full pipeline: expected best valid pose downstream');
  assert(fullPipeline.complete_when.includes('all_viable_fallback_paths_attempted_or_recorded'), 'completion contracts full pipeline: expected fallback paths attempted/recorded');
  assert(fullPipeline.complete_when.includes('artifact_only_md_package_when_visualization_unavailable'), 'completion contracts full pipeline: expected artifact-only MD package fallback');
  assert(fullPipeline.complete_when.includes('top_pose_burrete_link_or_exact_status_before_md'), 'completion contracts full pipeline: expected top-pose Burrete link/status before MD');
  assert(fullPipeline.complete_when.includes('md_handoff_includes_pose_package_and_burrete_status'), 'completion contracts full pipeline: expected MD handoff to include Burrete pose status');
  assert(fullPipeline.complete_when.includes('trajectory_burrete_open_attempt'), 'completion contracts full pipeline: expected trajectory Burrete open attempt');
  assert(fullPipeline.complete_when.includes('bounded_multimodel_pdb_display_file'), 'completion contracts full pipeline: expected bounded multi-model PDB display file');
  assert(fullPipeline.complete_when.includes('bounded_nowater_multimodel_pdb_display_file'), 'completion contracts full pipeline: expected no-water display PDB');
  assert(fullPipeline.complete_when.includes('multiframe_nowater_display_pdb'), 'completion contracts full pipeline: expected multi-frame no-water display PDB');
  assert(fullPipeline.complete_when.includes('snapshot_gro_marked_as_provenance_not_preview'), 'completion contracts full pipeline: expected GRO snapshot provenance status');
  assert(fullPipeline.complete_when.includes('compact_nowater_preview_topology_or_metadata'), 'completion contracts full pipeline: expected compact no-water preview topology/metadata');
  assert(fullPipeline.complete_when.includes('native_trajectory_topology_for_interpretation'), 'completion contracts full pipeline: expected native trajectory/topology provenance');
  assert(links.complete_when.includes('burrete_open_attempt'), 'completion contracts links: expected Burrete open attempt');
  assert(smoke.complete_when.includes('trajectory_burrete_open_attempt'), 'completion contracts MD smoke: expected trajectory Burrete open attempt');
  assert(smoke.complete_when.includes('bounded_multimodel_pdb_display_file'), 'completion contracts MD smoke: expected bounded multi-model PDB display file');
  assert(smoke.complete_when.includes('bounded_nowater_multimodel_pdb_display_file'), 'completion contracts MD smoke: expected no-water display PDB');
  assert(smoke.complete_when.includes('multiframe_nowater_display_pdb'), 'completion contracts MD smoke: expected multi-frame no-water display PDB');
  assert(smoke.complete_when.includes('snapshot_gro_marked_as_provenance_not_preview'), 'completion contracts MD smoke: expected GRO snapshot provenance status');
  assert(smoke.complete_when.includes('compact_nowater_preview_topology_or_metadata'), 'completion contracts MD smoke: expected compact no-water preview topology/metadata');
  assert(smoke.complete_when.includes('native_trajectory_topology_for_interpretation'), 'completion contracts MD smoke: expected native trajectory/topology provenance');
  assert(fullPipeline.incomplete_if.includes('only_static_pdb_paths_for_visualization'), 'completion contracts full pipeline: static PDB paths must not satisfy visualization');
  assert(fullPipeline.incomplete_if.includes('declares_visualization_ok_without_burrete_open_result'), 'completion contracts full pipeline: display export alone cannot be reported as opened visualization');
  assert(fullPipeline.incomplete_if.includes('codex_inline_visualization_substituted_for_burrete_review'), 'completion contracts full pipeline: inline charts cannot substitute for Burrete review');
  assert(fullPipeline.incomplete_if.includes('plain_text_viewer_url_without_clickable_markdown_link'), 'completion contracts full pipeline: raw viewer URL is not a delivered link');
  assert(fullPipeline.incomplete_if.includes('blocked_from_local_path_only'), 'completion contracts full pipeline: local PATH-only blocker is incomplete');
  assert(fullPipeline.incomplete_if.includes('missing_run_manifest_for_full_pipeline'), 'completion contracts full pipeline: missing run manifest is incomplete');
  assert(fullPipeline.incomplete_if.includes('report_without_command_log_artifact_statuses'), 'completion contracts full pipeline: report needs command/log/artifact statuses');
  assert(fullPipeline.incomplete_if.includes('declares_methods_unavailable_from_local_path_without_profile_probe'), 'completion contracts full pipeline: local PATH miss needs profile probe');
  assert(fullPipeline.incomplete_if.includes('offers_run_package_as_next_step_for_requested_full_run'), 'completion contracts full pipeline: run package offer is incomplete for requested full run');
  assert(fullPipeline.incomplete_if.includes('stops_on_optional_method_failure_with_valid_pose_available'), 'completion contracts full pipeline: optional method failure cannot stop when pose exists');
  assert(fullPipeline.incomplete_if.includes('asks_user_to_choose_optional_runtime_repair_vs_fallback_artifact'), 'completion contracts full pipeline: branch choice prompt is incomplete');
  assert(fullPipeline.incomplete_if.includes('discarded_matcha_best_pose_with_missing_optional_scores'), 'completion contracts full pipeline: Matcha pose artifact must survive missing optional scores');
  assert(fullPipeline.incomplete_if.includes('offers_to_continue_last_requested_stage_later'), 'completion contracts full pipeline: last-stage follow-up offer is incomplete');
  assert(fullPipeline.incomplete_if.includes('final_answer_contains_if_you_want_followup'), 'completion contracts full pipeline: if-you-want follow-up is incomplete');
  assert(fullPipeline.incomplete_if.includes('asks_user_to_press_1_or_continue_for_implied_next_stage'), 'completion contracts full pipeline: continue prompt is incomplete');
  assert(fullPipeline.incomplete_if.includes('stops_after_docking_report_when_visualization_requested'), 'completion contracts full pipeline: docking report without requested visualization is incomplete');
  assert(fullPipeline.incomplete_if.includes('docking_result_without_burrete_opened_or_unavailable_status'), 'completion contracts full pipeline: docking requires Burrete open status');
  assert(fullPipeline.incomplete_if.includes('matcha_remote_payload_uses_local_windows_path'), 'completion contracts full pipeline: remote Matcha must not use local Windows paths');
  assert(fullPipeline.incomplete_if.includes('generic_molstar_instruction_without_burrete'), 'completion contracts full pipeline: generic Mol* instruction is incomplete');
  assert(fullPipeline.incomplete_if.includes('omits_top_pose_burrete_review_before_md'), 'completion contracts full pipeline: missing pose review before MD is incomplete');
  assert(fullPipeline.incomplete_if.includes('starts_md_before_burrete_top_pose_review'), 'completion contracts full pipeline: MD before pose review is incomplete');
  assert(fullPipeline.incomplete_if.includes('md_handoff_without_burrete_pose_status'), 'completion contracts full pipeline: MD handoff without pose status is incomplete');
  assert(fullPipeline.incomplete_if.includes('omits_trajectory_burrete_open_attempt'), 'completion contracts full pipeline: missing trajectory open attempt is incomplete');
  assert(fullPipeline.incomplete_if.includes('opens_xtc_alone_as_visualization_display'), 'completion contracts full pipeline: XTC-only display is incomplete');
  assert(fullPipeline.incomplete_if.includes('bulk_water_in_local_preview_topology'), 'completion contracts full pipeline: bulk-water preview topology is incomplete');
  assert(fullPipeline.incomplete_if.includes('full_solvated_topology_as_preview_display_file'), 'completion contracts full pipeline: solvated topology preview is incomplete');
  assert(fullPipeline.incomplete_if.includes('gigabyte_scale_preview_topology'), 'completion contracts full pipeline: huge preview topology is incomplete');
  assert(fullPipeline.incomplete_if.includes('opens_gro_snapshot_as_trajectory_visualization'), 'completion contracts full pipeline: GRO snapshot as trajectory visualization is incomplete');
  assert(fullPipeline.incomplete_if.includes('single_final_structure_as_completed_trajectory_preview'), 'completion contracts full pipeline: single final structure preview is incomplete');
  assert(fullPipeline.incomplete_if.includes('water_heavy_gro_as_preview_display'), 'completion contracts full pipeline: water-heavy GRO preview is incomplete');
  assert(fullPipeline.incomplete_if.includes('trajectory_visualization_without_trajectory_derived_display_frames'), 'completion contracts full pipeline: missing trajectory-derived display frames is incomplete');
  assert(links.incomplete_if.includes('returns_plain_pdb_text'), 'completion contracts links: plain PDB text must not satisfy visualization links');
  assert(links.incomplete_if.includes('returns_only_file_paths'), 'completion contracts links: file paths alone must not satisfy visualization links');
  assert(links.incomplete_if.includes('declares_visualization_ok_without_burrete_open_result'), 'completion contracts links: file paths cannot be reported as opened visualization');
  assert(links.incomplete_if.includes('codex_inline_visualization_substituted_for_burrete_review'), 'completion contracts links: inline charts cannot substitute for Burrete review');
  assert(links.incomplete_if.includes('plain_text_viewer_url_without_clickable_markdown_link'), 'completion contracts links: raw viewer URL is not a delivered link');
  assert(links.incomplete_if.includes('generic_molstar_instruction_without_burrete'), 'completion contracts links: generic Mol* instruction is incomplete');
  assert(smoke.incomplete_if.includes('asks_user_to_press_1_or_continue_for_implied_next_stage'), 'completion contracts MD smoke: continue prompt is incomplete');
  assert(smoke.incomplete_if.includes('declares_visualization_ok_without_burrete_open_result'), 'completion contracts MD smoke: display export cannot be reported as opened visualization');
  assert(smoke.incomplete_if.includes('codex_inline_visualization_substituted_for_burrete_review'), 'completion contracts MD smoke: inline charts cannot substitute for Burrete review');
  assert(smoke.incomplete_if.includes('offers_to_continue_last_requested_stage_later'), 'completion contracts MD smoke: last-stage follow-up offer is incomplete');
  assert(smoke.incomplete_if.includes('offers_viewer_setup_as_next_step'), 'completion contracts MD smoke: viewer setup as next step is incomplete');
  assert(smoke.incomplete_if.includes('plain_text_viewer_url_without_clickable_markdown_link'), 'completion contracts MD smoke: raw viewer URL is not a delivered link');
  assert(smoke.incomplete_if.includes('opens_xtc_alone_as_visualization_display'), 'completion contracts MD smoke: XTC-only display is incomplete');
  assert(smoke.incomplete_if.includes('bulk_water_in_local_preview_topology'), 'completion contracts MD smoke: bulk-water preview topology is incomplete');
  assert(smoke.incomplete_if.includes('full_solvated_topology_as_preview_display_file'), 'completion contracts MD smoke: solvated topology preview is incomplete');
  assert(smoke.incomplete_if.includes('gigabyte_scale_preview_topology'), 'completion contracts MD smoke: huge preview topology is incomplete');
  assert(smoke.incomplete_if.includes('opens_gro_snapshot_as_trajectory_visualization'), 'completion contracts MD smoke: GRO snapshot as trajectory visualization is incomplete');
  assert(smoke.incomplete_if.includes('single_final_structure_as_completed_trajectory_preview'), 'completion contracts MD smoke: single final structure preview is incomplete');
  assert(smoke.incomplete_if.includes('water_heavy_gro_as_preview_display'), 'completion contracts MD smoke: water-heavy GRO preview is incomplete');
  assert(smoke.incomplete_if.includes('trajectory_visualization_without_trajectory_derived_display_frames'), 'completion contracts MD smoke: missing trajectory-derived display frames is incomplete');
  assert(fullPipeline.incomplete_if.includes('legacy_story_readme_as_visualization_link'), 'completion contracts full pipeline: legacy story README cannot count as visualization');
  assert(fullPipeline.incomplete_if.includes('experimental_reference_presented_as_requested_result_visualization'), 'completion contracts full pipeline: experimental reference cannot count as requested result visualization');
  pass('completion contracts require runtime discovery and Burrete link/status instead of local PATH blockers or static files');
}

function checkTriggerEvals() {
  assert(existsSync(triggerEvalsPath), `trigger evals missing: ${triggerEvalsPath}`);
  const evals = JSON.parse(read(triggerEvalsPath));
  assert(evals.version === 1, 'trigger evals: expected version 1');
  const cases = Array.isArray(evals.cases) ? evals.cases : [];
  assert(cases.length >= 20, 'trigger evals: expected broad weak-model coverage');
  const lpFlowSkills = new Set([
    'gnina-smina-docking',
    'gromacs-md',
    'boltz',
    'matcha-scoring',
    'burrete:open-workspace',
    'burrete:molecule-collection',
    'burrete:trajectory-review',
  ]);
  for (const item of cases) {
    const expected = Array.isArray(item.expected_skills) ? item.expected_skills : [];
    const notExpected = Array.isArray(item.not_expected_skills) ? item.not_expected_skills : [];
    assert(!expected.includes('lp-flow-router'), `trigger evals obsolete router expected: ${item.query}`);
    assert(!notExpected.includes('lp-flow-router'), `trigger evals obsolete router not_expected: ${item.query}`);
    if (expected.some(skill => lpFlowSkills.has(skill)) && expected[0]?.startsWith('burrete:') === false) {
      assert(lpFlowSkills.has(expected[0]), `trigger evals focused-first: ${item.query}`);
    }
  }

  const dockingMdVisual = cases.find(item => String(item.query || '').includes('open the top pose') && String(item.query || '').includes('visualize the trajectory'));
  assert(dockingMdVisual, 'trigger evals: missing docking -> pose review -> MD -> trajectory case');
  assert(dockingMdVisual.expected_skills.includes('burrete:open-workspace'), 'trigger evals: top-pose opening must route to Burrete');
  assert(dockingMdVisual.expected_skills.includes('burrete:trajectory-review'), 'trigger evals: trajectory visualization must route to Burrete');

  const full6lr9 = cases.find(item => String(item.query || '').includes('PDB 6LR9'));
  assert(full6lr9, 'trigger evals: missing 6LR9 full pipeline case');
  assert(full6lr9.expected_skills.includes('burrete:open-workspace'), 'trigger evals 6LR9: expected pose review');
  assert(full6lr9.expected_skills.includes('burrete:trajectory-review'), 'trigger evals 6LR9: expected trajectory review');
  assert((full6lr9.must_include_concepts || []).includes('per-method status rows for failed/unavailable methods'), 'trigger evals 6LR9: expected per-method statuses');
  assert((full6lr9.must_include_concepts || []).includes('run_manifest.json with phase spans, method statuses, logs, and artifacts'), 'trigger evals 6LR9: expected run manifest');
  assert((full6lr9.must_include_concepts || []).includes('markdown report with stepwise debug trace'), 'trigger evals 6LR9: expected debug report');
  assert((full6lr9.must_include_concepts || []).includes('best available valid pose artifact continues downstream'), 'trigger evals 6LR9: expected fallback pose artifact');
  assert((full6lr9.must_not_include_concepts || []).includes('ask user to choose between repairing optional runtime and producing fallback artifact'), 'trigger evals 6LR9: forbid branch choice prompt');
  assert((full6lr9.must_include_concepts || []).includes('Burrete top-pose review/open status before MD'), 'trigger evals 6LR9: expected pose review before MD concept');
  assert((full6lr9.must_not_include_concepts || []).includes('start MD before Burrete top-pose review'), 'trigger evals 6LR9: forbid MD before pose review');
  assert((full6lr9.must_not_include_concepts || []).includes('if you want, i can continue'), 'trigger evals 6LR9: forbid follow-up offer');
  assert((full6lr9.must_not_include_concepts || []).includes('missing run_manifest.json for full pipeline'), 'trigger evals 6LR9: forbid missing run manifest');
  assert((full6lr9.must_not_include_concepts || []).includes('report lacks command/log/artifact statuses'), 'trigger evals 6LR9: forbid weak report');
  assert((full6lr9.must_include_concepts || []).includes('bounded multi-model PDB as visualization display file'), 'trigger evals 6LR9: expected display PDB');
  assert((full6lr9.must_include_concepts || []).includes('bounded no-water multi-model PDB as visualization display file'), 'trigger evals 6LR9: expected no-water display PDB');
  assert((full6lr9.must_include_concepts || []).includes('multi-frame no-water display PDB for trajectory visualization'), 'trigger evals 6LR9: expected multi-frame display PDB');
  assert((full6lr9.must_include_concepts || []).includes('compact no-bulk-water preview topology or metadata'), 'trigger evals 6LR9: expected compact preview topology');
  assert((full6lr9.must_not_include_concepts || []).includes('open xtc alone as visualization display'), 'trigger evals 6LR9: forbid XTC-only display');
  assert((full6lr9.must_not_include_concepts || []).includes('open gro snapshot as trajectory visualization'), 'trigger evals 6LR9: forbid GRO snapshot trajectory display');
  assert((full6lr9.must_not_include_concepts || []).includes('bulk water in local preview topology'), 'trigger evals 6LR9: forbid water-heavy preview topology');

  const links = cases.find(item => String(item.query || '').includes('visualization links'));
  assert(links, 'trigger evals: missing visualization links case');
  assert(links.expected_skills.includes('burrete:open-workspace'), 'trigger evals links: expected Burrete opening');
  assert(links.not_expected_skills.includes('gromacs-md'), 'trigger evals links: should not rerun MD for existing outputs');

  const noContinue = cases.find(item => String(item.query || '') === 'Dock this ligand, run MD, and visualize the trajectory.');
  assert(noContinue, 'trigger evals: missing dock -> MD -> visualize no-continue case');
  assert(noContinue.expected_skills.includes('burrete:molecule-collection'), 'trigger evals no-continue: expected pose review');
  assert(noContinue.expected_skills.includes('burrete:trajectory-review'), 'trigger evals no-continue: expected trajectory review');
  assert((noContinue.must_include_concepts || []).includes('best available valid pose artifact continues downstream'), 'trigger evals no-continue: expected fallback pose artifact');
  assert((noContinue.must_not_include_concepts || []).includes('stop because one optional method failed while another valid pose exists'), 'trigger evals no-continue: forbid optional-method stop');
  assert((noContinue.must_include_concepts || []).includes('Burrete top-pose review/open status before MD'), 'trigger evals no-continue: expected pose review before MD concept');
  assert((noContinue.must_not_include_concepts || []).includes('start MD before Burrete top-pose review'), 'trigger evals no-continue: forbid MD before pose review');
  assert((noContinue.must_not_include_concepts || []).includes('if you want, i can continue'), 'trigger evals no-continue: forbid follow-up offer');
  assert((noContinue.must_include_concepts || []).includes('finish requested handoffs before final answer or report a real blocker'), 'trigger evals no-continue: require terminal-state answer');
  assert((noContinue.must_include_concepts || []).includes('bounded multi-model PDB as visualization display file'), 'trigger evals no-continue: expected display PDB');
  assert((noContinue.must_include_concepts || []).includes('bounded no-water multi-model PDB as visualization display file'), 'trigger evals no-continue: expected no-water display PDB');
  assert((noContinue.must_include_concepts || []).includes('multi-frame no-water display PDB for trajectory visualization'), 'trigger evals no-continue: expected multi-frame display PDB');
  assert((noContinue.must_include_concepts || []).includes('compact no-bulk-water preview topology or metadata'), 'trigger evals no-continue: expected compact preview topology');
  assert((noContinue.must_not_include_concepts || []).includes('open xtc alone as visualization display'), 'trigger evals no-continue: forbid XTC-only display');
  assert((noContinue.must_not_include_concepts || []).includes('open gro snapshot as trajectory visualization'), 'trigger evals no-continue: forbid GRO snapshot trajectory display');
  assert((noContinue.must_not_include_concepts || []).includes('bulk water in local preview topology'), 'trigger evals no-continue: forbid water-heavy preview topology');

  const molstarPoses = cases.find(item => String(item.query || '') === 'Show me the docking poses in Mol*.');
  assert(molstarPoses, 'trigger evals: missing Mol* docking pose case');
  assert(molstarPoses.expected_skills.includes('burrete:molecule-collection'), 'trigger evals Mol*: expected Burrete molecule collection');

  const openTrajectory = cases.find(item => String(item.query || '') === 'Open the MD trajectory.');
  assert(openTrajectory, 'trigger evals: missing open MD trajectory case');
  assert(openTrajectory.expected_skills.includes('burrete:trajectory-review'), 'trigger evals open trajectory: expected Burrete trajectory review');

  const dockVisualize = cases.find(item => String(item.query || '') === 'Dock and visualize the best poses.');
  assert(dockVisualize, 'trigger evals: missing dock and visualize best poses case');
  assert(dockVisualize.expected_skills.includes('gnina-smina-docking'), 'trigger evals dock visualize: expected docking');
  assert(dockVisualize.expected_skills.includes('burrete:molecule-collection'), 'trigger evals dock visualize: expected Burrete pose review');
  pass('trigger evals require runtime discovery for local PATH blockers and Burrete for pose/trajectory visualization routes');
}

function checkCliPipelineSurface() {
  const help = runCli(['--help'], 'public help');
  assertIncludes(help, 'run docking', 'public help');
  assertIncludes(help, 'md <connect|submit|status|log|result|analyze-tpr>', 'public help');
  assertIncludes(help, 'Use Burrete for ordinary molecular viewing, pose review, and trajectory review.', 'public help Burrete policy');
  assertNotIncludes(help, 'MolViewStories', 'public help should not expose old story workflow');
  assertNotIncludes(help, 'visualize story', 'public help should not expose old story workflow');

  const runHelp = runCli(['run', '--help'], 'run help');
  assertIncludes(runHelp, 'run docking prepares a local run package', 'run help');
  assertIncludes(runHelp, 'does not start remote compute by itself', 'run help');
  assertIncludes(runHelp, 'Server/profile/tool paths must come from config/profile/flags/env, never hidden defaults.', 'run help');

  const mdHelp = runCli(['md', '--help'], 'md help');
  assertNotIncludes(mdHelp, 'trajectory-serve', 'md help must not expose the removed local viewer');
  assertIncludes(mdHelp, 'bounded no-water multi-frame PDB display artifact', 'md help');
  assertIncludes(mdHelp, 'Resource allocation follows the configured scheduler profile', 'md help');

  const tools = JSON.parse(runCli(['list-tools'], 'list-tools'));
  const toolNames = tools.map(tool => tool.name).sort();
  for (const name of [
    'lp_flow_plugin_status',
    'lp_flow_run_docking',
    'lp_flow_md_connect_check',
    'lp_flow_md_submit',
    'lp_flow_md_status',
    'lp_flow_md_log',
    'lp_flow_md_result',
    'lp_flow_md_analyze_tpr',
  ]) {
    assert(toolNames.includes(name), `public list-tools: expected ${name}`);
  }
  assert(!toolNames.includes('lp_flow_md_trajectory_serve'), 'public list-tools: legacy trajectory viewer must stay hidden');
  assert(!toolNames.some(name => name.includes('story') || name.includes('molstar')), `public list-tools: old visualization/story tools leaked: ${toolNames.join(', ')}`);

  const internalHelp = runCli(['list-tools', '--include-internal'], 'internal list-tools');
  assertNotIncludes(internalHelp, 'MolViewStories', 'internal help must not expose the removed viewer');
  pass('CLI discovery exposes docking, MD, and Burrete-first visualization contracts without running workflows');
}

function main() {
  assert(existsSync(entrypoint), `entrypoint missing: ${entrypoint}`);
  checkSourceCacheSync();
  checkSkillFrontmatter();
  checkTriggerWording();
  checkPipelineSkillChain();
  checkCompletionContracts();
  checkTriggerEvals();
  checkCliPipelineSurface();

  if (failures.length) {
    console.error('Pipeline skills contract check FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('Pipeline skills contract check PASSED');
  for (const item of passes) console.log(`- ${item}`);
}

main();
