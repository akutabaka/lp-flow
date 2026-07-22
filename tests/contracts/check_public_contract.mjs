#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const entrypoint = path.join(repoRoot, 'scripts', 'lp-flow.mjs');
const node = process.execPath;

const PUBLIC_TOOLS = [
  'lp_flow_md_analyze_tpr',
  'lp_flow_md_connect_check',
  'lp_flow_md_log',
  'lp_flow_md_result',
  'lp_flow_md_status',
  'lp_flow_md_submit',
  'lp_flow_plugin_status',
  'lp_flow_prepare_burrete_request',
  'lp_flow_prepare_redocking_case',
  'lp_flow_record_burrete_receipt',
  'lp_flow_remote_command_plan',
  'lp_flow_remote_execute_step',
  'lp_flow_run_docking',
];
const ADVANCED_ONLY_TOOLS = [
  'lp_flow_remote_session_check',
  'lp_flow_remote_session_close',
  'lp_flow_remote_session_open',
];
const INTERNAL_TOOLS = [
  'lp_flow_remote_session_check',
  'lp_flow_remote_session_close',
  'lp_flow_remote_session_open',
  'lp_flow_md_analyze_tpr',
  'lp_flow_md_connect_check',
  'lp_flow_md_log',
  'lp_flow_md_result',
  'lp_flow_md_status',
  'lp_flow_md_submit',
  'lp_flow_plugin_status',
  'lp_flow_prepare_burrete_request',
  'lp_flow_prepare_redocking_case',
  'lp_flow_record_burrete_receipt',
  'lp_flow_run_docking',
  'lp_flow_resolve_profile',
  'lp_flow_find_case_folder',
  'lp_flow_validate_case_folder',
  'lp_flow_safe_remote_cleanup_check',
  'lp_flow_build_run_plan',
  'lp_flow_write_run_package',
  'lp_flow_build_docking_payload',
  'lp_flow_remote_command_plan',
  'lp_flow_remote_execute_step',
  'lp_flow_build_summary_command',
  'lp_flow_inspect_results',
];

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

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label}: expected to include ${JSON.stringify(needle)}`);
}

function assertNotIncludes(text, needle, label) {
  assert(!text.includes(needle), `${label}: expected not to include ${JSON.stringify(needle)}`);
}

function assertNotMatches(text, pattern, label) {
  assert(!pattern.test(text), `${label}: expected not to match ${pattern}`);
}

function assertArrayEqual(actual, expected, label) {
  const a = [...actual].sort();
  const b = [...expected].sort();
  const same = a.length === b.length && a.every((value, index) => value === b[index]);
  assert(same, `${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function runCli(args, options = {}) {
  const result = spawnSync(node, [entrypoint, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return {
    args,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    text: `${result.stdout || ''}${result.stderr || ''}`,
    error: result.error,
  };
}

function requireCli(args, label) {
  const result = runCli(args);
  assert(!result.error, `${label}: failed to start: ${result.error?.message}`);
  assert(result.status === 0, `${label}: expected exit 0, got ${result.status}\n${result.text}`);
  return result;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`${label}: failed to parse JSON: ${error.message}\n${result.stdout}`);
    return null;
  }
}

function mcpSession(requests) {
  const result = spawnSync(node, [entrypoint, 'mcp'], {
    cwd: repoRoot,
    input: `${requests.map(request => JSON.stringify(request)).join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(!result.error, `MCP session: failed to start: ${result.error?.message}`);
  assert(result.status === 0, `MCP session: expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`);
  const stdout = result.stdout || '';
  assertNotIncludes(stdout, 'Content-Length', 'MCP stdio output');
  try {
    return stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    fail(`MCP session: failed to parse newline-delimited response: ${error.message}\n${stdout}`);
    return [];
  }
}

function mcpRequests(request) {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract', version: '1.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, ...request },
  ];
}

function mcpToolsList(params = {}) {
  const responses = mcpSession(mcpRequests({ method: 'tools/list', params }));
  const initialized = responses.find(response => response.id === 1)?.result;
  assert(initialized?.serverInfo?.name, 'MCP initialize: expected serverInfo');
  assertIncludes(initialized?.instructions || '', 'Burrete', 'MCP initialize instructions');
  return responses.find(response => response.id === 2)?.result?.tools || [];
}

function mcpToolCall(name, args = {}, extra = {}) {
  const responses = mcpSession(mcpRequests({ method: 'tools/call', params: { name, arguments: args, ...extra } }));
  return responses.find(response => response.id === 2)?.result || null;
}

function checkPluginMcpConfig() {
  const mcpConfigPath = path.join(repoRoot, '.mcp.json');
  assert(existsSync(mcpConfigPath), `.mcp.json not found: ${mcpConfigPath}`);
  const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  assert(Object.hasOwn(config, 'mcpServers'), '.mcp.json must use the standard mcpServers wrapper');
  assert(!Object.hasOwn(config, 'mcp_servers'), '.mcp.json must not use the legacy mcp_servers key');
  const servers = config.mcpServers;
  assert(servers.lp_flow_mcp, '.mcp.json must expose lp_flow_mcp');
  assert(!servers['lp-flow'], '.mcp.json must not use a hyphenated MCP server id');
  assert(servers.lp_flow_mcp.cwd === '.', '.mcp.json lp_flow_mcp must set cwd "."');
  assert(servers.lp_flow_mcp.command === 'node', '.mcp.json lp_flow_mcp must use the portable node entrypoint');
  assertIncludes((servers.lp_flow_mcp.args || []).join(' '), './scripts/lp-flow.mjs mcp', '.mcp.json lp_flow_mcp args');
  pass('.mcp.json uses a portable node entrypoint, Codex-visible server id, and plugin-root cwd');
}

function checkPluginManifestAndAssets() {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert(!Object.hasOwn(manifest.interface || {}, 'requirements'), 'plugin manifest: unsupported interface.requirements must be omitted');
  assert(!Object.hasOwn(manifest.interface || {}, 'thirdPartyAssetNotes'), 'plugin manifest: unsupported interface.thirdPartyAssetNotes must be omitted');
  assert(existsSync(path.join(repoRoot, 'assets', 'screenshots', 'lp-flow-demo.png')), 'README hero screenshot must exist');
  assert(existsSync(path.join(repoRoot, 'assets', 'diagrams', 'lp-flow-architecture.svg')), 'architecture diagram must exist');
  assert(!existsSync(path.join(repoRoot, 'assets', 'mvs-stories')), 'legacy Mol View Stories assets must not be bundled');
  pass('plugin manifest uses accepted fields and public assets are present without the legacy viewer bundle');
}

function enumValues(tool, propertyName) {
  return tool?.inputSchema?.properties?.[propertyName]?.enum || [];
}

function propertyNames(tool) {
  return Object.keys(tool?.inputSchema?.properties || {});
}

function checkPublicHelp() {
  const help = requireCli(['--help'], 'public help').text;
  for (const needle of [
    'status',
    'list-tools',
    'run docking',
    'md <connect|submit|status|log|result|analyze-tpr>',
    'Burrete',
    'mcp',
  ]) {
    assertIncludes(help, needle, 'public help');
  }
  assertNotMatches(help, /\bmake-[A-Za-z0-9-]+/, 'public help');
  assertNotMatches(help, /\bbuild-[A-Za-z0-9-]+/, 'public help');
  assertNotIncludes(help, 'visualize structure', 'public help');
  assertNotIncludes(help, '--viewer molstar', 'public help');
  assertNotMatches(help, /--open(?!-browser|-codex)\b/, 'public help');
  assertNotIncludes(help, '--open-codex', 'public help');
  for (const forbidden of [
    'story-type generic',
    'story-type structure',
    'story-type docking',
    'generic|structure',
    'visualize docking',
    'visualize story',
    'story serve',
    'story validate',
    'MolViewStories',
    'Mol View Stories',
    'molstory',
    'CellPACK',
    'Exosome',
    'Mycoplasma',
    'session open',
    'resolve-profile',
    'validate-case',
    'find-case',
    'remote-command-plan',
    'remote-execute-step',
    'safe-cleanup-check',
    'inspect-results',
  ]) {
    assertNotIncludes(help, forbidden, 'public help');
  }
  pass('public CLI help exposes only the compact surface');
}

function checkAdvancedInternalHelp() {
  const advanced = requireCli(['--help', '--advanced'], 'advanced help').text;
  assertIncludes(advanced, 'session open', 'advanced help');
  assertIncludes(advanced, '--execute true', 'advanced help');
  assertNotIncludes(advanced, 'story serve-hub', 'advanced help');
  assertNotIncludes(advanced, 'story render-package', 'advanced help');
  assertNotIncludes(advanced, 'coarse-overview', 'advanced help');
  assertNotIncludes(advanced, 'curated-presentation', 'advanced help');
  assertNotIncludes(advanced, 'CellPACK', 'advanced help');

  const internal = requireCli(['--help', '--internal'], 'internal help').text;
  assertIncludes(internal, 'Internal maintenance', 'internal help');
  for (const command of ['build-run-plan', 'remote-command-plan', 'remote-execute-step']) {
    assertIncludes(internal, command, 'internal help');
  }
  assertNotIncludes(internal, 'story serve', 'internal help');
  assertNotIncludes(internal, 'visualize story', 'internal help');
  pass('advanced/internal help exposes execution and maintenance surfaces without legacy viewers');
}

function checkToolDiscovery() {
  const publicList = parseJsonOutput(requireCli(['list-tools'], 'CLI list-tools'), 'CLI list-tools') || [];
  const advancedList = parseJsonOutput(requireCli(['list-tools', '--advanced'], 'CLI list-tools --advanced'), 'CLI list-tools --advanced') || [];
  const internalList = parseJsonOutput(requireCli(['list-tools', '--internal'], 'CLI list-tools --internal'), 'CLI list-tools --internal') || [];
  assertArrayEqual(publicList.map(tool => tool.name), PUBLIC_TOOLS, 'CLI public tools');
  assertArrayEqual(
    advancedList.map(tool => tool.name).filter(name => !PUBLIC_TOOLS.includes(name)),
    ADVANCED_ONLY_TOOLS,
    'CLI advanced-only tools',
  );
  assertArrayEqual(internalList.map(tool => tool.name), INTERNAL_TOOLS, 'CLI internal tools');

  const mcpPublic = mcpToolsList();
  const mcpAdvanced = mcpToolsList({ visibility: 'advanced' });
  const mcpInternal = mcpToolsList({ visibility: 'internal' });
  assertArrayEqual(mcpPublic.map(tool => tool.name), PUBLIC_TOOLS, 'MCP public tools');
  assertArrayEqual(
    mcpAdvanced.map(tool => tool.name).filter(name => !PUBLIC_TOOLS.includes(name)),
    ADVANCED_ONLY_TOOLS,
    'MCP advanced-only tools',
  );
  assertArrayEqual(mcpInternal.map(tool => tool.name), INTERNAL_TOOLS, 'MCP internal tools');
  pass('CLI and MCP tool discovery match the public contract');

  return { mcpPublic };
}

function checkPublicSchemas(mcpPublic) {
  const publicToolNames = mcpPublic.map(tool => tool.name);
  for (const hidden of [
    'lp_flow_visualize_docking',
    'lp_flow_visualize_story',
    'lp_flow_story_serve',
    'lp_flow_story_validate',
    'lp_flow_story_serve_hub',
    'lp_flow_story_render_package',
    'lp_flow_md_trajectory_serve',
  ]) {
    assert(!publicToolNames.includes(hidden), `public schemas: expected compatibility tool to be absent: ${hidden}`);
  }
  for (const tool of mcpPublic) {
    assert(tool.inputSchema?.additionalProperties === false, `public schema ${tool.name}: expected additionalProperties=false`);
    assert(tool.outputSchema?.type === 'object', `public schema ${tool.name}: expected object outputSchema`);
    assert(Object.keys(tool.outputSchema?.properties || {}).length > 0, `public schema ${tool.name}: expected named output properties`);
    assert(typeof tool.title === 'string' && tool.title.length > 0, `public schema ${tool.name}: expected title`);
    const annotations = tool.annotations || {};
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert(typeof annotations[key] === 'boolean', `public schema ${tool.name}: expected boolean ${key}`);
    }
  }
  const docking = mcpPublic.find(tool => tool.name === 'lp_flow_run_docking');
  assert(docking, 'public schemas: expected lp_flow_run_docking');
  assertArrayEqual(propertyNames(docking), ['config', 'out_dir'], 'public run docking schema properties');
  for (const forbidden of ['viewer', 'display', 'trajectory', 'open_browser', 'html', 'png']) {
    assert(!propertyNames(docking).includes(forbidden), `public run docking schema: unexpected ${forbidden}`);
  }
  pass('public MCP schemas hide legacy local viewers and expose Burrete-first workflow surface only');

  const status = mcpToolCall('lp_flow_plugin_status');
  const statusPayload = status?.structuredContent || {};
  assert(statusPayload.plugin_root === '<installed-plugin>', 'plugin status: expected redacted plugin root by default');
  assert(statusPayload.mcp_config === '.mcp.json', 'plugin status: expected relative MCP config path by default');
  assert(typeof statusPayload.configured_profile_count === 'number', 'plugin status: expected configured profile count');
  assert(!Object.hasOwn(statusPayload, 'configured_profiles'), 'plugin status: expected profile names/paths to be withheld by default');
  pass('plugin status redacts installation and profile paths unless explicitly requested');

  const hiddenCall = mcpToolCall('lp_flow_build_summary_command', { run_dir: '/safe/audit' });
  assert(hiddenCall?.isError === true, 'public MCP tools/call must reject a known internal tool omitted from public discovery');
  assertIncludes(hiddenCall?.content?.[0]?.text || '', 'not available in public MCP visibility', 'public MCP direct internal call guard');
  pass('public MCP tools/call enforces the same visibility boundary as discovery');
}

function checkRemovedViewerCommands() {
  for (const command of ['visualize', 'story']) {
    const result = runCli([command]);
    assert(result.status !== 0, `${command}: expected removed command to fail`);
    assertIncludes(result.text, `Unknown command: ${command}`, `${command} removal`);
  }
  pass('legacy viewer commands are absent from the CLI');
}

function checkTreeHygiene() {
  const forbiddenExtensions = new Set(['.bcif', '.mvsj', '.mvsx', '.mvstory', '.molx', '.pyc']);
  const forbiddenDirectoryNames = new Set(['__pycache__', 'results', 'outputs', '.lp-flow-runs', 'screenshots']);
  const violations = [];
  const stack = [repoRoot];
  while (stack.length) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(repoRoot, fullPath);
      if (entry.isDirectory()) {
        const curatedScreenshotDir = relative === path.join('assets', 'screenshots');
        if ((forbiddenDirectoryNames.has(entry.name) && !curatedScreenshotDir) || /^tmp/i.test(entry.name) || /^viewer/i.test(entry.name)) {
          violations.push(`${relative}${path.sep}`);
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (forbiddenExtensions.has(ext) || entry.name === 'thumb.jpg') {
          violations.push(relative);
        }
      }
    }
  }
  assert(violations.length === 0, `tree hygiene: forbidden generated artifacts found:\n${violations.join('\n')}`);
  pass('source tree contains no generated scientific/viewer/cache artifacts');
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createMinimalRunPackage(root) {
  const packageDir = path.join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(path.join(packageDir, 'input'), { recursive: true });
  const inputFile = path.join(packageDir, 'input', 'receptor.pdb');
  writeFileSync(inputFile, 'HEADER CONTRACT TEST\nEND\n', 'utf8');
  const remoteRoot = '/home/contract/docking_runs';
  const runDir = `${remoteRoot}/contract_run`;
  writeJson(path.join(packageDir, 'run_plan.json'), {
    case: { run_id: 'contract_run' },
    local: { task_dir: packageDir },
    profile: {
      profile_ref: 'contract',
      remote_work_root: remoteRoot,
    },
    remote: { run_dir: runDir },
  });
  writeJson(path.join(packageDir, 'upload_manifest.json'), [
    {
      role: 'input',
      local_path: inputFile,
      remote_path: `${runDir}/input/receptor.pdb`,
    },
  ]);
  writeJson(path.join(packageDir, 'download_manifest.json'), [
    {
      role: 'remote_archive',
      remote_path: `${remoteRoot}/contract_run.tar.gz`,
      local_path: path.join(packageDir, 'contract_run.tar.gz'),
    },
  ]);
  return packageDir;
}

function flattenPlannedCommands(plan) {
  return (plan.steps || []).flatMap(step => step.commands || []);
}

function checkPersistentSshControlMaster() {
  const tempRoot = path.join(tmpdir(), `lp-flow-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tempRoot, { recursive: true });
  try {
    const packageDir = createMinimalRunPackage(tempRoot);
    const profile = {
      profile_name: 'contract',
      ssh_alias: 'remote-alias',
      username: 'contract',
      remote_work_root: '/home/contract/docking_runs',
    };
    const result = requireCli(['remote-command-plan', '--package-dir', packageDir, '--profile-json', JSON.stringify(profile)], 'remote-command-plan ControlMaster');
    const plan = parseJsonOutput(result, 'remote-command-plan ControlMaster');
    const commands = flattenPlannedCommands(plan);
    assert(commands.length > 0, 'remote-command-plan: expected planned commands');
    if (process.platform === 'win32') {
      assert(plan?.ssh_control?.enabled === false, 'remote-command-plan: expected ssh_control.enabled=false by default on Windows');
      assertIncludes(plan?.ssh_control?.reason || '', 'disabled by default on Windows', 'remote-command-plan Windows disabled reason');
      for (const command of commands.filter(item => item.kind === 'ssh' || item.kind?.startsWith('scp'))) {
        assertNotIncludes(command.argv.join('\n'), 'ControlMaster=auto', `${command.kind} default Windows argv`);
        assertNotIncludes(command.argv.join('\n'), 'ControlPath=', `${command.kind} default Windows argv`);
      }
    } else {
      assert(plan?.ssh_control?.enabled === true, 'remote-command-plan: expected ssh_control.enabled=true by default');
      assert(plan?.ssh_control?.control_master === 'auto', 'remote-command-plan: expected ControlMaster=auto metadata');
      assert(plan?.ssh_control?.control_persist === '10m', 'remote-command-plan: expected ControlPersist=10m metadata');
      assert(typeof plan?.ssh_control?.control_path === 'string' && plan.ssh_control.control_path.includes('lpd-ssh-'), 'remote-command-plan: expected hashed ControlPath metadata');
      for (const command of commands.filter(item => item.kind === 'ssh' || item.kind?.startsWith('scp'))) {
        assertIncludes(command.argv.join('\n'), 'ControlMaster=auto', `${command.kind} argv`);
        assertIncludes(command.argv.join('\n'), 'ControlPersist=10m', `${command.kind} argv`);
        assertIncludes(command.argv.join('\n'), `ControlPath=${plan.ssh_control.control_path}`, `${command.kind} argv`);
        assert(command.ssh_control?.control_path === plan.ssh_control.control_path, `${command.kind}: expected command ssh_control path to match plan`);
      }
    }

    const enabledProfile = { ...profile, ssh_control_master: true };
    const enabledResult = requireCli(['remote-command-plan', '--package-dir', packageDir, '--profile-json', JSON.stringify(enabledProfile)], 'remote-command-plan ControlMaster explicit enabled');
    const enabledPlan = parseJsonOutput(enabledResult, 'remote-command-plan ControlMaster explicit enabled');
    assert(enabledPlan?.ssh_control?.enabled === true, 'remote-command-plan explicit enabled: expected ssh_control.enabled=true');
    assert(enabledPlan?.ssh_control?.control_master === 'auto', 'remote-command-plan explicit enabled: expected ControlMaster=auto metadata');
    assert(enabledPlan?.ssh_control?.control_persist === '10m', 'remote-command-plan explicit enabled: expected ControlPersist=10m metadata');
    assert(typeof enabledPlan?.ssh_control?.control_path === 'string' && enabledPlan.ssh_control.control_path.includes('lpd-ssh-'), 'remote-command-plan explicit enabled: expected hashed ControlPath metadata');
    for (const command of flattenPlannedCommands(enabledPlan).filter(item => item.kind === 'ssh' || item.kind?.startsWith('scp'))) {
      assertIncludes(command.argv.join('\n'), 'ControlMaster=auto', `${command.kind} explicit enabled argv`);
      assertIncludes(command.argv.join('\n'), 'ControlPersist=10m', `${command.kind} explicit enabled argv`);
      assertIncludes(command.argv.join('\n'), `ControlPath=${enabledPlan.ssh_control.control_path}`, `${command.kind} explicit enabled argv`);
      assert(command.ssh_control?.control_path === enabledPlan.ssh_control.control_path, `${command.kind}: expected explicit enabled ssh_control path to match plan`);
    }

    const sessionResult = requireCli(['session', 'open', '--profile-json', JSON.stringify(profile), '--execute', 'false'], 'session open dry-run');
    const sessionPlan = parseJsonOutput(sessionResult, 'session open dry-run');
    const sessionArgv = sessionPlan?.command?.argv || [];
    assert(sessionPlan?.ssh_control?.enabled === true, 'session open: expected ssh_control.enabled=true');
    assert(sessionPlan?.ssh_control?.control_persist === '8h', 'session open: expected ControlPersist=8h metadata');
    assert(typeof sessionPlan?.ssh_control?.control_path === 'string' && sessionPlan.ssh_control.control_path.includes('lpd-ssh-'), 'session open: expected hashed ControlPath metadata');
    assertIncludes(sessionArgv.join('\n'), '-M', 'session open argv');
    assertIncludes(sessionArgv.join('\n'), '-N', 'session open argv');
    assertIncludes(sessionArgv.join('\n'), '-f', 'session open argv');
    assertIncludes(sessionArgv.join('\n'), 'ControlMaster=yes', 'session open argv');
    assertIncludes(sessionArgv.join('\n'), 'ControlPersist=8h', 'session open argv');
    assertIncludes(sessionArgv.join('\n'), `ControlPath=${sessionPlan.ssh_control.control_path}`, 'session open argv');

    const disabledProfile = { ...profile, ssh_control_master: false };
    const disabledResult = requireCli(['remote-command-plan', '--package-dir', packageDir, '--profile-json', JSON.stringify(disabledProfile)], 'remote-command-plan ControlMaster disabled');
    const disabledPlan = parseJsonOutput(disabledResult, 'remote-command-plan ControlMaster disabled');
    assert(disabledPlan?.ssh_control?.enabled === false, 'remote-command-plan disabled: expected ssh_control.enabled=false');
    for (const command of flattenPlannedCommands(disabledPlan).filter(item => item.kind === 'ssh' || item.kind?.startsWith('scp'))) {
      assertNotIncludes(command.argv.join('\n'), 'ControlMaster=auto', `${command.kind} disabled argv`);
      assertNotIncludes(command.argv.join('\n'), 'ControlPath=', `${command.kind} disabled argv`);
    }
    pass('remote command plan uses platform-safe SSH ControlMaster policy and supports explicit enable/disable');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  assert(existsSync(entrypoint), `entrypoint not found: ${entrypoint}`);
  checkPluginMcpConfig();
  checkPluginManifestAndAssets();
  checkPublicHelp();
  checkAdvancedInternalHelp();
  const { mcpPublic } = checkToolDiscovery();
  checkPublicSchemas(mcpPublic);
  checkRemovedViewerCommands();
  checkPersistentSshControlMaster();
  checkTreeHygiene();

  if (failures.length) {
    console.error('Public API contract check FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('Public API contract check PASSED');
  for (const item of passes) console.log(`- ${item}`);
}

main();
