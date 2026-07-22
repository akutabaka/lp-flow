#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const required = process.env.LP_FLOW_REQUIRE_BURRETE_HOST === '1';
const candidates = [
  process.env.LP_FLOW_BURRETE_PLUGIN_ROOT,
  path.join(homedir(), 'plugins', 'Burrete', 'plugins', 'burette-agent'),
  path.join(homedir(), '.codex', 'plugins', 'cache', 'personal', 'burrete', 'local', 'plugins', 'burette-agent'),
].filter(Boolean);
const root = candidates.find(candidate =>
  existsSync(path.join(candidate, '.mcp.json')) &&
  existsSync(path.join(candidate, 'node_modules', '@modelcontextprotocol', 'sdk')),
);

if (!root) {
  const message = `Burrete host integration SKIPPED: installed plugin not found (${candidates.join(', ')})`;
  if (required) throw new Error(message);
  console.log(message);
  process.exit(0);
}

const config = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
const server = Object.values(config.mcpServers || {})[0];
if (!server?.command || !Array.isArray(server.args)) throw new Error('Installed Burrete .mcp.json has no runnable server');

const requests = [
  {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lp-flow-host-test', version: '1.0' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'validate_trajectory_review_artifact',
      arguments: {
        manifest: { version: 1, title: 'LP-Flow host test', blocks: [{ type: 'trajectory', dataset: 'frames' }] },
        snapshot: { version: 1, status: 'ready', datasets: { frames: [{ frame: 1 }, { frame: 2 }] } },
      },
    },
  },
];
const command = String(server.command).toLowerCase() === 'node' ? process.execPath : server.command;
const result = spawnSync(command, server.args, {
  cwd: root,
  input: `${requests.map(item => JSON.stringify(item)).join('\n')}\n`,
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
  timeout: 60000,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Installed Burrete MCP exited ${result.status}\n${result.stderr}`);
const responses = (result.stdout || '').split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
const tools = responses.find(response => response.id === 2)?.result?.tools || [];
const names = new Set(tools.map(tool => tool.name));
for (const name of ['open_burrete_docking_view', 'burrete.open_workspace', 'validate_trajectory_review_artifact']) {
  if (!names.has(name)) throw new Error(`Installed Burrete is missing required tool: ${name}`);
}
const validation = responses.find(response => response.id === 3)?.result?.structuredContent;
if (validation?.ok !== true || validation?.summary?.surface !== 'trajectory-review') {
  throw new Error(`Installed Burrete trajectory validation failed: ${JSON.stringify(validation)}`);
}

console.log(`Burrete host integration PASSED (${root})`);
